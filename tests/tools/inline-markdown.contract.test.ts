/**
 * @fileoverview Plain upstream metadata survives Markdown rendering on both tool surfaces.
 * @module tests/tools/inline-markdown.contract
 */
import { execFileSync } from 'node:child_process';
import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetTagFaq } from '@/mcp-server/tools/definitions/stackexchange-get-tag-faq.tool.js';
import { stackexchangeGetThread } from '@/mcp-server/tools/definitions/stackexchange-get-thread.tool.js';
import { stackexchangeGetUser } from '@/mcp-server/tools/definitions/stackexchange-get-user.tool.js';
import { stackexchangeListSites } from '@/mcp-server/tools/definitions/stackexchange-list-sites.tool.js';
import { stackexchangeSearchQuestions } from '@/mcp-server/tools/definitions/stackexchange-search-questions.tool.js';
import {
  getStackExchangeService,
  initStackExchangeService,
} from '@/services/stackexchange/stackexchange-service.js';

const label = 'A*p* [x](https://evil.example)';
const url = 'https://example.com/a(b)?x=1';
const render = (markdown: string): string =>
  execFileSync('bun', ['-e', 'console.write(Bun.markdown.html(await Bun.stdin.text()))'], {
    input: markdown,
    encoding: 'utf8',
  });

beforeEach(() => {
  initStackExchangeService({} as AppConfig, {} as StorageService);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const items = path.endsWith('/sites')
      ? [{ name: label, api_site_parameter: 'test', site_url: url, audience: label }]
      : path.includes('/top-tags')
        ? []
        : path.includes('/users/')
          ? [
              {
                user_id: 1,
                display_name: label,
                link: url,
                reputation: 1,
                location: label,
                website_url: 'javascript:alert(1)',
              },
            ]
          : path.endsWith('/answers')
            ? [
                {
                  answer_id: 2,
                  question_id: 1,
                  score: 1,
                  is_accepted: true,
                  body: '<p><strong>body</strong> <code>x*y</code></p>',
                  owner: { display_name: label, link: url },
                },
              ]
            : [
                {
                  question_id: 1,
                  title: label,
                  link: url,
                  score: 1,
                  tags: ['test'],
                  answer_count: 1,
                  is_answered: true,
                  body: '<p><strong>body</strong> <code>x*y</code></p>',
                  owner: { display_name: label, link: url },
                },
              ];
    return new Response(
      JSON.stringify({ items, has_more: false, quota_remaining: 100, quota_max: 300 }),
    );
  });
});
afterEach(() => {
  getStackExchangeService().dispose();
  vi.restoreAllMocks();
});

describe('upstream plain text rendering', () => {
  const calls = [
    ['search', () => runToolContract(stackexchangeSearchQuestions, { query: 'test' })],
    ['FAQ', () => runToolContract(stackexchangeGetTagFaq, { tag: 'test' })],
    ['thread', () => runToolContract(stackexchangeGetThread, { questionIdOrUrl: '1' })],
    ['user', () => runToolContract(stackexchangeGetUser, { userId: 1 })],
    ['sites', () => runToolContract(stackexchangeListSites, {})],
  ] as const;
  for (const [name, call] of calls) {
    it(`preserves ${name} metadata without interpreting it as Markdown`, async () => {
      const result = await call();
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.structuredContent)).toContain(label);
      expect(JSON.stringify(result.structuredContent)).toContain(url);
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const html = render(text);
      expect(html).toContain('A*p* [x](https://evil.example)');
      expect(html).not.toContain('href="https://evil.example"');
      expect(html).toContain('href="https://example.com/a(b)?x=1"');
      if (name === 'thread') {
        expect(html).toContain('<strong>body</strong> <code>x*y</code>');
      }
      if (name === 'user') {
        expect(html).not.toContain('href="javascript:');
        expect(html).toContain('javascript:alert(1)');
      }
    });
  }
});

describe('empty-result notices', () => {
  const calls = [
    ['search', () => runToolContract(stackexchangeSearchQuestions, { query: label, site: label })],
    ['FAQ', () => runToolContract(stackexchangeGetTagFaq, { tag: label, site: label })],
    ['sites', () => runToolContract(stackexchangeListSites, { filter: label })],
  ] as const;
  for (const [name, call] of calls) {
    it(`keeps caller text literal in the ${name} notice on both surfaces`, async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 }),
        ),
      );
      const result = await call();
      expect(result.isError).toBeFalsy();
      const { notice } = z.object({ notice: z.string() }).parse(result.structuredContent);
      expect(notice).toContain('A*p* [x](https://evil.example)');
      expect(notice).not.toContain('\\*');
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const html = render(text);
      expect(html).toContain('A*p* [x](https://evil.example)');
      expect(html).not.toContain('href="https://evil.example"');
      expect(html).not.toContain('<em>p</em>');
    });
  }
});
