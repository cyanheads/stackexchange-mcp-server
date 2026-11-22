/**
 * @fileoverview Question closure data on the three tools that return questions.
 * @module tests/tools/question-closure.contract
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetTagFaq } from '@/mcp-server/tools/definitions/stackexchange-get-tag-faq.tool.js';
import { stackexchangeGetThread } from '@/mcp-server/tools/definitions/stackexchange-get-thread.tool.js';
import { stackexchangeSearchQuestions } from '@/mcp-server/tools/definitions/stackexchange-search-questions.tool.js';
import { initStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

const question = {
  question_id: 3975376,
  title: 'Copying an object',
  link: 'https://stackoverflow.com/q/3975376',
  score: 5,
  tags: ['python'],
  answer_count: 0,
  is_answered: false,
  body: '<p>Question body.</p>',
};

function serveQuestion(fields: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    Response.json({
      items: String(input).includes('/answers?') ? [] : [{ ...question, ...fields }],
      has_more: false,
      quota_remaining: 250,
      quota_max: 300,
    }),
  );
}

beforeEach(() => initStackExchangeService({} as AppConfig, {} as StorageService));
afterEach(() => vi.restoreAllMocks());

describe('question closure on the wire', () => {
  it('keeps the body and omits closure fields on an open thread', async () => {
    const fetch = serveQuestion({});
    const result = await runToolContract(stackexchangeGetThread, { questionIdOrUrl: '3975376' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ bodyMarkdown: 'Question body.' });
    for (const key of ['closedReason', 'closedDate', 'duplicateOf']) {
      expect(result.structuredContent).not.toHaveProperty(key);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['search', () => runToolContract(stackexchangeSearchQuestions, { query: 'copy' })],
    ['FAQ', () => runToolContract(stackexchangeGetTagFaq, { tag: 'python' })],
    ['thread', () => runToolContract(stackexchangeGetThread, { questionIdOrUrl: '3975376' })],
  ] as const)('reports a nonduplicate closure on both %s surfaces', async (surface, call) => {
    serveQuestion({ closed_reason: 'Needs details', closed_date: 1679868108 });
    const result = await call();
    expect(result.isError).toBeFalsy();
    const expected = { closedReason: 'Needs details', closedDate: '2023-03-26T22:01:48.000Z' };
    expect(result.structuredContent).toMatchObject(
      surface === 'thread' ? expected : { questions: [expected] },
    );
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('Needs details');
    expect(text).toContain('2023-03-26T22:01:48.000Z');
    expect(result.structuredContent).not.toHaveProperty('duplicateOf');
  });

  it('preserves every original in order and its optional accepted answer without another request', async () => {
    const fetch = serveQuestion({
      closed_reason: 'Duplicate',
      closed_details: {
        original_questions: [
          {
            question_id: 184710,
            title: 'Copy &amp; reference',
            answer_count: 31,
            accepted_answer_id: 184745,
          },
          { question_id: 2438938, title: 'Copy on assignment?', answer_count: 0 },
        ],
      },
    });
    const result = await runToolContract(stackexchangeGetThread, { questionIdOrUrl: '3975376' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty('duplicateOf', [
      { questionId: 184710, title: 'Copy & reference', answerCount: 31, acceptedAnswerId: 184745 },
      { questionId: 2438938, title: 'Copy on assignment?', answerCount: 0 },
    ]);
    expect(result.structuredContent).not.toHaveProperty('closedDate');
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    for (const value of [
      '184710',
      'Copy & reference',
      '31',
      '184745',
      '2438938',
      'Copy on assignment',
    ])
      expect(text).toContain(value);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
