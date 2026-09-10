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

describe('StackExchangeService.getThread comment fetching', () => {
  const QUESTION_ID = 11227809;
  const ACCEPTED_ID = 11227902;
  const OTHER_ID = 11227809111;

  /** Mirrors MAX_COMMENTS_PER_POST in stackexchange-service.ts. */
  const COMMENTS_CAP = 20;

  const commentItem = (
    postId: number,
    commentId: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    comment_id: commentId,
    post_id: postId,
    score: 1,
    creation_date: 1_708_378_290,
    body: 'A comment.',
    owner: { display_name: 'Commenter', link: 'https://stackoverflow.com/users/1/commenter' },
    ...overrides,
  });

  /**
   * Serve the whole getThread call graph. `questionComments` / `answerComments`
   * are the raw item lists the two comment routes return; `answerCommentsHasMore`
   * reproduces a combined page cut short.
   */
  const mockThread = (opts: {
    answers?: Record<string, unknown>[];
    questionComments?: Record<string, unknown>[];
    answerComments?: Record<string, unknown>[];
    answerCommentsHasMore?: boolean;
    questionCommentsHasMore?: boolean;
  }) => {
    const answers = opts.answers ?? [
      {
        answer_id: ACCEPTED_ID,
        question_id: QUESTION_ID,
        score: 100,
        is_accepted: true,
        body: '<p>A.</p>',
      },
    ];
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/comments')) {
        const isQuestionRoute = url.includes('/questions/');
        return jsonResponse({
          items: isQuestionRoute ? (opts.questionComments ?? []) : (opts.answerComments ?? []),
          has_more: isQuestionRoute
            ? (opts.questionCommentsHasMore ?? false)
            : (opts.answerCommentsHasMore ?? false),
          quota_remaining: 90,
          quota_max: 300,
        });
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: answers,
          has_more: false,
          quota_remaining: 95,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: QUESTION_ID,
            title: 'A commented question',
            link: 'https://stackoverflow.com/q/11227809',
            score: 28_000,
            answer_count: answers.length,
            is_answered: true,
            tags: ['java'],
            body: '<p>Q.</p>',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });
  };

  // -- characterization: the default path, unchanged ------------------------

  it('issues no comment request and attaches no comments when includeComments is omitted', async () => {
    const fetchSpy = mockThread({ questionComments: [commentItem(QUESTION_ID, 1)] });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID },
      createMockContext(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/comments'))).toBe(false);
    expect(thread.comments).toBeUndefined();
    expect(thread.answers[0]?.comments).toBeUndefined();
  });

  it('issues no comment request when includeComments is explicitly false', async () => {
    const fetchSpy = mockThread({});

    await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: false },
      createMockContext(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -- the opted-in path -----------------------------------------------------

  it('adds exactly two calls regardless of how many answers were fetched', async () => {
    const manyAnswers = Array.from({ length: 8 }, (_, i) => ({
      answer_id: 1000 + i,
      question_id: QUESTION_ID,
      score: 50 - i,
      is_accepted: i === 0,
      body: '<p>A.</p>',
    }));
    const fetchSpy = mockThread({ answers: manyAnswers });

    await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    // 2 baseline (question + answers page) + 2 comment calls, not 2 + 8.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const commentUrls = fetchSpy.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes('/comments'));
    expect(commentUrls).toHaveLength(2);
    // Every answer ID rides one semicolon-delimited batch.
    const batched = commentUrls.find((u) => u.includes('/answers/'));
    expect(batched).toContain(manyAnswers.map((a) => a.answer_id).join(';'));
  });

  it('requests both comment routes newest-first with bodies at the route maximum page size', async () => {
    const fetchSpy = mockThread({});

    await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    const commentCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/comments'));
    expect(commentCalls).toHaveLength(2);
    for (const call of commentCalls) {
      const url = new URL(String(call[0]));
      expect(url.searchParams.get('filter')).toBe('withbody');
      expect(url.searchParams.get('sort')).toBe('creation');
      expect(url.searchParams.get('order')).toBe('desc');
      // 100 is the route maximum — the widest page makes starvation rare.
      expect(url.searchParams.get('pagesize')).toBe('100');
    }
  });

  it('attaches question and answer comments grouped by post_id, not by request order', async () => {
    mockThread({
      answers: [
        {
          answer_id: ACCEPTED_ID,
          question_id: QUESTION_ID,
          score: 100,
          is_accepted: true,
          body: '<p>A.</p>',
        },
        {
          answer_id: OTHER_ID,
          question_id: QUESTION_ID,
          score: 5,
          is_accepted: false,
          body: '<p>B.</p>',
        },
      ],
      questionComments: [commentItem(QUESTION_ID, 900)],
      // Interleaved: SE orders the combined page newest-first across every post.
      answerComments: [
        commentItem(OTHER_ID, 1),
        commentItem(ACCEPTED_ID, 2),
        commentItem(OTHER_ID, 3),
      ],
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    expect(thread.comments?.map((c) => c.commentId)).toEqual([900]);
    const byId = new Map(thread.answers.map((a) => [a.answerId, a]));
    expect(byId.get(ACCEPTED_ID)?.comments?.map((c) => c.commentId)).toEqual([2]);
    expect(byId.get(OTHER_ID)?.comments?.map((c) => c.commentId)).toEqual([1, 3]);
  });

  it('normalizes inline code and links in a comment body to markdown', async () => {
    mockThread({
      questionComments: [
        commentItem(QUESTION_ID, 1, {
          body: 'Use <code>if() add</code> — see <a href="https://en.wikipedia.org/wiki/Branch_predictor" rel="nofollow noreferrer">the history</a>. It isn&#39;t free.',
        }),
      ],
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    expect(thread.comments?.[0]?.bodyMarkdown).toBe(
      "Use `if() add` — see [the history](https://en.wikipedia.org/wiki/Branch_predictor). It isn't free.",
    );
  });

  it('maps comment score, author, and ISO 8601 creation date', async () => {
    mockThread({
      questionComments: [
        commentItem(QUESTION_ID, 141067132, {
          score: 7,
          creation_date: 1_340_801_496,
          owner: {
            display_name: 'Jesper R&#248;nn-Jensen',
            link: 'https://stackoverflow.com/users/10/jesper',
          },
        }),
      ],
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    expect(thread.comments?.[0]).toMatchObject({
      commentId: 141067132,
      score: 7,
      authorName: 'Jesper Rønn-Jensen',
      authorLink: 'https://stackoverflow.com/users/10/jesper',
      creationDate: '2012-06-27T12:51:36.000Z',
    });
  });

  it('omits author and date on a comment whose upstream payload lacks them', async () => {
    mockThread({
      questionComments: [{ comment_id: 5, post_id: QUESTION_ID, score: 0, body: 'Bare comment.' }],
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    expect(thread.comments?.[0]?.bodyMarkdown).toBe('Bare comment.');
    expect(thread.comments?.[0]?.authorName).toBeUndefined();
    expect(thread.comments?.[0]?.authorLink).toBeUndefined();
    expect(thread.comments?.[0]?.creationDate).toBeUndefined();
  });

  // -- empty vs. unknown -----------------------------------------------------

  it('reports a genuinely comment-free post as an empty list, not as unknown', async () => {
    mockThread({ questionComments: [], answerComments: [], answerCommentsHasMore: false });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    expect(thread.comments).toEqual([]);
    expect(thread.answers[0]?.comments).toEqual([]);
    expect(thread.answers[0]?.commentsTruncated).toBeUndefined();
  });

  it('leaves a post starved by a truncated combined page unknown rather than comment-free', async () => {
    // The live shape: two answer IDs at one page size, every returned comment
    // belonging to the first, has_more still set. The second contributed nothing
    // despite having comments of its own.
    mockThread({
      answers: [
        {
          answer_id: ACCEPTED_ID,
          question_id: QUESTION_ID,
          score: 100,
          is_accepted: true,
          body: '<p>A.</p>',
        },
        {
          answer_id: OTHER_ID,
          question_id: QUESTION_ID,
          score: 5,
          is_accepted: false,
          body: '<p>B.</p>',
        },
      ],
      answerComments: [commentItem(ACCEPTED_ID, 1), commentItem(ACCEPTED_ID, 2)],
      answerCommentsHasMore: true,
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    const byId = new Map(thread.answers.map((a) => [a.answerId, a]));
    // The starved answer: absent, never an empty array.
    expect(byId.get(OTHER_ID)?.comments).toBeUndefined();
    expect(byId.get(OTHER_ID)?.comments).not.toEqual([]);
    // The answer that did receive comments cannot be proven complete either —
    // the page is ordered newest-first across posts, so older ones may remain.
    expect(byId.get(ACCEPTED_ID)?.comments).toHaveLength(2);
    expect(byId.get(ACCEPTED_ID)?.commentsTruncated).toBe(true);
  });

  // -- the per-post cap ------------------------------------------------------

  it('caps one post at the per-post limit and marks that post truncated', async () => {
    const over = Array.from({ length: COMMENTS_CAP + 5 }, (_, i) =>
      commentItem(ACCEPTED_ID, i + 1),
    );
    mockThread({
      answers: [
        {
          answer_id: ACCEPTED_ID,
          question_id: QUESTION_ID,
          score: 100,
          is_accepted: true,
          body: '<p>A.</p>',
        },
        {
          answer_id: OTHER_ID,
          question_id: QUESTION_ID,
          score: 5,
          is_accepted: false,
          body: '<p>B.</p>',
        },
      ],
      answerComments: [...over, commentItem(OTHER_ID, 999)],
      answerCommentsHasMore: false,
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    const byId = new Map(thread.answers.map((a) => [a.answerId, a]));
    // The cap bites on one post specifically...
    expect(byId.get(ACCEPTED_ID)?.comments).toHaveLength(COMMENTS_CAP);
    expect(byId.get(ACCEPTED_ID)?.commentsTruncated).toBe(true);
    // ...and its neighbour in the same combined page stays whole.
    expect(byId.get(OTHER_ID)?.comments).toHaveLength(1);
    expect(byId.get(OTHER_ID)?.commentsTruncated).toBeUndefined();
  });

  it('marks the question truncated when its own comment page reports more', async () => {
    mockThread({
      questionComments: [commentItem(QUESTION_ID, 1)],
      questionCommentsHasMore: true,
    });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    expect(thread.comments).toHaveLength(1);
    expect(thread.commentsTruncated).toBe(true);
  });

  it('fetches question comments but no answer batch when the question has no answers', async () => {
    const fetchSpy = mockThread({ answers: [], questionComments: [commentItem(QUESTION_ID, 1)] });

    const { thread } = await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
      createMockContext(),
    );

    // No answer IDs means no /answers/{ids}/comments route to call — three total.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(
      fetchSpy.mock.calls.some(
        ([u]) => String(u).includes('/answers/') && String(u).includes('/comments'),
      ),
    ).toBe(false);
    expect(thread.comments).toHaveLength(1);
    expect(thread.answers).toEqual([]);
  });

  it('includes the merged accepted answer in the batched comment request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/comments')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 90, quota_max: 300 });
      }
      // The explicit single-answer fetch for the out-of-page accepted answer.
      if (/\/answers\/\d+\?/.test(url)) {
        return jsonResponse({
          items: [
            {
              answer_id: ACCEPTED_ID,
              question_id: QUESTION_ID,
              score: 10,
              is_accepted: true,
              body: '<p>Accepted.</p>',
            },
          ],
          has_more: false,
          quota_remaining: 94,
          quota_max: 300,
        });
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: OTHER_ID,
              question_id: QUESTION_ID,
              score: 900,
              is_accepted: false,
              body: '<p>Higher voted.</p>',
            },
          ],
          has_more: true,
          quota_remaining: 95,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: QUESTION_ID,
            title: 'A capped thread',
            link: 'https://stackoverflow.com/q/11227809',
            score: 100,
            answer_count: 12,
            is_answered: true,
            tags: ['java'],
            body: '<p>Q.</p>',
            accepted_answer_id: ACCEPTED_ID,
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    await makeService().getThread(
      { site: 'stackoverflow', questionId: QUESTION_ID, maxAnswers: 1, includeComments: true },
      createMockContext(),
    );

    const batched = fetchSpy.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.includes('/answers/') && u.includes('/comments'));
    expect(batched).toBeDefined();
    // The merged accepted answer is not in the votes page, but its comments
    // still ride the same single batched call.
    expect(decodeURIComponent(batched!)).toContain(`${ACCEPTED_ID}`);
    expect(decodeURIComponent(batched!)).toContain(`${OTHER_ID}`);
  });

  // -- error mapping ---------------------------------------------------------

  it('reads an `ids` rejection from the question comments route as a bad question ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/questions/') && url.includes('/comments')) {
        return badParameterResponse('ids');
      }
      if (url.includes('/comments')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 90, quota_max: 300 });
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: ACCEPTED_ID,
              question_id: QUESTION_ID,
              score: 1,
              is_accepted: false,
              body: '<p>A.</p>',
            },
          ],
          has_more: false,
          quota_remaining: 95,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: QUESTION_ID,
            title: 'Q',
            link: 'https://stackoverflow.com/q/11227809',
            score: 1,
            answer_count: 1,
            is_answered: true,
            tags: ['java'],
            body: '<p>Q.</p>',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const error = await makeService()
      .getThread(
        { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
        createMockContext(),
      )
      .then(
        () => {
          throw new Error('Expected the call to reject');
        },
        (err: unknown) => err as McpError,
      );

    expect(error.message).toBe('The question ID is not a valid Stack Exchange question ID.');
    expect((error.data as Record<string, unknown>).reason).toBe('invalid_id_or_url');
  });

  it('does not blame the caller for an `ids` rejection from the batched answers comments route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/answers/') && url.includes('/comments')) {
        return badParameterResponse('ids');
      }
      if (url.includes('/comments')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 90, quota_max: 300 });
      }
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: ACCEPTED_ID,
              question_id: QUESTION_ID,
              score: 1,
              is_accepted: false,
              body: '<p>A.</p>',
            },
          ],
          has_more: false,
          quota_remaining: 95,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: QUESTION_ID,
            title: 'Q',
            link: 'https://stackoverflow.com/q/11227809',
            score: 1,
            answer_count: 1,
            is_answered: true,
            tags: ['java'],
            body: '<p>Q.</p>',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const error = await makeService()
      .getThread(
        { site: 'stackoverflow', questionId: QUESTION_ID, includeComments: true },
        createMockContext(),
      )
      .then(
        () => {
          throw new Error('Expected the call to reject');
        },
        (err: unknown) => err as McpError,
      );

    // The answer IDs are SE's own, never the caller's input — the question-ID
    // wording would send the caller after the wrong thing to fix.
    expect(error.message).not.toContain('question ID');
    expect(error.message).toBe('Stack Exchange rejected the "ids" parameter.');
    expect((error.data as Record<string, unknown>).reason).toBe('invalid_parameter');
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

// ---------------------------------------------------------------------------
// #17 — excerpt derived from body_markdown on /search/advanced
// ---------------------------------------------------------------------------

describe('StackExchangeService.searchQuestions custom filter', () => {
  /**
   * The filter string pinned in stackexchange-service.ts. Asserted as a literal
   * so swapping it without re-minting against /filters/create fails loudly.
   */
  const PINNED_SEARCH_FILTER = '!-tSBS8YTedGMoaqycoVR';

  const emptySearch = { items: [], has_more: false, quota_remaining: 100, quota_max: 300 };

  it('requests /search/advanced with the pinned custom filter', async () => {
    // Pre-fix the search call carried no filter, so SE's default field set
    // omitted body_markdown and `excerpt` was absent from every result.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(emptySearch));

    await makeService().searchQuestions({ query: 'q', site: 'stackoverflow' }, createMockContext());

    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.searchParams.get('filter')).toBe(PINNED_SEARCH_FILTER);
  });

  it('leaves /tags/{tag}/faq on the SE default filter', async () => {
    // getTagFaq maps through the same normalizeQuestion but must not inherit a
    // `base=none` filter minted for the search route.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(emptySearch));

    await makeService().getTagFaq({ tag: 'python', site: 'stackoverflow' }, createMockContext());

    expect(new URL(String(spy.mock.calls[0]![0])).searchParams.get('filter')).toBeNull();
  });
});

describe('StackExchangeService excerpt derivation', () => {
  /** Mirrors EXCERPT_MAX_CHARS in stackexchange-service.ts. */
  const EXCERPT_MAX_CHARS = 300;

  const questionWithBody = (bodyMarkdown: string | undefined) => ({
    question_id: 1,
    title: 'A question',
    link: 'https://stackoverflow.com/q/1',
    score: 5,
    answer_count: 1,
    is_answered: true,
    tags: ['python'],
    ...(bodyMarkdown === undefined ? {} : { body_markdown: bodyMarkdown }),
  });

  /** Run searchQuestions against one item carrying `body` and return its excerpt. */
  const excerptFor = async (body: string | undefined): Promise<string | undefined> => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [questionWithBody(body)],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      }),
    );
    const { questions } = await makeService().searchQuestions(
      { query: 'q', site: 'stackoverflow' },
      createMockContext(),
    );
    return questions[0]?.excerpt;
  };

  it('derives the excerpt from body_markdown', async () => {
    // Pre-fix body_markdown was never requested and never read — excerpt was
    // declared, described, and absent from every result.
    expect(await excerptFor('Say I have two async generators and want to merge them.')).toBe(
      'Say I have two async generators and want to merge them.',
    );
  });

  it('decodes HTML entities the way title already does', async () => {
    // body_markdown arrives HTML-encoded: &#39; for an apostrophe, &quot; for a quote.
    expect(await excerptFor('It&#39;s a &quot;merge&quot; of &lt;T&gt; values &amp; keys.')).toBe(
      `It's a "merge" of <T> values & keys.`,
    );
  });

  it('decodes before truncating, so no entity is split across the boundary', async () => {
    // An entity straddling EXCERPT_MAX_CHARS would leave `&qu` if the cut came first.
    const filler = 'word '.repeat(60); // 300 chars
    const excerpt = await excerptFor(`${filler}&quot;quoted&quot; tail that runs past the cap.`);
    expect(excerpt).toBeDefined();
    expect(excerpt).not.toContain('&qu');
    expect(excerpt).not.toContain('&#');
    expect(excerpt).not.toMatch(/&[a-z]+$/);
  });

  it('truncates at a word boundary and marks the cut', async () => {
    const body = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(10);
    const excerpt = await excerptFor(body);
    expect(excerpt).toBeDefined();
    expect(excerpt!.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
    expect(excerpt!.endsWith('…')).toBe(true);
    // The character before the ellipsis ends a whole word, never a split one.
    expect(body.split(' ')).toContain(excerpt!.slice(0, -1).split(' ').pop());
  });

  it('returns the whole body untruncated and unmarked when it fits', async () => {
    const excerpt = await excerptFor('Short enough to survive whole.');
    expect(excerpt).toBe('Short enough to survive whole.');
    expect(excerpt).not.toContain('…');
  });

  it('drops fenced code blocks rather than truncating into one', async () => {
    const excerpt = await excerptFor(
      'Here is the failing call:\n\n```python\nasync def f():\n    yield 1\n```\n\nWhy does it hang?',
    );
    expect(excerpt).toBe('Here is the failing call: Why does it hang?');
    expect(excerpt).not.toContain('```');
    expect(excerpt).not.toContain('yield');
  });

  it('drops an unpaired opening fence and everything after it', async () => {
    const excerpt = await excerptFor('Leading prose.\n\n```python\nasync def f():\n    yield 1');
    expect(excerpt).toBe('Leading prose.');
    expect(excerpt).not.toContain('```');
  });

  it('drops indented code blocks, which is how SE renders code in body_markdown', async () => {
    // Verified live: /search/advanced body_markdown carries 4-space indented code,
    // not fences.
    const excerpt = await excerptFor(
      'Say I have two async generators:\n\n    async def get_rules():\n        while True:\n            yield 1\n\nI want to merge them.',
    );
    expect(excerpt).toBe('Say I have two async generators: I want to merge them.');
    expect(excerpt).not.toContain('async def');
  });

  it('omits the excerpt when the body is nothing but code', async () => {
    // Better absent than an excerpt fabricated out of stripped markup.
    expect(await excerptFor('```js\nconst a = 1;\n```')).toBeUndefined();
  });

  it('omits the excerpt when the body is empty or whitespace', async () => {
    expect(await excerptFor('')).toBeUndefined();
    expect(await excerptFor('   \n\n  ')).toBeUndefined();
  });

  it('omits the excerpt when the route carries no body at all', async () => {
    // The /tags/{tag}/faq shape: same mapper, SE default filter, no body.
    expect(await excerptFor(undefined)).toBeUndefined();
  });

  it('closes an inline-code span the cut left open', async () => {
    const body = `${'padding word '.repeat(22)}\`unterminated_code_span_that_runs_past_the_cap`;
    const excerpt = await excerptFor(body);
    expect(excerpt).toBeDefined();
    expect((excerpt!.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('drops a markdown link the cut left half-open', async () => {
    const body = `${'padding word '.repeat(21)}see [the docs](https://example.com/a/very/long/path)`;
    const excerpt = await excerptFor(body);
    expect(excerpt).toBeDefined();
    expect(excerpt).not.toContain('](');
    expect(excerpt).not.toContain('[the docs]');
  });

  it('leaves a bracketed expression that is not a link alone', async () => {
    expect(await excerptFor('Reading array[0] raises IndexError.')).toBe(
      'Reading array[0] raises IndexError.',
    );
  });

  it('derives an excerpt per item, leaving a body-less sibling without one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [
          { ...questionWithBody('First question body text.'), question_id: 1 },
          { ...questionWithBody(undefined), question_id: 2 },
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

    expect(questions[0]?.excerpt).toBe('First question body text.');
    expect(questions[1]?.excerpt).toBeUndefined();
  });

  it('getTagFaq maps through the same mapper without an excerpt', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        items: [questionWithBody(undefined)],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      }),
    );

    const { questions } = await makeService().getTagFaq(
      { tag: 'python', site: 'stackoverflow' },
      createMockContext(),
    );

    expect(questions[0]?.excerpt).toBeUndefined();
    expect(questions[0]?.title).toBe('A question');
  });
});

// ---------------------------------------------------------------------------
// #18 — paging
// ---------------------------------------------------------------------------

describe('StackExchangeService paging', () => {
  const emptyWrapper = { items: [], has_more: false, quota_remaining: 100, quota_max: 300 };

  const captureUrl = async (run: (svc: StackExchangeService) => Promise<unknown>): Promise<URL> => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(emptyWrapper));
    await run(makeService());
    expect(spy).toHaveBeenCalledTimes(1);
    return new URL(String(spy.mock.calls[0]![0]));
  };

  it('forwards page to /search/advanced', async () => {
    const url = await captureUrl((svc) =>
      svc.searchQuestions({ query: 'q', site: 'stackoverflow', page: 3 }, createMockContext()),
    );
    expect(url.searchParams.get('page')).toBe('3');
  });

  it('forwards page to /tags/{tag}/faq', async () => {
    const url = await captureUrl((svc) =>
      svc.getTagFaq({ tag: 'python', site: 'stackoverflow', page: 4 }, createMockContext()),
    );
    expect(url.searchParams.get('page')).toBe('4');
  });

  it('omits page from /search/advanced when the caller supplies none', async () => {
    const url = await captureUrl((svc) =>
      svc.searchQuestions({ query: 'q', site: 'stackoverflow' }, createMockContext()),
    );
    expect(url.searchParams.get('page')).toBeNull();
  });

  it('omits page from /tags/{tag}/faq when the caller supplies none', async () => {
    const url = await captureUrl((svc) =>
      svc.getTagFaq({ tag: 'python', site: 'stackoverflow' }, createMockContext()),
    );
    expect(url.searchParams.get('page')).toBeNull();
  });

  it('leaves pagesize untouched when paging', async () => {
    const url = await captureUrl((svc) =>
      svc.searchQuestions(
        { query: 'q', site: 'stackoverflow', page: 2, pageSize: 30 },
        createMockContext(),
      ),
    );
    expect(url.searchParams.get('pagesize')).toBe('30');
    expect(url.searchParams.get('page')).toBe('2');
  });
});

describe('StackExchangeService paging depth limit', () => {
  /**
   * SE's keyless paging wall, reproduced live against api.stackexchange.com on
   * both routes: the envelope carries `error_id: 403`, but the HTTP status line
   * is 400 — the same status `bad_parameter` arrives under. Keying on the status
   * alone therefore cannot tell the two apart; `error_name` is what separates them.
   */
  const seAccessDenied = (errorMessage = 'page above 25 requires access token or app key') =>
    new Response(
      JSON.stringify({ error_id: 403, error_message: errorMessage, error_name: 'access_denied' }),
      { status: 400 },
    );

  const CONTRACT = [
    {
      reason: 'paging_depth_limit',
      code: JsonRpcErrorCode.Forbidden,
      when: 'SE refused the requested page depth.',
      recovery: 'Recovery text for the paging depth case.',
    },
  ] as const;

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

  it('classifies the keyless paging wall as paging_depth_limit on searchQuestions', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => seAccessDenied());

    const error = await rejection(() =>
      makeService().searchQuestions(
        { query: 'q', site: 'stackoverflow', page: 26 },
        createMockContext({ errors: CONTRACT }),
      ),
    );

    // Pre-fix an access_denied envelope fell through to the framework's generic
    // HTTP classifier: no reason, no recovery hint, nothing for the caller to act on.
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.message).toContain('page above 25 requires access token or app key');
    expect(error.data).toMatchObject({
      reason: 'paging_depth_limit',
      recovery: { hint: 'Recovery text for the paging depth case.' },
      error_name: 'access_denied',
      error_id: 403,
    });
    // Forbidden is not a retryable code — one upstream call, one quota unit.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('classifies the keyless paging wall as paging_depth_limit on getTagFaq', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => seAccessDenied());

    const error = await rejection(() =>
      makeService().getTagFaq(
        { tag: 'python', site: 'stackoverflow', page: 30 },
        createMockContext({ errors: CONTRACT }),
      ),
    );

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect((error.data as Record<string, unknown>).reason).toBe('paging_depth_limit');
  });

  it('never reports it as invalid_parameter — nothing about the request was malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => seAccessDenied());

    const error = await rejection(() =>
      makeService().searchQuestions(
        { query: 'q', site: 'stackoverflow', page: 26 },
        createMockContext({ errors: CONTRACT }),
      ),
    );

    expect((error.data as Record<string, unknown>).reason).not.toBe('invalid_parameter');
    expect(error.code).not.toBe(JsonRpcErrorCode.ValidationError);
  });

  it('leaves an access_denied that is not about paging to the framework classifier', async () => {
    // A revoked or malformed key also answers access_denied; calling that a paging
    // depth limit would send the caller after the wrong remedy.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      seAccessDenied('requires authentication'),
    );

    const error = await rejection(() =>
      makeService().searchQuestions(
        { query: 'q', site: 'stackoverflow' },
        createMockContext({ errors: CONTRACT }),
      ),
    );

    expect((error.data as Record<string, unknown>).reason).toBeUndefined();
    expect((error.data as Record<string, unknown>).errorSource).toBe('FetchHttpError');
  });

  it('still routes a bad_parameter rejection through the caller mapping', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => badParameterResponse('pagesize'));

    const error = await rejection(() =>
      makeService().searchQuestions(
        { query: 'q', site: 'stackoverflow', page: 2 },
        createMockContext({
          errors: [
            {
              reason: 'invalid_parameter',
              code: JsonRpcErrorCode.ValidationError,
              when: 'A named parameter was refused.',
              recovery: 'Recovery text for the rejected parameter case.',
            },
          ] as const,
        }),
      ),
    );

    expect((error.data as Record<string, unknown>).reason).toBe('invalid_parameter');
    expect(error.message).toContain('pagesize');
  });
});
