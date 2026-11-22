/**
 * @fileoverview Tool to enumerate Stack Exchange network sites.
 * @module mcp-server/tools/definitions/stackexchange-list-sites
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

export const stackexchangeListSites = tool('stackexchange_list_sites', {
  title: 'List Stack Exchange Sites',
  description:
    'Discover Stack Exchange communities by name, apiSiteParameter, or audience. Returns site type and URL. ' +
    'The apiSiteParameter value is what other tools accept as the `site` input (e.g. "stackoverflow", "superuser", "serverfault"). ' +
    'Results are fetched live. Include the standalone "meta" filter token to include meta sites. ' +
    'Use this tool to discover valid site parameters before calling other stackexchange_* tools.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    filter: z
      .string()
      .optional()
      .describe(
        'Case-insensitive filter. Every token must match the site name, apiSiteParameter, or audience. Include the standalone token "meta" to include meta sites, or pass "meta" alone to browse the complete catalog.',
      ),
  }),
  output: z.object({
    sites: z
      .array(
        z
          .object({
            name: z.string().describe('Human-readable site name (e.g. "Stack Overflow").'),
            apiSiteParameter: z
              .string()
              .describe(
                'Value to pass as the `site` parameter on all other stackexchange_* tools (e.g. "stackoverflow").',
              ),
            siteUrl: z.string().describe('Public URL of the site.'),
            siteType: z
              .string()
              .optional()
              .describe('Upstream site type when known (e.g. "main_site" or "meta_site").'),
            audience: z
              .string()
              .optional()
              .describe('Intended audience description when provided by the API.'),
          })
          .describe('A Stack Exchange network site entry.'),
      )
      .describe('Stack Exchange sites matching the filter and meta-site selection.'),
    totalCount: z.number().describe('Total number of sites returned after filtering.'),
  }),
  enrichment: {
    quotaRemaining: z.number().describe('Remaining API quota calls for the current day.'),
    quotaMax: z
      .number()
      .describe('Maximum API quota calls per day (300 keyless, ~10,000 with API key).'),
    notice: z
      .string()
      .optional()
      .describe('Actionable guidance when results are empty or filtered.'),
  },
  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
    quotaRemaining: { label: 'Quota Remaining' },
    quotaMax: { label: 'Quota Max' },
  },

  errors: [
    {
      reason: 'quota_exceeded',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Stack Exchange API quota_remaining reached 0 during the site page walk.',
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
      reason: 'invalid_parameter',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Stack Exchange rejected a parameter of the /sites request and named the field.',
      recovery:
        'Retry once — this tool sends no caller-supplied parameter upstream, so no input change fixes it.',
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
    const svc = getStackExchangeService();
    const { sites, quotaRemaining, quotaMax, truncated } = await svc.getSites(ctx);

    ctx.enrich({ quotaRemaining, quotaMax });

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ');
    const tokens = normalize(input.filter ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const includeMeta = tokens.includes('meta');
    const terms = tokens.filter((token) => token !== 'meta');
    const matching = terms.length
      ? sites.filter((site) => {
          const searchable = normalize(
            `${site.name} ${site.apiSiteParameter} ${site.audience ?? ''}`,
          );
          return terms.every((term) => searchable.includes(term));
        })
      : sites;
    const filtered = includeMeta
      ? matching
      : matching.filter((site) => site.siteType !== 'meta_site');
    const omittedMeta = matching.length - filtered.length;

    const notices: string[] = [];
    if (terms.length > 0 && matching.length === 0) {
      notices.push(
        `No site matched "${input.filter}". Omit the filter to browse communities or use "meta" alone for the complete catalog.`,
      );
    }
    if (omittedMeta > 0) {
      notices.push(
        `Omitted ${omittedMeta} matching meta site${omittedMeta === 1 ? '' : 's'}. Include the "meta" token to see them.`,
      );
    }
    if (truncated) {
      notices.push(
        'This site list is partial — Stack Exchange still reported more sites when the page walk reached its limit. ' +
          'A site absent from these results may still exist; pass its apiSiteParameter directly to another stackexchange_* tool to check.',
      );
    }
    if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Listed SE sites', {
      total: filtered.length,
      filtered: terms.length > 0,
      truncated,
    });
    return { sites: filtered, totalCount: filtered.length };
  },

  format: (result) => {
    if (result.sites.length === 0) {
      return [{ type: 'text', text: 'No sites matched the filter.' }];
    }
    const lines: string[] = [
      `**${result.totalCount} site${result.totalCount === 1 ? '' : 's'}**\n`,
    ];
    for (const s of result.sites) {
      lines.push(`## ${escapeMarkdownInline(s.name)}`);
      lines.push(`**api_site_parameter:** ${escapeMarkdownInline(s.apiSiteParameter)}`);
      lines.push(`**URL:** ${markdownLink(s.siteUrl, s.siteUrl)}`);
      if (s.audience) lines.push(`**Audience:** ${escapeMarkdownInline(s.audience)}`);
      if (s.siteType !== undefined)
        lines.push(`**Site type:** ${escapeMarkdownInline(s.siteType)}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
