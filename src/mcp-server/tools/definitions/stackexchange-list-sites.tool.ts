/**
 * @fileoverview Tool to enumerate Stack Exchange network sites.
 * @module mcp-server/tools/definitions/stackexchange-list-sites
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
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

  async handler(input, ctx) {
    const svc = getStackExchangeService();
    const { sites, quotaRemaining, quotaMax } = await svc.getSites(ctx);

    ctx.enrich({ quotaRemaining, quotaMax });

    let filtered = sites;
    if (input.filter?.trim()) {
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9\s]/g, ' ');
      const tokens = normalize(input.filter).split(/\s+/).filter(Boolean);
      filtered = sites.filter((s) => {
        const hay = `${normalize(s.name)} ${normalize(s.apiSiteParameter)}`;
        return tokens.every((t) => hay.includes(t));
      });

      if (filtered.length === 0) {
        ctx.enrich.notice(
          `No site matched "${input.filter}". Call stackexchange_list_sites without a filter to browse all sites.`,
        );
      }
    }

    ctx.log.info('Listed SE sites', { total: filtered.length, filtered: !!input.filter });
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
