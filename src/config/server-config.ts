/**
 * @fileoverview Server-specific configuration schema for the Stack Exchange MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .optional()
    .describe(
      'Stack Exchange API key — lifts per-IP quota from ~300/day to ~10,000/day. ' +
        'Register at https://stackapps.com/apps/oauth/register (OAuth flow for write access only; key-only is read-only).',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'STACKEXCHANGE_API_KEY',
  });
  return _config;
}
