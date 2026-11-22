/**
 * @fileoverview Tool to fetch a complete Stack Exchange Q&A thread with HTML→markdown normalization.
 * @module mcp-server/tools/definitions/stackexchange-get-thread
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import {
  COMMENTS_PAGE_SIZE,
  getStackExchangeService,
  type ThreadTarget,
} from '@/services/stackexchange/stackexchange-service.js';
import { appendClosureStats, closureFields } from '../question-closure.js';

/** The site a numeric question ID is read from when the caller names none. */
const DEFAULT_SITE = 'stackoverflow';

/** The first `/questions/{id}` anywhere in the input. */
const QUESTION_REF = /\/questions\/(\d+)/;
const SHARE_REF = /\/([qa])\/(\d+)(?=$|[/#?\s<>)\]"'`])/;
const LONG_ANSWER_REF = /^\/[^/\s?#<>()[\]"'`]+\/(\d+)(?=$|[/#?\s<>)\]"'`])/;

/**
 * The authority directly in front of that reference — after `//`, or, when no
 * scheme was written, after the start of the text, whitespace, `<`, `(`, `[` or
 * a quote. Anchored at the end, so wrapped forms (`<https://…>`, an archive URL
 * around a question URL, `see unix.stackexchange.com/questions/…`) yield the
 * host the question path belongs to. The capture excludes every delimiter, so
 * each candidate start scans only to the next one: linear in the input.
 */
const AUTHORITY_BEFORE = /(?:^|\/\/|[\s<(["'`])([^\s/?#<>()[\]"'`]+)$/;

/**
 * A hostname lowercased, without a leading `www.` or the trailing dot of a
 * fully qualified name — Stack Exchange answers `stackoverflow.com.` with
 * "No site found".
 */
const bareHost = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');

/**
 * Read the post target and the authority immediately before its path. Keep
 * the legacy /questions/ match first for wrapped URLs and hostless paths.
 */
function parseQuestionIdOrUrl(input: string): (ThreadTarget & { host?: string }) | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return { questionId: parseInt(trimmed, 10) };

  const question = QUESTION_REF.exec(trimmed);
  const ref = question ?? SHARE_REF.exec(trimmed);
  if (!ref) return null;
  const authority = AUTHORITY_BEFORE.exec(trimmed.slice(0, ref.index))?.[1];
  const hostname = authority ? URL.parse(`https://${authority}`)?.hostname : undefined;
  const host = hostname === undefined ? undefined : bareHost(hostname);
  // Two non-empty labels at least, so `.` and `..` stay relative-path segments.
  const location = host && /[^.]\.[^.]/.test(host) ? { host } : {};
  if (!question) {
    const id = Number(ref[2]);
    return ref[1] === 'a' ? { ...location, answerId: id } : { ...location, questionId: id };
  }
  const questionId = Number(question[1]);
  const answerId = Number(LONG_ANSWER_REF.exec(trimmed.slice(ref.index + ref[0].length))?.[1]);
  return {
    ...location,
    questionId,
    ...(Number.isSafeInteger(answerId) && answerId > 0 && answerId !== questionId
      ? { answerId }
      : {}),
  };
}

/**
 * The `api_site_parameter` of a site's canonical host: the subdomain on
 * stackexchange.com (`unix.meta.stackexchange.com` → `unix.meta`), the host
 * less `.com` elsewhere (`ru.stackoverflow.com` → `ru.stackoverflow`), and
 * mathoverflow.net's hosts as they are. Holds for every site in `/2.3/sites`.
 */
function siteParameterOf(host: string): string {
  if (host.endsWith('.stackexchange.com')) return host.slice(0, -'.stackexchange.com'.length);
  return host.endsWith('.com') ? host.slice(0, -'.com'.length) : host;
}

/**
 * Whether a caller's `site` names the site a URL was read from. Compared with
 * the URL's own host and with the canonical host of the question `link` Stack
 * Exchange returned (in either form), so an alias URL beside its site's
 * current parameter — `arqade.com` with `gaming` — still counts as a match.
 */
function namesSameSite(site: string, urlHost: string, link: string): boolean {
  const value = bareHost(site.trim());
  const linkHostname = URL.parse(link)?.hostname;
  const linkHost = linkHostname ? bareHost(linkHostname) : undefined;
  return (
    value === urlHost ||
    (linkHost !== undefined && (value === linkHost || value === siteParameterOf(linkHost)))
  );
}

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
  `Comments on ${post}, newest first. An empty array means no entries on the requested page. An absent array means comments were not requested or no entries for this post could be established from the fetched page.`;

export const stackexchangeGetThread = tool('stackexchange_get_thread', {
  title: 'Get Stack Exchange Q&A Thread',
  description:
    'Fetch a Stack Exchange question and a page of answers, accepted first then by score, with Markdown bodies and attribution. Accepts a question ID, a full question URL, or a Share URL like "https://stackoverflow.com/q/11227809" or "https://stackoverflow.com/a/11227902". Use answersPage to continue and includeComments to read corrections and follow-up discussion.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    questionIdOrUrl: z
      .string()
      .describe(
        'Numeric question ID or a Stack Exchange question or answer URL (/questions/, /q/, or /a/). A URL supplies its site. If its host is unknown to Stack Exchange, the tool uses the explicit site when provided and otherwise reports invalid_site.',
      ),
    site: z
      .string()
      .optional()
      .describe(
        'Stack Exchange site a numeric question ID belongs to — the apiSiteParameter (e.g. "stackoverflow", "unix") or the site\'s domain (e.g. "unix.stackexchange.com"). Defaults to "stackoverflow". Not needed with a URL, which names its own site: a site naming a different one is ignored, or used when the URL host is not a Stack Exchange site, and either way reported as siteConflict. Call stackexchange_list_sites to discover valid values.',
      ),
    maxAnswers: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Votes page size (1–100, default 10). The linked answer and the first page’s accepted answer can add items beyond this size.',
      ),
    answersPage: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Votes page to fetch, starting at 1. Keep maxAnswers fixed when paging.'),
    includeComments: z
      .boolean()
      .default(false)
      .describe(
        'Fetch the requested comments page on the question and on batches of up to 100 returned answer IDs. An out-of-page answer from a long URL can add a separate comments request.',
      ),
    commentsPage: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Comment page to fetch with includeComments, starting at 1. Keep the question URL, answersPage and maxAnswers fixed when paging comments.',
      ),
  }),
  output: z.object({
    ...closureFields,
    duplicateOf: z
      .array(
        z
          .object({
            questionId: z.number().int().describe('Original question ID on the same site.'),
            title: z.string().describe('Title of the original question.'),
            answerCount: z.number().int().describe('Answer count on the original question.'),
            acceptedAnswerId: z
              .number()
              .int()
              .optional()
              .describe('Accepted answer ID when reported.'),
          })
          .describe('A question identified by Stack Exchange as an original of this duplicate.'),
      )
      .optional()
      .describe(
        'Original questions for a duplicate, in Stack Exchange order. Pass their question IDs to this tool with the same site.',
      ),
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
        'Total answers the question has upstream, across all pages. Use nextAnswersPage, when present, to continue.',
      ),
    answersPage: z.number().int().optional().describe('Requested votes page when greater than 1.'),
    commentsPage: z
      .number()
      .int()
      .optional()
      .describe('Requested comment page when greater than 1 and comments were requested.'),
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
      .describe("True when this slice doesn't establish the question's full comment list."),
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
              .describe("True when this slice doesn't establish the answer's full comment list."),
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
    truncated: z.boolean().optional().describe('True when the votes page has a successor.'),
    shown: z.number().optional().describe('Number of answers returned.'),
    cap: z.number().optional().describe('The maxAnswers cap applied to this request.'),
    commentsCap: z
      .number()
      .optional()
      .describe(
        'Maximum number of comments per upstream page, shared across all IDs in an answer batch.',
      ),
    nextAnswersPage: z
      .number()
      .int()
      .optional()
      .describe('Next answersPage when Stack Exchange reports more votes-ranked answers.'),
    nextQuestionCommentsPage: z
      .number()
      .int()
      .optional()
      .describe('Next commentsPage when the question has more comments.'),
    nextAnswerCommentsPage: z
      .number()
      .int()
      .optional()
      .describe('Next commentsPage when at least one answer batch has more comments.'),
    notice: z
      .string()
      .optional()
      .describe('How to continue the answer page or which linked content could not be read.'),
    siteConflict: z
      .object({
        resolvedBy: z
          .enum(['url_host', 'site'])
          .describe(
            'Which one the question was read from: "url_host" when site was ignored in favor of the URL\'s own site, "site" when the URL host is not a Stack Exchange site and site was used instead.',
          ),
        urlHost: z.string().describe('Host of the question URL.'),
        site: z.string().describe('The site value passed.'),
      })
      .optional()
      .describe(
        'Present only when questionIdOrUrl is a URL and site names a different site — says which of the two the question was read from.',
      ),
  },
  enrichmentTrailer: {
    quotaRemaining: { label: 'Quota Remaining' },
    quotaMax: { label: 'Quota Max' },
    nextQuestionCommentsPage: {
      render: (value) =>
        value === undefined
          ? ''
          : `> More question comments are available. Continue with commentsPage: ${value}.`,
    },
    nextAnswerCommentsPage: {
      render: (value) =>
        value === undefined
          ? ''
          : `> More comments are available in at least one answer batch. Continue with commentsPage: ${value}, keeping answersPage and maxAnswers fixed.`,
    },
    siteConflict: {
      render: (value) => {
        if (value === undefined) return '';
        const site = escapeMarkdownInline(value.site);
        const urlHost = escapeMarkdownInline(value.urlHost);
        return value.resolvedBy === 'url_host'
          ? `> site "${site}" was ignored — the question was read from ${urlHost}, the site its URL names.`
          : `> ${urlHost} is not a Stack Exchange site, so the question was read from site "${site}".`;
      },
    },
  },

  errors: [
    {
      reason: 'question_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The question lookup returns an empty result set — SE returns HTTP 200 with no items for unknown question IDs rather than 404.',
      recovery:
        'Verify the question ID or run stackexchange_search_questions to find a valid question ID.',
    },
    {
      reason: 'answer_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'An answer Share URL refers to an answer absent from the Stack Exchange response.',
      recovery: 'Verify the answer URL or pass its full question URL to read the thread.',
    },
    {
      reason: 'paging_depth_limit',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Stack Exchange refused a requested page above 25 without an API key.',
      recovery:
        'Use answersPage and commentsPage at 25 or below, or configure STACKEXCHANGE_API_KEY.',
    },
    {
      reason: 'invalid_site',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The site value, or the host of a question URL, is not a Stack Exchange network site.',
      recovery:
        'Pass a question URL from a Stack Exchange site, or call stackexchange_list_sites to discover valid site values and retry.',
    },
    {
      reason: 'invalid_id_or_url',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input has no recognized question ID or post URL, or Stack Exchange refused the ID.',
      recovery: 'Provide a numeric question ID or a valid Stack Exchange question or answer URL.',
    },
    {
      reason: 'invalid_parameter',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Stack Exchange rejected a request parameter other than the question ID, and named the field.',
      recovery:
        'Correct the parameter named in the error message — maxAnswers must be 1–100 and site must match the question.',
    },
    {
      reason: 'quota_exceeded',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Stack Exchange API quota_remaining has reached 0.',
      retryable: false,
      recovery:
        'Quota resets at midnight UTC; set STACKEXCHANGE_API_KEY to lift the limit to 10,000 per day.',
    },
    {
      reason: 'throttled',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Stack Exchange returned an IP throttle, or the backoff for this API method exceeds the remaining time.',
      recovery:
        'Wait the retryAfter seconds shown before retrying. A method backoff applies to that method across sites. HTTP 429 and throttle_violation apply to every method.',
    },
    {
      reason: 'pacer_shed',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: "The call would wait in this server's queue to Stack Exchange longer than its time budget allows.",
      recovery: 'Wait the retryAfter seconds shown before retrying the queued request.',
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
      when: 'Stack Exchange reported itself temporarily unavailable or failing internally, or answered with a body that is not the expected JSON envelope.',
      recovery:
        'Retry in a few minutes — Stack Exchange is degraded and no change to the input helps.',
    },
  ],

  async handler(input, ctx) {
    const parsed = parseQuestionIdOrUrl(input.questionIdOrUrl);
    if (parsed === null) {
      throw ctx.fail(
        'invalid_id_or_url',
        `Cannot parse "${input.questionIdOrUrl}" as a question ID or a Stack Exchange question URL.`,
        { input: input.questionIdOrUrl },
      );
    }
    const { host, ...reference } = parsed;

    // A blank site from a form-based client is unset. `site` is optional rather
    // than defaulted so an omitted value is never reported as a siteConflict.
    const requestedSite = input.site?.trim() ? input.site : undefined;
    const site = host ?? requestedSite ?? DEFAULT_SITE;
    // A host Stack Exchange does not know (a translation proxy) falls back to the
    // caller's own site — the request 0.1.17 sent. Without one it stays invalid_site.
    const fallbackSite =
      host && requestedSite !== undefined && bareHost(requestedSite.trim()) !== host
        ? requestedSite
        : undefined;

    const svc = getStackExchangeService();
    const {
      thread,
      quotaRemaining,
      quotaMax,
      siteUsed,
      answersHaveMore,
      questionCommentsHaveMore,
      answerCommentsHaveMore,
      linkedLookupFailed,
    } = await svc.getThread(
      {
        ...reference,
        site,
        ...(fallbackSite !== undefined ? { fallbackSite } : {}),
        maxAnswers: input.maxAnswers,
        answersPage: input.answersPage,
        commentsPage: input.commentsPage,
        includeComments: input.includeComments,
      },
      ctx,
    );

    let siteConflict:
      | { resolvedBy: 'site' | 'url_host'; urlHost: string; site: string }
      | undefined;
    if (host && requestedSite !== undefined) {
      const resolvedBy =
        siteUsed !== host
          ? 'site'
          : namesSameSite(requestedSite, host, thread.link)
            ? undefined
            : 'url_host';
      if (resolvedBy) siteConflict = { resolvedBy, urlHost: host, site: requestedSite };
    }

    ctx.enrich({
      quotaRemaining,
      quotaMax,
      ...(input.includeComments ? { commentsCap: COMMENTS_PAGE_SIZE } : {}),
      ...(answersHaveMore ? { nextAnswersPage: input.answersPage + 1 } : {}),
      ...(questionCommentsHaveMore ? { nextQuestionCommentsPage: input.commentsPage + 1 } : {}),
      ...(answerCommentsHaveMore ? { nextAnswerCommentsPage: input.commentsPage + 1 } : {}),
      ...(siteConflict ? { siteConflict } : {}),
    });
    const linkedNotice = linkedLookupFailed
      ? `Could not read the linked answer${linkedLookupFailed === 'comments' ? '’s comments' : ''} from Stack Exchange.`
      : '';
    if (answersHaveMore) {
      const continuation = `Continue with answersPage: ${input.answersPage + 1} and keep maxAnswers at ${input.maxAnswers}.`;
      ctx.enrich.truncated({
        shown: thread.answers.length,
        cap: input.maxAnswers,
        guidance: linkedNotice ? `${continuation} ${linkedNotice}` : continuation,
      });
    } else if (linkedNotice) {
      ctx.enrich.notice(linkedNotice);
    }

    ctx.log.info('Fetched SE thread', {
      questionId: thread.questionId,
      site: siteUsed,
      answerCount: thread.answers.length,
      includeComments: input.includeComments,
    });

    return {
      ...thread,
      ...(input.answersPage > 1 ? { answersPage: input.answersPage } : {}),
      ...(input.includeComments && input.commentsPage > 1
        ? { commentsPage: input.commentsPage }
        : {}),
    };
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
        lines.push(
          result.commentsPage || post.commentsTruncated
            ? '  *No comments on this page.*'
            : '  *No comments.*',
        );
        lines.push('');
        return;
      }

      lines.push(`  **Comments (${post.comments.length}):**`);
      for (const c of post.comments) {
        // Absent author and date are omitted rather than labelled — a deleted
        // or anonymous commenter is missing data, not a fact to render.
        const parts = [`**${c.score >= 0 ? '+' : ''}${c.score}**`];
        if (c.authorName) {
          parts.push(
            c.authorLink
              ? markdownLink(c.authorName, c.authorLink)
              : escapeMarkdownInline(c.authorName),
          );
        }
        if (c.creationDate) parts.push(c.creationDate);
        parts.push(`comment ${c.commentId}`);
        lines.push(`  - ${parts.join(' · ')}: ${c.bodyMarkdown}`);
      }
      if (post.commentsTruncated) {
        lines.push('  *Partial comment list for this post.*');
      }
      lines.push('');
    };

    // Question header
    lines.push(`# ${escapeMarkdownInline(result.title)}`);
    const statParts = [`**Question ID:** ${result.questionId}`, `**Score:** ${result.score}`];
    if (result.answerCount != null) statParts.push(`**Answers:** ${result.answerCount}`);
    if (result.answersPage !== undefined) statParts.push(`**Answers page:** ${result.answersPage}`);
    if (result.commentsPage !== undefined)
      statParts.push(`**Comments page:** ${result.commentsPage}`);
    if (result.creationDate) statParts.push(`**Asked:** ${result.creationDate}`);
    if (result.lastActivityDate) statParts.push(`**Active:** ${result.lastActivityDate}`);
    appendClosureStats(statParts, result);
    lines.push(statParts.join(' | '));
    if (result.duplicateOf !== undefined) {
      lines.push(`**Duplicate of (${result.duplicateOf.length}):**`);
      for (const original of result.duplicateOf) {
        const accepted =
          original.acceptedAnswerId === undefined
            ? ''
            : ` · accepted answer ${original.acceptedAnswerId}`;
        lines.push(
          `- Question ${original.questionId}: ${escapeMarkdownInline(original.title)} · answers: ${original.answerCount}${accepted}`,
        );
      }
    }
    lines.push(`**Tags:** ${escapeMarkdownInline(result.tags.join(', '))}`);
    lines.push(`**Link:** ${markdownLink(result.link, result.link)}`);
    if (result.authorName) {
      const authorRef = result.authorLink
        ? markdownLink(result.authorName, result.authorLink)
        : escapeMarkdownInline(result.authorName);
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
      lines.push(
        result.answersPage === undefined
          ? '*No answers yet.*'
          : `*No answers on page ${result.answersPage}.*`,
      );
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
          const authorRef = a.authorLink
            ? markdownLink(a.authorName, a.authorLink)
            : escapeMarkdownInline(a.authorName);
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
