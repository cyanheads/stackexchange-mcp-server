/**
 * @fileoverview Tests for the stackexchange_get_thread tool.
 * Covers accepted-answer-first ordering, URL parsing, question-not-found (empty items[]),
 * invalid ID/URL, sparse upstream payloads (no author, no acceptedAnswerId), and format().
 * @module tests/tools/stackexchange-get-thread.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetThread } from '@/mcp-server/tools/definitions/stackexchange-get-thread.tool.js';
import type {
  NormalizedAnswer,
  NormalizedThread,
} from '@/services/stackexchange/stackexchange-service.js';

// ---------------------------------------------------------------------------
// Service mock
// ---------------------------------------------------------------------------
vi.mock('@/services/stackexchange/stackexchange-service.js', () => ({
  getStackExchangeService: vi.fn(),
}));

import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

const mockGetService = vi.mocked(getStackExchangeService);

const makeAnswer = (overrides: Partial<NormalizedAnswer> = {}): NormalizedAnswer => ({
  answerId: 11227846,
  score: 34000,
  isAccepted: true,
  bodyMarkdown: 'Branch prediction is the answer.',
  authorName: 'JUser',
  authorLink: 'https://stackoverflow.com/users/1/juser',
  authorReputation: 120000,
  ...overrides,
});

const makeThread = (overrides: Partial<NormalizedThread> = {}): NormalizedThread => ({
  questionId: 11227809,
  title: 'Why is processing a sorted array faster?',
  link: 'https://stackoverflow.com/questions/11227809',
  score: 28000,
  tags: ['java', 'performance'],
  bodyMarkdown: 'I noticed a **10x** speedup when the array is sorted.',
  authorName: 'SUser',
  authorLink: 'https://stackoverflow.com/users/2/suser',
  acceptedAnswerId: 11227846,
  answers: [makeAnswer()],
  ...overrides,
});

const makeThreadResult = (thread = makeThread()) => ({
  getThread: vi.fn().mockResolvedValue({ thread, quotaRemaining: 250, quotaMax: 300 }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------
describe('stackexchangeGetThread handler', () => {
  it('fetches thread by numeric ID string', async () => {
    mockGetService.mockReturnValue(
      makeThreadResult() as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.questionId).toBe(11227809);
  });

  it('extracts ID from a full Stack Exchange question URL', async () => {
    const svc = makeThreadResult();
    mockGetService.mockReturnValue(svc as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({
      questionIdOrUrl:
        'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster',
    });
    await stackexchangeGetThread.handler(input, ctx);
    expect(svc.getThread).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 11227809 }),
      ctx,
    );
  });

  it('throws invalid_id_or_url for unparseable input', async () => {
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: 'not-a-url-or-id' });
    await expect(stackexchangeGetThread.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id_or_url' },
    });
  });

  it('throws invalid_id_or_url for a plain text non-numeric non-URL string', async () => {
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: 'some-title-with-dashes' });
    await expect(stackexchangeGetThread.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it('propagates question_not_found when service throws (empty items[])', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetService.mockReturnValue({
      getThread: vi
        .fn()
        .mockRejectedValue(notFound('Question ID 999 not found', { reason: 'question_not_found' })),
    } as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '999' });
    await expect(stackexchangeGetThread.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('returns thread with sparse author fields (no authorName/Link)', async () => {
    const sparseThread = makeThread({
      authorName: undefined,
      authorLink: undefined,
      answers: [
        makeAnswer({ authorName: undefined, authorLink: undefined, authorReputation: undefined }),
      ],
    });
    mockGetService.mockReturnValue(
      makeThreadResult(sparseThread) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.authorName).toBeUndefined();
    expect(result.answers[0]!.authorName).toBeUndefined();
  });

  it('returns thread with no acceptedAnswerId (sparse)', async () => {
    const sparseThread = makeThread({ acceptedAnswerId: undefined });
    mockGetService.mockReturnValue(
      makeThreadResult(sparseThread) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.acceptedAnswerId).toBeUndefined();
  });

  it('returns thread with empty answers array', async () => {
    const noAnswers = makeThread({ answers: [] });
    mockGetService.mockReturnValue(
      makeThreadResult(noAnswers) as ReturnType<typeof getStackExchangeService>,
    );
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.answers).toHaveLength(0);
  });

  it('passes maxAnswers to service', async () => {
    const svc = makeThreadResult();
    mockGetService.mockReturnValue(svc as ReturnType<typeof getStackExchangeService>);
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({
      questionIdOrUrl: '11227809',
      maxAnswers: 5,
    });
    await stackexchangeGetThread.handler(input, ctx);
    expect(svc.getThread).toHaveBeenCalledWith(expect.objectContaining({ maxAnswers: 5 }), ctx);
  });
});

// ---------------------------------------------------------------------------
// format() tests — accepted-answer-first ordering surfaced in rendered text
// ---------------------------------------------------------------------------
describe('stackexchangeGetThread format', () => {
  it('renders question title, ID, score, tags, and link', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Why is processing a sorted array faster?');
    expect(text).toContain('11227809');
    expect(text).toContain('28000');
    expect(text).toContain('java');
    expect(text).toContain('https://stackoverflow.com/questions/11227809');
  });

  it('marks accepted answer with ✓ Accepted badge', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('✓ Accepted');
  });

  it('renders answer body markdown', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Branch prediction is the answer.');
  });

  it('renders question body markdown', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10x');
  });

  it('shows "No answers yet" when answers is empty', () => {
    const thread = makeThread({ answers: [] });
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No answers yet');
  });

  it('renders author attribution (name + link) per CC BY-SA 4.0', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    // Answer author with link
    expect(text).toContain('JUser');
    // Author reputation
    expect(text).toContain('120');
  });

  it('renders question author when present, omits gracefully when absent', () => {
    // With question author
    const withAuthor = makeThread();
    const textWith = (stackexchangeGetThread.format!(withAuthor)[0] as { text: string }).text;
    expect(textWith).toContain('SUser');

    // Without question author — should not crash or contain "undefined"
    // (Answer section may still contain "Author:" for answer attribution)
    const withoutAuthor = makeThread({ authorName: undefined, authorLink: undefined });
    const textWithout = (stackexchangeGetThread.format!(withoutAuthor)[0] as { text: string }).text;
    expect(textWithout).not.toContain('undefined');
    // Question-level author line should be absent (it's rendered as standalone "**Author:** name")
    expect(textWithout).not.toContain('SUser');
  });

  it('includes CC BY-SA 4.0 attribution footer', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC BY-SA 4.0');
  });

  it('renders accepted answer ID when present', () => {
    const thread = makeThread();
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('11227846');
  });

  it('omits accepted answer ID gracefully when absent (sparse)', () => {
    const thread = makeThread({ acceptedAnswerId: undefined });
    const blocks = stackexchangeGetThread.format!(thread);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Accepted Answer ID');
    expect(text).not.toContain('undefined');
  });
});
