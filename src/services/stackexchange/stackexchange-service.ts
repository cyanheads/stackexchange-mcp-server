/**
 * @fileoverview Stack Exchange API v2.3 HTTP client with backoff tracking,
 * quota logging, gzip decompression, and typed domain methods.
 * @module services/stackexchange/stackexchange-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { decodeHtmlEntities, normalizeHtml } from './html-normalizer.js';
import type {
  SeAnswer,
  SeError,
  SeQuestion,
  SeSite,
  SeTopTag,
  SeUser,
  SeWrapper,
} from './types.js';

const BASE_URL = 'https://api.stackexchange.com/2.3';
const REQUEST_TIMEOUT_MS = 30_000;

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

/** Convert SE's Unix epoch seconds to an ISO 8601 string. */
function toIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

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

/** Module-level backoff tracking — per-process, acceptable for server-side use. */
let backoffUntil = 0;

/** Honour the SE `backoff` field before the next request. */
async function waitForBackoff(): Promise<void> {
  const now = Date.now();
  if (now < backoffUntil) {
    await new Promise<void>((resolve) => setTimeout(resolve, backoffUntil - now));
  }
}

/** Update the backoff window from a response envelope. */
function updateBackoff(wrapper: { backoff?: number }): void {
  if (wrapper.backoff && wrapper.backoff > 0) {
    backoffUntil = Date.now() + wrapper.backoff * 1000;
  }
}

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

/** Normalized answer for thread output. */
export interface NormalizedAnswer {
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
export interface NormalizedThread {
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

/** Map a raw SE question onto the normalized shape shared by search and tag FAQ. */
function normalizeQuestion(q: SeQuestion): NormalizedQuestion {
  return {
    questionId: q.question_id,
    title: decodeHtmlEntities(q.title),
    link: q.link,
    score: q.score,
    answerCount: q.answer_count,
    isAnswered: q.is_answered,
    tags: q.tags,
    ...(q.excerpt ? { excerpt: decodeHtmlEntities(q.excerpt) } : {}),
    ...(q.creation_date !== undefined ? { creationDate: toIsoDate(q.creation_date) } : {}),
    ...(q.last_activity_date !== undefined
      ? { lastActivityDate: toIsoDate(q.last_activity_date) }
      : {}),
  };
}

export class StackExchangeService {
  private readonly apiKey: string | undefined;

  constructor(_config: AppConfig, _storage: StorageService, apiKey?: string) {
    this.apiKey = apiKey;
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
  private async fetchSe<T>(
    url: string,
    ctx: Context,
    badParameter: BadParameterMapping = invalidParameter,
  ): Promise<SeWrapper<T>> {
    await waitForBackoff();

    let response: Response;
    try {
      response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, ctx, {
        headers: {
          'Accept-Encoding': 'gzip',
          Accept: 'application/json',
        },
        signal: ctx.signal,
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
        if (errObj?.error_name === 'bad_parameter') {
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
      throw serviceUnavailable('Failed to parse Stack Exchange response', {}, { cause: err });
    }

    updateBackoff(wrapper);

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
      async () => {
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
        const wrapper = await this.fetchSe<SeQuestion>(url, ctx);

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
      async () => {
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

        const [questionWrapper, answersWrapper] = await Promise.all([
          this.fetchSe<SeQuestion>(questionUrl, ctx, questionIdOrParameter),
          this.fetchSe<SeAnswer>(answersUrl, ctx, questionIdOrParameter),
        ]);

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
          const acceptedWrapper = await this.fetchSe<SeAnswer>(acceptedUrl, ctx);
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

        const normalizedAnswers: NormalizedAnswer[] = answers.map((a) => ({
          answerId: a.answer_id,
          score: a.score,
          isAccepted: a.is_accepted,
          bodyMarkdown: normalizeHtml(a.body ?? ''),
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
      async () => {
        const url = this.buildUrl(`/tags/${encodeURIComponent(opts.tag)}/faq`, {
          site: opts.site,
          pagesize: opts.pageSize ?? 10,
        });
        const wrapper = await this.fetchSe<SeQuestion>(url, ctx);

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
      async () => {
        const profileUrl = this.buildUrl(`/users/${opts.userId}`, {
          site: opts.site,
          filter: SE_USER_FILTER,
        });
        const topTagsUrl = this.buildUrl(`/users/${opts.userId}/top-tags`, {
          site: opts.site,
          pagesize: 10,
        });

        const [profileWrapper, topTagsWrapper] = await Promise.all([
          this.fetchSe<SeUser>(profileUrl, ctx),
          this.fetchSe<SeTopTag>(topTagsUrl, ctx),
        ]);

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
      async () => {
        // SE API returns site names and audiences HTML-encoded (e.g. "Unix &amp; Linux")
        const normalizeSite = (s: SeSite): NormalizedSite => ({
          name: decodeHtmlEntities(s.name),
          apiSiteParameter: s.api_site_parameter,
          siteUrl: s.site_url,
          ...(s.audience ? { audience: decodeHtmlEntities(s.audience) } : {}),
        });

        const fetchPage = (page: number) =>
          this.fetchSe<SeSite>(this.buildUrl('/sites', { pagesize: SITES_PAGE_SIZE, page }), ctx);

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
