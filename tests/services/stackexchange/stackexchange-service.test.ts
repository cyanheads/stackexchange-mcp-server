/**
 * @fileoverview Service-layer tests for StackExchangeService entity decoding.
 * The tool tests mock getStackExchangeService wholesale with pre-normalized
 * fixtures, so they cannot catch a decode regression inside getThread/getUser.
 * These exercise the real service methods against a mocked fetch returning raw,
 * entity-encoded upstream payloads.
 * @module tests/services/stackexchange/stackexchange-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SearchQuestionsOptions,
  StackExchangeService,
} from '@/services/stackexchange/stackexchange-service.js';

/**
 * The constructor retains only apiKey — config/storage are unused — so minimal
 * stand-ins suffice to exercise the domain methods.
 */
const makeService = () => new StackExchangeService({} as AppConfig, {} as StorageService);

/** A 200 OK Response whose body is the given SE wrapper serialized to JSON. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

/**
 * SE's `bad_parameter` rejection: HTTP 400 with a JSON error envelope.
 * `errorMessage` is either prose naming an unknown site or the bare name of the
 * field SE refused — both wordings reproduced live against api.stackexchange.com.
 */
const badParameterResponse = (errorMessage: string): Response =>
  new Response(
    JSON.stringify({ error_id: 400, error_message: errorMessage, error_name: 'bad_parameter' }),
    { status: 400 },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StackExchangeService entity decoding', () => {
  it('getUser decodes HTML entities in displayName and location', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/top-tags')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 });
      }
      return jsonResponse({
        items: [
          {
            user_id: 1946,
            display_name: 'Tom &amp; Jerry',
            link: 'https://stackoverflow.com/users/1946',
            reputation: 5000,
            location: 'S&#227;o Paulo',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const svc = makeService();
    const { user } = await svc.getUser(
      { site: 'stackoverflow', userId: 1946 },
      createMockContext(),
    );

    expect(user.displayName).toBe('Tom & Jerry');
    expect(user.location).toBe('São Paulo');
  });

  it('getThread decodes HTML entities in question and answer author names', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: 2,
              question_id: 1,
              score: 10,
              is_accepted: true,
              body: '<p>Answer body.</p>',
              owner: { display_name: 'Fl&#225;vio Amieiro', user_id: 20 },
            },
          ],
          has_more: false,
          quota_remaining: 100,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: 1,
            title: 'A question',
            link: 'https://stackoverflow.com/q/1',
            score: 5,
            answer_count: 1,
            is_answered: true,
            tags: ['c'],
            body: '<p>Question body.</p>',
            owner: { display_name: 'Jesper R&#248;nn-Jensen', user_id: 10 },
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const svc = makeService();
    const { thread } = await svc.getThread(
      { site: 'stackoverflow', questionId: 1 },
      createMockContext(),
    );

    expect(thread.authorName).toBe('Jesper Rønn-Jensen');
    expect(thread.answers[0]?.authorName).toBe('Flávio Amieiro');
  });
});

describe('StackExchangeService body normalization', () => {
  it('normalizes table, nested list, and escaped-bracket bodies into structuredContent markdown', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: 2,
              question_id: 1,
              score: 10,
              is_accepted: true,
              body: '<div class="s-table-container"><table class="s-table"><thead><tr><th>Method</th><th>Time</th></tr></thead><tbody><tr><td>sorted</td><td>1.93s</td></tr></tbody></table></div>',
            },
          ],
          has_more: false,
          quota_remaining: 100,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: 1,
            title: 'Why use a &lt;div&gt;?',
            link: 'https://stackoverflow.com/q/1',
            score: 5,
            answer_count: 1,
            is_answered: true,
            tags: ['html'],
            body: '<p>Use the &lt;div&gt; element.</p><ul><li>outer<ul><li>inner</li></ul></li></ul>',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: 1 },
      createMockContext(),
    );

    expect(thread.title).toBe('Why use a <div>?');
    expect(thread.bodyMarkdown).toContain('Use the <div> element.');
    expect(thread.bodyMarkdown).toContain('- outer\n  - inner');
    expect(thread.answers[0]?.bodyMarkdown).toBe(
      '| Method | Time |\n| --- | --- |\n| sorted | 1.93s |',
    );
  });
});

describe('StackExchangeService.searchQuestions sort/min mapping', () => {
  /** A 200 OK /search/advanced wrapper with no items and non-zero quota. */
  const searchWrapper = { items: [], has_more: false, quota_remaining: 100, quota_max: 300 };

  /** Run searchQuestions against a mocked fetch and return the outgoing request URL. */
  const captureSearchUrl = async (opts: SearchQuestionsOptions): Promise<URL> => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(searchWrapper));
    await makeService().searchQuestions(opts, createMockContext());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return new URL(String(fetchSpy.mock.calls[0]![0]));
  };

  it("translates the 'newest' facade to SE's 'creation' sort", async () => {
    const url = await captureSearchUrl({ query: 'q', site: 'stackoverflow', sort: 'newest' });
    expect(url.searchParams.get('sort')).toBe('creation');
    expect(url.searchParams.get('min')).toBeNull();
  });

  it('forces sort=votes with min when minScore is set under the default relevance sort', async () => {
    // Pre-fix this sent sort=relevance, which SE rejects with `bad_parameter: min`.
    const url = await captureSearchUrl({
      query: 'q',
      site: 'stackoverflow',
      sort: 'relevance',
      minScore: 100000,
    });
    expect(url.searchParams.get('sort')).toBe('votes');
    expect(url.searchParams.get('min')).toBe('100000');
  });

  it('forces sort=votes when minScore is set under an explicit activity sort', async () => {
    // Pre-fix this sent sort=activity, so `min` filtered by date instead of score.
    const url = await captureSearchUrl({
      query: 'q',
      site: 'stackoverflow',
      sort: 'activity',
      minScore: 50,
    });
    expect(url.searchParams.get('sort')).toBe('votes');
    expect(url.searchParams.get('min')).toBe('50');
  });

  it.each(['relevance', 'votes', 'activity'] as const)(
    'passes sort=%s through unchanged and omits min',
    async (sort) => {
      const url = await captureSearchUrl({ query: 'q', site: 'stackoverflow', sort });
      expect(url.searchParams.get('sort')).toBe(sort);
      expect(url.searchParams.get('min')).toBeNull();
    },
  );
});

describe('StackExchangeService.getThread accepted-answer merge', () => {
  /** Matches the explicit single-answer fetch (/answers/{id}), not the /questions/{id}/answers page. */
  const isAcceptedAnswerFetch = (url: string) => /\/answers\/\d+/.test(url);

  it('fetches the accepted answer when it falls outside the top-maxAnswers votes page and lists it first', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (isAcceptedAnswerFetch(url)) {
        return jsonResponse({
          items: [
            {
              answer_id: 2241883,
              question_id: 2241875,
              score: 500,
              is_accepted: true,
              body: '<p>The accepted answer.</p>',
            },
          ],
          has_more: false,
          quota_remaining: 95,
          quota_max: 300,
        });
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: 25333702,
              question_id: 2241875,
              score: 900,
              is_accepted: false,
              body: '<p>A higher-voted, non-accepted answer.</p>',
            },
          ],
          has_more: true,
          quota_remaining: 96,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: 2241875,
            title: 'A capped thread',
            link: 'https://stackoverflow.com/q/2241875',
            score: 100,
            answer_count: 12,
            is_answered: true,
            tags: ['python'],
            body: '<p>Question body.</p>',
            accepted_answer_id: 2241883,
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: 2241875, maxAnswers: 1 },
      createMockContext(),
    );

    // Accepted answer is present despite ranking below the top-1 by votes...
    expect(thread.answers.map((a) => a.answerId)).toContain(2241883);
    // ...and sorts ahead of the higher-voted, non-accepted answer.
    expect(thread.answers[0]?.answerId).toBe(2241883);
    expect(thread.answers[0]?.isAccepted).toBe(true);
    // maxAnswers=1 page (1) + merged accepted (1) = 2 — completeness beats the cap.
    expect(thread.answers).toHaveLength(2);
    // Total surfaced from the question's answer_count.
    expect(thread.answerCount).toBe(12);
    // Three upstream calls: question, answers page, explicit accepted fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('skips the extra fetch when the accepted answer is already in the page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (isAcceptedAnswerFetch(url)) {
        throw new Error('accepted answer already present — no explicit fetch expected');
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            { answer_id: 100, question_id: 1, score: 50, is_accepted: false, body: '<p>A.</p>' },
            {
              answer_id: 200,
              question_id: 1,
              score: 40,
              is_accepted: true,
              body: '<p>Accepted.</p>',
            },
          ],
          has_more: false,
          quota_remaining: 96,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: 1,
            title: 'Complete thread',
            link: 'https://stackoverflow.com/q/1',
            score: 10,
            answer_count: 2,
            is_answered: true,
            tags: ['c'],
            body: '<p>Q.</p>',
            accepted_answer_id: 200,
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: 1, maxAnswers: 10 },
      createMockContext(),
    );

    // Accepted (200) sorts first even though its score (40) is below answer 100 (50).
    expect(thread.answers[0]?.answerId).toBe(200);
    expect(thread.answers[0]?.isAccepted).toBe(true);
    expect(thread.answers).toHaveLength(2);
    expect(thread.answerCount).toBe(2);
    // Only two calls — question + answers page. No third fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not fetch an accepted answer when the question has none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (isAcceptedAnswerFetch(url)) {
        throw new Error('no accepted answer exists — no explicit fetch expected');
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            { answer_id: 5, question_id: 3, score: 7, is_accepted: false, body: '<p>A.</p>' },
          ],
          has_more: false,
          quota_remaining: 96,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: 3,
            title: 'Unaccepted thread',
            link: 'https://stackoverflow.com/q/3',
            score: 4,
            answer_count: 1,
            is_answered: false,
            tags: ['go'],
            body: '<p>Q.</p>',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: 3 },
      createMockContext(),
    );

    expect(thread.acceptedAnswerId).toBeUndefined();
    expect(thread.answerCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('StackExchangeService.getSites pagination', () => {
  /**
   * Mirrors MAX_SITE_PAGES in stackexchange-service.ts — the walk's hard stop.
   * Raising the service ceiling without updating this fails the boundary tests
   * below rather than silently widening the bound.
   */
  const PAGE_CEILING = 10;
  const PAGE_SIZE = 100;

  /** One /sites page of synthetic entries, tagged with the page that served them. */
  const sitePage = (page: number, itemCount: number, hasMore: boolean) => ({
    items: Array.from({ length: itemCount }, (_, i) => ({
      name: `Site ${page}-${i}`,
      api_site_parameter: `site-${page}-${i}`,
      site_url: `https://site-${page}-${i}.example.com`,
    })),
    has_more: hasMore,
    quota_remaining: 300 - page,
    quota_max: 300,
  });

  /** Serve full pages up to `totalPages`; `runaway` keeps has_more set forever. */
  const mockSitePages = (totalPages: number, { runaway = false } = {}) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page') ?? '1');
      return jsonResponse(sitePage(page, PAGE_SIZE, runaway || page < totalPages));
    });

  it('decodes HTML entities in site name and audience', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [
          {
            name: 'Unix &amp; Linux',
            api_site_parameter: 'unix',
            site_url: 'https://unix.stackexchange.com',
            audience: 'users of Linux, FreeBSD &amp; other Un*x-like systems',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      }),
    );

    const { sites } = await makeService().getSites(createMockContext());

    expect(sites[0]?.name).toBe('Unix & Linux');
    expect(sites[0]?.audience).toBe('users of Linux, FreeBSD & other Un*x-like systems');
  });

  it('issues one request when the first page reports no more pages', async () => {
    const fetchSpy = mockSitePages(1);

    const { sites } = await makeService().getSites(createMockContext());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sites).toHaveLength(PAGE_SIZE);
  });

  it('walks past the second page while has_more stays set', async () => {
    const fetchSpy = mockSitePages(4);

    const { sites, truncated } = await makeService().getSites(createMockContext());

    // Pre-fix this stopped after page 2, dropping every site on pages 3 and 4.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(sites).toHaveLength(4 * PAGE_SIZE);
    expect(sites.some((s) => s.apiSiteParameter === 'site-4-0')).toBe(true);
    expect(truncated).toBe(false);
  });

  it('stops at the page ceiling and reports truncation when has_more never clears', async () => {
    const fetchSpy = mockSitePages(PAGE_CEILING, { runaway: true });

    const { sites, truncated } = await makeService().getSites(createMockContext());

    expect(fetchSpy).toHaveBeenCalledTimes(PAGE_CEILING);
    expect(sites).toHaveLength(PAGE_CEILING * PAGE_SIZE);
    expect(truncated).toBe(true);
  });

  it('reports no truncation when has_more clears exactly at the ceiling', async () => {
    const fetchSpy = mockSitePages(PAGE_CEILING);

    const { truncated } = await makeService().getSites(createMockContext());

    expect(fetchSpy).toHaveBeenCalledTimes(PAGE_CEILING);
    expect(truncated).toBe(false);
  });

  it('returns an empty list when the network reports no sites', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(sitePage(1, 0, false)));

    const { sites, truncated } = await makeService().getSites(createMockContext());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sites).toEqual([]);
    expect(truncated).toBe(false);
  });

  it('stops when the page past the last one comes back empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page') ?? '1');
      return page === 1
        ? jsonResponse(sitePage(1, PAGE_SIZE, true))
        : jsonResponse(sitePage(page, 0, false));
    });

    const { sites, truncated } = await makeService().getSites(createMockContext());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sites).toHaveLength(PAGE_SIZE);
    expect(truncated).toBe(false);
  });

  it('reports the quota reading from the last page fetched', async () => {
    mockSitePages(3);

    const { quotaRemaining, quotaMax } = await makeService().getSites(createMockContext());

    expect(quotaRemaining).toBe(297);
    expect(quotaMax).toBe(300);
  });
});

describe('StackExchangeService.getUser profile filter', () => {
  /**
   * The filter string pinned in stackexchange-service.ts. Asserted as a literal
   * so swapping it without re-minting against /filters/create fails loudly.
   */
  const PINNED_USER_FILTER = '!fgp_FAe)vSKeMW4GBo(u*a)doNjyqH*B';

  /** Mock both getUser requests, recording every outgoing URL. */
  const mockUserFetch = (user: Record<string, unknown>): string[] => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/top-tags')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 });
      }
      return jsonResponse({
        items: [user],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });
    return urls;
  };

  const baseUser = {
    user_id: 22656,
    display_name: 'Jon Skeet',
    link: 'https://stackoverflow.com/users/22656/jon-skeet',
    reputation: 1_400_000,
  };

  it('requests the profile with the pinned custom filter and leaves top-tags unfiltered', async () => {
    const urls = mockUserFetch(baseUser);

    await makeService().getUser({ site: 'stackoverflow', userId: 22656 }, createMockContext());

    // Pre-fix the profile call carried no filter, so SE's default field set
    // omitted answer_count/question_count entirely.
    const profileUrl = new URL(urls.find((u) => !u.includes('/top-tags')) ?? '');
    const topTagsUrl = new URL(urls.find((u) => u.includes('/top-tags')) ?? '');
    expect(profileUrl.searchParams.get('filter')).toBe(PINNED_USER_FILTER);
    expect(topTagsUrl.searchParams.get('filter')).toBeNull();
  });

  it('maps answer_count and question_count when the filter returns them', async () => {
    mockUserFetch({ ...baseUser, answer_count: 35_805, question_count: 56 });

    const { user } = await makeService().getUser(
      { site: 'stackoverflow', userId: 22656 },
      createMockContext(),
    );

    expect(user.answerCount).toBe(35_805);
    expect(user.questionCount).toBe(56);
  });

  it('leaves the post counts absent when the profile omits them', async () => {
    mockUserFetch(baseUser);

    const { user } = await makeService().getUser(
      { site: 'stackoverflow', userId: 22656 },
      createMockContext(),
    );

    expect(user.answerCount).toBeUndefined();
    expect(user.questionCount).toBeUndefined();
  });
});

describe('StackExchangeService date mapping', () => {
  const CREATED_EPOCH = 1_340_801_496;
  const CREATED_ISO = '2012-06-27T12:51:36.000Z';
  const ACTIVE_EPOCH = 1_755_000_000;
  const ACTIVE_ISO = '2025-08-12T12:00:00.000Z';

  const questionItem = (overrides: Record<string, unknown> = {}) => ({
    question_id: 1,
    title: 'A question',
    link: 'https://stackoverflow.com/q/1',
    score: 5,
    answer_count: 1,
    is_answered: true,
    tags: ['c'],
    ...overrides,
  });

  it('searchQuestions emits ISO 8601 strings rather than epoch seconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [questionItem({ creation_date: CREATED_EPOCH, last_activity_date: ACTIVE_EPOCH })],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      }),
    );

    const { questions } = await makeService().searchQuestions(
      { query: 'q', site: 'stackoverflow' },
      createMockContext(),
    );

    expect(questions[0]?.creationDate).toBe(CREATED_ISO);
    expect(questions[0]?.lastActivityDate).toBe(ACTIVE_ISO);
  });

  it('searchQuestions omits a date the item lacks while mapping a sibling that has it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [
          questionItem({
            question_id: 1,
            creation_date: CREATED_EPOCH,
            last_activity_date: ACTIVE_EPOCH,
          }),
          questionItem({ question_id: 2 }),
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      }),
    );

    const { questions } = await makeService().searchQuestions(
      { query: 'q', site: 'stackoverflow' },
      createMockContext(),
    );

    expect(questions[0]?.creationDate).toBe(CREATED_ISO);
    expect(questions[1]?.creationDate).toBeUndefined();
    expect(questions[1]?.lastActivityDate).toBeUndefined();
  });

  it('getTagFaq emits ISO 8601 question dates', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [questionItem({ creation_date: CREATED_EPOCH, last_activity_date: ACTIVE_EPOCH })],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      }),
    );

    const { questions } = await makeService().getTagFaq(
      { tag: 'c', site: 'stackoverflow' },
      createMockContext(),
    );

    expect(questions[0]?.creationDate).toBe(CREATED_ISO);
    expect(questions[0]?.lastActivityDate).toBe(ACTIVE_ISO);
  });

  it('getThread emits ISO 8601 dates on the question and on every answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: 2,
              question_id: 1,
              score: 10,
              is_accepted: true,
              body: '<p>Accepted.</p>',
              creation_date: CREATED_EPOCH,
              last_activity_date: ACTIVE_EPOCH,
            },
            {
              answer_id: 3,
              question_id: 1,
              score: 4,
              is_accepted: false,
              body: '<p>Undated.</p>',
            },
          ],
          has_more: false,
          quota_remaining: 100,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          questionItem({
            body: '<p>Q.</p>',
            answer_count: 2,
            creation_date: CREATED_EPOCH,
            last_activity_date: ACTIVE_EPOCH,
          }),
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: 1 },
      createMockContext(),
    );

    expect(thread.creationDate).toBe(CREATED_ISO);
    expect(thread.lastActivityDate).toBe(ACTIVE_ISO);
    expect(thread.answers[0]?.creationDate).toBe(CREATED_ISO);
    expect(thread.answers[0]?.lastActivityDate).toBe(ACTIVE_ISO);
    expect(thread.answers[1]?.creationDate).toBeUndefined();
    expect(thread.answers[1]?.lastActivityDate).toBeUndefined();
  });

  it('getUser emits ISO 8601 account and last-access dates', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/top-tags')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 });
      }
      return jsonResponse({
        items: [
          {
            user_id: 22656,
            display_name: 'Jon Skeet',
            link: 'https://stackoverflow.com/users/22656/jon-skeet',
            reputation: 1_400_000,
            creation_date: 1_222_430_705,
            last_access_date: 1_788_983_645,
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { user } = await makeService().getUser(
      { site: 'stackoverflow', userId: 22656 },
      createMockContext(),
    );

    expect(user.creationDate).toBe('2008-09-26T12:05:05.000Z');
    expect(user.lastAccessDate).toBe('2026-09-09T19:54:05.000Z');
  });

  it('getUser leaves both dates absent when the profile omits them', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/top-tags')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 });
      }
      return jsonResponse({
        items: [
          {
            user_id: 1,
            display_name: 'Anon',
            link: 'https://stackoverflow.com/users/1',
            reputation: 1,
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const { user } = await makeService().getUser(
      { site: 'stackoverflow', userId: 1 },
      createMockContext(),
    );

    expect(user.creationDate).toBeUndefined();
    expect(user.lastAccessDate).toBeUndefined();
  });
});

describe('StackExchangeService hasMore threading', () => {
  it('searchQuestions surfaces the wrapper has_more flag', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ items: [], has_more: true, quota_remaining: 100, quota_max: 300 }),
    );
    const { hasMore } = await makeService().searchQuestions(
      { query: 'q', site: 'stackoverflow' },
      createMockContext(),
    );
    expect(hasMore).toBe(true);
  });

  it('getTagFaq surfaces the wrapper has_more flag', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 }),
    );
    const { hasMore } = await makeService().getTagFaq(
      { tag: 'python', site: 'stackoverflow' },
      createMockContext(),
    );
    expect(hasMore).toBe(false);
  });
});

describe('StackExchangeService bad_parameter classification', () => {
  /**
   * A stand-in contract, not any one tool's. The service resolves the reason
   * and hint from whatever contract the calling context carries — asserting
   * against a synthetic one proves that, where a real tool's contract would
   * only prove the two happen to agree.
   */
  const CONTRACT = [
    {
      reason: 'invalid_site',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown site.',
      recovery: 'Recovery text for the invalid site case.',
    },
    {
      reason: 'invalid_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A named parameter was refused.',
      recovery: 'Recovery text for the rejected parameter case.',
    },
    {
      reason: 'invalid_id_or_url',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The question ID was refused.',
      recovery: 'Recovery text for the invalid question id case.',
    },
    {
      reason: 'user_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such user.',
      recovery: 'Recovery text for the missing user case.',
    },
    {
      reason: 'question_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such question.',
      recovery: 'Recovery text for the missing question case.',
    },
  ] as const;

  const contractCtx = () => createMockContext({ errors: CONTRACT });

  /** The McpError a call rejected with. */
  const rejection = async (run: () => Promise<unknown>): Promise<McpError> => {
    const error = await run().then(
      () => {
        throw new Error('Expected the call to reject');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(McpError);
    return error as McpError;
  };

  it('classifies SE prose about an unknown site as invalid_site', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      badParameterResponse('No site found for name `notarealsite`'),
    );

    const error = await rejection(() =>
      makeService().getTagFaq({ tag: 'python', site: 'notarealsite' }, contractCtx()),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe('Stack Exchange API error: No site found for name `notarealsite`');
    expect(error.data).toMatchObject({
      reason: 'invalid_site',
      recovery: { hint: 'Recovery text for the invalid site case.' },
      error_name: 'bad_parameter',
      error_id: 400,
    });
  });

  it('classifies a bare "site" field rejection as invalid_site', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => badParameterResponse('site'));

    const error = await rejection(() =>
      makeService().getTagFaq({ tag: 'python', site: '' }, contractCtx()),
    );

    expect(error.data).toMatchObject({ reason: 'invalid_site' });
  });

  it('names the field SE refused instead of blaming the site', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => badParameterResponse('pagesize'));

    const error = await rejection(() =>
      makeService().getTagFaq({ tag: 'python', site: 'stackoverflow' }, contractCtx()),
    );

    // Pre-fix every non-`ids` rejection came back as invalid_site with the raw
    // field name pasted after "Stack Exchange API error:".
    expect(error.message).toBe('Stack Exchange rejected the "pagesize" parameter.');
    expect(error.data).toMatchObject({
      reason: 'invalid_parameter',
      recovery: { hint: 'Recovery text for the rejected parameter case.' },
    });
  });

  it('reads an `ids` rejection on a /questions route as a bad question ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => badParameterResponse('ids'));

    const error = await rejection(() =>
      makeService().getThread({ questionId: 2_147_483_648, site: 'stackoverflow' }, contractCtx()),
    );

    expect(error.message).toBe('The question ID is not a valid Stack Exchange question ID.');
    expect(error.data).toMatchObject({
      reason: 'invalid_id_or_url',
      recovery: { hint: 'Recovery text for the invalid question id case.' },
    });
  });

  it.each([
    [
      'getUser',
      (svc: StackExchangeService, ctx: ReturnType<typeof contractCtx>) =>
        svc.getUser({ userId: 2_147_483_648, site: 'stackoverflow' }, ctx),
    ],
    [
      'getTagFaq',
      (svc: StackExchangeService, ctx: ReturnType<typeof contractCtx>) =>
        svc.getTagFaq({ tag: 'python', site: 'stackoverflow' }, ctx),
    ],
    [
      'searchQuestions',
      (svc: StackExchangeService, ctx: ReturnType<typeof contractCtx>) =>
        svc.searchQuestions({ query: 'q', site: 'stackoverflow' }, ctx),
    ],
  ])('does not read an `ids` rejection on a %s route as a question ID', async (_name, call) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => badParameterResponse('ids'));

    const error = await rejection(() => call(makeService(), contractCtx()));

    expect(error.message).not.toContain('question ID');
    expect(error.message).toBe('Stack Exchange rejected the "ids" parameter.');
    expect((error.data as Record<string, unknown>).reason).toBe('invalid_parameter');
  });
});

describe('StackExchangeService recovery hints resolve from the caller contract', () => {
  const USER_CONTRACT = [
    {
      reason: 'user_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such user.',
      recovery: 'Recovery text supplied by the calling tool contract.',
    },
  ] as const;

  const emptyUserFetch = () =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 }),
      );

  const userRejection = async (ctx: Parameters<StackExchangeService['getUser']>[1]) => {
    const error = await makeService()
      .getUser({ site: 'stackoverflow', userId: 999_999_999 }, ctx)
      .then(
        () => {
          throw new Error('Expected the call to reject');
        },
        (err: unknown) => err as McpError,
      );
    return error.data as Record<string, unknown>;
  };

  it('attaches the hint the calling contract declares', async () => {
    emptyUserFetch();

    const data = await userRejection(createMockContext({ errors: USER_CONTRACT }));

    expect(data.reason).toBe('user_not_found');
    expect(data.recovery).toEqual({
      hint: 'Recovery text supplied by the calling tool contract.',
    });
  });

  it('omits recovery entirely when the caller declares no contract', async () => {
    emptyUserFetch();

    const data = await userRejection(createMockContext());

    // The hint is never a service-side literal — with nothing to resolve
    // against, the spread contributes nothing and the reason still rides.
    expect(data.reason).toBe('user_not_found');
    expect(data).not.toHaveProperty('recovery');
  });
});
