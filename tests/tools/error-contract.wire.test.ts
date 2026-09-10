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
