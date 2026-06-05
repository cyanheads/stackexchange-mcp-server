/**
 * @fileoverview Tool to search questions across a Stack Exchange site.
 * @module mcp-server/tools/definitions/stackexchange-search-questions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

export const stackexchangeSearchQuestions = tool('stackexchange_search_questions', {
  title: 'Search Stack Exchange Questions',
  description:
    'Search questions across a Stack Exchange site. Returns ranked questions with title, score, answer count, ' +
    'accepted status, tags, and excerpt — no bodies at this stage. Results supply question_id values for ' +
    'stackexchange_get_thread, which fetches the full question body and all answers. ' +
    'Use the `site` parameter to target a specific community (e.g. "stackoverflow", "superuser", "unix"); ' +
    'call stackexchange_list_sites to discover valid site values.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    query: z
      .string()
      .describe('Full-text search query (e.g. "python async generator send value").'),
    site: z
      .string()
      .default('stackoverflow')
      .describe(
        'Stack Exchange site to search — use the api_site_parameter value (e.g. "stackoverflow", "superuser", "serverfault"). ' +
          'Defaults to "stackoverflow". Call stackexchange_list_sites to discover valid values.',
      ),
    tags: z
      .array(z.string().describe('A single tag to filter by (e.g. "python", "async").'))
      .optional()
      .describe('Filter results to questions with all specified tags.'),
    acceptedOnly: z
      .boolean()
      .optional()
      .describe('When true, return only questions that have an accepted answer.'),
    minScore: z
      .number()
      .int()
      .optional()
      .describe('Minimum question score — excludes questions with lower scores.'),
    sort: z
      .enum(['relevance', 'votes', 'activity', 'newest'])
      .default('relevance')
      .describe(
        'Result ordering: "relevance" (default, best match), "votes" (highest score first), ' +
          '"activity" (most recently active), "newest" (most recently created).',
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
            excerpt: z
              .string()
              .optional()
              .describe('Short text excerpt from the question when available.'),
          })
          .describe(
            'A Stack Exchange question with score, answer count, tags, and optional excerpt.',
          ),
      )
      .describe('Questions matching the search query, ordered by the specified sort.'),
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
  },
  enrichmentTrailer: {
    quotaRemaining: { label: 'Quota Remaining' },
    quotaMax: { label: 'Quota Max' },
  },

  errors: [
    {
      reason: 'invalid_site',
      code: JsonRpcErrorCode.InvalidParams,
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
    const filteredTags = input.tags?.filter(Boolean);
    const { questions, quotaRemaining, quotaMax } = await svc.searchQuestions(
      {
        query: input.query,
        site: input.site,
        ...(filteredTags && filteredTags.length > 0 ? { tags: filteredTags } : {}),
        ...(input.acceptedOnly !== undefined ? { acceptedOnly: input.acceptedOnly } : {}),
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        sort: input.sort,
        pageSize: input.pageSize,
      },
      ctx,
    );

    ctx.enrich({ quotaRemaining, quotaMax });

    if (questions.length === 0) {
      ctx.enrich.notice(
        `No questions matched "${input.query}" on ${input.site}. Try broader terms, different tags, or a different site.`,
      );
    }

    ctx.log.info('Searched SE questions', {
      query: input.query,
      site: input.site,
      count: questions.length,
    });

    return {
      questions,
      attribution:
        'Stack Exchange Network — content licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)',
    };
  },

  format: (result) => {
    if (result.questions.length === 0) {
      return [{ type: 'text', text: 'No questions found for the given query.' }];
    }
    const lines: string[] = [];
    for (const q of result.questions) {
      lines.push(`## ${q.title}`);
      lines.push(
        `**ID:** ${q.questionId} | **Score:** ${q.score} | **Answers:** ${q.answerCount} | **Answered:** ${q.isAnswered ? 'Yes' : 'No'}`,
      );
      lines.push(`**Tags:** ${q.tags.join(', ')}`);
      lines.push(`**Link:** ${q.link}`);
      if (q.excerpt) lines.push(`\n${q.excerpt}`);
      lines.push('');
    }
    lines.push(`---\n*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
