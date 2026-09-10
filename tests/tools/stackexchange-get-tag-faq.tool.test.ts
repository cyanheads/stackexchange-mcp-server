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
      attribution: ATTRIBUTION,
    };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC BY-SA');
    expect(text).toContain('Stack Exchange Network');
  });

  it('renders "No FAQ questions found" for empty result', () => {
    const output = { questions: [], tag: 'noop', site: 'stackoverflow', attribution: ATTRIBUTION };
    const blocks = stackexchangeGetTagFaq.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No FAQ questions found');
  });

  it('renders attribution footer even for empty result', () => {
    const output = { questions: [], tag: 'noop', site: 'stackoverflow', attribution: ATTRIBUTION };
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
      attribution: ATTRIBUTION,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Asked:');
    expect(text).not.toContain('Active:');
    expect(text).not.toContain('undefined');
  });
});
