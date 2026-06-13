/**
 * @fileoverview Tool to fetch the highest-voted answered questions for a tag (tag FAQ).
 * @module mcp-server/tools/definitions/stackexchange-get-tag-faq
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

export const stackexchangeGetTagFaq = tool('stackexchange_get_tag_faq', {
  title: 'Get Stack Exchange Tag FAQ',
  description:
    'Fetch the highest-voted answered questions for a tag on a Stack Exchange site — the canonical "best answers in X" list. ' +
    'Returns a question list without bodies; use stackexchange_get_thread to read the full body and answers for any result. ' +
    'Use this tool to find the authoritative community resources on a topic (e.g. tag "javascript" on stackoverflow). ' +
    'Use stackexchange_search_questions for free-text search rather than tag-based browsing.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    tag: z
      .string()
      .describe('Tag to look up (e.g. "python", "javascript", "docker"). Must match exactly.'),
    site: z
      .string()
      .default('stackoverflow')
      .describe(
        'Stack Exchange site — use the api_site_parameter value (e.g. "stackoverflow", "superuser"). ' +
          'Defaults to "stackoverflow". Call stackexchange_list_sites to discover valid values.',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe('Number of results to return (1–30, default 10).'),
  }),
  output: z.object({
    questions: z
      .array(
        z
          .object({
            questionId: z
              .number()
              .int()
              .describe('Question ID — pass to stackexchange_get_thread to fetch the full thread.'),
            title: z.string().describe('Question title.'),
            link: z.string().describe('Direct URL to the question.'),
            score: z.number().int().describe('Question score (upvotes minus downvotes).'),
            answerCount: z.number().int().describe('Total number of answers.'),
            isAnswered: z
              .boolean()
              .describe(
                'True when the question has an accepted answer or at least one positively-scored answer.',
              ),
            tags: z
              .array(z.string().describe('A tag applied to this question.'))
              .describe('Tags applied to this question.'),
          })
          .describe('A Stack Exchange FAQ question with score, answer count, and tags.'),
      )
      .describe('Highest-voted answered questions for the specified tag, ordered by votes.'),
    tag: z.string().describe('Tag name used for this FAQ lookup.'),
    site: z.string().describe('Stack Exchange site api_site_parameter used for this lookup.'),
    attribution: z
      .string()
      .describe(
        'Content license notice. Stack Exchange content is licensed under CC BY-SA 4.0 and requires attribution.',
      ),
  }),
  enrichment: {
    quotaRemaining: z.number().describe('Remaining API quota calls for the current day.'),
    quotaMax: z
      .number()
      .describe('Maximum API quota calls per day (300 keyless, ~10,000 with API key).'),
    truncated: z.boolean().optional().describe('True when results were capped at pageSize.'),
    shown: z.number().optional().describe('Number of results returned.'),
    cap: z.number().optional().describe('The pageSize cap applied to this request.'),
    notice: z
      .string()
      .optional()
      .describe('Actionable guidance when results are empty or filtered.'),
  },
  enrichmentTrailer: {
    quotaRemaining: { label: 'Quota Remaining' },
    quotaMax: { label: 'Quota Max' },
  },

  errors: [
    {
      reason: 'invalid_site',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The provided site value is not a valid Stack Exchange network site identifier.',
      recovery:
        'Call stackexchange_list_sites to discover valid site api_site_parameter values and retry.',
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
    const svc = getStackExchangeService();
    const { questions, quotaRemaining, quotaMax } = await svc.getTagFaq(
      {
        tag: input.tag,
        site: input.site,
        pageSize: input.pageSize,
      },
      ctx,
    );

    ctx.enrich({ quotaRemaining, quotaMax });
    ctx.enrich.truncated({ shown: questions.length, cap: input.pageSize });

    if (questions.length === 0) {
      ctx.enrich.notice(
        `No FAQ questions found for tag "${input.tag}" on ${input.site}. Verify the tag name or try a different site.`,
      );
    }

    ctx.log.info('Fetched SE tag FAQ', {
      tag: input.tag,
      site: input.site,
      count: questions.length,
    });

    return {
      questions,
      tag: input.tag,
      site: input.site,
      attribution:
        'Stack Exchange Network — content licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)',
    };
  },

  format: (result) => {
    const lines: string[] = [`## Tag FAQ: \`${result.tag}\` on ${result.site}\n`];
    if (result.questions.length === 0) {
      lines.push('No FAQ questions found for this tag.');
      lines.push('');
      lines.push(`---\n*${result.attribution}*`);
      return [{ type: 'text', text: lines.join('\n') }];
    }
    for (const q of result.questions) {
      lines.push(`### ${q.title}`);
      lines.push(
        `**ID:** ${q.questionId} | **Score:** ${q.score} | **Answers:** ${q.answerCount} | **Answered:** ${q.isAnswered ? 'Yes' : 'No'}`,
      );
      lines.push(`**Tags:** ${q.tags.join(', ')}`);
      lines.push(`**Link:** ${q.link}`);
      lines.push('');
    }
    lines.push(`---\n*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
