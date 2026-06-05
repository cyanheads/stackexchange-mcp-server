#!/usr/bin/env node
/**
 * @fileoverview stackexchange-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initStackExchangeService } from './services/stackexchange/stackexchange-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions:
    'Stack Exchange network access — Stack Overflow, Super User, Server Fault, Unix & Linux, and 180+ more sites.\n' +
    'Workflow: use stackexchange_list_sites to find a site api_site_parameter, then stackexchange_search_questions ' +
    'or stackexchange_get_tag_faq to discover question IDs, then stackexchange_get_thread for full Q&A content with ' +
    'markdown-normalized bodies. stackexchange_get_user resolves an answer author by user_id.\n' +
    'Rate limit: ~300 requests/day keyless per IP; set STACKEXCHANGE_API_KEY for ~10,000/day.',
  setup(core) {
    const serverConfig = getServerConfig();
    initStackExchangeService(core.config, core.storage, serverConfig.apiKey);
  },
});
