/**
 * @fileoverview Tool to fetch a Stack Exchange user profile by ID.
 * @module mcp-server/tools/definitions/stackexchange-get-user
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

export const stackexchangeGetUser = tool('stackexchange_get_user', {
  title: 'Get Stack Exchange User Profile',
  description:
    'Fetch a Stack Exchange user profile by numeric user ID: reputation, badge counts, top tags by answer score, ' +
    'and account metadata. Useful for credibility context on an answer author — pass the authorUserId from any ' +
    'question or answer in stackexchange_get_thread output. Returns profile fields plus up to 10 top tags by answer score.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    userId: z
      .number()
      .int()
      .describe(
        'Numeric user ID — use the authorUserId field from a question or answer in stackexchange_get_thread output.',
      ),
    site: z
      .string()
      .default('stackoverflow')
      .describe(
        'Stack Exchange site — use the api_site_parameter value (e.g. "stackoverflow", "superuser"). ' +
          'Defaults to "stackoverflow". Call stackexchange_list_sites to discover valid values.',
      ),
  }),
  output: z.object({
    userId: z.number().int().describe('Numeric user ID on this Stack Exchange site.'),
    displayName: z.string().describe('Display name shown on the site.'),
    link: z.string().describe('Direct URL to the user profile.'),
    reputation: z.number().int().describe('User reputation score.'),
    badgeCounts: z
      .object({
        gold: z.number().int().optional().describe('Number of gold badges.'),
        silver: z.number().int().optional().describe('Number of silver badges.'),
        bronze: z.number().int().optional().describe('Number of bronze badges.'),
      })
      .optional()
      .describe('Badge counts when provided by the API.'),
    location: z.string().optional().describe('User-provided location string when available.'),
    websiteUrl: z.string().optional().describe('User-provided website URL when available.'),
    answerCount: z
      .number()
      .int()
      .optional()
      .describe('Total number of answers posted when provided by the API.'),
    questionCount: z
      .number()
      .int()
      .optional()
      .describe('Total number of questions posted when provided by the API.'),
    topTags: z
      .array(
        z
          .object({
            tagName: z.string().describe('Tag name.'),
            answerCount: z.number().int().optional().describe('Number of answers in this tag.'),
            answerScore: z.number().int().optional().describe('Total answer score in this tag.'),
          })
          .describe('A tag the user has answered in, with answer count and score.'),
      )
      .describe('Top tags by answer score (up to 10). Empty array for new users with no answers.'),
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
      reason: 'user_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The user lookup returns an empty result set — SE returns HTTP 200 with no items for unknown user IDs rather than 404.',
      recovery:
        'Verify the user ID or look up a valid ID from an answer via stackexchange_get_thread.',
    },
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
    const { user, quotaRemaining, quotaMax } = await svc.getUser(
      { userId: input.userId, site: input.site },
      ctx,
    );

    ctx.enrich({ quotaRemaining, quotaMax });

    ctx.log.info('Fetched SE user', {
      userId: user.userId,
      displayName: user.displayName,
      site: input.site,
    });

    return user;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.displayName}`);
    lines.push(`**User ID:** ${result.userId}`);
    lines.push(`**Reputation:** ${result.reputation.toLocaleString()}`);
    lines.push(`**Profile:** ${result.link}`);

    if (result.badgeCounts) {
      const badges: string[] = [];
      if (result.badgeCounts.gold != null) badges.push(`🥇 ${result.badgeCounts.gold}`);
      if (result.badgeCounts.silver != null) badges.push(`🥈 ${result.badgeCounts.silver}`);
      if (result.badgeCounts.bronze != null) badges.push(`🥉 ${result.badgeCounts.bronze}`);
      if (badges.length > 0) lines.push(`**Badges:** ${badges.join('  ')}`);
    }

    if (result.location) lines.push(`**Location:** ${result.location}`);
    if (result.websiteUrl) lines.push(`**Website:** ${result.websiteUrl}`);

    if (result.answerCount != null || result.questionCount != null) {
      const parts: string[] = [];
      if (result.answerCount != null) parts.push(`${result.answerCount} answers`);
      if (result.questionCount != null) parts.push(`${result.questionCount} questions`);
      lines.push(`**Posts:** ${parts.join(' · ')}`);
    }

    if (result.topTags.length > 0) {
      lines.push('\n### Top Tags');
      for (const t of result.topTags) {
        const parts: string[] = [`\`${t.tagName}\``];
        if (t.answerScore != null) parts.push(`score: ${t.answerScore}`);
        if (t.answerCount != null) parts.push(`${t.answerCount} answers`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    } else {
      lines.push('\n*No top tags — user has no answers yet.*');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
