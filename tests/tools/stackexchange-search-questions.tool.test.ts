/**
 * @fileoverview Tests for the stackexchange_search_questions tool.
 * @module tests/tools/stackexchange-search-questions.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeSearchQuestions } from '@/mcp-server/tools/definitions/stackexchange-search-questions.tool.js';
import type { NormalizedQuestion } from '@/services/stackexchange/stackexchange-service.js';

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

const CREATED_ISO = '2012-06-27T12:51:36.000Z';
const ACTIVE_ISO = '2025-08-12T12:00:00.000Z';

const makeQuestion = (overrides: FixtureOverrides<NormalizedQuestion> = {}): NormalizedQuestion =>
  withoutUndefined<NormalizedQuestion>({
    questionId: 11227809,
    title: 'Why is processing a sorted array faster than processing an unsorted array?',
    link: 'https://stackoverflow.com/questions/11227809',
    score: 28000,
    answerCount: 27,
    isAnswered: true,
    tags: ['java', 'c++', 'performance', 'sorting'],
    creationDate: CREATED_ISO,
    lastActivityDate: ACTIVE_ISO,
    ...overrides,
  });

const makeSearchResult = (questions: NormalizedQuestion[] = [makeQuestion()], hasMore = false) => ({
  searchQuestions: vi.fn().mockResolvedValue({
    questions,
    quotaRemaining: 250,
    quotaMax: 300,
    hasMore,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------
describe('stackexchangeSearchQuestions handler', () => {
  it('returns questions for a valid query', async () => {
    mockService(makeSearchResult());
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'sorted array faster' });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.questionId).toBe(11227809);
    expect(result.attribution).toContain('CC BY-SA');
  });

  it('applies default site=stackoverflow and sort=relevance', async () => {
    const mockSvc = makeSearchResult();
    mockService(mockSvc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'test query' });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(mockSvc.searchQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'stackoverflow', sort: 'relevance' }),
      ctx,
    );
  });

  it('passes tags when provided', async () => {
    const mockSvc = makeSearchResult();
    mockService(mockSvc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({
      query: 'async await',
      tags: ['javascript', 'node.js'],
    });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(mockSvc.searchQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['javascript', 'node.js'] }),
      ctx,
    );
  });

  it('strips empty-string tags (form-client payload)', async () => {
    const mockSvc = makeSearchResult();
    mockService(mockSvc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({
      query: 'test',
      tags: ['', ''],
    });
    await stackexchangeSearchQuestions.handler(input, ctx);
    // Empty tags should be filtered out — tags key should be absent or empty
    const callArg = mockSvc.searchQuestions.mock.calls[0]![0] as Record<string, unknown>;
    const tags = callArg.tags as string[] | undefined;
    expect(!tags || tags.length === 0).toBe(true);
  });

  it('returns empty array when API returns no results (HTTP 200 with items=[])', async () => {
    mockService(makeSearchResult([]));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({
      query: 'xyzzy-does-not-exist-1234567',
    });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    expect(result.questions).toHaveLength(0);
  });

  it('passes minScore and acceptedOnly when provided', async () => {
    const mockSvc = makeSearchResult();
    mockService(mockSvc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({
      query: 'test',
      minScore: 5,
      acceptedOnly: true,
    });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(mockSvc.searchQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ minScore: 5, acceptedOnly: true }),
      ctx,
    );
  });

  it('propagates service errors (e.g. invalid_site → throws)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    mockService({
      searchQuestions: vi
        .fn()
        .mockRejectedValue(
          validationError('bad_parameter: invalid site', { reason: 'invalid_site' }),
        ),
    });
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({
      query: 'test',
      site: 'notasite',
    });
    await expect(stackexchangeSearchQuestions.handler(input, ctx)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// format() tests
// ---------------------------------------------------------------------------
const ATTRIBUTION =
  'Stack Exchange Network — content licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)';

describe('stackexchangeSearchQuestions format', () => {
  it('renders "No questions found" for empty result', () => {
    const blocks = stackexchangeSearchQuestions.format!({
      questions: [],
      page: 1,
      attribution: ATTRIBUTION,
    });
    expect(blocks[0]!.type).toBe('text');
    expect((blocks[0] as { text: string }).text).toContain('No questions found');
  });

  it('renders question ID and title in output', () => {
    const output = { questions: [makeQuestion()], page: 1, attribution: ATTRIBUTION };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('11227809');
    expect(text).toContain('sorted array faster');
  });

  it('renders score, answer count, tags, and link', () => {
    const output = { questions: [makeQuestion()], page: 1, attribution: ATTRIBUTION };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('28000');
    expect(text).toContain('27');
    expect(text).toContain('java');
    expect(text).toContain('https://stackoverflow.com/questions/11227809');
  });

  it('renders CC BY-SA attribution footer', () => {
    const output = { questions: [makeQuestion()], page: 1, attribution: ATTRIBUTION };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC BY-SA');
    expect(text).toContain('Stack Exchange Network');
  });

  it('includes excerpt when present', () => {
    const output = {
      questions: [makeQuestion({ excerpt: 'Branch prediction makes the difference.' })],
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Branch prediction makes the difference.');
  });

  it('omits excerpt gracefully when absent (sparse upstream)', () => {
    const output = {
      questions: [makeQuestion({ excerpt: undefined })],
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeSearchQuestions.format!(output);
    expect(blocks[0]!.type).toBe('text');
    // Should not crash or contain "undefined"
    expect((blocks[0] as { text: string }).text).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// truncated enrichment gating (#7)
// ---------------------------------------------------------------------------
describe('stackexchangeSearchQuestions truncation enrichment', () => {
  const fullPage = () =>
    Array.from({ length: 5 }, (_, i) => makeQuestion({ questionId: 1000 + i }));

  it('fires truncated when the page is filled and the upstream has more', async () => {
    mockService(makeSearchResult(fullPage(), true));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).toHaveBeenCalledOnce();
  });

  it('omits truncated when the page is filled but the upstream has no more', async () => {
    mockService(makeSearchResult(fullPage(), false));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });

  it('omits truncated when fewer results than the page cap are returned', async () => {
    mockService(makeSearchResult([makeQuestion()], true));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Date surfacing
// ---------------------------------------------------------------------------
describe('stackexchangeSearchQuestions dates', () => {
  it('carries ISO 8601 question dates through structuredContent', async () => {
    mockService(makeSearchResult());
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'sorted array' });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    // Parsed through the tool's own output schema — the framework builds
    // structuredContent that way, so an undeclared field would be stripped here.
    const parsed = stackexchangeSearchQuestions.output.parse(result);
    expect(parsed.questions[0]!.creationDate).toBe(CREATED_ISO);
    expect(parsed.questions[0]!.lastActivityDate).toBe(ACTIVE_ISO);
  });

  it('renders both dates in format() alongside the score', () => {
    const blocks = stackexchangeSearchQuestions.format!({
      questions: [makeQuestion()],
      page: 1,
      attribution: 'CC BY-SA 4.0',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(`**Asked:** ${CREATED_ISO}`);
    expect(text).toContain(`**Active:** ${ACTIVE_ISO}`);
  });

  it('omits the date labels when the question carries neither date', () => {
    const blocks = stackexchangeSearchQuestions.format!({
      questions: [makeQuestion({ creationDate: undefined, lastActivityDate: undefined })],
      page: 1,
      attribution: 'CC BY-SA 4.0',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Asked:');
    expect(text).not.toContain('Active:');
    expect(text).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// #17 — excerpt reaches both consumption surfaces
// ---------------------------------------------------------------------------
describe('stackexchangeSearchQuestions excerpt', () => {
  const EXCERPT = 'Say I have two async generators and want to merge them.';

  it('carries the excerpt through structuredContent', async () => {
    mockService(makeSearchResult([makeQuestion({ excerpt: EXCERPT })]));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'async generator' });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    // Parsed through the tool's own output schema — the framework builds
    // structuredContent that way, so an undeclared field would be stripped here.
    const parsed = stackexchangeSearchQuestions.output.parse(result);
    expect(parsed.questions[0]!.excerpt).toBe(EXCERPT);
  });

  it('leaves the excerpt absent in structuredContent when the question has none', async () => {
    mockService(makeSearchResult([makeQuestion({ excerpt: undefined })]));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q' });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    const parsed = stackexchangeSearchQuestions.output.parse(result);
    expect(parsed.questions[0]!.excerpt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #18 — paging
// ---------------------------------------------------------------------------
describe('stackexchangeSearchQuestions paging', () => {
  const fullPage = (size = 5) =>
    Array.from({ length: size }, (_, i) => makeQuestion({ questionId: 1000 + i }));

  it('defaults page to 1 and forwards it to the service', async () => {
    const svc = makeSearchResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q' });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(svc.searchQuestions).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), ctx);
  });

  it('forwards an explicit page to the service', async () => {
    const svc = makeSearchResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', page: 4 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(svc.searchQuestions).toHaveBeenCalledWith(expect.objectContaining({ page: 4 }), ctx);
  });

  it.each([0, -1, 1.5])('rejects page %s at the schema, before any request', (page) => {
    expect(() => stackexchangeSearchQuestions.input.parse({ query: 'q', page })).toThrow();
  });

  it('echoes the effective page in structuredContent when page was omitted', async () => {
    mockService(makeSearchResult());
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q' });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    expect(stackexchangeSearchQuestions.output.parse(result).page).toBe(1);
  });

  it('echoes the effective page in structuredContent when page was supplied', async () => {
    mockService(makeSearchResult());
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', page: 7 });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    expect(stackexchangeSearchQuestions.output.parse(result).page).toBe(7);
  });

  it('renders the effective page in format()', () => {
    const blocks = stackexchangeSearchQuestions.format!({
      questions: [makeQuestion()],
      page: 3,
      attribution: ATTRIBUTION,
    });
    expect((blocks[0] as { text: string }).text).toContain('3');
  });

  it('renders the effective page in format() on an empty page', () => {
    const blocks = stackexchangeSearchQuestions.format!({
      questions: [],
      page: 9,
      attribution: ATTRIBUTION,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('9');
    expect(text).not.toContain('undefined');
  });

  it('names paging in the truncation notice rather than only raising the cap', async () => {
    mockService(makeSearchResult(fullPage(), true));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5, page: 2 });
    await stackexchangeSearchQuestions.handler(input, ctx);

    const guidance = truncatedSpy.mock.calls[0]![0].guidance;
    expect(guidance).toBeDefined();
    // Pre-fix the framework default fired: "Raise the cap or narrow with filters"
    // — advice that dead-ends at pageSize 30.
    expect(guidance).not.toContain('Raise the cap');
    expect(guidance).toContain('page 3');
  });

  it('emits no paging notice when the upstream reports no more results', async () => {
    mockService(makeSearchResult(fullPage(), false));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5, page: 2 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it('tells a caller who paged past the end that the page is past the end', async () => {
    mockService(makeSearchResult([], false));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'generics', page: 12 });
    await stackexchangeSearchQuestions.handler(input, ctx);

    const notice = noticeSpy.mock.calls[0]![0];
    expect(notice).toContain('12');
    // Not the page-1 "try broader terms" advice — the query did match, this page did not.
    expect(notice).not.toContain('Try broader terms');
  });

  it('keeps the broaden-the-query advice on an empty first page', async () => {
    mockService(makeSearchResult([], false));
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'xyzzy-nothing' });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(noticeSpy.mock.calls[0]![0]).toContain('Try broader terms');
  });

  it('leaves pageSize alone — paging is additive to the cap', async () => {
    const svc = makeSearchResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeSearchQuestions.errors });
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', page: 2 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(svc.searchQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10, page: 2 }),
      ctx,
    );
  });

  it('declares paging_depth_limit as a Forbidden error contract entry', () => {
    const entry = stackexchangeSearchQuestions.errors?.find(
      (e) => e.reason === 'paging_depth_limit',
    );
    expect(entry).toBeDefined();
    expect(entry!.recovery).toContain('STACKEXCHANGE_API_KEY');
    expect(entry!.recovery).toContain('25');
  });
});
