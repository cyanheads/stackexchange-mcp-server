/**
 * @fileoverview Wire-shape tests for the tool error contract — the dual-surface
 * envelope a client actually receives.
 *
 * These run the REAL StackExchangeService against a mocked `fetch`, driven
 * through `runToolContract` so both consumption surfaces are exercised:
 * `structuredContent.error` (Claude Code and other JSON clients) and
 * `content[0].text` (Claude Desktop and other format()-only clients). Errors
 * raised inside a called service are invisible to the conformance linter, so
 * the declared `reason` and `recovery` hint only stay honest if asserted here.
 *
 * Recovery hints are asserted against each tool's own `errors[]` entry rather
 * than a copied literal — the contract is the source of truth, and a reworded
 * hint must not silently pass.
 * @module tests/tools/error-contract.wire.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetTagFaq } from '@/mcp-server/tools/definitions/stackexchange-get-tag-faq.tool.js';
import { stackexchangeGetThread } from '@/mcp-server/tools/definitions/stackexchange-get-thread.tool.js';
import { stackexchangeGetUser } from '@/mcp-server/tools/definitions/stackexchange-get-user.tool.js';
import { stackexchangeListSites } from '@/mcp-server/tools/definitions/stackexchange-list-sites.tool.js';
import { stackexchangeSearchQuestions } from '@/mcp-server/tools/definitions/stackexchange-search-questions.tool.js';
import { initStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

// ---------------------------------------------------------------------------
// Contract lookup
// ---------------------------------------------------------------------------

/** The shape every tool `errors[]` entry shares, narrowed to what these tests read. */
type ContractEntry = { readonly reason: string; readonly recovery: string };
type Contracted = { readonly errors?: readonly ContractEntry[] };

/**
 * The `recovery` string a tool declares for one reason. Throws rather than
 * returning undefined so a renamed reason fails loudly instead of comparing
 * `undefined` to `undefined`.
 */
const declaredRecovery = (def: Contracted, reason: string): string => {
  const entry = def.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry declares reason "${reason}"`);
  return entry.recovery;
};

/** Every reason a tool advertises — what a client is entitled to switch on. */
const declaredReasons = (def: Contracted): string[] => (def.errors ?? []).map((e) => e.reason);

// ---------------------------------------------------------------------------
// Wire surfaces
// ---------------------------------------------------------------------------

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

interface WireError {
  code: number;
  data?: {
    reason?: string;
    recovery?: { hint?: string };
  } & Record<string, unknown>;
  message: string;
}

/** The JSON surface — `structuredContent.error`, read by Claude Code-style clients. */
const wireError = (result: ToolResult): WireError => {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error?: WireError } | undefined)?.error;
  if (!error) throw new Error('Expected structuredContent.error on an error result');
  return error;
};

/** The markdown surface — `content[0].text`, read by format()-only clients. */
const wireText = (result: ToolResult): string => (result.content[0] as { text: string }).text;

/**
 * Assert both surfaces carry one reason's contract recovery: `data.recovery.hint`
 * on the JSON surface, and the mirrored `Recovery:` line on the markdown surface.
 */
const expectRecoveryParity = (result: ToolResult, def: Contracted, reason: string): void => {
  const hint = declaredRecovery(def, reason);
  expect(wireError(result).data?.recovery?.hint).toBe(hint);
  expect(wireText(result)).toContain(`Recovery: ${hint}`);
};

// ---------------------------------------------------------------------------
// Upstream fixtures
// ---------------------------------------------------------------------------

/** A 200 OK SE wrapper. */
const seOk = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ has_more: false, quota_remaining: 100, quota_max: 300, ...body }), {
    status: 200,
  });

/**
 * SE's `bad_parameter` rejection: HTTP 400 with a JSON envelope. `errorMessage`
 * is either prose naming an unknown site ("No site found for name `x`") or the
 * bare name of the field SE refused ("ids", "pagesize") — both wordings
 * reproduced live against api.stackexchange.com.
 */
const seBadParameter = (errorMessage: string): Response =>
  new Response(
    JSON.stringify({ error_id: 400, error_message: errorMessage, error_name: 'bad_parameter' }),
    { status: 400 },
  );

const UNKNOWN_SITE_MESSAGE = 'No site found for name `notarealsite`';

/** Answer every outgoing request with the same response. */
const mockFetch = (response: () => Response) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());

beforeEach(() => {
  // The tool definitions resolve the service through the module singleton, so
  // the real service — not a stand-in — is what these tests exercise.
  initStackExchangeService({} as AppConfig, {} as StorageService);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// #16 — declared recovery hints reach the caller from service-thrown errors
// ---------------------------------------------------------------------------

describe('service-thrown errors carry the calling tool contract recovery hint', () => {
  it('invalid_site on stackexchange_search_questions', async () => {
    mockFetch(() => seBadParameter(UNKNOWN_SITE_MESSAGE));

    const result = await runToolContract(stackexchangeSearchQuestions, {
      query: 'generics',
      site: 'notarealsite',
    });

    const error = wireError(result);
    // Unchanged by this fix — the code and reason are what they always were.
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_site');
    expectRecoveryParity(result, stackexchangeSearchQuestions, 'invalid_site');
  });

  it('invalid_site resolves against the calling tool, not a shared default', async () => {
    mockFetch(() => seBadParameter(UNKNOWN_SITE_MESSAGE));

    const result = await runToolContract(stackexchangeGetUser, {
      userId: 22656,
      site: 'notarealsite',
    });

    expect(wireError(result).data?.reason).toBe('invalid_site');
    expectRecoveryParity(result, stackexchangeGetUser, 'invalid_site');
  });

  it('question_not_found on stackexchange_get_thread', async () => {
    mockFetch(() => seOk({ items: [] }));

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: '999999999',
    });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('question_not_found');
    expectRecoveryParity(result, stackexchangeGetThread, 'question_not_found');
  });

  it('user_not_found on stackexchange_get_user', async () => {
    mockFetch(() => seOk({ items: [] }));

    const result = await runToolContract(stackexchangeGetUser, { userId: 999999 });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('user_not_found');
    expectRecoveryParity(result, stackexchangeGetUser, 'user_not_found');
  });

  it('quota_exceeded on stackexchange_get_tag_faq', async () => {
    mockFetch(() => seOk({ items: [], quota_remaining: 0 }));

    // RateLimited is a transient code, so withRetry sleeps 1s/2s/4s before
    // giving up. Fake timers drive those sleeps rather than waiting them out.
    vi.useFakeTimers();
    const pending = runToolContract(stackexchangeGetTagFaq, { tag: 'python' });
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('quota_exceeded');
    expectRecoveryParity(result, stackexchangeGetTagFaq, 'quota_exceeded');
  });

  it('handler-thrown invalid_id_or_url keeps carrying its hint', async () => {
    const fetchSpy = mockFetch(() => seOk({ items: [] }));

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: 'not-a-question',
    });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_id_or_url');
    expectRecoveryParity(result, stackexchangeGetThread, 'invalid_id_or_url');
    // Rejected before any upstream call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #21 — bad_parameter names the field Stack Exchange actually rejected
// ---------------------------------------------------------------------------

describe('bad_parameter attribution', () => {
  it('rejects an out-of-range userId locally, naming userId', async () => {
    const fetchSpy = mockFetch(() => seBadParameter('ids'));

    const result = await runToolContract(stackexchangeGetUser, { userId: 2147483648 });

    const error = wireError(result);
    expect(error.message).toContain('userId');
    expect(error.message).toContain('2147483647');
    expect(error.message).not.toContain('question ID');
    // The reason is one stackexchange_get_user declares — never invalid_id_or_url,
    // which that tool has no question-shaped input to justify.
    expect(error.data?.reason).toBe('invalid_user_id');
    expect(declaredReasons(stackexchangeGetUser)).toContain(error.data?.reason);
    expectRecoveryParity(result, stackexchangeGetUser, 'invalid_user_id');
    // Caught before the request goes out — the shared mapper is never reached.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts the largest in-range userId', async () => {
    mockFetch(() => seOk({ items: [] }));

    const result = await runToolContract(stackexchangeGetUser, { userId: 2147483647 });

    // Reaches the API and fails on the empty result set, not on the bound.
    expect(wireError(result).data?.reason).toBe('user_not_found');
  });

  it('reports a non-site rejection on stackexchange_get_tag_faq as a parameter problem', async () => {
    mockFetch(() => seBadParameter('pagesize'));

    const result = await runToolContract(stackexchangeGetTagFaq, {
      tag: 'python',
      pageSize: 30,
    });

    const error = wireError(result);
    // Pre-fix this was invalid_site, steering the caller to stackexchange_list_sites
    // for a rejection that has nothing to do with the site.
    expect(error.data?.reason).toBe('invalid_parameter');
    expect(error.message).toContain('pagesize');
    expectRecoveryParity(result, stackexchangeGetTagFaq, 'invalid_parameter');
  });

  it('never reports a question ID problem on stackexchange_get_tag_faq', async () => {
    mockFetch(() => seBadParameter('ids'));

    const result = await runToolContract(stackexchangeGetTagFaq, { tag: 'python' });

    const error = wireError(result);
    expect(error.message).not.toContain('question ID');
    expect(error.data?.reason).not.toBe('invalid_id_or_url');
    expect(declaredReasons(stackexchangeGetTagFaq)).toContain(error.data?.reason);
  });

  it('never reports a question ID problem on stackexchange_get_user', async () => {
    mockFetch(() => seBadParameter('ids'));

    const result = await runToolContract(stackexchangeGetUser, { userId: 22656 });

    const error = wireError(result);
    expect(error.message).not.toContain('question ID');
    expect(error.data?.reason).not.toBe('invalid_id_or_url');
    expect(declaredReasons(stackexchangeGetUser)).toContain(error.data?.reason);
  });

  it('keeps the question-ID wording on stackexchange_get_thread, where it is correct', async () => {
    mockFetch(() => seBadParameter('ids'));

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: '2147483648',
    });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_id_or_url');
    expect(error.message).toBe('The question ID is not a valid Stack Exchange question ID.');
    expectRecoveryParity(result, stackexchangeGetThread, 'invalid_id_or_url');
  });

  it('reports a non-ids, non-site rejection on stackexchange_search_questions by field', async () => {
    mockFetch(() => seBadParameter('tagged'));

    const result = await runToolContract(stackexchangeSearchQuestions, {
      query: 'generics',
      tags: ['not a tag'],
    });

    const error = wireError(result);
    expect(error.data?.reason).toBe('invalid_parameter');
    expect(error.message).toContain('tagged');
    expectRecoveryParity(result, stackexchangeSearchQuestions, 'invalid_parameter');
  });
});

// ---------------------------------------------------------------------------
// #18 — the keyless paging wall reaches the caller as a declared reason
// ---------------------------------------------------------------------------

/**
 * SE's refusal to page past its keyless ceiling, reproduced live against
 * api.stackexchange.com on both `/search/advanced` and `/tags/{tag}/faq`: the
 * envelope carries `error_id: 403`, but the HTTP status line is 400 — the same
 * status `bad_parameter` arrives under, so only `error_name` separates them.
 */
const seAccessDenied = (
  errorMessage = 'page above 25 requires access token or app key',
): Response =>
  new Response(
    JSON.stringify({ error_id: 403, error_message: errorMessage, error_name: 'access_denied' }),
    { status: 400 },
  );

describe('paging depth limit', () => {
  it('paging_depth_limit on stackexchange_search_questions', async () => {
    mockFetch(() => seAccessDenied());

    const result = await runToolContract(stackexchangeSearchQuestions, {
      query: 'python',
      page: 26,
    });

    const error = wireError(result);
    // Pre-fix a 403-flavoured envelope fell through to the framework's generic
    // HTTP classifier: -32602 with no reason and no recovery hint.
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data?.reason).toBe('paging_depth_limit');
    expect(declaredReasons(stackexchangeSearchQuestions)).toContain(error.data?.reason);
    expectRecoveryParity(result, stackexchangeSearchQuestions, 'paging_depth_limit');
    // The remedy is named on the wire, not just the failure.
    expect(wireText(result)).toContain('STACKEXCHANGE_API_KEY');
  });

  it('paging_depth_limit on stackexchange_get_tag_faq', async () => {
    mockFetch(() => seAccessDenied());

    const result = await runToolContract(stackexchangeGetTagFaq, { tag: 'python', page: 30 });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data?.reason).toBe('paging_depth_limit');
    expectRecoveryParity(result, stackexchangeGetTagFaq, 'paging_depth_limit');
  });

  it('is not reported as invalid_parameter — the request was well formed', async () => {
    mockFetch(() => seAccessDenied());

    const result = await runToolContract(stackexchangeSearchQuestions, {
      query: 'python',
      page: 26,
    });

    const error = wireError(result);
    expect(error.data?.reason).not.toBe('invalid_parameter');
    expect(error.code).not.toBe(JsonRpcErrorCode.ValidationError);
  });

  it('rejects page 0 at the schema, before any upstream call', async () => {
    const fetchSpy = mockFetch(() => seAccessDenied());

    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'q', page: 0 });

    expect(wireError(result).message).toContain('page');
    // A page below 1 never costs a quota unit — the schema stops it here.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #17 — the excerpt reaches both wire surfaces from a real upstream payload
// ---------------------------------------------------------------------------

describe('search excerpt on the wire', () => {
  it('derives the excerpt from body_markdown and carries it on both surfaces', async () => {
    mockFetch(() =>
      seOk({
        items: [
          {
            question_id: 11227809,
            title: 'Why is a sorted array faster?',
            link: 'https://stackoverflow.com/q/11227809',
            score: 28000,
            answer_count: 27,
            is_answered: true,
            tags: ['java', 'performance'],
            body_markdown: 'It&#39;s branch prediction.\n\n    if (data[c] >= 128)\n\nWhy so fast?',
          },
        ],
      }),
    );

    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'sorted array' });

    expect(result.isError).toBeFalsy();
    const questions = (
      result.structuredContent as { questions: { excerpt?: string }[]; page: number }
    ).questions;
    expect(questions[0]!.excerpt).toBe(`It's branch prediction. Why so fast?`);
    expect((result.structuredContent as { page: number }).page).toBe(1);
    expect(wireText(result)).toContain(`It's branch prediction. Why so fast?`);
  });

  // -------------------------------------------------------------------------
  // #26 — markdown syntax stripped from the excerpt on both surfaces
  // -------------------------------------------------------------------------

  it('flattens a resolvable reference link, drops the definition and quote marker, and leaves an unresolved pair alone', async () => {
    mockFetch(() =>
      seOk({
        items: [
          {
            question_id: 37433157,
            title: 'Sending mail with an async SMTP client',
            link: 'https://stackoverflow.com/q/37433157',
            score: 12,
            answer_count: 2,
            is_answered: true,
            tags: ['python', 'tornado'],
            // Entity-encoded the way SE ships body_markdown — the quote marker
            // arrives as &gt;, so decoding has to precede the strip.
            body_markdown:
              '&gt; [Microsoft][SQL Server]Cannot open backup device.\n\nI have an [asynchronous API][1] which I&#39;m using to connect.\n\n  [1]: https://github.com/vuamitom/tornado-smtpclient\n',
          },
        ],
      }),
    );

    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'async smtp' });

    expect(result.isError).toBeFalsy();
    // Parsed through the tool's own output schema — the framework builds
    // structuredContent that way, so an undeclared field would be stripped here.
    const excerpt = stackexchangeSearchQuestions.output.parse(result.structuredContent).questions[0]
      ?.excerpt;
    expect(excerpt).toBe(
      "[Microsoft][SQL Server]Cannot open backup device. I have an asynchronous API which I'm using to connect.",
    );
    // The same prose on the format()-only surface, not just in the JSON one.
    expect(wireText(result)).toContain(excerpt!);
  });
});

// ---------------------------------------------------------------------------
// #20 — opt-in comments reach both wire surfaces, empty distinct from unknown
// ---------------------------------------------------------------------------

const QUESTION_ID = 11227809;
const ANSWER_A = 11227902;
const ANSWER_B = 11227808;

/**
 * Route the whole getThread call graph. `answerComments` is the ONE combined
 * list `/answers/{ids}/comments` returns across every requested answer, and
 * `answerCommentsHasMore` reproduces a page SE cut short.
 */
const mockThreadFetch = (opts: {
  questionComments?: Record<string, unknown>[];
  answerComments?: Record<string, unknown>[];
  answerCommentsHasMore?: boolean;
}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/comments')) {
      const isQuestionRoute = url.includes('/questions/');
      return seOk({
        items: isQuestionRoute ? (opts.questionComments ?? []) : (opts.answerComments ?? []),
        has_more: isQuestionRoute ? false : (opts.answerCommentsHasMore ?? false),
      });
    }
    if (url.includes('/answers')) {
      return seOk({
        items: [
          {
            answer_id: ANSWER_A,
            question_id: QUESTION_ID,
            score: 100,
            is_accepted: true,
            body: '<p>First answer.</p>',
          },
          {
            answer_id: ANSWER_B,
            question_id: QUESTION_ID,
            score: 20,
            is_accepted: false,
            body: '<p>Second answer.</p>',
          },
        ],
      });
    }
    return seOk({
      items: [
        {
          question_id: QUESTION_ID,
          title: 'Why is processing a sorted array faster?',
          link: 'https://stackoverflow.com/q/11227809',
          score: 28000,
          answer_count: 2,
          is_answered: true,
          tags: ['java'],
          body: '<p>Question body.</p>',
        },
      ],
    });
  });

interface WireThread {
  answers: { answerId: number; comments?: { commentId: number }[]; commentsTruncated?: boolean }[];
  comments?: { commentId: number; bodyMarkdown: string }[];
}

const wireThread = (result: ToolResult): WireThread => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as unknown as WireThread;
};

describe('get_thread comments on the wire', () => {
  it('costs no extra call and carries no comments by default', async () => {
    const fetchSpy = mockThreadFetch({});

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: String(QUESTION_ID),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const thread = wireThread(result);
    expect(thread.comments).toBeUndefined();
    expect(thread.answers.every((a) => a.comments === undefined)).toBe(true);
    expect(wireText(result)).not.toMatch(/Comments/i);
  });

  it('carries markdown-normalized comments on both surfaces when opted in', async () => {
    mockThreadFetch({
      questionComments: [
        {
          comment_id: 900,
          post_id: QUESTION_ID,
          score: 3,
          creation_date: 1_711_712_583,
          body: 'Too bad we can&#39;t edit comments.',
          owner: {
            display_name: 'Peter Cordes',
            link: 'https://stackoverflow.com/users/224132/peter-cordes',
          },
        },
      ],
      answerComments: [
        {
          comment_id: 901,
          post_id: ANSWER_A,
          score: 12,
          creation_date: 1_708_378_290,
          body: 'This breaks on v3 — use <code>cmov</code> instead, see <a href="https://example.com/x">the note</a>.',
          owner: { display_name: 'Reviewer', link: 'https://stackoverflow.com/users/2/reviewer' },
        },
        { comment_id: 902, post_id: ANSWER_B, score: 0, body: 'Only works on POSIX.' },
      ],
    });

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: String(QUESTION_ID),
      includeComments: true,
    });

    const thread = wireThread(result);
    // Entity-decoded and inline markup converted — comments take the same
    // normalizeHtml pass a post body does.
    expect(thread.comments?.[0]?.bodyMarkdown).toBe("Too bad we can't edit comments.");
    const byId = new Map(thread.answers.map((a) => [a.answerId, a]));
    expect(byId.get(ANSWER_A)?.comments?.[0]?.commentId).toBe(901);
    expect(byId.get(ANSWER_B)?.comments?.[0]?.commentId).toBe(902);

    const text = wireText(result);
    expect(text).toContain(
      'This breaks on v3 — use `cmov` instead, see [the note](https://example.com/x).',
    );
    expect(text).toContain('Only works on POSIX.');
    expect(text).toContain("Too bad we can't edit comments.");
  });

  it('keeps a starved post distinguishable from a comment-free one on both surfaces', async () => {
    // The live shape: two answer IDs, one combined page, every comment belonging
    // to the first answer, has_more still set.
    mockThreadFetch({
      questionComments: [],
      answerComments: [{ comment_id: 901, post_id: ANSWER_A, score: 1, body: 'Present.' }],
      answerCommentsHasMore: true,
    });

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: String(QUESTION_ID),
      includeComments: true,
    });

    const thread = wireThread(result);
    const byId = new Map(thread.answers.map((a) => [a.answerId, a]));
    // JSON surface: absent, never an empty array.
    expect(byId.get(ANSWER_B)?.comments).toBeUndefined();
    expect(byId.get(ANSWER_B)?.comments).not.toEqual([]);
    // The question genuinely has none, and says so.
    expect(thread.comments).toEqual([]);

    // Rendered surface: the starved answer does not read as comment-free.
    const text = wireText(result);
    const starvedSection = text.slice(text.indexOf(`### Answer ${ANSWER_B}`));
    expect(starvedSection).toMatch(/unknown/i);
    expect(starvedSection).not.toMatch(/No comments/i);
    // ...while the question's genuinely empty list does.
    expect(text.slice(text.indexOf('## Question'), text.indexOf('## Answers'))).toMatch(
      /No comments/i,
    );
  });

  it('blames the caller for an `ids` rejection from the question comments route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/questions/') && url.includes('/comments')) return seBadParameter('ids');
      if (url.includes('/comments')) return seOk({ items: [] });
      if (url.includes('/answers')) {
        return seOk({
          items: [
            {
              answer_id: ANSWER_A,
              question_id: QUESTION_ID,
              score: 1,
              is_accepted: false,
              body: '<p>A.</p>',
            },
          ],
        });
      }
      return seOk({
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
      });
    });

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: String(QUESTION_ID),
      includeComments: true,
    });

    const error = wireError(result);
    // `ids` on /questions/{id}/comments IS the caller's question ID, so it
    // reuses the mapping the other /questions routes already carry.
    expect(error.data?.reason).toBe('invalid_id_or_url');
    expect(error.message).toBe('The question ID is not a valid Stack Exchange question ID.');
    expectRecoveryParity(result, stackexchangeGetThread, 'invalid_id_or_url');
  });

  it('does not blame the caller for an `ids` rejection from the batched answers comments route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/answers/') && url.includes('/comments')) return seBadParameter('ids');
      if (url.includes('/comments')) return seOk({ items: [] });
      if (url.includes('/answers')) {
        return seOk({
          items: [
            {
              answer_id: ANSWER_A,
              question_id: QUESTION_ID,
              score: 1,
              is_accepted: false,
              body: '<p>A.</p>',
            },
          ],
        });
      }
      return seOk({
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
      });
    });

    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: String(QUESTION_ID),
      includeComments: true,
    });

    const error = wireError(result);
    // These `ids` are the answer IDs SE itself returned — telling the caller to
    // fix their question ID would send them after the wrong thing.
    expect(error.message).not.toContain('question ID');
    expect(error.data?.reason).toBe('invalid_parameter');
    expect(declaredReasons(stackexchangeGetThread)).toContain(error.data?.reason);
    expectRecoveryParity(result, stackexchangeGetThread, 'invalid_parameter');
  });
});

// ---------------------------------------------------------------------------
// #24 — stackexchange_list_sites declares the reasons its page walk can raise
// ---------------------------------------------------------------------------

/**
 * Drive a call whose failure carries a transient code. `withRetry` sleeps
 * 1s/2s/4s before giving up, so fake timers advance those sleeps rather than
 * waiting them out. `afterEach` restores the real clock.
 */
const runTransient = async (run: () => Promise<ToolResult>): Promise<ToolResult> => {
  vi.useFakeTimers();
  const pending = run();
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5_000);
  return pending;
};

/** The 1-based page a /sites request asked for. */
const pageOf = (input: unknown): number =>
  Number(new URL(String(input)).searchParams.get('page') ?? '1');

/** One /sites page, its single entry tagged with the page that served it. */
const sitePage = (
  page: number,
  opts: { hasMore?: boolean; quotaRemaining?: number } = {},
): Response =>
  seOk({
    items: [
      {
        name: `Site ${page}`,
        api_site_parameter: `site-${page}`,
        site_url: `https://site-${page}.example.com`,
      },
    ],
    has_more: opts.hasMore ?? false,
    ...(opts.quotaRemaining !== undefined ? { quota_remaining: opts.quotaRemaining } : {}),
  });

describe('stackexchange_list_sites error contract', () => {
  it('advertises a contract at all, so ctx.recoveryFor has something to resolve', () => {
    // Pre-fix this tool declared no errors[], so every failure reached the
    // caller with no reason to branch on and no recovery hint.
    expect(declaredReasons(stackexchangeListSites).length).toBeGreaterThan(0);
  });

  it('carries every walked page onto both surfaces', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => sitePage(pageOf(input), { hasMore: pageOf(input) < 3 }));

    const result = await runToolContract(stackexchangeListSites, {});

    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Parsed through the tool's own output schema — a raw handler return would
    // not pin the emitted shape.
    const output = stackexchangeListSites.output.parse(result.structuredContent);
    expect(output.totalCount).toBe(3);
    expect(output.sites.map((s) => s.apiSiteParameter)).toEqual(['site-1', 'site-2', 'site-3']);
    // The pages past the first reach the rendered surface too, not just the JSON one.
    expect(wireText(result)).toContain('site-3');
  });

  it('declares quota_exceeded and stops the walk when quota lands at zero', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        sitePage(pageOf(input), { hasMore: true, quotaRemaining: 0 }),
      );

    const result = await runTransient(() => runToolContract(stackexchangeListSites, {}));

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('quota_exceeded');
    expect(declaredReasons(stackexchangeListSites)).toContain('quota_exceeded');
    expectRecoveryParity(result, stackexchangeListSites, 'quota_exceeded');
    // The walk never advanced past the page that reported the quota spent —
    // nine further requests against an exhausted quota is what the check buys.
    expect(fetchSpy.mock.calls.every((call) => pageOf(call[0]) === 1)).toBe(true);
  });

  it('declares invalid_parameter for a rejected page-walk parameter', async () => {
    mockFetch(() => seBadParameter('pagesize'));

    const result = await runToolContract(stackexchangeListSites, {});

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_parameter');
    expect(error.message).toContain('pagesize');
    expectRecoveryParity(result, stackexchangeListSites, 'invalid_parameter');
  });

  it('declares upstream_unavailable when the body is not JSON', async () => {
    mockFetch(() => new Response('<html>Bad Gateway</html>', { status: 200 }));

    const result = await runTransient(() => runToolContract(stackexchangeListSites, {}));

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_unavailable');
    expectRecoveryParity(result, stackexchangeListSites, 'upstream_unavailable');
  });

  it('carries upstream_unavailable from the shared parse path on a sibling tool', async () => {
    mockFetch(() => new Response('<html>Bad Gateway</html>', { status: 200 }));

    const result = await runTransient(() =>
      runToolContract(stackexchangeSearchQuestions, { query: 'generics' }),
    );

    // The throw site is shared, so the reason it puts on the wire has to be one
    // every calling tool declares — not one only stackexchange_list_sites has.
    expect(wireError(result).data?.reason).toBe('upstream_unavailable');
    expectRecoveryParity(result, stackexchangeSearchQuestions, 'upstream_unavailable');
  });
});

// ---------------------------------------------------------------------------
// #25 — an unrecognized API key is a deployment fault, not a caller one
// ---------------------------------------------------------------------------

/**
 * SE's rejection of a key it does not recognize, reproduced live against
 * api.stackexchange.com: `bad_parameter` on HTTP 400, whose `error_message` is
 * prose naming the `key` parameter rather than the bare name of a refused field.
 */
const UNRECOGNIZED_KEY_MESSAGE = "`key` doesn't match a known application";

/** Not a credential — a placeholder that must never reach either wire surface. */
const FAKE_CONFIGURED_KEY = 'placeholder-not-a-real-stack-apps-key';

/** Assert the failure reads as the deployment's problem, on both surfaces. */
const expectDeploymentFault = (result: ToolResult, def: Contracted): void => {
  const error = wireError(result);
  expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
  expect(error.data?.reason).toBe('invalid_api_key');
  expect(declaredReasons(def)).toContain('invalid_api_key');
  expectRecoveryParity(result, def, 'invalid_api_key');
  // The remedy names the environment variable an operator has to fix.
  expect(error.message).toContain('STACKEXCHANGE_API_KEY');
  expect(wireText(result)).toContain('STACKEXCHANGE_API_KEY');
};

describe('unrecognized API key', () => {
  beforeEach(() => {
    mockFetch(() => seBadParameter(UNRECOGNIZED_KEY_MESSAGE));
  });

  it('is a configuration fault on stackexchange_search_questions', async () => {
    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'generics' });
    expectDeploymentFault(result, stackexchangeSearchQuestions);
  });

  it('is a configuration fault on stackexchange_get_tag_faq', async () => {
    const result = await runToolContract(stackexchangeGetTagFaq, { tag: 'python' });
    expectDeploymentFault(result, stackexchangeGetTagFaq);
  });

  it('is a configuration fault on stackexchange_get_user', async () => {
    const result = await runToolContract(stackexchangeGetUser, { userId: 22656 });
    expectDeploymentFault(result, stackexchangeGetUser);
  });

  it('is a configuration fault on stackexchange_get_thread', async () => {
    const result = await runToolContract(stackexchangeGetThread, {
      questionIdOrUrl: '11227809',
    });
    expectDeploymentFault(result, stackexchangeGetThread);
  });

  it('is a configuration fault on stackexchange_list_sites', async () => {
    const result = await runToolContract(stackexchangeListSites, {});
    expectDeploymentFault(result, stackexchangeListSites);
  });

  it('is never reported as invalid_site', async () => {
    const result = await runToolContract(stackexchangeSearchQuestions, {
      query: 'generics',
      site: 'stackoverflow',
    });

    const error = wireError(result);
    // The site was fine. Steering the caller to stackexchange_list_sites would
    // send them after a value that is not the problem.
    expect(error.data?.reason).not.toBe('invalid_site');
    expect(wireText(result)).not.toContain('stackexchange_list_sites');
  });

  it('never quotes the prose back as the name of a refused parameter', async () => {
    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'generics' });

    const error = wireError(result);
    // Pre-fix: `Stack Exchange rejected the "`key` doesn't match a known
    // application" parameter.` — a sentence presented as a field name.
    expect(error.data?.reason).not.toBe('invalid_parameter');
    expect(error.message).not.toContain("doesn't match a known application");
  });

  it('never echoes the configured key onto either surface', async () => {
    initStackExchangeService({} as AppConfig, {} as StorageService, FAKE_CONFIGURED_KEY);

    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'generics' });

    expectDeploymentFault(result, stackexchangeSearchQuestions);
    // The whole envelope, not just the message — data and content[] included.
    expect(JSON.stringify(result)).not.toContain(FAKE_CONFIGURED_KEY);
  });
});

describe('field-name rejections are untouched by the key classification', () => {
  it('leaves a genuine field-name rejection on invalid_parameter', async () => {
    mockFetch(() => seBadParameter('pagesize'));

    const result = await runToolContract(stackexchangeGetTagFaq, { tag: 'python', pageSize: 30 });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_parameter');
    expect(error.message).toContain('pagesize');
    expectRecoveryParity(result, stackexchangeGetTagFaq, 'invalid_parameter');
  });

  it('does not fire on a field name that merely contains "key"', async () => {
    // The classification is anchored to the start of the message, so a field
    // name with "key" inside it stays a caller parameter problem.
    mockFetch(() => seBadParameter('monkey'));

    const result = await runToolContract(stackexchangeSearchQuestions, { query: 'generics' });

    const error = wireError(result);
    expect(error.data?.reason).toBe('invalid_parameter');
    expect(error.message).toContain('monkey');
  });

  it('leaves the unknown-site rejection on invalid_site', async () => {
    mockFetch(() => seBadParameter(UNKNOWN_SITE_MESSAGE));

    const result = await runToolContract(stackexchangeSearchQuestions, {
      query: 'generics',
      site: 'notarealsite',
    });

    expect(wireError(result).data?.reason).toBe('invalid_site');
    expectRecoveryParity(result, stackexchangeSearchQuestions, 'invalid_site');
  });
});
