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

const CREATED_ISO = '2008-09-26T12:05:05.000Z';
const LAST_ACCESS_ISO = '2026-09-09T19:54:05.000Z';

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
    creationDate: CREATED_ISO,
    lastAccessDate: LAST_ACCESS_ISO,
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

  it('rejects an out-of-range userId before calling the service', async () => {
    const declared = stackexchangeGetUser.errors?.find((e) => e.reason === 'invalid_user_id');
    expect(declared).toBeDefined();

    const svc = makeUserResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 2147483648 });

    // Bounded in the handler rather than the schema so the rejection travels
    // the contract path and carries a declared reason plus its recovery hint.
    await expect(stackexchangeGetUser.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_user_id',
        recovery: { hint: declared?.recovery },
      },
    });
    expect(svc.getUser).not.toHaveBeenCalled();
  });

  it('passes the largest in-range userId through to the service', async () => {
    const svc = makeUserResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 2147483647 });

    await stackexchangeGetUser.handler(input, ctx);

    expect(svc.getUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 2147483647 }), ctx);
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

// ---------------------------------------------------------------------------
// Date surfacing
// ---------------------------------------------------------------------------
describe('stackexchangeGetUser dates', () => {
  it('carries ISO 8601 account and last-access dates through structuredContent', async () => {
    mockService(makeUserResult());
    const ctx = createMockContext({ errors: stackexchangeGetUser.errors });
    const input = stackexchangeGetUser.input.parse({ userId: 1 });
    const result = await stackexchangeGetUser.handler(input, ctx);
    // Parsed through the tool's own output schema — the framework builds
    // structuredContent that way, so an undeclared field would be stripped here.
    const parsed = stackexchangeGetUser.output.parse(result);
    expect(parsed.creationDate).toBe(CREATED_ISO);
    expect(parsed.lastAccessDate).toBe(LAST_ACCESS_ISO);
  });

  it('renders both dates in format()', () => {
    const text = (stackexchangeGetUser.format!(makeUser())[0] as { text: string }).text;
    expect(text).toContain(`**Member since:** ${CREATED_ISO}`);
    expect(text).toContain(`**Last seen:** ${LAST_ACCESS_ISO}`);
  });

  it('omits the date labels when the profile carries neither date', () => {
    const sparse = makeUser({ creationDate: undefined, lastAccessDate: undefined });
    const text = (stackexchangeGetUser.format!(sparse)[0] as { text: string }).text;
    expect(text).not.toContain('Member since:');
    expect(text).not.toContain('Last seen:');
    expect(text).not.toContain('undefined');
  });
});
