/**
 * @fileoverview Tool to enumerate Stack Exchange network sites.
 * @module mcp-server/tools/definitions/stackexchange-list-sites
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

export const stackexchangeListSites = tool('stackexchange_list_sites', {
  title: 'List Stack Exchange Sites',
  description:
    'Enumerate all sites in the Stack Exchange network — name, api_site_parameter, audience, and URL. ' +
    'The api_site_parameter value is what other tools accept as the `site` input (e.g. "stackoverflow", "superuser", "serverfault"). ' +
    'Results are fetched live and optionally filtered by name. ' +
    'Use this tool to discover valid site parameters before calling other stackexchange_* tools.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    filter: z
      .string()
      .optional()
      .describe(
        'Optional case-insensitive name filter — returns only sites whose name contains all provided tokens. ' +
          'Omit to return all sites.',
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
            audience: z
              .string()
              .optional()
              .describe('Intended audience description when provided by the API.'),
          })
          .describe('A Stack Exchange network site entry.'),
      )
      .describe('Stack Exchange network sites matching the optional name filter.'),
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
    quotaRemaining: { label: 'Quota Remaining' },
    quotaMax: { label: 'Quota Max' },
  },

  errors: [
    {
      reason: 'quota_exceeded',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Stack Exchange API quota_remaining reached 0 during the site page walk.',
      recovery:
        'Quota resets at midnight UTC; set STACKEXCHANGE_API_KEY to lift the limit to 10,000 per day.',
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
      when: 'Stack Exchange answered with a body that is not the expected JSON envelope.',
      recovery:
        'Retry in a few minutes — Stack Exchange is degraded and no change to the input helps.',
    },
  ],

  async handler(input, ctx) {
    const svc = getStackExchangeService();
    const { sites, quotaRemaining, quotaMax, truncated } = await svc.getSites(ctx);

    ctx.enrich({ quotaRemaining, quotaMax });

    // A whitespace-only filter selects nothing to narrow by, so it must not
    // narrow, must not report a no-match, and must not log as applied.
    const filterQuery = input.filter?.trim();

    let filtered = sites;
    if (filterQuery) {
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9\s]/g, ' ');
      const tokens = normalize(filterQuery).split(/\s+/).filter(Boolean);
      filtered = sites.filter((s) => {
        const hay = `${normalize(s.name)} ${normalize(s.apiSiteParameter)}`;
        return tokens.every((t) => hay.includes(t));
      });
    }

    const notices: string[] = [];
    if (filterQuery && filtered.length === 0) {
      notices.push(
        `No site matched "${input.filter}". Call stackexchange_list_sites without a filter to browse all sites.`,
      );
    }
    if (truncated) {
      notices.push(
        'This site list is partial — Stack Exchange still reported more sites when the page walk reached its limit. ' +
          'A site absent from these results may still exist; pass its api_site_parameter directly to another stackexchange_* tool to check.',
      );
    }
    if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Listed SE sites', {
      total: filtered.length,
      filtered: Boolean(filterQuery),
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
      lines.push(`## ${s.name}`);
      lines.push(`**api_site_parameter:** \`${s.apiSiteParameter}\``);
      lines.push(`**URL:** ${s.siteUrl}`);
      if (s.audience) lines.push(`**Audience:** ${s.audience}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
