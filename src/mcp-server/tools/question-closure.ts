/**
 * @fileoverview Stack Exchange question closure fields shared by search, tag FAQs and threads.
 * @module mcp-server/tools/question-closure
 */
import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Optional on open questions and when Stack Exchange omits the value. */
export const closureFields = {
  closedReason: z
    .string()
    .optional()
    .describe('Reason Stack Exchange gives for closing the question.'),
  closedDate: z.string().optional().describe('ISO 8601 timestamp when the question was closed.'),
};

/** Append reported closure details to the question's existing Markdown statistics. */
export function appendClosureStats(
  stats: string[],
  question: { closedReason?: string | undefined; closedDate?: string | undefined },
): void {
  if (question.closedReason !== undefined)
    stats.push(`**Closed:** ${escapeMarkdownInline(question.closedReason)}`);
  if (question.closedDate !== undefined) stats.push(`**Closed on:** ${question.closedDate}`);
}
