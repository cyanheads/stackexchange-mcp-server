/**
 * @fileoverview Tests for the stackexchange_get_tag_faq tool.
 * Covers happy path, empty result (HTTP 200 with items=[]), sparse payloads,
 * error propagation, and format().
 * @module tests/tools/stackexchange-get-tag-faq.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetTagFaq } from '@/mcp-server/tools/definitions/stackexchange-get-tag-faq.tool.js';
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

const CREATED_ISO = '2012-06-27T12:51:36.000Z';
const ACTIVE_ISO = '2025-08-12T12:00:00.000Z';

const makeFaqQuestion = (overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion => ({
  questionId: 11227809,
  title: 'Why is processing a sorted array faster than processing an unsorted array?',
  link: 'https://stackoverflow.com/questions/11227809',
  score: 28000,
  answerCount: 27,
  isAnswered: true,
  tags: ['java', 'c++', 'performance'],
  creationDate: CREATED_ISO,
  lastActivityDate: ACTIVE_ISO,
  ...overrides,
});

/** A question with no upstream timestamps — the sparse-payload shape. */
const undatedFaqQuestion = (): NormalizedQuestion => ({
  questionId: 99,
  title: 'Undated question',
  link: 'https://stackoverflow.com/questions/99',
  score: 1,
  answerCount: 0,
  isAnswered: false,
  tags: ['c'],
});

const makeFaqResult = (questions: NormalizedQuestion[] = [makeFaqQuestion()], hasMore = false) => ({
  getTagFaq: vi.fn().mockResolvedValue({ questions, quotaRemaining: 250, quotaMax: 300, hasMore }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------
describe('stackexchangeGetTagFaq handler', () => {
  it('returns questions for a valid tag', async () => {
    mockService(makeFaqResult());
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java' });
    const result = await stackexchangeGetTagFaq.handler(input, ctx);
    expect(result.questions).toHaveLength(1);
    expect(result.tag).toBe('java');
    expect(result.site).toBe('stackoverflow');
    expect(result.attribution).toContain('CC BY-SA');
  });

  it('defaults site to stackoverflow and pageSize to 10', async () => {
    const svc = makeFaqResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'python' });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(svc.getTagFaq).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'stackoverflow', pageSize: 10 }),
      ctx,
    );
  });

  it('returns empty questions array when API returns no results (HTTP 200, items=[])', async () => {
    mockService(makeFaqResult([]));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'nonexistent-tag-xyz' });
    const result = await stackexchangeGetTagFaq.handler(input, ctx);
    expect(result.questions).toHaveLength(0);
    expect(result.tag).toBe('nonexistent-tag-xyz');
  });

  it('calls ctx.enrich.notice when tag returns no results', async () => {
    mockService(makeFaqResult([]));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'nonexistent-tag-xyz' });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0]![0]).toContain('nonexistent-tag-xyz');
  });

  it('propagates service errors (invalid_site → throws)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    mockService({
      getTagFaq: vi
        .fn()
        .mockRejectedValue(validationError('bad_parameter: site', { reason: 'invalid_site' })),
    });
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'python', site: 'notasite' });
    await expect(stackexchangeGetTagFaq.handler(input, ctx)).rejects.toThrow();
  });

  it('passes custom site and pageSize to service', async () => {
    const svc = makeFaqResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({
      tag: 'bash',
      site: 'unix',
      pageSize: 5,
    });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(svc.getTagFaq).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'bash', site: 'unix', pageSize: 5 }),
      ctx,
    );
  });
});

// ---------------------------------------------------------------------------
// format() tests
// ---------------------------------------------------------------------------
const ATTRIBUTION =
  'Stack Exchange Network — content licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)';

describe('stackexchangeGetTagFaq format', () => {
  it('renders tag and site header', () => {
    const output = {
      questions: [makeFaqQuestion()],
      tag: 'java',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('java');
    expect(text).toContain('stackoverflow');
  });

  it('renders question ID, title, score, and link', () => {
    const output = {
      questions: [makeFaqQuestion()],
      tag: 'java',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('11227809');
    expect(text).toContain('sorted array faster');
    expect(text).toContain('28000');
    expect(text).toContain('https://stackoverflow.com/questions/11227809');
  });

  it('renders CC BY-SA attribution footer', () => {
    const output = {
      questions: [makeFaqQuestion()],
      tag: 'java',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC BY-SA');
    expect(text).toContain('Stack Exchange Network');
  });

  it('renders "No FAQ questions found" for empty result', () => {
    const output = {
      questions: [],
      tag: 'noop',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No FAQ questions found');
  });

  it('renders attribution footer even for empty result', () => {
    const output = {
      questions: [],
      tag: 'noop',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC BY-SA');
  });

  it('does not include "undefined" in output for sparse questions', () => {
    // excerpt field doesn't exist on FAQ questions — verify graceful omission
    const output = {
      questions: [makeFaqQuestion()],
      tag: 'java',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    expect((blocks[0] as { text: string }).text).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// truncated enrichment gating (#7)
// ---------------------------------------------------------------------------
describe('stackexchangeGetTagFaq truncation enrichment', () => {
  const fullPage = () =>
    Array.from({ length: 5 }, (_, i) => makeFaqQuestion({ questionId: 1000 + i }));

  it('fires truncated when the page is filled and the upstream has more', async () => {
    mockService(makeFaqResult(fullPage(), true));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', pageSize: 5 });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(truncatedSpy).toHaveBeenCalledOnce();
  });

  it('omits truncated when the page is filled but the upstream has no more', async () => {
    mockService(makeFaqResult(fullPage(), false));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', pageSize: 5 });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });

  it('omits truncated when fewer results than the page cap are returned', async () => {
    mockService(makeFaqResult([makeFaqQuestion()], true));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', pageSize: 5 });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Date surfacing
// ---------------------------------------------------------------------------
describe('stackexchangeGetTagFaq dates', () => {
  it('carries ISO 8601 question dates through structuredContent', async () => {
    mockService(makeFaqResult());
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java' });
    const result = await stackexchangeGetTagFaq.handler(input, ctx);
    // Parsed through the tool's own output schema — the framework builds
    // structuredContent that way, so an undeclared field would be stripped here.
    const parsed = stackexchangeGetTagFaq.output.parse(result);
    expect(parsed.questions[0]!.creationDate).toBe(CREATED_ISO);
    expect(parsed.questions[0]!.lastActivityDate).toBe(ACTIVE_ISO);
  });

  it('renders both dates in format() alongside the score', () => {
    const blocks = stackexchangeGetTagFaq.format!({
      questions: [makeFaqQuestion()],
      tag: 'java',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(`**Asked:** ${CREATED_ISO}`);
    expect(text).toContain(`**Active:** ${ACTIVE_ISO}`);
  });

  it('omits the date labels when the question carries neither date', () => {
    const blocks = stackexchangeGetTagFaq.format!({
      questions: [undatedFaqQuestion()],
      tag: 'c',
      site: 'stackoverflow',
      page: 1,
      attribution: ATTRIBUTION,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Asked:');
    expect(text).not.toContain('Active:');
    expect(text).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// #18 — paging
// ---------------------------------------------------------------------------
describe('stackexchangeGetTagFaq paging', () => {
  const fullPage = (size = 5) =>
    Array.from({ length: size }, (_, i) => makeFaqQuestion({ questionId: 1000 + i }));

  it('defaults page to 1 and forwards it to the service', async () => {
    const svc = makeFaqResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'python' });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(svc.getTagFaq).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), ctx);
  });

  it('forwards an explicit page to the service', async () => {
    const svc = makeFaqResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'python', page: 5 });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(svc.getTagFaq).toHaveBeenCalledWith(expect.objectContaining({ page: 5 }), ctx);
  });

  it.each([0, -3, 2.5])('rejects page %s at the schema, before any request', (page) => {
    expect(() => stackexchangeGetTagFaq.input.parse({ tag: 'python', page })).toThrow();
  });

  it('echoes the effective page in structuredContent when page was omitted', async () => {
    mockService(makeFaqResult());
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java' });
    const result = await stackexchangeGetTagFaq.handler(input, ctx);
    expect(stackexchangeGetTagFaq.output.parse(result).page).toBe(1);
  });

  it('echoes the effective page in structuredContent when page was supplied', async () => {
    mockService(makeFaqResult());
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', page: 6 });
    const result = await stackexchangeGetTagFaq.handler(input, ctx);
    expect(stackexchangeGetTagFaq.output.parse(result).page).toBe(6);
  });

  it('renders the effective page in format()', () => {
    const blocks = stackexchangeGetTagFaq.format!({
      questions: [makeFaqQuestion()],
      tag: 'java',
      site: 'stackoverflow',
      page: 3,
      attribution: ATTRIBUTION,
    });
    expect((blocks[0] as { text: string }).text).toContain('3');
  });

  it('renders the effective page in format() on an empty page', () => {
    const blocks = stackexchangeGetTagFaq.format!({
      questions: [],
      tag: 'java',
      site: 'stackoverflow',
      page: 8,
      attribution: ATTRIBUTION,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('8');
    expect(text).not.toContain('undefined');
  });

  it('names paging in the truncation notice rather than only raising the cap', async () => {
    mockService(makeFaqResult(fullPage(), true));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', pageSize: 5, page: 2 });
    await stackexchangeGetTagFaq.handler(input, ctx);

    const guidance = truncatedSpy.mock.calls[0]![0].guidance;
    expect(guidance).toBeDefined();
    // Pre-fix the framework default fired: "Raise the cap or narrow with filters"
    // — advice that dead-ends at pageSize 30.
    expect(guidance).not.toContain('Raise the cap');
    expect(guidance).toContain('page 3');
  });

  it('emits no paging notice when the upstream reports no more results', async () => {
    mockService(makeFaqResult(fullPage(), false));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', pageSize: 5, page: 2 });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it('tells a caller who paged past the end that the page is past the end', async () => {
    mockService(makeFaqResult([], false));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', page: 14 });
    await stackexchangeGetTagFaq.handler(input, ctx);

    const notice = noticeSpy.mock.calls[0]![0];
    expect(notice).toContain('14');
    // Not the page-1 "verify the tag name" advice — the tag is fine, this page is not.
    expect(notice).not.toContain('Verify the tag name');
  });

  it('keeps the verify-the-tag advice on an empty first page', async () => {
    mockService(makeFaqResult([], false));
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'nonexistent-tag-xyz' });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(noticeSpy.mock.calls[0]![0]).toContain('Verify the tag name');
  });

  it('leaves pageSize alone — paging is additive to the cap', async () => {
    const svc = makeFaqResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'java', page: 2 });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(svc.getTagFaq).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10, page: 2 }),
      ctx,
    );
  });

  it('declares paging_depth_limit as a Forbidden error contract entry', () => {
    const entry = stackexchangeGetTagFaq.errors?.find((e) => e.reason === 'paging_depth_limit');
    expect(entry).toBeDefined();
    expect(entry!.recovery).toContain('STACKEXCHANGE_API_KEY');
    expect(entry!.recovery).toContain('25');
  });
});
