/**
 * @fileoverview Tool to fetch a complete Stack Exchange Q&A thread with HTML→markdown normalization.
 * @module mcp-server/tools/definitions/stackexchange-get-thread
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

/**
 * Parse a question ID from either a numeric string or a Stack Exchange question URL.
 * Returns null if the input cannot be parsed as a valid SE question ID.
 */
function parseQuestionIdOrUrl(input: string): number | null {
  const trimmed = input.trim();

  // Numeric ID directly
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // Full SE question URL: extract the integer immediately after /questions/
  // Handles: https://stackoverflow.com/questions/11227809/...
  //          https://stackoverflow.com/questions/11227809/title#answerAnchor
  const match = trimmed.match(/\/questions\/(\d+)/);
  if (match?.[1]) {
    return parseInt(match[1], 10);
  }

  return null;
}

export const stackexchangeGetThread = tool('stackexchange_get_thread', {
  title: 'Get Stack Exchange Q&A Thread',
  description:
    'Fetch a complete Q&A thread — question body and all answers, accepted answer first then sorted by score, ' +
    'rendered as clean markdown with fenced code blocks. Accepts an integer question ID or a full Stack Exchange ' +
    'question URL (e.g. "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster" or ' +
    '"11227809"). HTML is normalized to markdown automatically; attribution (author + link) included per CC BY-SA 4.0. ' +
    'Get question IDs from stackexchange_search_questions or stackexchange_get_tag_faq.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    questionIdOrUrl: z
      .string()
      .describe(
        'Numeric question ID (e.g. "11227809") or a full Stack Exchange question URL ' +
          '(e.g. "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster"). ' +
          'The integer immediately following /questions/ is extracted from URLs.',
      ),
    site: z
      .string()
      .default('stackoverflow')
      .describe(
        'Stack Exchange site — use the api_site_parameter value (e.g. "stackoverflow", "superuser"). ' +
          'Defaults to "stackoverflow". Must match the site where the question lives. ' +
          'Call stackexchange_list_sites to discover valid values.',
      ),
    maxAnswers: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Maximum number of answers to include (1–100, default 10). Answers are sorted: accepted first, then by score.',
      ),
  }),
  output: z.object({
    questionId: z
      .number()
      .int()
      .describe('Numeric question ID — identifies this thread on the site.'),
    title: z.string().describe('Question title.'),
    link: z.string().describe('Direct URL to the question.'),
    score: z.number().int().describe('Question score (upvotes minus downvotes).'),
    tags: z
      .array(z.string().describe('A tag applied to this question.'))
      .describe('Tags applied to this question.'),
    bodyMarkdown: z.string().describe('Question body normalized from HTML to markdown.'),
    authorName: z.string().optional().describe('Question author display name when available.'),
    authorLink: z.string().optional().describe('Question author profile URL when available.'),
    acceptedAnswerId: z
      .number()
      .int()
      .optional()
      .describe('ID of the accepted answer when one exists.'),
    answers: z
      .array(
        z
          .object({
            answerId: z.number().int().describe('Numeric answer ID.'),
            score: z.number().int().describe('Answer score (upvotes minus downvotes).'),
            isAccepted: z.boolean().describe('True when this is the accepted answer.'),
            bodyMarkdown: z.string().describe('Answer body normalized from HTML to markdown.'),
            authorName: z
              .string()
              .optional()
              .describe('Answer author display name when available.'),
            authorLink: z.string().optional().describe('Answer author profile URL when available.'),
            authorReputation: z
              .number()
              .int()
              .optional()
              .describe('Answer author reputation when available.'),
          })
          .describe('A single Q&A answer with markdown body, score, and author attribution.'),
      )
      .describe('Answers sorted: accepted answer first, then by score descending.'),
  }),
  enrichment: {
    quotaRemaining: z.number().describe('Remaining API quota calls for the current day.'),
    quotaMax: z
      .number()
      .describe('Maximum API quota calls per day (300 keyless, ~10,000 with API key).'),
  },
  enrichmentTrailer: {
    quotaRemaining: { label: 'Quota Remaining' },
    quotaMax: { label: 'Quota Max' },
  },

  errors: [
    {
      reason: 'question_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The question lookup returns an empty result set — SE returns HTTP 200 with no items for unknown question IDs rather than 404.',
      recovery:
        'Verify the question ID or run stackexchange_search_questions to find a valid question ID.',
    },
    {
      reason: 'invalid_site',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The provided site value is not a valid Stack Exchange network site identifier.',
      recovery:
        'Call stackexchange_list_sites to discover valid site api_site_parameter values and retry.',
    },
    {
      reason: 'invalid_id_or_url',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The input is not a parseable integer ID and not a recognizable SE question URL.',
      recovery:
        'Provide a numeric question ID (e.g. "11227809") or a valid Stack Exchange question URL.',
    },
    {
      reason: 'quota_exceeded',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Stack Exchange API quota_remaining has reached 0.',
      recovery:
        'Quota resets at midnight UTC; set STACKEXCHANGE_API_KEY to lift the limit to 10,000 per day.',
    },
  ],

  async handler(input, ctx) {
    const questionId = parseQuestionIdOrUrl(input.questionIdOrUrl);
    if (questionId === null) {
      throw ctx.fail(
        'invalid_id_or_url',
        `Cannot parse "${input.questionIdOrUrl}" as a question ID or SE question URL.`,
        { ...ctx.recoveryFor('invalid_id_or_url'), input: input.questionIdOrUrl },
      );
    }

    const svc = getStackExchangeService();
    const { thread, quotaRemaining, quotaMax } = await svc.getThread(
      {
        questionId,
        site: input.site,
        maxAnswers: input.maxAnswers,
      },
      ctx,
    );

    ctx.enrich({ quotaRemaining, quotaMax });

    ctx.log.info('Fetched SE thread', {
      questionId,
      site: input.site,
      answerCount: thread.answers.length,
    });

    return thread;
  },

  format: (result) => {
    const lines: string[] = [];

    // Question header
    lines.push(`# ${result.title}`);
    lines.push(`**Question ID:** ${result.questionId} | **Score:** ${result.score}`);
    lines.push(`**Tags:** ${result.tags.join(', ')}`);
    lines.push(`**Link:** ${result.link}`);
    if (result.authorName) {
      const authorRef = result.authorLink
        ? `[${result.authorName}](${result.authorLink})`
        : result.authorName;
      lines.push(`**Author:** ${authorRef}`);
    }
    if (result.acceptedAnswerId != null) {
      lines.push(`**Accepted Answer ID:** ${result.acceptedAnswerId}`);
    }
    lines.push('');

    // Question body
    lines.push('## Question');
    lines.push('');
    lines.push(result.bodyMarkdown);
    lines.push('');

    // Answers
    if (result.answers.length === 0) {
      lines.push('*No answers yet.*');
    } else {
      lines.push(`---\n\n## Answers (${result.answers.length})`);
      for (const a of result.answers) {
        lines.push('');
        const acceptedBadge = a.isAccepted ? ' ✓ Accepted' : '';
        lines.push(`### Answer ${a.answerId}${acceptedBadge}`);

        // Attribution per CC BY-SA 4.0
        const attrParts: string[] = [`**Score:** ${a.score}`];
        if (a.authorName) {
          const authorRef = a.authorLink ? `[${a.authorName}](${a.authorLink})` : a.authorName;
          attrParts.push(`**Author:** ${authorRef}`);
          if (a.authorReputation != null) {
            attrParts.push(`rep: ${a.authorReputation.toLocaleString()}`);
          }
        }
        lines.push(attrParts.join(' | '));
        lines.push('');
        lines.push(a.bodyMarkdown);
        lines.push('');
      }
    }

    lines.push(
      `---\n*Content licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)*`,
    );

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
