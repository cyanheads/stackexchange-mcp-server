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
    'Results past the pageSize cap are reachable with the `page` parameter. ' +
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
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page of results to return, 1-based (default 1). Page 2 with pageSize 10 returns results 11–20. ' +
          'Each page is a separate upstream call and costs one API quota unit, which matters on the keyless 300/day tier. ' +
          'Without STACKEXCHANGE_API_KEY, Stack Exchange refuses any page above 25.',
      ),
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
            creationDate: z
              .string()
              .optional()
              .describe(
                'ISO 8601 timestamp of when the question was asked — use it to judge whether the advice is still current.',
              ),
            lastActivityDate: z
              .string()
              .optional()
              .describe(
                'ISO 8601 timestamp of the most recent activity on the question (edit, answer, or comment).',
              ),
          })
          .describe('A Stack Exchange FAQ question with score, answer count, tags, and dates.'),
      )
      .describe('Highest-voted answered questions for the specified tag, ordered by votes.'),
    tag: z.string().describe('Tag name used for this FAQ lookup.'),
    site: z.string().describe('Stack Exchange site api_site_parameter used for this lookup.'),
    page: z
      .number()
      .int()
      .describe('The 1-based page these results came from — 1 when the input omitted page.'),
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
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The provided site value is not a valid Stack Exchange network site identifier.',
      recovery:
        'Call stackexchange_list_sites to discover valid site api_site_parameter values and retry.',
    },
    {
      reason: 'invalid_parameter',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Stack Exchange rejected a request parameter and named the field rather than reporting a bad site.',
      recovery:
        'Correct the parameter named in the error message — tag must be an exact tag name and pageSize must be 1–30.',
    },
    {
      reason: 'quota_exceeded',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Stack Exchange API quota_remaining has reached 0.',
      recovery:
        'Quota resets at midnight UTC; set STACKEXCHANGE_API_KEY to lift the limit to 10,000 per day.',
    },
    {
      reason: 'paging_depth_limit',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Stack Exchange refused the requested page because paging above page 25 needs a key.',
      recovery:
        'Retry with page 25 or lower, or set STACKEXCHANGE_API_KEY to reach pages beyond 25.',
    },
    {
      reason: 'invalid_api_key',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Stack Exchange does not recognize the API key this server is configured with.',
      recovery:
        'No tool input can fix this — ask the operator to correct STACKEXCHANGE_API_KEY in the server environment.',
    },
    {
      reason: 'upstream_unavailable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Stack Exchange answered with a body that is not the expected JSON envelope.',
      recovery:
        'Retry in a few minutes — Stack Exchange is degraded and no change to the input helps.',
    },
  ],

  async handler(input, ctx) {
    const svc = getStackExchangeService();
    const { questions, quotaRemaining, quotaMax, hasMore } = await svc.getTagFaq(
      {
        tag: input.tag,
        site: input.site,
        pageSize: input.pageSize,
        page: input.page,
      },
      ctx,
    );

    ctx.enrich({ quotaRemaining, quotaMax });

    // The two notices are mutually exclusive — a filled page cannot be an empty
    // one — and `truncated()` writes `notice` last-wins, so the branch is what
    // keeps one from overwriting the other.
    if (questions.length >= input.pageSize && hasMore) {
      ctx.enrich.truncated({
        shown: questions.length,
        cap: input.pageSize,
        guidance:
          `Showing page ${input.page}; Stack Exchange has more results. ` +
          `Request page ${input.page + 1} with the same tag and pageSize to continue — one API quota unit per page.`,
      });
    } else if (questions.length === 0) {
      ctx.enrich.notice(
        input.page > 1
          ? `Page ${input.page} is past the end of the FAQ for tag "${input.tag}" on ${input.site}. Request a lower page.`
          : `No FAQ questions found for tag "${input.tag}" on ${input.site}. Verify the tag name or try a different site.`,
      );
    }

    ctx.log.info('Fetched SE tag FAQ', {
      tag: input.tag,
      site: input.site,
      page: input.page,
      count: questions.length,
    });

    return {
      questions,
      tag: input.tag,
      site: input.site,
      page: input.page,
      attribution:
        'Stack Exchange Network — content licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)',
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Tag FAQ: \`${result.tag}\` on ${result.site} — page ${result.page}\n`,
    ];
    if (result.questions.length === 0) {
      lines.push('No FAQ questions found for this tag.');
      lines.push('');
      lines.push(`---\n*${result.attribution}*`);
      return [{ type: 'text', text: lines.join('\n') }];
    }
    for (const q of result.questions) {
      lines.push(`### ${q.title}`);
      const stats = [
        `**ID:** ${q.questionId}`,
        `**Score:** ${q.score}`,
        `**Answers:** ${q.answerCount}`,
        `**Answered:** ${q.isAnswered ? 'Yes' : 'No'}`,
      ];
      if (q.creationDate) stats.push(`**Asked:** ${q.creationDate}`);
      if (q.lastActivityDate) stats.push(`**Active:** ${q.lastActivityDate}`);
      lines.push(stats.join(' | '));
      lines.push(`**Tags:** ${q.tags.join(', ')}`);
      lines.push(`**Link:** ${q.link}`);
      lines.push('');
    }
    lines.push(`---\n*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
