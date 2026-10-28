/**
 * @fileoverview Cancellation, deadline, and throttle coverage across the real
 * upstream seam.
 * @module tests/services/stackexchange/pacing
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeListSites } from '@/mcp-server/tools/definitions/stackexchange-list-sites.tool.js';
import {
  getStackExchangeService,
  initStackExchangeService,
  StackExchangeService,
} from '@/services/stackexchange/stackexchange-service.js';

/**
 * The service sleeps out an upstream backoff through `node:timers/promises`,
 * which fake timers do not reach. Route it through the global clock so they do,
 * rejecting on abort with the `AbortError` Node's own implementation raises.
 */
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const aborted = () => new DOMException('The operation was aborted', 'AbortError');
      if (signal?.aborted) {
        reject(aborted());
        return;
      }
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(aborted());
      };
      const timer = globalThis.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
}));

const makeService = () => new StackExchangeService({} as AppConfig, {} as StorageService);
const response = (backoff?: number) =>
  new Response(
    JSON.stringify({ items: [], has_more: false, quota_remaining: 100, quota_max: 300, backoff }),
  );
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('upstream pacing', () => {
  it('reports a backoff past the deadline as throttled on both response surfaces', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(120));
    initStackExchangeService({} as AppConfig, {} as StorageService);
    await runToolContract(stackexchangeListSites, {});
    const result = runToolContract(stackexchangeListSites, {});
    await vi.advanceTimersByTimeAsync(50_001);
    const output = await result;
    expect(output.isError).toBe(true);
    expect(output.structuredContent).toMatchObject({
      error: { data: { reason: 'throttled' } },
    });
    expect(output.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('throttled'),
        }),
      ]),
    );
    getStackExchangeService().dispose();
  });

  it('disposal rejects queued work without dispatching it', async () => {
    vi.useFakeTimers();
    // A backoff the active call can sleep out within its deadline, holding the
    // slot so the next call queues behind it.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(20));
    const service = makeService();
    await service.getSites(createMockContext());
    const controller = new AbortController();
    const active = service
      .getSites(createMockContext({ signal: controller.signal }))
      .catch((error) => error);
    const queued = service.getSites(createMockContext()).catch((error) => error);
    service.dispose();
    expect(await queued).toMatchObject({ code: -32011 });
    controller.abort();
    await active;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honors an upstream backoff before the next request', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(2))
      .mockImplementation(async () => response());
    const service = makeService();
    await service.getSites(createMockContext());
    const next = service.getSites(createMockContext());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels a request while waiting for upstream backoff', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(20))
      .mockImplementation(async () => response());
    const service = makeService();
    await service.getSites(createMockContext());
    const controller = new AbortController();
    let settled = false;
    const next = service.getSites(createMockContext({ signal: controller.signal })).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await next;
  });

  it('bounds a long upstream backoff by the operation deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(120))
      .mockImplementation(async () => response());
    const service = makeService();
    await service.getSites(createMockContext());
    let failure: unknown;
    const next = service.getSites(createMockContext()).catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(50_001);
    expect(failure).toMatchObject({ data: { reason: 'throttled' } });
    await next;
  });

  it('keeps concurrent callers behind a newly received backoff and cancels queued work', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(120));
    const service = makeService();
    const controller = new AbortController();
    const first = service.getSites(createMockContext());
    const waiting = service
      .getSites(createMockContext({ signal: controller.signal }))
      .catch((error) => error);
    const queued = service
      .getSites(createMockContext({ signal: controller.signal }))
      .catch((error) => error);
    await first;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    await Promise.all([waiting, queued]);
    expect(fetch).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('does not dispatch sibling requests after a terminal error', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ error_name: 'bad_parameter', error_id: 400, error_message: 'site' }),
            { status: 400 },
          ),
      );
    await expect(
      makeService().getUser({ userId: 1, site: 'invalid' }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_site' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Throttle classification and deadline-checked waits (#30, #33)
// ---------------------------------------------------------------------------

/** OPERATION_DEADLINE_MS — every call must settle inside it. */
const DEADLINE_MS = 50_000;

/** SE's method-error envelope; every method error arrives on HTTP 400. */
const seEnvelope = (errorName: string, errorId: number, errorMessage: string) =>
  new Response(
    JSON.stringify({ error_id: errorId, error_message: errorMessage, error_name: errorName }),
    { status: 400 },
  );

/** A bare HTTP 429, optionally naming its wait in `Retry-After`. */
const tooManyRequests = (retryAfter?: string) =>
  new Response('', {
    status: 429,
    ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
  });

const THROTTLE_MESSAGE = 'too many requests from this IP, more requests available in 83980 seconds';

/** A fetch spy that rejects every request a test did not stub, so each one is counted. */
const stubFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));

/** A request that never answers until its signal aborts — holds the pacer's one slot. */
const hangUntilAborted = async (_input: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Track a call's outcome and the fake-clock instant it settled at. */
const track = <T>(promise: Promise<T>) => {
  const outcome: { error?: McpError; settledAt?: number; value?: T } = {};
  const done = promise.then(
    (value) => {
      outcome.value = value;
      outcome.settledAt = Date.now();
    },
    (error: McpError) => {
      outcome.error = error;
      outcome.settledAt = Date.now();
    },
  );
  return { done, outcome };
};

describe('throttle classification and deadline-checked waits', () => {
  it.each([
    [
      'a throttle_violation envelope',
      () => seEnvelope('throttle_violation', 502, THROTTLE_MESSAGE),
      JsonRpcErrorCode.RateLimited,
      { reason: 'throttled', retryAfter: 83_980 },
      1,
    ],
    [
      'an HTTP 429 naming its wait in Retry-After',
      () => tooManyRequests('45'),
      JsonRpcErrorCode.RateLimited,
      { reason: 'throttled', retryAfter: 45 },
      1,
    ],
    [
      'an HTTP 429 naming its wait as a Retry-After date',
      // HTTP-dates carry whole seconds, so the wait reads back as 45 after rounding up.
      () => tooManyRequests(new Date(Date.now() + 45_000).toUTCString()),
      JsonRpcErrorCode.RateLimited,
      { reason: 'throttled', retryAfter: 45 },
      1,
    ],
    [
      'a temporarily_unavailable envelope',
      () => seEnvelope('temporarily_unavailable', 503, 'simulated'),
      JsonRpcErrorCode.ServiceUnavailable,
      { reason: 'upstream_unavailable' },
      4,
    ],
    [
      'an internal_error envelope',
      () => seEnvelope('internal_error', 500, 'simulated'),
      JsonRpcErrorCode.ServiceUnavailable,
      { reason: 'upstream_unavailable' },
      4,
    ],
  ])('classifies %s', async (_label, answer, code, data, requests) => {
    vi.useFakeTimers();
    const fetch = stubFetch().mockImplementation(async () => answer());
    const call = track(makeService().getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(20_000);
    await call.done;
    expect(call.outcome.error?.code).toBe(code);
    expect(call.outcome.error?.data).toMatchObject(data);
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it('fills an unstated throttle wait from the cooldown gate and keeps the reason through the retry rewrap', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch().mockImplementation(async () =>
      seEnvelope('throttle_violation', 502, 'simulated'),
    );
    const call = track(makeService().getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(20_000);
    await call.done;
    // Four attempts: the gate doubles 1s → 2s → 4s → 8s, and each wait is the
    // gate the rate limit just closed.
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(call.outcome.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(call.outcome.error?.data).toMatchObject({
      reason: 'throttled',
      retryAfter: 8,
      retryAttempts: 4,
    });
    expect(call.outcome.error?.message).toContain('failed after 4 attempts');
  });

  it('puts the throttle wait in the message, where format()-only clients read it', async () => {
    stubFetch().mockImplementation(async () =>
      seEnvelope('throttle_violation', 502, THROTTLE_MESSAGE),
    );
    const call = track(makeService().getSites(createMockContext()));
    await call.done;
    expect(call.outcome.error?.message).toContain('83980 seconds');
  });

  it.each([
    ['a bare HTTP 429', () => tooManyRequests()],
    ['a temporarily_unavailable envelope', () => seEnvelope('temporarily_unavailable', 503, 'x')],
    ['an internal_error envelope', () => seEnvelope('internal_error', 500, 'x')],
    ['an HTTP 408', () => new Response('', { status: 408 })],
  ])('retries %s and succeeds within one call', async (_label, answer) => {
    vi.useFakeTimers();
    const fetch = stubFetch()
      .mockImplementationOnce(async () => answer())
      .mockImplementationOnce(async () => response());
    const call = track(makeService().getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(2_000);
    await call.done;
    expect(call.outcome.error).toBeUndefined();
    expect(call.outcome.value?.sites).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses the next call without a request once a throttle names its wait', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch().mockImplementationOnce(async () =>
      seEnvelope('throttle_violation', 502, THROTTLE_MESSAGE),
    );
    const service = makeService();
    await track(service.getSites(createMockContext())).done;
    const next = track(service.getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(0);
    await next.done;
    expect(next.outcome.error?.data?.reason).toBe('throttled');
    const retryAfter = next.outcome.error?.data?.retryAfter as number;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(83_980);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails at once on a backoff that outlasts the deadline, sending no request', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch().mockImplementationOnce(async () => response(120));
    const service = makeService();
    await service.getSites(createMockContext());
    const next = track(service.getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(0);
    expect(next.outcome.settledAt).toBeDefined();
    expect(next.outcome.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(next.outcome.error?.data?.reason).toBe('throttled');
    const retryAfter = next.outcome.error?.data?.retryAfter as number;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(120);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports throttled, not the deadline, when the budget runs out behind repeated 429s', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch().mockImplementation(async () => tooManyRequests('20'));
    const startedAt = Date.now();
    const call = track(makeService().getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await call.done;
    // 0s, 20s, 40s — the third 429's 20s wait no longer fits the 10s left.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(call.outcome.error?.data).toMatchObject({ reason: 'throttled', retryAfter: 20 });
    expect(call.outcome.settledAt! - startedAt).toBeLessThan(DEADLINE_MS);
  });

  it.each([
    [
      'getTagFaq',
      (s: StackExchangeService) => s.getTagFaq({ tag: 'python', site: 'so' }, createMockContext()),
    ],
    [
      'searchQuestions',
      (s: StackExchangeService) =>
        s.searchQuestions({ query: 'q', site: 'so' }, createMockContext()),
    ],
    ['getSites', (s: StackExchangeService) => s.getSites(createMockContext())],
    [
      'getUser',
      (s: StackExchangeService) => s.getUser({ userId: 1, site: 'so' }, createMockContext()),
    ],
    [
      'getThread',
      (s: StackExchangeService) => s.getThread({ questionId: 1, site: 'so' }, createMockContext()),
    ],
  ])('%s sends no request after one reports a spent quota', async (_name, call) => {
    vi.useFakeTimers();
    // Stack Exchange answers a request sent against a spent quota with a
    // throttle_violation, so only the first request reports quota_remaining: 0.
    const fetch = stubFetch()
      .mockImplementation(async () => seEnvelope('throttle_violation', 502, THROTTLE_MESSAGE))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  question_id: 1,
                  user_id: 1,
                  title: 't',
                  link: 'l',
                  display_name: 'u',
                  reputation: 1,
                },
              ],
              has_more: false,
              quota_remaining: 0,
              quota_max: 300,
            }),
          ),
      );
    const pending = track<unknown>(call(makeService()));
    await vi.advanceTimersByTimeAsync(20_000);
    await pending.done;
    expect(pending.outcome.error?.data).toMatchObject({
      reason: 'quota_exceeded',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('settles three concurrent callers on a bare 429 as throttled or shed, inside the deadline', async () => {
    vi.useFakeTimers();
    stubFetch().mockImplementation(async () => tooManyRequests());
    const service = makeService();
    const startedAt = Date.now();
    const calls = [1, 2, 3].map(() =>
      track(service.searchQuestions({ query: 'q', site: 'so' }, createMockContext())),
    );
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await Promise.all(calls.map((c) => c.done));
    for (const { outcome } of calls) {
      expect(['throttled', 'pacer_shed']).toContain(outcome.error?.data?.reason);
      expect(typeof outcome.error?.data?.retryAfter).toBe('number');
      expect(outcome.settledAt! - startedAt).toBeLessThan(DEADLINE_MS);
    }
  });

  it('fails callers queued behind a long throttle at once, sending nothing for them', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch().mockImplementationOnce(async () =>
      seEnvelope('throttle_violation', 502, THROTTLE_MESSAGE),
    );
    const service = makeService();
    const startedAt = Date.now();
    const calls = [0, 1, 2, 3].map((i) =>
      track(service.searchQuestions({ query: `q${i}`, site: 'so' }, createMockContext())),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    for (const { outcome } of calls) {
      expect(outcome.settledAt! - startedAt).toBeLessThanOrEqual(1_000);
      expect(outcome.error?.data).toMatchObject({ reason: 'throttled' });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls.map(({ done }) => done));
  });

  it('sheds a caller queued behind a held slot before the deadline, never dispatching it', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch()
      .mockImplementationOnce(async () => response(40))
      .mockImplementationOnce(hangUntilAborted);
    const service = makeService();
    await service.getSites(createMockContext());
    const startedAt = Date.now();
    // Sleeps the 40s backoff in the slot, then hangs there.
    const holder = track(service.getSites(createMockContext()));
    const target = track(service.getSites(createMockContext()));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await Promise.all([holder.done, target.done]);
    expect(target.outcome.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(target.outcome.error?.data?.reason).toBe('pacer_shed');
    expect(typeof target.outcome.error?.data?.retryAfter).toBe('number');
    expect(target.outcome.settledAt! - startedAt).toBeLessThan(DEADLINE_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never relabels a caller abort during a 429 retry wait as throttled', async () => {
    vi.useFakeTimers();
    stubFetch().mockImplementation(async () => tooManyRequests());
    const controller = new AbortController();
    const call = track(makeService().getSites(createMockContext({ signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await call.done;
    expect((call.outcome.error as unknown as Error).name).toBe('AbortError');
    expect(call.outcome.error?.data?.reason).toBeUndefined();
  });

  it('never relabels a caller abort during an upstream backoff as throttled', async () => {
    vi.useFakeTimers();
    stubFetch().mockImplementationOnce(async () => response(20));
    const service = makeService();
    await service.getSites(createMockContext());
    const controller = new AbortController();
    const call = track(service.getSites(createMockContext({ signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await call.done;
    expect((call.outcome.error as unknown as Error).name).toBe('AbortError');
    expect(call.outcome.error?.data?.reason).toBeUndefined();
  });
});
