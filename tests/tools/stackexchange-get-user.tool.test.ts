/**
 * @fileoverview Tests for the stackexchange_get_user tool.
 * Covers happy path, user-not-found (empty items[]), sparse profiles (no badges/location/
 * website/topTags), error propagation, and format().
 * @module tests/tools/stackexchange-get-user.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetUser } from '@/mcp-server/tools/definitions/stackexchange-get-user.tool.js';
import type { NormalizedUser } from '@/services/stackexchange/stackexchange-service.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------
vi.mock('@/services/stackexchange/stackexchange-service.js', () => ({
  getStackExchangeService: vi.fn(),
}));

import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

const mockGetService = vi.mocked(getStackExchangeService);

const mockService = (service: Partial<ReturnType<typeof getStackExchangeService>>): void => {
  mockGetService.mockReturnValue(service as ReturnType<typeof getStackExchangeService>);
};

type FixtureOverrides<T> = { [K in keyof T]?: T[K] | undefined };

const withoutUndefined = <T extends object>(value: FixtureOverrides<T>): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

const makeUser = (overrides: FixtureOverrides<NormalizedUser> = {}): NormalizedUser =>
  withoutUndefined<NormalizedUser>({
    userId: 1,
    displayName: 'Jon Skeet',
    link: 'https://stackoverflow.com/users/1/jon-skeet',
    reputation: 1400000,
    badgeCounts: { gold: 860, silver: 9000, bronze: 9500 },
    location: 'Reading, UK',
    websiteUrl: 'https://codeblog.jonskeet.uk',
    answerCount: 38000,
    questionCount: 7500,
    topTags: [
      { tagName: 'c#', answerCount: 22000, answerScore: 300000 },
      { tagName: 'java', answerCount: 2000, answerScore: 40000 },
    ],
    ...overrides,
  });

const makeUserResult = (user = makeUser()) => ({
  getUser: vi.fn().mockResolvedValue({ user, quotaRemaining: 250, quotaMax: 300 }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------
describe('stackexchangeGetUser handler', () => {
  it('returns user for a valid user ID', async () => {
    mockService(makeUserResult());
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 1 });
    const result = await stackexchangeGetUser.handler(input, ctx);
    expect(result.userId).toBe(1);
    expect(result.displayName).toBe('Jon Skeet');
    expect(result.reputation).toBe(1400000);
  });

  it('defaults site to stackoverflow', async () => {
    const svc = makeUserResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 1 });
    await stackexchangeGetUser.handler(input, ctx);
    expect(svc.getUser).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'stackoverflow' }),
      ctx,
    );
  });

  it('throws user_not_found when service throws (empty items[])', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService({
      getUser: vi
        .fn()
        .mockRejectedValue(notFound('User ID 999999 not found', { reason: 'user_not_found' })),
    });
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 999999 });
    await expect(stackexchangeGetUser.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('returns sparse user with no badgeCounts, location, websiteUrl', async () => {
    const sparseUser = makeUser({
      badgeCounts: undefined,
      location: undefined,
      websiteUrl: undefined,
      answerCount: undefined,
      questionCount: undefined,
      topTags: [],
    });
    mockService(makeUserResult(sparseUser));
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 42 });
    const result = await stackexchangeGetUser.handler(input, ctx);
    expect(result.badgeCounts).toBeUndefined();
    expect(result.location).toBeUndefined();
    expect(result.topTags).toHaveLength(0);
  });

  it('passes custom site to service', async () => {
    const svc = makeUserResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 1, site: 'superuser' });
    await stackexchangeGetUser.handler(input, ctx);
    expect(svc.getUser).toHaveBeenCalledWith(expect.objectContaining({ site: 'superuser' }), ctx);
  });
});

// ---------------------------------------------------------------------------
// format() tests
// ---------------------------------------------------------------------------
describe('stackexchangeGetUser format', () => {
  it('renders display name, user ID, reputation, and profile link', () => {
    const blocks = stackexchangeGetUser.format!(makeUser());
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Jon Skeet');
    expect(text).toContain('1');
    expect(text).toContain('1,400,000');
    expect(text).toContain('https://stackoverflow.com/users/1/jon-skeet');
  });

  it('renders badge counts when present', () => {
    const blocks = stackexchangeGetUser.format!(makeUser());
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('860');
    expect(text).toContain('9000');
    expect(text).toContain('9500');
  });

  it('renders location and website when present', () => {
    const blocks = stackexchangeGetUser.format!(makeUser());
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Reading, UK');
    expect(text).toContain('https://codeblog.jonskeet.uk');
  });

  it('renders top tags with score and answer count', () => {
    const blocks = stackexchangeGetUser.format!(makeUser());
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('c#');
    expect(text).toContain('300000');
    expect(text).toContain('22000');
  });

  it('shows "No top tags" for user with no answers (sparse)', () => {
    const sparse = makeUser({
      topTags: [],
      badgeCounts: undefined,
      location: undefined,
      websiteUrl: undefined,
    });
    const blocks = stackexchangeGetUser.format!(sparse);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No top tags');
    // Should not contain "undefined"
    expect(text).not.toContain('undefined');
  });

  it('omits badge/location/website sections gracefully when absent (sparse)', () => {
    const sparse = makeUser({ badgeCounts: undefined, location: undefined, websiteUrl: undefined });
    const blocks = stackexchangeGetUser.format!(sparse);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Badges:');
    expect(text).not.toContain('Location:');
    expect(text).not.toContain('Website:');
    expect(text).not.toContain('undefined');
  });

  it('renders answer and question counts when present', () => {
    const blocks = stackexchangeGetUser.format!(makeUser());
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('38000');
    expect(text).toContain('7500');
  });

  it('omits posts section when both counts are absent (sparse)', () => {
    const sparse = makeUser({ answerCount: undefined, questionCount: undefined });
    const blocks = stackexchangeGetUser.format!(sparse);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Posts:');
  });
});
