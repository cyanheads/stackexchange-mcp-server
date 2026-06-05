/**
 * @fileoverview Barrel export for all Stack Exchange MCP tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { stackexchangeGetTagFaq } from './stackexchange-get-tag-faq.tool.js';
export { stackexchangeGetThread } from './stackexchange-get-thread.tool.js';
export { stackexchangeGetUser } from './stackexchange-get-user.tool.js';
export { stackexchangeListSites } from './stackexchange-list-sites.tool.js';
export { stackexchangeSearchQuestions } from './stackexchange-search-questions.tool.js';

import { stackexchangeGetTagFaq } from './stackexchange-get-tag-faq.tool.js';
import { stackexchangeGetThread } from './stackexchange-get-thread.tool.js';
import { stackexchangeGetUser } from './stackexchange-get-user.tool.js';
import { stackexchangeListSites } from './stackexchange-list-sites.tool.js';
import { stackexchangeSearchQuestions } from './stackexchange-search-questions.tool.js';

export const allToolDefinitions = [
  stackexchangeListSites,
  stackexchangeSearchQuestions,
  stackexchangeGetTagFaq,
  stackexchangeGetUser,
  stackexchangeGetThread,
];
