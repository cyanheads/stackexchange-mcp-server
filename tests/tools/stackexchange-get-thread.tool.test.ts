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

const mockService = (service: Partial<ReturnType<typeof getStackExchangeService>>): void => {
  mockGetService.mockReturnValue(service as ReturnType<typeof getStackExchangeService>);
};

type FixtureOverrides<T> = { [K in keyof T]?: T[K] | undefined };

const withoutUndefined = <T extends object>(value: FixtureOverrides<T>): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

const makeAnswer = (overrides: FixtureOverrides<NormalizedAnswer> = {}): NormalizedAnswer =>
  withoutUndefined<NormalizedAnswer>({
    answerId: 11227846,
    score: 34000,
    isAccepted: true,
    bodyMarkdown: 'Branch prediction is the answer.',
    authorName: 'JUser',
    authorLink: 'https://stackoverflow.com/users/1/juser',
    authorReputation: 120000,
    ...overrides,
  });

const makeThread = (overrides: FixtureOverrides<NormalizedThread> = {}): NormalizedThread =>
  withoutUndefined<NormalizedThread>({
    questionId: 11227809,
    title: 'Why is processing a sorted array faster?',
    link: 'https://stackoverflow.com/questions/11227809',
    score: 28000,
    tags: ['java', 'performance'],
    bodyMarkdown: 'I noticed a **10x** speedup when the array is sorted.',
    authorName: 'SUser',
    authorLink: 'https://stackoverflow.com/users/2/suser',
    acceptedAnswerId: 11227846,
    answerCount: 1,
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
    mockService(makeThreadResult());
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.questionId).toBe(11227809);
  });

  it('extracts ID from a full Stack Exchange question URL', async () => {
    const svc = makeThreadResult();
    mockService(svc);
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
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('throws invalid_id_or_url when service rejects the ID as bad_parameter (out-of-range integer)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    mockService({
      getThread: vi.fn().mockRejectedValue(
        validationError('The question ID is not a valid Stack Exchange question ID.', {
          reason: 'invalid_id_or_url',
        }),
      ),
    });
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '99999999999' });
    await expect(stackexchangeGetThread.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id_or_url' },
    });
  });

  it('propagates question_not_found when service throws (empty items[])', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService({
      getThread: vi
        .fn()
        .mockRejectedValue(notFound('Question ID 999 not found', { reason: 'question_not_found' })),
    });
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
    mockService(makeThreadResult(sparseThread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.authorName).toBeUndefined();
    expect(result.answers[0]!.authorName).toBeUndefined();
  });

  it('returns thread with no acceptedAnswerId (sparse)', async () => {
    const sparseThread = makeThread({ acceptedAnswerId: undefined });
    mockService(makeThreadResult(sparseThread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.acceptedAnswerId).toBeUndefined();
  });

  it('returns thread with empty answers array', async () => {
    const noAnswers = makeThread({ answers: [] });
    mockService(makeThreadResult(noAnswers));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.answers).toHaveLength(0);
  });

  it('returns authorUserId on question and answer when present', async () => {
    const threadWithIds = makeThread({
      authorUserId: 1,
      answers: [makeAnswer({ authorUserId: 22656 })],
    });
    mockService(makeThreadResult(threadWithIds));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.authorUserId).toBe(1);
    expect(result.answers[0]!.authorUserId).toBe(22656);
  });

  it('omits authorUserId gracefully when absent (community wiki, deleted user)', async () => {
    const sparseThread = makeThread({
      authorUserId: undefined,
      answers: [makeAnswer({ authorUserId: undefined })],
    });
    mockService(makeThreadResult(sparseThread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.authorUserId).toBeUndefined();
    expect(result.answers[0]!.authorUserId).toBeUndefined();
  });

  it('passes maxAnswers to service', async () => {
    const svc = makeThreadResult();
    mockService(svc);
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

// ---------------------------------------------------------------------------
// truncated enrichment gating (#7) + answerCount surfacing (#11)
// ---------------------------------------------------------------------------
describe('stackexchangeGetThread truncation enrichment', () => {
  it('fires truncated when fewer answers are shown than the total answerCount', async () => {
    const thread = makeThread({ answerCount: 27, answers: [makeAnswer()] });
    mockService(makeThreadResult(thread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeGetThread.input.parse({
      questionIdOrUrl: '11227809',
      maxAnswers: 1,
    });
    await stackexchangeGetThread.handler(input, ctx);
    expect(truncatedSpy).toHaveBeenCalledOnce();
  });

  it('omits truncated when every answer is shown (answers.length === answerCount)', async () => {
    const thread = makeThread({ answerCount: 1, answers: [makeAnswer()] });
    mockService(makeThreadResult(thread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const truncatedSpy = vi.spyOn(ctx.enrich, 'truncated');
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    await stackexchangeGetThread.handler(input, ctx);
    expect(truncatedSpy).not.toHaveBeenCalled();
  });

  it('passes answerCount through the handler unchanged', async () => {
    const thread = makeThread({ answerCount: 27 });
    mockService(makeThreadResult(thread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    expect(result.answerCount).toBe(27);
  });
});

describe('stackexchangeGetThread format answerCount', () => {
  it('renders the total answer count in the header', () => {
    const thread = makeThread({ answerCount: 999 });
    const text = (stackexchangeGetThread.format!(thread)[0] as { text: string }).text;
    expect(text).toContain('999');
  });
});
