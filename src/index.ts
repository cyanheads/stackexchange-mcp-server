#!/usr/bin/env node
/**
 * @fileoverview stackexchange-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import {
  getStackExchangeService,
  initStackExchangeService,
} from './services/stackexchange/stackexchange-service.js';

await createApp({
  name: 'stackexchange-mcp-server',
  title: 'stackexchange-mcp-server',
  sessionMode: 'stateless',
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions:
    'Use stackexchange_list_sites to find a community, then stackexchange_search_questions or stackexchange_get_tag_faq to discover question IDs. Read full Q&A content with stackexchange_get_thread, and pass an authorUserId to stackexchange_get_user for author context.',
  setup(core) {
    const serverConfig = getServerConfig();
    initStackExchangeService(core.config, core.storage, serverConfig.apiKey);
  },
  teardown() {
    getStackExchangeService().dispose();
  },
});
