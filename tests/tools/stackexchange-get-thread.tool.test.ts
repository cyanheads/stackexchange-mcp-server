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
import { normalizeHtml } from '@/services/stackexchange/html-normalizer.js';
import type {
  NormalizedAnswer,
  NormalizedComment,
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

const CREATED_ISO = '2012-06-27T12:51:36.000Z';
const ACTIVE_ISO = '2025-08-12T12:00:00.000Z';
const ANSWERED_ISO = '2023-07-22T04:26:40.000Z';

const makeAnswer = (overrides: FixtureOverrides<NormalizedAnswer> = {}): NormalizedAnswer =>
  withoutUndefined<NormalizedAnswer>({
    answerId: 11227846,
    score: 34000,
    isAccepted: true,
    bodyMarkdown: 'Branch prediction is the answer.',
    authorName: 'JUser',
    authorLink: 'https://stackoverflow.com/users/1/juser',
    authorReputation: 120000,
    creationDate: ANSWERED_ISO,
    lastActivityDate: ACTIVE_ISO,
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
    creationDate: CREATED_ISO,
    lastActivityDate: ACTIVE_ISO,
    ...overrides,
  });

const COMMENTED_ISO = '2024-03-29T11:43:03.000Z';

const makeComment = (overrides: FixtureOverrides<NormalizedComment> = {}): NormalizedComment =>
  withoutUndefined<NormalizedComment>({
    commentId: 141067132,
    score: 7,
    bodyMarkdown: 'This breaks on `v3` — see [the note](https://example.com/note).',
    authorName: 'Peter Cordes',
    authorLink: 'https://stackoverflow.com/users/224132/peter-cordes',
    creationDate: COMMENTED_ISO,
    ...overrides,
  });

const makeThreadResult = (thread = makeThread()) => ({
  getThread: vi.fn().mockResolvedValue({ thread, quotaRemaining: 250, quotaMax: 300 }),
});

/** The rendered `content[]` surface for one thread. */
const rendered = (thread: NormalizedThread): string =>
  (stackexchangeGetThread.format!(thread)[0] as { text: string }).text;

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

// ---------------------------------------------------------------------------
// Normalized bodies reach content[] as well as structuredContent
// ---------------------------------------------------------------------------
describe('stackexchangeGetThread format of normalized bodies', () => {
  it('renders a table, a nested list, and literal angle brackets in the rendered text', () => {
    const thread = makeThread({
      bodyMarkdown: normalizeHtml(
        '<p>Use the &lt;div&gt; element.</p><ul><li>outer<ul><li>inner</li></ul></li></ul>',
      ),
      answers: [
        makeAnswer({
          bodyMarkdown: normalizeHtml(
            '<div class="s-table-container"><table class="s-table"><thead><tr><th>Method</th><th>Time</th></tr></thead><tbody><tr><td>sorted</td><td>1.93s</td></tr></tbody></table></div>',
          ),
        }),
      ],
    });
    const text = (stackexchangeGetThread.format!(thread)[0] as { text: string }).text;
    expect(text).toContain('Use the <div> element.');
    expect(text).toContain('- outer\n  - inner');
    expect(text).toContain('| Method | Time |\n| --- | --- |\n| sorted | 1.93s |');
  });
});

// ---------------------------------------------------------------------------
// Date surfacing
// ---------------------------------------------------------------------------
describe('stackexchangeGetThread dates', () => {
  it('carries ISO 8601 dates for the question and every answer through structuredContent', async () => {
    mockService(
      makeThreadResult(
        makeThread({
          answerCount: 2,
          answers: [makeAnswer(), makeAnswer({ answerId: 2, isAccepted: false })],
        }),
      ),
    );
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });
    const result = await stackexchangeGetThread.handler(input, ctx);
    // Parsed through the tool's own output schema — the framework builds
    // structuredContent that way, so an undeclared field would be stripped here.
    const parsed = stackexchangeGetThread.output.parse(result);
    expect(parsed.creationDate).toBe(CREATED_ISO);
    expect(parsed.lastActivityDate).toBe(ACTIVE_ISO);
    expect(parsed.answers[0]!.creationDate).toBe(ANSWERED_ISO);
    expect(parsed.answers[1]!.creationDate).toBe(ANSWERED_ISO);
    expect(parsed.answers[1]!.lastActivityDate).toBe(ACTIVE_ISO);
  });

  it('renders the question dates and every answer date in format()', () => {
    const thread = makeThread({
      answerCount: 2,
      answers: [
        makeAnswer(),
        makeAnswer({ answerId: 2, isAccepted: false, creationDate: '2023-11-14T22:13:20.000Z' }),
      ],
    });
    const text = (stackexchangeGetThread.format!(thread)[0] as { text: string }).text;
    expect(text).toContain(`**Asked:** ${CREATED_ISO}`);
    expect(text).toContain(`**Active:** ${ACTIVE_ISO}`);
    expect(text).toContain(`**Posted:** ${ANSWERED_ISO}`);
    // The second answer's own date renders too — not just the first one's.
    expect(text).toContain('**Posted:** 2023-11-14T22:13:20.000Z');
  });

  it('omits the date labels when neither the question nor its answer is dated', () => {
    const thread = makeThread({
      creationDate: undefined,
      lastActivityDate: undefined,
      answers: [makeAnswer({ creationDate: undefined, lastActivityDate: undefined })],
    });
    const text = (stackexchangeGetThread.format!(thread)[0] as { text: string }).text;
    expect(text).not.toContain('Asked:');
    expect(text).not.toContain('Posted:');
    expect(text).not.toContain('Active:');
    expect(text).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// #20 — opt-in comment fetching
// ---------------------------------------------------------------------------

describe('stackexchangeGetThread comment opt-in', () => {
  it('defaults includeComments to false and passes it to the service', async () => {
    const svc = makeThreadResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' });

    expect(input.includeComments).toBe(false);
    await stackexchangeGetThread.handler(input, ctx);
    expect(svc.getThread).toHaveBeenCalledWith(
      expect.objectContaining({ includeComments: false }),
      ctx,
    );
  });

  it('forwards includeComments: true to the service', async () => {
    const svc = makeThreadResult();
    mockService(svc);
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const input = stackexchangeGetThread.input.parse({
      questionIdOrUrl: '11227809',
      includeComments: true,
    });

    await stackexchangeGetThread.handler(input, ctx);
    expect(svc.getThread).toHaveBeenCalledWith(
      expect.objectContaining({ includeComments: true }),
      ctx,
    );
  });

  it('enriches with the per-post comment cap only when comments were requested', async () => {
    const withComments = makeThread({
      comments: [makeComment()],
      answers: [makeAnswer({ comments: [] })],
    });
    mockService(makeThreadResult(withComments));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const enrichSpy = vi.spyOn(ctx, 'enrich');

    await stackexchangeGetThread.handler(
      stackexchangeGetThread.input.parse({
        questionIdOrUrl: '11227809',
        includeComments: true,
      }),
      ctx,
    );

    expect(enrichSpy).toHaveBeenCalledWith(expect.objectContaining({ commentsCap: 20 }));
  });

  it('omits the comment cap enrichment on the default path', async () => {
    mockService(makeThreadResult());
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const enrichSpy = vi.spyOn(ctx, 'enrich');

    await stackexchangeGetThread.handler(
      stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' }),
      ctx,
    );

    for (const call of enrichSpy.mock.calls) {
      expect(call[0]).not.toHaveProperty('commentsCap');
    }
  });
});

describe('stackexchangeGetThread comments on structuredContent', () => {
  /**
   * Parsed through the tool's own output schema — the framework builds
   * structuredContent that way, so a field the schema does not declare is
   * stripped here rather than silently surviving a raw handler return.
   */
  const structured = async (thread: NormalizedThread) => {
    mockService(makeThreadResult(thread));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const result = await stackexchangeGetThread.handler(
      stackexchangeGetThread.input.parse({
        questionIdOrUrl: '11227809',
        includeComments: true,
      }),
      ctx,
    );
    return stackexchangeGetThread.output.parse(result);
  };

  it('carries question and answer comments with every declared field', async () => {
    const parsed = await structured(
      makeThread({
        comments: [makeComment({ commentId: 900 })],
        answers: [makeAnswer({ comments: [makeComment({ commentId: 901, score: -1 })] })],
      }),
    );

    expect(parsed.comments?.[0]).toEqual({
      commentId: 900,
      score: 7,
      bodyMarkdown: 'This breaks on `v3` — see [the note](https://example.com/note).',
      authorName: 'Peter Cordes',
      authorLink: 'https://stackoverflow.com/users/224132/peter-cordes',
      creationDate: COMMENTED_ISO,
    });
    expect(parsed.answers[0]!.comments?.[0]?.commentId).toBe(901);
    expect(parsed.answers[0]!.comments?.[0]?.score).toBe(-1);
  });

  it('keeps a comment-free post as an empty list and a starved post as absent', async () => {
    const parsed = await structured(
      makeThread({
        comments: [],
        answers: [
          makeAnswer({ answerId: 1, comments: [makeComment()], commentsTruncated: true }),
          // Starved by a truncated combined page — state unknown, not none.
          makeAnswer({ answerId: 2, isAccepted: false, comments: undefined }),
          makeAnswer({ answerId: 3, isAccepted: false, comments: [] }),
        ],
      }),
    );

    expect(parsed.comments).toEqual([]);
    expect(parsed.answers[0]!.commentsTruncated).toBe(true);
    // The load-bearing assertion: the schema must not coerce absent to empty.
    expect(parsed.answers[1]!.comments).toBeUndefined();
    expect(parsed.answers[1]!.comments).not.toEqual([]);
    expect(parsed.answers[2]!.comments).toEqual([]);
  });

  it('leaves comments absent everywhere on the default path', async () => {
    mockService(makeThreadResult(makeThread()));
    const ctx = createMockContext({ errors: stackexchangeGetThread.errors });
    const result = await stackexchangeGetThread.handler(
      stackexchangeGetThread.input.parse({ questionIdOrUrl: '11227809' }),
      ctx,
    );
    const parsed = stackexchangeGetThread.output.parse(result);

    expect(parsed.comments).toBeUndefined();
    expect(parsed.answers[0]!.comments).toBeUndefined();
  });
});

describe('stackexchangeGetThread comments in format()', () => {
  it('renders question comments and every answer comment under its own post', () => {
    const text = rendered(
      makeThread({
        comments: [makeComment({ commentId: 900, bodyMarkdown: 'A question-level caveat.' })],
        answers: [
          makeAnswer({
            answerId: 11227846,
            comments: [
              makeComment({ commentId: 901, bodyMarkdown: 'This breaks on v3.' }),
              makeComment({ commentId: 902, bodyMarkdown: 'Only works on POSIX.' }),
            ],
          }),
        ],
      }),
    );

    expect(text).toContain('A question-level caveat.');
    expect(text).toContain('This breaks on v3.');
    expect(text).toContain('Only works on POSIX.');
    // Attribution and score reach the rendered surface too, not just the JSON one.
    expect(text).toContain('Peter Cordes');
    expect(text).toContain(COMMENTED_ISO);
    // The answer's comments render after its body, not before it.
    expect(text.indexOf('Branch prediction is the answer.')).toBeLessThan(
      text.indexOf('This breaks on v3.'),
    );
  });

  it('renders a starved post as unknown and never as comment-free', () => {
    const text = rendered(
      makeThread({
        comments: [makeComment()],
        answerCount: 2,
        answers: [
          makeAnswer({ answerId: 1, comments: [makeComment({ bodyMarkdown: 'Present.' })] }),
          makeAnswer({ answerId: 2, isAccepted: false, comments: undefined }),
        ],
      }),
    );

    // The acceptance criterion: absent must read as unknown on this surface.
    expect(text).toMatch(/unknown/i);
    expect(text).not.toMatch(/No comments/i);
    expect(text).not.toContain('undefined');
  });

  it('distinguishes a genuinely comment-free post from a starved one in one thread', () => {
    const text = rendered(
      makeThread({
        comments: [],
        answerCount: 2,
        answers: [
          makeAnswer({ answerId: 1, comments: [] }),
          makeAnswer({ answerId: 2, isAccepted: false, comments: undefined }),
        ],
      }),
    );

    // Both states appear, and they do not read the same.
    expect(text).toMatch(/No comments/i);
    expect(text).toMatch(/unknown/i);
    const noneAt = text.indexOf('### Answer 1');
    const unknownAt = text.indexOf('### Answer 2');
    expect(text.slice(noneAt, unknownAt)).toMatch(/No comments/i);
    expect(text.slice(unknownAt)).toMatch(/unknown/i);
    expect(text.slice(unknownAt)).not.toMatch(/No comments/i);
  });

  it('marks a post whose comment list was cut', () => {
    const text = rendered(
      makeThread({
        comments: [makeComment()],
        answers: [makeAnswer({ comments: [makeComment()], commentsTruncated: true })],
      }),
    );

    expect(text).toMatch(/partial/i);
  });

  it('says nothing about comments at all when they were not requested', () => {
    const text = rendered(makeThread());

    expect(text).not.toMatch(/Comments/i);
    expect(text).not.toMatch(/unknown/i);
    expect(text).not.toContain('undefined');
  });
});

describe('stackexchangeGetThread sparse comment rendering', () => {
  it('omits author and date on a comment that carries neither, without inventing either', () => {
    const text = rendered(
      makeThread({
        comments: [
          makeComment({
            commentId: 555,
            score: -2,
            bodyMarkdown: 'Deleted-user comment.',
            authorName: undefined,
            authorLink: undefined,
            creationDate: undefined,
          }),
        ],
        answers: [makeAnswer({ comments: [] })],
      }),
    );

    expect(text).toContain('Deleted-user comment.');
    expect(text).toContain('comment 555');
    // A negative score keeps its sign rather than gaining a spurious '+'.
    expect(text).toContain('**-2**');
    expect(text).not.toContain('undefined');
    // No fabricated stand-in for the missing author.
    expect(text).not.toMatch(/unknown author|anonymous/i);
  });

  it('renders a comment name without a profile link as plain text', () => {
    const text = rendered(
      makeThread({
        comments: [makeComment({ authorName: 'Linkless', authorLink: undefined })],
        answers: [makeAnswer({ comments: [] })],
      }),
    );

    expect(text).toContain('Linkless');
    expect(text).not.toContain('[Linkless](');
  });
});
