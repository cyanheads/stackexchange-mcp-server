/**
 * @fileoverview Shared dispatch and Stack Exchange method backoff.
 * @module services/stackexchange/stackexchange-pacer
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  requestCancelled,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';

/** A wait stated by an IP-wide upstream throttle. */
export function throttled(
  retryAfter: number | undefined,
  data: Record<string, unknown> = {},
  cause?: unknown,
): McpError {
  const seconds = retryAfter === undefined ? undefined : Math.max(1, retryAfter);
  return rateLimited(
    seconds === undefined
      ? 'Stack Exchange is throttling requests from this server.'
      : `Stack Exchange is throttling requests from this server; retry in ${seconds} seconds.`,
    { ...data, reason: 'throttled', ...(seconds !== undefined && { retryAfter: seconds }) },
    cause === undefined ? undefined : { cause },
  );
}

/** One attempt's caller signal and absolute deadline for admission. */
export interface SeAttempt {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/**
 * Stack Exchange groups requests to the same route across sites and arguments.
 * Numeric IDs (including batches) and encoded tag names are path arguments.
 */
export function stackExchangeMethod(url: string): string {
  return new URL(url).pathname
    .replace(/^\/2\.3(?=\/)/, '')
    .replace(/^\/(questions|answers|users)\/-?\d+(?:;-?\d+)*(?=\/|$)/, '/$1/{ids}')
    .replace(/^\/tags\/[^/]+(?=\/faq$)/, '/tags/{tag}');
}

const BACKOFF_EXTENDED = Symbol('Stack Exchange extended a backoff');

/** One slot for upstream requests, with scope-specific waits before queue admission. */
export class StackExchangePacer {
  private readonly pacer = createPacer({
    name: 'stackexchange',
    maxConcurrent: 1,
    cooldown: { baseMs: 1000, maxMs: 30_000 },
  });
  private readonly shutdown = new AbortController();
  private readonly methodBackoffs = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private globalBackoff = 0;

  /** Cancel all waiters while leaving an active request to finish. */
  dispose(): void {
    this.pacer.dispose();
    this.shutdown.abort(requestCancelled('The stackexchange pacer has been disposed.'));
  }

  /** Record a successful method backoff, or an IP-wide wait named by a throttle error. */
  extendBackoff(seconds: number, method?: string): void {
    const until = Date.now() + seconds * 1000;
    if (method === undefined) {
      if (until <= this.globalBackoff) return;
      this.globalBackoff = until;
    } else {
      if (until <= (this.methodBackoffs.get(method) ?? 0)) return;
      this.methodBackoffs.set(method, until);
    }
    for (const listener of this.listeners) listener();
  }

  /** Hold the slot only for the request and its response classification. */
  async run<T>(method: string, attempt: SeAttempt, task: () => Promise<T>): Promise<T> {
    const waiting = AbortSignal.any([attempt.signal, this.shutdown.signal]);
    const backoffUntil = () => Math.max(this.globalBackoff, this.methodBackoffs.get(method) ?? 0);
    for (;;) {
      waiting.throwIfAborted();
      const until = backoffUntil();
      const now = Date.now();
      if (until > Math.max(now, attempt.deadlineAt)) {
        const seconds = Math.ceil((until - now) / 1000);
        if (until === this.globalBackoff) throw throttled(seconds);
        throw rateLimited(
          `Stack Exchange asked this server to back off the ${method} method; retry in ${seconds} seconds.`,
          { reason: 'throttled', retryAfter: seconds },
        );
      }

      const wake = new AbortController();
      // A newly blocked queue entry must withdraw before the current response
      // releases the slot. An off-slot sleeper rechecks the new absolute wait.
      const onBackoff = () => {
        if (backoffUntil() > until) wake.abort(BACKOFF_EXTENDED);
      };
      const signal = AbortSignal.any([waiting, wake.signal]);
      this.listeners.add(onBackoff);
      try {
        if (until > now) {
          await sleep(until - now, undefined, { signal });
          continue;
        }
        return await this.pacer.run(
          () => {
            this.listeners.delete(onBackoff);
            return task();
          },
          { signal, maxWaitMs: Math.max(0, attempt.deadlineAt - Date.now()) },
        );
      } catch (error) {
        if (signal.reason === BACKOFF_EXTENDED) continue;
        if (until > now) waiting.throwIfAborted();
        throw this.withStatedWait(error);
      } finally {
        this.listeners.delete(onBackoff);
      }
    }
  }

  private withStatedWait(error: unknown): unknown {
    if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.RateLimited) return error;
    const data = error.data ?? {};
    if (data.reason === 'throttled' && data.retryAfter === undefined) {
      return throttled(Math.ceil(this.pacer.cooldown.remainingMs / 1000), data, error.cause);
    }
    if (data.reason === 'pacer_shed') {
      return rateLimited(`${error.message} Retry in ${String(data.retryAfter)} seconds.`, data, {
        cause: error,
      });
    }
    return error;
  }
}
