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
  excerpt?: string;
  isAnswered: boolean;
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
  isAccepted: boolean;
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
  displayName: string;
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

  /** Fetch, decompress (auto), parse, handle errors. */
  private async fetchSe<T>(url: string, ctx: Context): Promise<SeWrapper<T>> {
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
          // SE returns error_message "ids" when the IDs field is rejected (e.g. out-of-range integer).
          // All other bad_parameter responses (site, tags, etc.) map to invalid_site.
          const reason = errObj.error_message === 'ids' ? 'invalid_id_or_url' : 'invalid_site';
          const message =
            reason === 'invalid_id_or_url'
              ? 'The question ID is not a valid Stack Exchange question ID.'
              : `Stack Exchange API error: ${errObj.error_message}`;
          throw validationError(message, {
            reason,
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

        if (wrapper.quota_remaining === 0) {
          throw rateLimited('Stack Exchange API quota exhausted.', {
            reason: 'quota_exceeded',
            quota_remaining: 0,
            quota_max: wrapper.quota_max,
          });
        }

        const questions: NormalizedQuestion[] = wrapper.items.map((q) => ({
          questionId: q.question_id,
          title: decodeHtmlEntities(q.title),
          link: q.link,
          score: q.score,
          answerCount: q.answer_count,
          isAnswered: q.is_answered,
          tags: q.tags,
          ...(q.excerpt ? { excerpt: decodeHtmlEntities(q.excerpt) } : {}),
        }));

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
          this.fetchSe<SeQuestion>(questionUrl, ctx),
          this.fetchSe<SeAnswer>(answersUrl, ctx),
        ]);

        if (questionWrapper.quota_remaining === 0) {
          throw rateLimited('Stack Exchange API quota exhausted.', {
            reason: 'quota_exceeded',
            quota_remaining: 0,
            quota_max: questionWrapper.quota_max,
          });
        }

        const q = questionWrapper.items[0];
        if (!q) {
          throw notFound(`Question ID ${opts.questionId} not found on site "${opts.site}".`, {
            reason: 'question_not_found',
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

        if (wrapper.quota_remaining === 0) {
          throw rateLimited('Stack Exchange API quota exhausted.', {
            reason: 'quota_exceeded',
            quota_remaining: 0,
            quota_max: wrapper.quota_max,
          });
        }

        const questions: NormalizedQuestion[] = wrapper.items.map((q) => ({
          questionId: q.question_id,
          title: decodeHtmlEntities(q.title),
          link: q.link,
          score: q.score,
          answerCount: q.answer_count,
          isAnswered: q.is_answered,
          tags: q.tags,
        }));

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
        const profileUrl = this.buildUrl(`/users/${opts.userId}`, { site: opts.site });
        const topTagsUrl = this.buildUrl(`/users/${opts.userId}/top-tags`, {
          site: opts.site,
          pagesize: 10,
        });

        const [profileWrapper, topTagsWrapper] = await Promise.all([
          this.fetchSe<SeUser>(profileUrl, ctx),
          this.fetchSe<SeTopTag>(topTagsUrl, ctx),
        ]);

        if (profileWrapper.quota_remaining === 0) {
          throw rateLimited('Stack Exchange API quota exhausted.', {
            reason: 'quota_exceeded',
            quota_remaining: 0,
            quota_max: profileWrapper.quota_max,
          });
        }

        const u = profileWrapper.items[0];
        if (!u) {
          throw notFound(`User ID ${opts.userId} not found on site "${opts.site}".`, {
            reason: 'user_not_found',
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

  /** Fetch all sites in the SE network (paginated, bounded set). */
  getSites(ctx: Context): Promise<{
    sites: NormalizedSite[];
    quotaRemaining: number;
    quotaMax: number;
  }> {
    return withRetry(
      async () => {
        const url = this.buildUrl('/sites', { pagesize: 100 });
        const wrapper = await this.fetchSe<SeSite>(url, ctx);

        // SE API returns site names and audiences HTML-encoded (e.g. "Unix &amp; Linux")
        const normalizeSite = (s: SeSite): NormalizedSite => ({
          name: decodeHtmlEntities(s.name),
          apiSiteParameter: s.api_site_parameter,
          siteUrl: s.site_url,
          ...(s.audience ? { audience: decodeHtmlEntities(s.audience) } : {}),
        });

        const sites: NormalizedSite[] = wrapper.items.map(normalizeSite);

        // If there are more pages, fetch them (SE has ~190 sites, fits in 2 pages at pagesize=100)
        if (wrapper.has_more) {
          const page2Url = this.buildUrl('/sites', { pagesize: 100, page: 2 });
          const wrapper2 = await this.fetchSe<SeSite>(page2Url, ctx);
          sites.push(...wrapper2.items.map(normalizeSite));
        }

        return { sites, quotaRemaining: wrapper.quota_remaining, quotaMax: wrapper.quota_max };
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
