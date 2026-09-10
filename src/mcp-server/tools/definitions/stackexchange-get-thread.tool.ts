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

/**
 * Per-post comment cap the service applies. Mirrored here so the handler can
 * report it to the agent alongside the per-post `commentsTruncated` flags.
 */
const COMMENTS_CAP = 20;

/** One comment hanging off a question or an answer. */
const commentSchema = z
  .object({
    commentId: z.number().int().describe('Numeric comment ID.'),
    score: z.number().int().describe('Comment score — comments can score below zero.'),
    bodyMarkdown: z.string().describe('Comment body normalized from HTML to markdown.'),
    authorName: z.string().optional().describe('Comment author display name when available.'),
    authorLink: z.string().optional().describe('Comment author profile URL when available.'),
    creationDate: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp of when the comment was posted — the newest comments carry the freshest corrections.',
      ),
  })
  .describe('A single comment with markdown body, score, date, and author attribution.');

/** The comment-bearing half of a post — shared by the question and every answer. */
type CommentedPost = {
  comments?: z.infer<typeof commentSchema>[] | undefined;
  commentsTruncated?: boolean | undefined;
};

/**
 * Describe a post's `comments` field. The absent-vs-empty distinction is the
 * whole point: an empty array means the post has no comments, while an absent
 * one means the fetch could not establish its state.
 */
const commentsDescription = (post: string) =>
  `Comments on ${post}, newest first, present only when includeComments is true. An empty array means ` +
  'this post has no comments; an absent array means its comment state is unknown — either comments were ' +
  'not requested, or the batched fetch was cut short before this post contributed any. Never read an ' +
  'absent array as "no comments".';

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
    includeComments: z
      .boolean()
      .default(false)
      .describe(
        'Fetch the comment thread under the question and under every returned answer (default false). ' +
          'Comments are where a stale answer usually gets corrected ("this breaks on v3", "use X instead now"), ' +
          "so set this when the answer's continued accuracy matters. Costs 2 extra API calls against the daily " +
          'quota regardless of how many answers are returned.',
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
    answerCount: z
      .number()
      .int()
      .optional()
      .describe(
        'Total answers the question has upstream. When greater than the returned answers[] length, more answers exist — raise maxAnswers to fetch them.',
      ),
    tags: z
      .array(z.string().describe('A tag applied to this question.'))
      .describe('Tags applied to this question.'),
    bodyMarkdown: z.string().describe('Question body normalized from HTML to markdown.'),
    authorName: z.string().optional().describe('Question author display name when available.'),
    authorLink: z.string().optional().describe('Question author profile URL when available.'),
    authorUserId: z
      .number()
      .int()
      .optional()
      .describe(
        'Question author numeric user ID when available — pass to stackexchange_get_user to fetch the full profile.',
      ),
    acceptedAnswerId: z
      .number()
      .int()
      .optional()
      .describe('ID of the accepted answer when one exists.'),
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
    comments: z.array(commentSchema).optional().describe(commentsDescription('the question')),
    commentsTruncated: z
      .boolean()
      .optional()
      .describe(
        "True when the question's comments[] is a partial list — more exist upstream than were returned.",
      ),
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
            authorUserId: z
              .number()
              .int()
              .optional()
              .describe(
                'Answer author numeric user ID when available — pass to stackexchange_get_user to fetch the full profile.',
              ),
            creationDate: z
              .string()
              .optional()
              .describe(
                'ISO 8601 timestamp of when the answer was posted — an old answer may predate the current API.',
              ),
            lastActivityDate: z
              .string()
              .optional()
              .describe('ISO 8601 timestamp of the most recent edit or activity on the answer.'),
            comments: z
              .array(commentSchema)
              .optional()
              .describe(commentsDescription('this answer')),
            commentsTruncated: z
              .boolean()
              .optional()
              .describe(
                "True when this answer's comments[] is a partial list — more exist upstream than were returned.",
              ),
          })
          .describe(
            'A single Q&A answer with markdown body, score, dates, and author attribution.',
          ),
      )
      .describe('Answers sorted: accepted answer first, then by score descending.'),
  }),
  enrichment: {
    quotaRemaining: z.number().describe('Remaining API quota calls for the current day.'),
    quotaMax: z
      .number()
      .describe('Maximum API quota calls per day (300 keyless, ~10,000 with API key).'),
    truncated: z.boolean().optional().describe('True when answers were capped at maxAnswers.'),
    shown: z.number().optional().describe('Number of answers returned.'),
    cap: z.number().optional().describe('The maxAnswers cap applied to this request.'),
    commentsCap: z
      .number()
      .optional()
      .describe(
        'Maximum comments carried per post — a post at this count reports commentsTruncated.',
      ),
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
      code: JsonRpcErrorCode.ValidationError,
      when: 'The provided site value is not a valid Stack Exchange network site identifier.',
      recovery:
        'Call stackexchange_list_sites to discover valid site api_site_parameter values and retry.',
    },
    {
      reason: 'invalid_id_or_url',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input is not a parseable integer ID and not a recognizable SE question URL.',
      recovery:
        'Provide a numeric question ID (e.g. "11227809") or a valid Stack Exchange question URL.',
    },
    {
      reason: 'invalid_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Stack Exchange rejected a request parameter other than the question ID, and named the field.',
      recovery:
        'Correct the parameter named in the error message — maxAnswers must be 1–100 and site must match the question.',
    },
    {
      reason: 'quota_exceeded',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Stack Exchange API quota_remaining has reached 0.',
      recovery:
        'Quota resets at midnight UTC; set STACKEXCHANGE_API_KEY to lift the limit to 10,000 per day.',
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Stack Exchange does not recognize the API key this server is configured with.',
      recovery:
        'No tool input can fix this — ask the operator to correct STACKEXCHANGE_API_KEY in the server environment.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Stack Exchange answered with a body that is not the expected JSON envelope.',
      recovery:
        'Retry in a few minutes — Stack Exchange is degraded and no change to the input helps.',
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
        includeComments: input.includeComments,
      },
      ctx,
    );

    ctx.enrich({
      quotaRemaining,
      quotaMax,
      ...(input.includeComments ? { commentsCap: COMMENTS_CAP } : {}),
    });
    if (thread.answers.length < thread.answerCount) {
      ctx.enrich.truncated({ shown: thread.answers.length, cap: input.maxAnswers });
    }

    ctx.log.info('Fetched SE thread', {
      questionId,
      site: input.site,
      answerCount: thread.answers.length,
      includeComments: input.includeComments,
    });

    return thread;
  },

  format: (result) => {
    const lines: string[] = [];

    /**
     * Whether comments were fetched at all. The question's comment route is
     * single-post, so it always reports that post's own list — a defined
     * `result.comments` is what separates "not requested" from "requested but
     * this post contributed nothing to the batched page".
     */
    const requested = result.comments !== undefined;

    /**
     * Render one post's comment block, indented under that post. The unknown
     * case must never render as the comment-free one: the first is a fact about
     * the fetch, the second a fact about the post.
     */
    const pushComments = (post: CommentedPost): void => {
      if (!requested) return;

      if (!post.comments) {
        lines.push('  *Comments unknown — this post received none of the fetched page.*');
        lines.push('');
        return;
      }
      if (post.comments.length === 0) {
        lines.push('  *No comments.*');
        lines.push('');
        return;
      }

      lines.push(`  **Comments (${post.comments.length}):**`);
      for (const c of post.comments) {
        // Absent author and date are omitted rather than labelled — a deleted
        // or anonymous commenter is missing data, not a fact to render.
        const parts = [`**${c.score >= 0 ? '+' : ''}${c.score}**`];
        if (c.authorName) {
          parts.push(c.authorLink ? `[${c.authorName}](${c.authorLink})` : c.authorName);
        }
        if (c.creationDate) parts.push(c.creationDate);
        parts.push(`comment ${c.commentId}`);
        lines.push(`  - ${parts.join(' · ')}: ${c.bodyMarkdown}`);
      }
      if (post.commentsTruncated) {
        lines.push('  *Comment list is partial for this post — more exist upstream.*');
      }
      lines.push('');
    };

    // Question header
    lines.push(`# ${result.title}`);
    const statParts = [`**Question ID:** ${result.questionId}`, `**Score:** ${result.score}`];
    if (result.answerCount != null) statParts.push(`**Answers:** ${result.answerCount}`);
    if (result.creationDate) statParts.push(`**Asked:** ${result.creationDate}`);
    if (result.lastActivityDate) statParts.push(`**Active:** ${result.lastActivityDate}`);
    lines.push(statParts.join(' | '));
    lines.push(`**Tags:** ${result.tags.join(', ')}`);
    lines.push(`**Link:** ${result.link}`);
    if (result.authorName) {
      const authorRef = result.authorLink
        ? `[${result.authorName}](${result.authorLink})`
        : result.authorName;
      const userIdSuffix = result.authorUserId != null ? ` (user_id: ${result.authorUserId})` : '';
      lines.push(`**Author:** ${authorRef}${userIdSuffix}`);
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
    pushComments(result);

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
        if (a.creationDate) attrParts.push(`**Posted:** ${a.creationDate}`);
        if (a.lastActivityDate) attrParts.push(`**Active:** ${a.lastActivityDate}`);
        if (a.authorName) {
          const authorRef = a.authorLink ? `[${a.authorName}](${a.authorLink})` : a.authorName;
          const userIdSuffix = a.authorUserId != null ? ` (user_id: ${a.authorUserId})` : '';
          attrParts.push(`**Author:** ${authorRef}${userIdSuffix}`);
          if (a.authorReputation != null) {
            attrParts.push(`rep: ${a.authorReputation.toLocaleString()}`);
          }
        }
        lines.push(attrParts.join(' | '));
        lines.push('');
        lines.push(a.bodyMarkdown);
        lines.push('');
        pushComments(a);
      }
    }

    lines.push(
      `---\n*Content licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)*`,
    );

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
