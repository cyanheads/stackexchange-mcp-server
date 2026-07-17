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

const makeQuestion = (overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion => ({
  questionId: 11227809,
  title: 'Why is processing a sorted array faster than processing an unsorted array?',
  link: 'https://stackoverflow.com/questions/11227809',
  score: 28000,
  answerCount: 27,
  isAnswered: true,
  tags: ['java', 'c++', 'performance', 'sorting'],
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
    mockGetService.mockReturnValue(
      makeSearchResult() as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext();
    const input = stackexchangeSearchQuestions.input.parse({ query: 'sorted array faster' });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.questionId).toBe(11227809);
    expect(result.attribution).toContain('CC BY-SA');
  });

  it('applies default site=stackoverflow and sort=relevance', async () => {
    const mockSvc = makeSearchResult();
    mockGetService.mockReturnValue(mockSvc as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext();
    const input = stackexchangeSearchQuestions.input.parse({ query: 'test query' });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(mockSvc.searchQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'stackoverflow', sort: 'relevance' }),
      ctx,
    );
  });

  it('passes tags when provided', async () => {
    const mockSvc = makeSearchResult();
    mockGetService.mockReturnValue(mockSvc as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext();
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
    mockGetService.mockReturnValue(mockSvc as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext();
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
    mockGetService.mockReturnValue(
      makeSearchResult([]) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext();
    const input = stackexchangeSearchQuestions.input.parse({
      query: 'xyzzy-does-not-exist-1234567',
    });
    const result = await stackexchangeSearchQuestions.handler(input, ctx);
    expect(result.questions).toHaveLength(0);
  });

  it('passes minScore and acceptedOnly when provided', async () => {
    const mockSvc = makeSearchResult();
    mockGetService.mockReturnValue(mockSvc as ReturnType<typeof getStackExchangeService>);
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
    mockGetService.mockReturnValue({
      searchQuestions: vi
        .fn()
        .mockRejectedValue(
          validationError('bad_parameter: invalid site', { reason: 'invalid_site' }),
        ),
    } as ReturnType<typeof getStackExchangeService>);
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
      attribution: ATTRIBUTION,
    });
    expect(blocks[0]!.type).toBe('text');
    expect((blocks[0] as { text: string }).text).toContain('No questions found');
  });

  it('renders question ID and title in output', () => {
    const output = { questions: [makeQuestion()], attribution: ATTRIBUTION };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('11227809');
    expect(text).toContain('sorted array faster');
  });

  it('renders score, answer count, tags, and link', () => {
    const output = { questions: [makeQuestion()], attribution: ATTRIBUTION };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('28000');
    expect(text).toContain('27');
    expect(text).toContain('java');
    expect(text).toContain('https://stackoverflow.com/questions/11227809');
  });

  it('renders CC BY-SA attribution footer', () => {
    const output = { questions: [makeQuestion()], attribution: ATTRIBUTION };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC BY-SA');
    expect(text).toContain('Stack Exchange Network');
  });

  it('includes excerpt when present', () => {
    const output = {
      questions: [makeQuestion({ excerpt: 'Branch prediction makes the difference.' })],
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeSearchQuestions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Branch prediction makes the difference.');
  });

  it('omits excerpt gracefully when absent (sparse upstream)', () => {
    const output = { questions: [makeQuestion({ excerpt: undefined })], attribution: ATTRIBUTION };
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
    mockGetService.mockReturnValue(
      makeSearchResult(fullPage(), true) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext();
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).toHaveBeenCalledOnce();
  });

  it('omits truncated when the page is filled but the upstream has no more', async () => {
    mockGetService.mockReturnValue(
      makeSearchResult(fullPage(), false) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext();
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });

  it('omits truncated when fewer results than the page cap are returned', async () => {
    mockGetService.mockReturnValue(
      makeSearchResult([makeQuestion()], true) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext();
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeSearchQuestions.input.parse({ query: 'q', pageSize: 5 });
    await stackexchangeSearchQuestions.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });
});
