/**
 * @fileoverview Cancellation and deadline coverage across the real upstream seam.
 * @module tests/services/stackexchange/pacing
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeListSites } from '@/mcp-server/tools/definitions/stackexchange-list-sites.tool.js';
import {
  getStackExchangeService,
  initStackExchangeService,
  StackExchangeService,
} from '@/services/stackexchange/stackexchange-service.js';

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
  it('reports the deadline reason on both response surfaces', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(120));
    initStackExchangeService({} as AppConfig, {} as StorageService);
    await runToolContract(stackexchangeListSites, {});
    const result = runToolContract(stackexchangeListSites, {});
    await vi.advanceTimersByTimeAsync(50_001);
    const output = await result;
    expect(output.isError).toBe(true);
    expect(output.structuredContent).toMatchObject({
      error: { data: { reason: 'retry_deadline_exceeded' } },
    });
    expect(output.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('retry_deadline_exceeded'),
        }),
      ]),
    );
    getStackExchangeService().dispose();
  });

  it('disposal rejects queued work without dispatching it', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(120));
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
    expect(failure).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
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
