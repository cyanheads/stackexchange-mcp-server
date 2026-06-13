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

const makeFaqQuestion = (overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion => ({
  questionId: 11227809,
  title: 'Why is processing a sorted array faster than processing an unsorted array?',
  link: 'https://stackoverflow.com/questions/11227809',
  score: 28000,
  answerCount: 27,
  isAnswered: true,
  tags: ['java', 'c++', 'performance'],
  ...overrides,
});

const makeFaqResult = (questions: NormalizedQuestion[] = [makeFaqQuestion()]) => ({
  getTagFaq: vi.fn().mockResolvedValue({ questions, quotaRemaining: 250, quotaMax: 300 }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------
describe('stackexchangeGetTagFaq handler', () => {
  it('returns questions for a valid tag', async () => {
    mockGetService.mockReturnValue(makeFaqResult() as ReturnType<typeof getStackExchangeService>);
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
    mockGetService.mockReturnValue(svc as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'python' });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(svc.getTagFaq).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'stackoverflow', pageSize: 10 }),
      ctx,
    );
  });

  it('returns empty questions array when API returns no results (HTTP 200, items=[])', async () => {
    mockGetService.mockReturnValue(makeFaqResult([]) as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'nonexistent-tag-xyz' });
    const result = await stackexchangeGetTagFaq.handler(input, ctx);
    expect(result.questions).toHaveLength(0);
    expect(result.tag).toBe('nonexistent-tag-xyz');
  });

  it('calls ctx.enrich.notice when tag returns no results', async () => {
    mockGetService.mockReturnValue(makeFaqResult([]) as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const noticeSpy = vi.spyOn(ctx.enrich, 'notice');
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'nonexistent-tag-xyz' });
    await stackexchangeGetTagFaq.handler(input, ctx);
    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0]![0]).toContain('nonexistent-tag-xyz');
  });

  it('propagates service errors (invalid_site → throws)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetService.mockReturnValue({
      getTagFaq: vi
        .fn()
        .mockRejectedValue(validationError('bad_parameter: site', { reason: 'invalid_site' })),
    } as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetTagFaq.errors });
    const input = stackexchangeGetTagFaq.input.parse({ tag: 'python', site: 'notasite' });
    await expect(stackexchangeGetTagFaq.handler(input, ctx)).rejects.toThrow();
  });

  it('passes custom site and pageSize to service', async () => {
    const svc = makeFaqResult();
    mockGetService.mockReturnValue(svc as ReturnType<typeof getStackExchangeService>);
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
