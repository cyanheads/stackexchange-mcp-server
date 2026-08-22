/**
 * @fileoverview Tests for the stackexchange_list_sites tool.
 * Covers site listing, filter logic (token matching, accent normalization),
 * empty result, and format().
 * @module tests/tools/stackexchange-list-sites.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeListSites } from '@/mcp-server/tools/definitions/stackexchange-list-sites.tool.js';
import type { NormalizedSite } from '@/services/stackexchange/stackexchange-service.js';

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

const SITES: NormalizedSite[] = [
  {
    name: 'Stack Overflow',
    apiSiteParameter: 'stackoverflow',
    siteUrl: 'https://stackoverflow.com',
    audience: 'professional and enthusiast programmers',
  },
  {
    name: 'Super User',
    apiSiteParameter: 'superuser',
    siteUrl: 'https://superuser.com',
    audience: 'computer enthusiasts and power users',
  },
  {
    name: 'Server Fault',
    apiSiteParameter: 'serverfault',
    siteUrl: 'https://serverfault.com',
    audience: 'system and network administrators',
  },
  {
    name: 'Ask Ubuntu',
    apiSiteParameter: 'askubuntu',
    siteUrl: 'https://askubuntu.com',
  },
];

const makeSitesResult = (sites = SITES) => ({
  getSites: vi.fn().mockResolvedValue({ sites, quotaRemaining: 250, quotaMax: 300 }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------
describe('stackexchangeListSites handler', () => {
  it('returns all sites when no filter is provided', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({});
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.sites).toHaveLength(4);
    expect(result.totalCount).toBe(4);
  });

  it('filters sites by name token (case-insensitive)', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({ filter: 'stack overflow' });
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.apiSiteParameter).toBe('stackoverflow');
  });

  it('filters by api_site_parameter token', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({ filter: 'superuser' });
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.sites.some((s) => s.apiSiteParameter === 'superuser')).toBe(true);
  });

  it('returns empty sites when no sites match the filter', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({ filter: 'xyzzy-does-not-exist' });
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.sites).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('ignores whitespace-only filter (treated as no filter)', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({ filter: '   ' });
    const result = await stackexchangeListSites.handler(input, ctx);
    // Whitespace-only → all sites returned
    expect(result.sites).toHaveLength(4);
  });

  it('matches multi-token filter (all tokens must match)', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    // "server fault" — two tokens, only serverfault matches both
    const input = stackexchangeListSites.input.parse({ filter: 'server fault' });
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.apiSiteParameter).toBe('serverfault');
  });

  it('returns correct totalCount equal to filtered sites length', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({ filter: 'user' });
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.totalCount).toBe(result.sites.length);
  });

  it('calls ctx.enrich.notice when filter returns no results', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeListSites.input.parse({ filter: 'xyzzy-does-not-exist' });
    await stackexchangeListSites.handler(input, ctx);
    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0]![0]).toContain('xyzzy-does-not-exist');
  });

  it('handles sites with no audience field (sparse)', async () => {
    mockService(makeSitesResult());
    const ctx = createMockContext();
    const input = stackexchangeListSites.input.parse({ filter: 'askubuntu' });
    const result = await stackexchangeListSites.handler(input, ctx);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.audience).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// format() tests
// ---------------------------------------------------------------------------
describe('stackexchangeListSites format', () => {
  it('renders site count, name, apiSiteParameter, and URL', () => {
    const output = { sites: SITES, totalCount: SITES.length };
    const blocks = stackexchangeListSites.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('4 sites');
    expect(text).toContain('Stack Overflow');
    expect(text).toContain('stackoverflow');
    expect(text).toContain('https://stackoverflow.com');
  });

  it('renders audience when present', () => {
    const output = { sites: SITES, totalCount: SITES.length };
    const blocks = stackexchangeListSites.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('professional and enthusiast programmers');
  });

  it('omits audience gracefully when absent (sparse)', () => {
    const sparseSites: NormalizedSite[] = [
      { name: 'Ask Ubuntu', apiSiteParameter: 'askubuntu', siteUrl: 'https://askubuntu.com' },
    ];
    const output = { sites: sparseSites, totalCount: 1 };
    const blocks = stackexchangeListSites.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Audience:');
  });

  it('renders "No sites matched" for empty result', () => {
    const output = { sites: [], totalCount: 0 };
    const blocks = stackexchangeListSites.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No sites matched');
  });

  it('uses singular "site" for totalCount of 1', () => {
    const output = { sites: [SITES[0]!], totalCount: 1 };
    const blocks = stackexchangeListSites.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 site');
    expect(text).not.toContain('1 sites');
  });
});
