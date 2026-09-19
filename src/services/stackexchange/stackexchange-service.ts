/**
 * @fileoverview Stack Exchange API v2.3 HTTP client with backoff tracking,
 * quota logging, gzip decompression, and typed domain methods.
 * @module services/stackexchange/stackexchange-service
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  configurationError,
  forbidden,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { decodeHtmlEntities, normalizeHtml } from './html-normalizer.js';
import type {
  SeAnswer,
  SeComment,
  SeError,
  SeQuestion,
  SeSite,
  SeTopTag,
  SeUser,
  SeWrapper,
} from './types.js';

const BASE_URL = 'https://api.stackexchange.com/2.3';
const REQUEST_TIMEOUT_MS = 30_000;
/** Leave headroom within a typical 60-second client timeout, including queue and backoff. */
const OPERATION_DEADLINE_MS = 50_000;

/** Page size for the /sites walk — 100 is the SE maximum. */
const SITES_PAGE_SIZE = 100;

/**
 * Hard stop for the /sites walk. The network is ~365 sites (4 pages) today; the
 * ceiling exists so a `has_more` that never clears cannot spin, not to cap the
 * result — hitting it sets `truncated` so the caller learns the list is partial.
 */
const MAX_SITE_PAGES = 10;

/**
 * Custom filter for /users/{id}. SE's default field set omits `answer_count`
 * and `question_count`, so the profile call names its fields explicitly.
 *
 * Built with `base=none`, so it returns ONLY these fields — every field the
 * getUser mapping reads must be listed:
 *   wrapper: .backoff .error_id .error_message .error_name .has_more .items
 *            .quota_max .quota_remaining
 *   user:    user_id display_name link reputation badge_counts location
 *            website_url answer_count question_count creation_date
 *            last_access_date
 *   badge_count: gold silver bronze
 *
 * Regenerate by re-requesting /filters/create with `base=none` and that
 * `include` list, then confirm the response's `included_fields` echoes every
 * one back — SE silently drops a field name that is not on the type.
 */
const SE_USER_FILTER = '!fgp_FAe)vSKeMW4GBo(u*a)doNjyqH*B';

/**
 * Custom filter for /search/advanced. `question.excerpt` is not a field on the
 * `question` type — SE drops it from a minted filter without an error — so the
 * search result excerpt is derived from `body_markdown`, which the same call
 * returns. No extra request, no route change.
 *
 * Built with `base=none`, so it returns ONLY these fields — every field the
 * normalizeQuestion mapping reads must be listed:
 *   wrapper:  .backoff .error_id .error_message .error_name .has_more .items
 *             .quota_max .quota_remaining
 *   question: question_id title link score answer_count is_answered tags
 *             creation_date last_activity_date body_markdown
 *
 * Regenerate by re-requesting /filters/create with `base=none` and that
 * `include` list, then confirm the response's `included_fields` echoes every
 * one back — a field name SE does not recognize is dropped silently, so a call
 * that merely succeeds proves nothing.
 */
const SE_SEARCH_FILTER = '!-tSBS8YTedGMoaqycoVR';

/** Longest excerpt carried on a search result, in characters. */
const EXCERPT_MAX_CHARS = 300;

/**
 * Page size for both comment routes — 100 is the SE maximum.
 *
 * `/answers/{ids}/comments` returns ONE combined list across every requested
 * answer, so this caps the total the page can hold, not each post's share. The
 * widest page is what makes it unlikely that a heavily-commented answer consumes
 * the whole page and starves a later one; it cannot rule it out, which is why
 * the caller still has to tell "no comments" apart from "none in this page".
 */
const COMMENTS_PAGE_SIZE = 100;

/**
 * Longest comment list carried on any one post. The combined page is shared
 * across posts, so this is applied client-side per post after grouping.
 */
const MAX_COMMENTS_PER_POST = 20;

/** A paired fenced code block, fences included. */
const FENCED_CODE_BLOCK = /```[\s\S]*?```/g;

/** An unpaired opening fence and everything after it. */
const TRAILING_FENCE = /```[\s\S]*$/;

/**
 * A markdown indented code block line. SE renders code in `body_markdown` as
 * four-space indentation rather than fences, so this is the common case.
 */
const INDENTED_CODE_LINE = /^(?: {4}|\t).*$/gm;

/** A markdown link whose closing `)` the cut removed — `[text](https://exa`. */
const UNCLOSED_LINK = /^\[[^\]]*\]\([^)]*$/;

/**
 * A leading blockquote marker, nested levels included — `>`, `> > `. Structure
 * rather than prose, and stray punctuation once the lines collapse onto one.
 */
const BLOCKQUOTE_MARKER = /^ {0,3}(?:> ?)+/gm;

/**
 * A link reference definition line — `[label]: https://example.com "Title"`.
 *
 * Follows CommonMark's single-line form: up to three leading spaces, a
 * destination, and nothing after it but an optional quoted or parenthesized
 * title. The tail anchor is what keeps ordinary prose that opens with a
 * bracketed word (`[Note]: this only happens on startup`) from reading as a
 * definition and being deleted.
 *
 * Serves both halves of the fix — it collects the labels a body defines, and it
 * drops the definition lines themselves, which the four-space code stripping
 * misses because a definition block is conventionally indented two.
 */
const REFERENCE_DEFINITION_LINE =
  /^ {0,3}\[([^[\]]+)\]:[ \t]*(?:<[^<>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/gm;

/**
 * A reference-style link or image — `[text][label]`, the shorthand `[text][]`,
 * and `![alt][label]`. Neither bracket may contain a bracket, so chained
 * subscripting matches the shape one pair at a time instead of swallowing its
 * neighbours. Whether the match is a link at all is decided by the definition
 * lookup, never by the shape.
 */
const REFERENCE_LINK = /!?\[([^[\]]*)\]\[([^[\]]*)\]/g;

/** Match a reference label the way CommonMark does: case-folded, inner whitespace collapsed. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Flatten reference-style links to their text, but only where the body actually
 * defines the label.
 *
 * `[text][label]` is link syntax only when a matching definition exists. The
 * same bracket shape is ordinary prose across real question bodies — chained
 * subscripting (`grid[i][j]`), driver error prefixes (`[Microsoft][SQL
 * Server]`), adjacent tag mentions (`[c++][java]`) — and a pattern-only flatten
 * deletes that content rather than repairing broken markup, so an unresolved
 * pair is left exactly as written.
 */
function flattenReferenceLinks(text: string, definedLabels: ReadonlySet<string>): string {
  if (definedLabels.size === 0) return text;
  return text.replace(REFERENCE_LINK, (whole, linkText: string, label: string) => {
    // The shorthand `[text][]` carries its label in the text.
    const key = normalizeLabel(label) || normalizeLabel(linkText);
    // The `!` sits outside both captures, so a resolved image leaves alt text alone.
    return definedLabels.has(key) ? linkText : whole;
  });
}

/** Convert SE's Unix epoch seconds to an ISO 8601 string. */
function toIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Drop a markdown construct the cut left open. Two survive whitespace collapsing
 * on an SE body: an inline-code span (odd backtick count) and a link whose
 * `](url)` half was clipped. Applied only to a truncated excerpt — on a whole
 * body an odd backtick is the author's, not the truncation's.
 */
function trimDanglingMarkdown(text: string): string {
  let out = text;

  if ((out.match(/`/g)?.length ?? 0) % 2 === 1) {
    out = out.slice(0, out.lastIndexOf('`'));
  }

  const linkStart = out.lastIndexOf('[');
  if (linkStart >= 0 && UNCLOSED_LINK.test(out.slice(linkStart))) {
    out = out.slice(0, out[linkStart - 1] === '!' ? linkStart - 1 : linkStart);
  }

  return out.trimEnd();
}

/**
 * Reduce a question body to a short prose excerpt.
 *
 * Entities are decoded first: `body_markdown` arrives HTML-encoded (`&quot;`,
 * `&#39;`) the way `title` does, and cutting before decoding can split an entity
 * into `&qu`. Blockquote markers go next, while the lines are still lines. Code
 * blocks come out rather than being truncated into — a clipped fence dangles,
 * and a flattened code block is noise in a one-paragraph excerpt. Returns
 * undefined when nothing but code and whitespace was there, so a caller gets no
 * excerpt rather than a fabricated one.
 *
 * Reference definitions are read from the whole body and their lines dropped,
 * then resolvable reference links are flattened before the cut — so a label
 * defined far below the excerpt window still resolves the link above it, and a
 * link spanning the boundary is plain words by the time the cut lands.
 */
function deriveExcerpt(bodyMarkdown: string): string | undefined {
  const withoutCode = decodeHtmlEntities(bodyMarkdown)
    .replace(BLOCKQUOTE_MARKER, '')
    .replace(FENCED_CODE_BLOCK, ' ')
    .replace(TRAILING_FENCE, ' ')
    .replace(INDENTED_CODE_LINE, ' ');

  const definedLabels = new Set<string>();
  for (const [, label] of withoutCode.matchAll(REFERENCE_DEFINITION_LINE)) {
    if (label !== undefined) definedLabels.add(normalizeLabel(label));
  }

  const prose = flattenReferenceLinks(
    withoutCode.replace(REFERENCE_DEFINITION_LINE, ' ').replace(/\s+/g, ' ').trim(),
    definedLabels,
  );

  if (!prose) return undefined;
  if (prose.length <= EXCERPT_MAX_CHARS) return prose;

  const cut = prose.slice(0, EXCERPT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const clipped = trimDanglingMarkdown((lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd());

  return clipped ? `${clipped}…` : undefined;
}

/**
 * Stack Exchange refusing the API key the server was configured with. SE reports
 * it as `bad_parameter` like any other refused field, but the `error_message` is
 * prose naming the `key` parameter — "`key` doesn't match a known application" —
 * rather than the bare field name every caller-supplied rejection carries.
 *
 * Anchored at the start of the message so a field name that merely contains
 * "key" stays a caller parameter problem, and matched with or without SE's
 * backticks since the two rejection wordings differ in that alone.
 */
const UNRECOGNIZED_KEY_MESSAGE = /^`?key(?:`|\b)/i;

/**
 * How one call site reports a `bad_parameter` rejection that is not about the
 * site. Stack Exchange names the field it refused (`ids`, `pagesize`, `tagged`)
 * but `fetchSe` is shared across every tool, so it cannot know what the caller
 * calls that input or which `reason` the calling tool declares. Each caller
 * supplies its own mapping instead of the mapper guessing.
 */
type BadParameterMapping = (field: string) => { reason: string; message: string };

/** Repeat back the field Stack Exchange refused, without assuming what it is. */
const invalidParameter: BadParameterMapping = (field) => ({
  reason: 'invalid_parameter',
  message: `Stack Exchange rejected the "${field}" parameter.`,
});

/**
 * Mapping for the `/questions/{ids}` routes, where SE's `ids` field is the
 * question ID the caller supplied. Correct only there — every other route
 * builds `ids` from something the caller never sent.
 */
const questionIdOrParameter: BadParameterMapping = (field) =>
  field === 'ids'
    ? {
        reason: 'invalid_id_or_url',
        message: 'The question ID is not a valid Stack Exchange question ID.',
      }
    : invalidParameter(field);

/**
 * Raise the calling tool's `quota_exceeded` error once SE reports the daily
 * quota spent. SE answers HTTP 200 with `quota_remaining: 0` rather than a
 * rate-limit status, so every domain method checks the envelope itself.
 */
function assertQuotaRemaining(
  wrapper: Pick<SeWrapper<unknown>, 'quota_max' | 'quota_remaining'>,
  ctx: Context,
): void {
  if (wrapper.quota_remaining !== 0) return;
  throw rateLimited('Stack Exchange API quota exhausted.', {
    reason: 'quota_exceeded',
    ...ctx.recoveryFor('quota_exceeded'),
    quota_remaining: 0,
    quota_max: wrapper.quota_max,
  });
}

export interface SearchQuestionsOptions {
  acceptedOnly?: boolean;
  /** API key from server config — injected by the service. */
  apiKey?: string;
  minScore?: number;
  /** 1-based upstream page. Omitted from the request when absent — SE defaults to 1. */
  page?: number;
  pageSize?: number;
  query: string;
  site: string;
  sort?: 'relevance' | 'votes' | 'activity' | 'newest';
  tags?: string[];
}

export interface GetThreadOptions {
  apiKey?: string;
  includeComments?: boolean;
  maxAnswers?: number;
  questionId: number;
  site: string;
}

export interface GetUserOptions {
  apiKey?: string;
  site: string;
  userId: number;
}

export interface GetTagFaqOptions {
  apiKey?: string;
  /** 1-based upstream page. Omitted from the request when absent — SE defaults to 1. */
  page?: number;
  pageSize?: number;
  site: string;
  tag: string;
}

export interface GetSitesOptions {
  apiKey?: string;
}

/** Normalized question for tool output. */
export interface NormalizedQuestion {
  answerCount: number;
  /** ISO 8601 timestamp of when the question was asked. */
  creationDate?: string;
  excerpt?: string;
  isAnswered: boolean;
  /** ISO 8601 timestamp of the question's most recent activity. */
  lastActivityDate?: string;
  link: string;
  questionId: number;
  score: number;
  tags: string[];
  title: string;
}

/** Normalized comment hanging off a question or an answer. */
export interface NormalizedComment {
  authorLink?: string;
  authorName?: string;
  bodyMarkdown: string;
  commentId: number;
  /** ISO 8601 timestamp of when the comment was posted. */
  creationDate?: string;
  score: number;
}

/**
 * A post's comment state. The absent-vs-empty distinction is load-bearing:
 * `comments: []` means the post has none, while an absent `comments` means the
 * fetch could not establish its state — comments were not requested, or the
 * combined page ran out before this post contributed anything. Rendering the
 * second as the first tells the caller a post is uncommented when it is not.
 */
interface CommentState {
  /** Absent when the post's comment state is unknown, never as a stand-in for none. */
  comments?: NormalizedComment[];
  /** True when `comments` is known to be a partial list for this post. */
  commentsTruncated?: boolean;
}

/** Normalized answer for thread output. */
export interface NormalizedAnswer extends CommentState {
  answerId: number;
  authorLink?: string;
  authorName?: string;
  authorReputation?: number;
  authorUserId?: number;
  bodyMarkdown: string;
  /** ISO 8601 timestamp of when the answer was posted. */
  creationDate?: string;
  isAccepted: boolean;
  /** ISO 8601 timestamp of the answer's most recent activity. */
  lastActivityDate?: string;
  score: number;
}

/** Normalized thread for tool output. */
export interface NormalizedThread extends CommentState {
  acceptedAnswerId?: number;
  answerCount: number;
  answers: NormalizedAnswer[];
  authorLink?: string;
  authorName?: string;
  authorUserId?: number;
  bodyMarkdown: string;
  /** ISO 8601 timestamp of when the question was asked. */
  creationDate?: string;
  /** ISO 8601 timestamp of the question's most recent activity. */
  lastActivityDate?: string;
  link: string;
  questionId: number;
  score: number;
  tags: string[];
  title: string;
}

/** Normalized user profile for tool output. */
export interface NormalizedUser {
  answerCount?: number;
  badgeCounts?: { gold?: number; silver?: number; bronze?: number };
  /** ISO 8601 timestamp of when the account was created. */
  creationDate?: string;
  displayName: string;
  /** ISO 8601 timestamp of the user's most recent site access. */
  lastAccessDate?: string;
  link: string;
  location?: string;
  questionCount?: number;
  reputation: number;
  topTags: { tagName: string; answerCount?: number; answerScore?: number }[];
  userId: number;
  websiteUrl?: string;
}

/** Normalized site for tool output. */
export interface NormalizedSite {
  apiSiteParameter: string;
  audience?: string;
  name: string;
  siteUrl: string;
}

/**
 * Map a raw SE question onto the normalized shape shared by search and tag FAQ.
 *
 * Only /search/advanced carries a body — /tags/{tag}/faq keeps SE's default
 * filter — so the excerpt is derived when one is present and left absent when
 * it is not, rather than assumed.
 */
function normalizeQuestion(q: SeQuestion): NormalizedQuestion {
  const excerpt = q.body_markdown
    ? deriveExcerpt(q.body_markdown)
    : q.excerpt
      ? decodeHtmlEntities(q.excerpt)
      : undefined;

  return {
    questionId: q.question_id,
    title: decodeHtmlEntities(q.title),
    link: q.link,
    score: q.score,
    answerCount: q.answer_count,
    isAnswered: q.is_answered,
    tags: q.tags,
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(q.creation_date !== undefined ? { creationDate: toIsoDate(q.creation_date) } : {}),
    ...(q.last_activity_date !== undefined
      ? { lastActivityDate: toIsoDate(q.last_activity_date) }
      : {}),
  };
}

/**
 * Map a raw SE comment onto the normalized shape.
 *
 * The body arrives as entity-encoded HTML — the comment type has no
 * `body_markdown` counterpart to the post types' — so it takes the same
 * `normalizeHtml` pass. Comments carry inline markup only (`<code>`, `<a>`,
 * `<b>`), which that pipeline already covers.
 */
function normalizeComment(c: SeComment): NormalizedComment {
  return {
    commentId: c.comment_id,
    score: c.score,
    bodyMarkdown: normalizeHtml(c.body ?? ''),
    ...(c.owner?.display_name ? { authorName: decodeHtmlEntities(c.owner.display_name) } : {}),
    ...(c.owner?.link ? { authorLink: c.owner.link } : {}),
    ...(c.creation_date !== undefined ? { creationDate: toIsoDate(c.creation_date) } : {}),
  };
}

/**
 * Reduce one post's share of a comment page to its capped, normalized list.
 *
 * `pageHasMore` is the fetch's own `has_more`. SE orders a page newest-first
 * across every post it covers rather than grouping by post, so once the page is
 * cut short no post in it can be shown to be complete — hence a post that did
 * receive comments is still reported truncated.
 */
function takeComments(items: SeComment[], pageHasMore: boolean): CommentState {
  const truncated = items.length > MAX_COMMENTS_PER_POST || pageHasMore;
  return {
    comments: items.slice(0, MAX_COMMENTS_PER_POST).map(normalizeComment),
    ...(truncated ? { commentsTruncated: true } : {}),
  };
}

export class StackExchangeService {
  private readonly apiKey: string | undefined;
  private backoffUntil = 0;
  private readonly pacer = createPacer({
    name: 'stackexchange',
    maxConcurrent: 1,
    cooldown: { baseMs: 1000, maxMs: 30_000 },
  });

  constructor(_config: AppConfig, _storage: StorageService, apiKey?: string) {
    this.apiKey = apiKey;
  }

  /** Reject queued requests during application shutdown. */
  dispose(): void {
    this.pacer.dispose();
  }

  /** Build a URL with common params (key, gzip). */
  private buildUrl(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${BASE_URL}${path}`);
    // SE API always returns gzip — accept it explicitly
    // (fetch auto-decompresses with Accept-Encoding: gzip)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
    if (this.apiKey) {
      url.searchParams.set('key', this.apiKey);
    }
    return url.toString();
  }

  /**
   * Fetch, decompress (auto), parse, handle errors. `badParameter` maps a
   * non-site `bad_parameter` rejection onto the calling tool's own contract.
   */
  private fetchSe<T>(
    url: string,
    ctx: Context,
    signal: AbortSignal,
    badParameter: BadParameterMapping = invalidParameter,
  ): Promise<SeWrapper<T>> {
    return this.pacer.run(
      async () => {
        const waitMs = this.backoffUntil - Date.now();
        if (waitMs > 0) await sleep(waitMs, undefined, { signal });
        return this.fetchEnvelope<T>(url, ctx, signal, badParameter);
      },
      { signal },
    );
  }

  /** Hold the pacer slot until the body has updated the shared backoff window. */
  private async fetchEnvelope<T>(
    url: string,
    ctx: Context,
    signal: AbortSignal,
    badParameter: BadParameterMapping,
  ): Promise<SeWrapper<T>> {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, ctx, {
        headers: {
          'Accept-Encoding': 'gzip',
          Accept: 'application/json',
        },
        signal,
        expectedStatuses: [400],
      });
    } catch (error) {
      // SE returns HTTP 400 with a JSON error envelope for bad parameters.
      if (
        error instanceof McpError &&
        error.data?.status === 400 &&
        typeof error.data.body === 'string'
      ) {
        let errObj: SeError | undefined;
        try {
          errObj = JSON.parse(error.data.body) as SeError;
        } catch {
          // Preserve the framework-classified HTTP error when the body is not JSON.
        }
        // Paging past the keyless depth ceiling. SE answers HTTP 400 — the same
        // status `bad_parameter` uses — with `error_name: access_denied` and an
        // `error_id` of 403 in the envelope, so the status cannot separate the
        // two and `error_name` is what classifies. Scoped to the message SE
        // sends for the page wall: a revoked or missing key answers
        // `access_denied` too, and needs a different remedy.
        if (errObj?.error_name === 'access_denied' && /\bpage\b/i.test(errObj.error_message)) {
          throw forbidden(`Stack Exchange refused the request: ${errObj.error_message}`, {
            reason: 'paging_depth_limit',
            ...ctx.recoveryFor('paging_depth_limit'),
            error_name: errObj.error_name,
            error_id: errObj.error_id,
          });
        }
        if (errObj?.error_name === 'bad_parameter') {
          // The configured key, not anything the caller sent. Classified ahead
          // of the site case and the caller's mapping, both of which would
          // report a deployment fault as a caller input problem. The message is
          // fixed rather than built from SE's prose or the configured value —
          // the key must never reach the wire, and the reason exists to tell an
          // operator their deployment is misconfigured.
          if (UNRECOGNIZED_KEY_MESSAGE.test(errObj.error_message)) {
            throw configurationError(
              'Stack Exchange did not recognize the API key this server is configured with — STACKEXCHANGE_API_KEY is not a registered Stack Apps key.',
              {
                reason: 'invalid_api_key',
                ...ctx.recoveryFor('invalid_api_key'),
                error_name: errObj.error_name,
                error_id: errObj.error_id,
              },
            );
          }
          // SE answers an unknown site with prose ("No site found for name `x`")
          // and every other rejection with the bare name of the field it refused
          // ("ids", "pagesize", "tagged"). Only the first is a site problem;
          // the rest go to the caller's mapping so the reported field and the
          // contract reason belong to the tool that was actually called.
          const detail = errObj.error_message;
          const { reason, message } =
            detail === 'site' || /^no site found/i.test(detail)
              ? { reason: 'invalid_site', message: `Stack Exchange API error: ${detail}` }
              : badParameter(detail);
          throw validationError(message, {
            reason,
            ...ctx.recoveryFor(reason),
            error_name: errObj.error_name,
            error_id: errObj.error_id,
          });
        }
      }
      throw error;
    }

    const text = await response.text();

    let wrapper: SeWrapper<T>;
    try {
      wrapper = JSON.parse(text) as SeWrapper<T>;
    } catch (err) {
      throw serviceUnavailable(
        'Failed to parse Stack Exchange response',
        { reason: 'upstream_unavailable', ...ctx.recoveryFor('upstream_unavailable') },
        { cause: err },
      );
    }

    if (wrapper.backoff && wrapper.backoff > 0) {
      this.backoffUntil = Math.max(this.backoffUntil, Date.now() + wrapper.backoff * 1000);
    }

    ctx.log.debug('SE quota', {
      quota_remaining: wrapper.quota_remaining,
      quota_max: wrapper.quota_max,
    });

    return wrapper;
  }

  /** Search questions (no bodies). */
  searchQuestions(
    opts: SearchQuestionsOptions,
    ctx: Context,
  ): Promise<{
    questions: NormalizedQuestion[];
    quotaRemaining: number;
    quotaMax: number;
    hasMore: boolean;
  }> {
    return withRetry(
      async ({ signal }) => {
        /**
         * Resolve one effective SE sort. SE `min` constrains the current sort
         * field (not score), so a minScore filter forces `votes` — its only
         * score-sorted mode; otherwise it errors under `relevance` or filters by
         * date under `activity`. Without minScore, the `newest` facade maps to
         * SE's `creation` (SE accepts only activity|creation|votes|relevance);
         * every other value passes through 1:1.
         */
        const requestedSort = opts.sort ?? 'relevance';
        const sort =
          opts.minScore !== undefined
            ? 'votes'
            : requestedSort === 'newest'
              ? 'creation'
              : requestedSort;

        const params: Record<string, string | number | boolean | undefined> = {
          site: opts.site,
          q: opts.query,
          sort,
          pagesize: opts.pageSize ?? 10,
          page: opts.page,
          filter: SE_SEARCH_FILTER,
        };
        if (opts.tags && opts.tags.length > 0) {
          params.tagged = opts.tags.join(';');
        }
        if (opts.acceptedOnly) {
          params.accepted = 'True';
        }
        if (opts.minScore !== undefined) {
          params.min = opts.minScore;
        }

        const url = this.buildUrl('/search/advanced', params);
        const wrapper = await this.fetchSe<SeQuestion>(url, ctx, signal);

        assertQuotaRemaining(wrapper, ctx);

        const questions: NormalizedQuestion[] = wrapper.items.map(normalizeQuestion);

        return {
          questions,
          quotaRemaining: wrapper.quota_remaining,
          quotaMax: wrapper.quota_max,
          hasMore: wrapper.has_more,
        };
      },
      {
        operation: 'searchQuestions',
        deadlineMs: OPERATION_DEADLINE_MS,
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch a complete Q&A thread with HTML→markdown normalization. */
  getThread(
    opts: GetThreadOptions,
    ctx: Context,
  ): Promise<{
    thread: NormalizedThread;
    quotaRemaining: number;
    quotaMax: number;
  }> {
    return withRetry(
      async ({ signal }) => {
        const questionUrl = this.buildUrl(`/questions/${opts.questionId}`, {
          site: opts.site,
          filter: 'withbody',
        });
        const answersUrl = this.buildUrl(`/questions/${opts.questionId}/answers`, {
          site: opts.site,
          filter: 'withbody',
          sort: 'votes',
          pagesize: opts.maxAnswers ?? 10,
        });

        const questionWrapper = await this.fetchSe<SeQuestion>(
          questionUrl,
          ctx,
          signal,
          questionIdOrParameter,
        );
        const answersWrapper = await this.fetchSe<SeAnswer>(
          answersUrl,
          ctx,
          signal,
          questionIdOrParameter,
        );

        assertQuotaRemaining(questionWrapper, ctx);

        const q = questionWrapper.items[0];
        if (!q) {
          throw notFound(`Question ID ${opts.questionId} not found on site "${opts.site}".`, {
            reason: 'question_not_found',
            ...ctx.recoveryFor('question_not_found'),
            questionId: opts.questionId,
            site: opts.site,
          });
        }

        // The answers page is sorted by votes, so an accepted answer ranked below
        // the top-maxAnswers is never in it. Pull it explicitly and merge it in —
        // one extra call, only in the miss case — so the thread never reports an
        // acceptedAnswerId whose body is absent from answers[].
        const answerItems = answersWrapper.items.slice();
        if (
          q.accepted_answer_id !== undefined &&
          !answerItems.some((a) => a.answer_id === q.accepted_answer_id)
        ) {
          const acceptedUrl = this.buildUrl(`/answers/${q.accepted_answer_id}`, {
            site: opts.site,
            filter: 'withbody',
          });
          // Default mapping, not questionIdOrParameter: `ids` on /answers/{id}
          // is the answer ID SE itself reported, never the caller's input.
          const acceptedWrapper = await this.fetchSe<SeAnswer>(acceptedUrl, ctx, signal);
          const acceptedAnswer = acceptedWrapper.items[0];
          if (acceptedAnswer) {
            answerItems.push(acceptedAnswer);
          }
        }

        // Sort answers: accepted first, then by score descending
        const answers = answerItems.sort((a, b) => {
          const aAccepted = a.answer_id === q.accepted_answer_id ? 1 : 0;
          const bAccepted = b.answer_id === q.accepted_answer_id ? 1 : 0;
          if (aAccepted !== bAccepted) return bAccepted - aAccepted;
          return b.score - a.score;
        });

        // Comments, when asked for: exactly two more calls, whatever the answer
        // count — `/answers/{ids}/comments` batches every fetched answer into one
        // semicolon-delimited request. Deferred until after the accepted-answer
        // merge so a merged answer's comments ride the same batch, and skipped
        // entirely on the not-found path above.
        let questionComments: CommentState = {};
        const answerComments = new Map<number, CommentState>();

        if (opts.includeComments) {
          const commentParams = {
            site: opts.site,
            filter: 'withbody',
            // SE's own default order. Newest-first is what surfaces the
            // corrections that make an old answer stale; sorting by votes would
            // resurface the oldest high-vote comments instead.
            sort: 'creation',
            order: 'desc',
            pagesize: COMMENTS_PAGE_SIZE,
          };
          const questionCommentsUrl = this.buildUrl(
            `/questions/${opts.questionId}/comments`,
            commentParams,
          );
          // No answers means no `/answers/{ids}/comments` route to call at all.
          const answerIds = answers.map((a) => a.answer_id);
          const answerCommentsUrl =
            answerIds.length > 0
              ? this.buildUrl(`/answers/${answerIds.join(';')}/comments`, commentParams)
              : undefined;

          const questionCommentsWrapper = await this.fetchSe<SeComment>(
            questionCommentsUrl,
            ctx,
            signal,
            questionIdOrParameter,
          );
          // Answer IDs came from SE; they are not the caller's question ID.
          const answerCommentsWrapper = answerCommentsUrl
            ? await this.fetchSe<SeComment>(answerCommentsUrl, ctx, signal)
            : undefined;

          questionComments = takeComments(
            questionCommentsWrapper.items,
            questionCommentsWrapper.has_more,
          );

          if (answerCommentsWrapper) {
            // Keyed on post_id: the combined page is ordered across posts, so
            // request order says nothing about which answer a comment belongs to.
            const grouped = Map.groupBy(answerCommentsWrapper.items, (c) => c.post_id);
            for (const answerId of answerIds) {
              const own = grouped.get(answerId);
              if (own) {
                answerComments.set(answerId, takeComments(own, answerCommentsWrapper.has_more));
                continue;
              }
              // Absent from the page. Only a page SE reported complete proves
              // the post has none; with more pending, its state is unknown and
              // stays absent rather than becoming an empty list.
              answerComments.set(answerId, answerCommentsWrapper.has_more ? {} : { comments: [] });
            }
          }
        }

        const normalizedAnswers: NormalizedAnswer[] = answers.map((a) => ({
          answerId: a.answer_id,
          score: a.score,
          isAccepted: a.is_accepted,
          bodyMarkdown: normalizeHtml(a.body ?? ''),
          ...answerComments.get(a.answer_id),
          ...(a.owner?.display_name
            ? { authorName: decodeHtmlEntities(a.owner.display_name) }
            : {}),
          ...(a.owner?.link ? { authorLink: a.owner.link } : {}),
          ...(a.owner?.reputation !== undefined ? { authorReputation: a.owner.reputation } : {}),
          ...(a.owner?.user_id !== undefined ? { authorUserId: a.owner.user_id } : {}),
          ...(a.creation_date !== undefined ? { creationDate: toIsoDate(a.creation_date) } : {}),
          ...(a.last_activity_date !== undefined
            ? { lastActivityDate: toIsoDate(a.last_activity_date) }
            : {}),
        }));

        const thread: NormalizedThread = {
          questionId: q.question_id,
          title: decodeHtmlEntities(q.title),
          link: q.link,
          score: q.score,
          tags: q.tags,
          bodyMarkdown: normalizeHtml(q.body ?? ''),
          ...(q.owner?.display_name
            ? { authorName: decodeHtmlEntities(q.owner.display_name) }
            : {}),
          ...(q.owner?.link ? { authorLink: q.owner.link } : {}),
          ...(q.owner?.user_id !== undefined ? { authorUserId: q.owner.user_id } : {}),
          answerCount: q.answer_count,
          answers: normalizedAnswers,
          ...questionComments,
          ...(q.accepted_answer_id !== undefined ? { acceptedAnswerId: q.accepted_answer_id } : {}),
          ...(q.creation_date !== undefined ? { creationDate: toIsoDate(q.creation_date) } : {}),
          ...(q.last_activity_date !== undefined
            ? { lastActivityDate: toIsoDate(q.last_activity_date) }
            : {}),
        };

        return {
          thread,
          quotaRemaining: questionWrapper.quota_remaining,
          quotaMax: questionWrapper.quota_max,
        };
      },
      {
        operation: 'getThread',
        deadlineMs: OPERATION_DEADLINE_MS,
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch the tag FAQ (highest-voted answered questions for a tag). */
  getTagFaq(
    opts: GetTagFaqOptions,
    ctx: Context,
  ): Promise<{
    questions: NormalizedQuestion[];
    quotaRemaining: number;
    quotaMax: number;
    hasMore: boolean;
  }> {
    return withRetry(
      async ({ signal }) => {
        const url = this.buildUrl(`/tags/${encodeURIComponent(opts.tag)}/faq`, {
          site: opts.site,
          pagesize: opts.pageSize ?? 10,
          page: opts.page,
        });
        const wrapper = await this.fetchSe<SeQuestion>(url, ctx, signal);

        assertQuotaRemaining(wrapper, ctx);

        const questions: NormalizedQuestion[] = wrapper.items.map(normalizeQuestion);

        return {
          questions,
          quotaRemaining: wrapper.quota_remaining,
          quotaMax: wrapper.quota_max,
          hasMore: wrapper.has_more,
        };
      },
      {
        operation: 'getTagFaq',
        deadlineMs: OPERATION_DEADLINE_MS,
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch a user profile + top tags. */
  getUser(
    opts: GetUserOptions,
    ctx: Context,
  ): Promise<{
    user: NormalizedUser;
    quotaRemaining: number;
    quotaMax: number;
  }> {
    return withRetry(
      async ({ signal }) => {
        const profileUrl = this.buildUrl(`/users/${opts.userId}`, {
          site: opts.site,
          filter: SE_USER_FILTER,
        });
        const topTagsUrl = this.buildUrl(`/users/${opts.userId}/top-tags`, {
          site: opts.site,
          pagesize: 10,
        });

        const profileWrapper = await this.fetchSe<SeUser>(profileUrl, ctx, signal);
        const topTagsWrapper = await this.fetchSe<SeTopTag>(topTagsUrl, ctx, signal);

        assertQuotaRemaining(profileWrapper, ctx);

        const u = profileWrapper.items[0];
        if (!u) {
          throw notFound(`User ID ${opts.userId} not found on site "${opts.site}".`, {
            reason: 'user_not_found',
            ...ctx.recoveryFor('user_not_found'),
            userId: opts.userId,
            site: opts.site,
          });
        }
        const topTags = topTagsWrapper.items.map((t) => ({
          tagName: t.tag_name,
          ...(t.answer_count !== undefined ? { answerCount: t.answer_count } : {}),
          ...(t.answer_score !== undefined ? { answerScore: t.answer_score } : {}),
        }));

        const user: NormalizedUser = {
          userId: u.user_id,
          displayName: decodeHtmlEntities(u.display_name),
          link: u.link,
          reputation: u.reputation,
          ...(u.badge_counts ? { badgeCounts: u.badge_counts } : {}),
          ...(u.location ? { location: decodeHtmlEntities(u.location) } : {}),
          ...(u.website_url ? { websiteUrl: u.website_url } : {}),
          topTags,
          ...(u.answer_count !== undefined ? { answerCount: u.answer_count } : {}),
          ...(u.question_count !== undefined ? { questionCount: u.question_count } : {}),
          ...(u.creation_date !== undefined ? { creationDate: toIsoDate(u.creation_date) } : {}),
          ...(u.last_access_date !== undefined
            ? { lastAccessDate: toIsoDate(u.last_access_date) }
            : {}),
        };

        return {
          user,
          quotaRemaining: profileWrapper.quota_remaining,
          quotaMax: profileWrapper.quota_max,
        };
      },
      {
        operation: 'getUser',
        deadlineMs: OPERATION_DEADLINE_MS,
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch every site in the SE network, walking pages while `has_more` is set.
   * The walk stops at MAX_SITE_PAGES; `truncated` reports whether SE still had
   * more to give when it stopped.
   */
  getSites(ctx: Context): Promise<{
    sites: NormalizedSite[];
    quotaRemaining: number;
    quotaMax: number;
    truncated: boolean;
  }> {
    return withRetry(
      async ({ signal }) => {
        // SE API returns site names and audiences HTML-encoded (e.g. "Unix &amp; Linux")
        const normalizeSite = (s: SeSite): NormalizedSite => ({
          name: decodeHtmlEntities(s.name),
          apiSiteParameter: s.api_site_parameter,
          siteUrl: s.site_url,
          ...(s.audience ? { audience: decodeHtmlEntities(s.audience) } : {}),
        });

        /**
         * One page of the walk. The quota check sits here rather than on the
         * result: this is the only method that loops, so an exhausted quota
         * discovered on page 1 would otherwise be followed by up to nine more
         * requests that cannot succeed. Checking every page matches what the
         * single-request methods do with their one response.
         */
        const fetchPage = async (page: number) => {
          const wrapper = await this.fetchSe<SeSite>(
            this.buildUrl('/sites', { pagesize: SITES_PAGE_SIZE, page }),
            ctx,
            signal,
          );
          assertQuotaRemaining(wrapper, ctx);
          return wrapper;
        };

        let wrapper = await fetchPage(1);
        const sites: NormalizedSite[] = wrapper.items.map(normalizeSite);

        for (let page = 2; wrapper.has_more && page <= MAX_SITE_PAGES; page++) {
          wrapper = await fetchPage(page);
          sites.push(...wrapper.items.map(normalizeSite));
        }

        return {
          sites,
          quotaRemaining: wrapper.quota_remaining,
          quotaMax: wrapper.quota_max,
          truncated: wrapper.has_more,
        };
      },
      {
        operation: 'getSites',
        deadlineMs: OPERATION_DEADLINE_MS,
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }
}

// --- Init/accessor pattern ---

let _service: StackExchangeService | undefined;

export function initStackExchangeService(
  config: AppConfig,
  storage: StorageService,
  apiKey?: string,
): void {
  _service = new StackExchangeService(config, storage, apiKey);
}

export function getStackExchangeService(): StackExchangeService {
  if (!_service) {
    throw new Error(
      'StackExchangeService not initialized — call initStackExchangeService() in setup()',
    );
  }
  return _service;
}
