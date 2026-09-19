/**
 * @fileoverview Rendered table values on both tool response surfaces.
 * @module tests/tools/table-markdown.contract
 */
import { execFileSync } from 'node:child_process';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stackexchangeGetThread } from '@/mcp-server/tools/definitions/stackexchange-get-thread.tool.js';
import { normalizeHtml } from '@/services/stackexchange/html-normalizer.js';
import {
  getStackExchangeService,
  initStackExchangeService,
} from '@/services/stackexchange/stackexchange-service.js';

/** Use Bun's independent Markdown renderer rather than reimplementing escape parsing. */
const render = (markdown: string): string =>
  execFileSync('bun', ['-e', 'console.write(Bun.markdown.html(await Bun.stdin.text()))'], {
    input: markdown,
    encoding: 'utf8',
  });
const table = String.raw`<table><tr><th>A</th><th>B</th></tr><tr><td>x\|y</td><td>a\*b</td></tr></table>`;
afterEach(() => vi.restoreAllMocks());

describe('table escaping', () => {
  it('preserves literal backslashes and column boundaries when rendered', () => {
    expect(render(normalizeHtml(table))).toContain(String.raw`<tr><td>x\|y</td><td>a\*b</td></tr>`);
  });

  it('preserves inline formatting, code and one-pass entity decoding', () => {
    const html =
      '<table><tr><th>A</th></tr><tr><td><strong>bold</strong> <a href="https://example.com">link</a> <code>a\\*b</code> &amp;lt;</td></tr></table>';
    const markdown = normalizeHtml(html);
    expect(markdown).toContain('**bold** [link](https://example.com) `a\\*b` &lt;');
    expect(render(markdown)).toContain(
      '<strong>bold</strong> <a href="https://example.com">link</a> <code>a\\*b</code> &lt;',
    );
  });

  it('carries correct rendered question and answer cells on both response surfaces', async () => {
    initStackExchangeService({} as AppConfig, {} as StorageService);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify({
            items: String(input).includes('/answers')
              ? [{ answer_id: 2, question_id: 1, score: 1, is_accepted: false, body: table }]
              : [
                  {
                    question_id: 1,
                    title: 'Escaping',
                    link: 'https://stackoverflow.com/q/1',
                    score: 1,
                    tags: [],
                    answer_count: 1,
                    is_answered: true,
                    body: table,
                  },
                ],
            has_more: false,
            quota_remaining: 100,
            quota_max: 300,
          }),
        ),
    );
    const result = await runToolContract(stackexchangeGetThread, { questionIdOrUrl: '1' });
    expect(result.isError).toBeFalsy();
    const output = stackexchangeGetThread.output.parse(result.structuredContent);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    for (const markdown of [output.bodyMarkdown, output.answers[0]?.bodyMarkdown ?? '', text]) {
      expect(render(markdown)).toContain(String.raw`<tr><td>x\|y</td><td>a\*b</td></tr>`);
    }
    getStackExchangeService().dispose();
  });
});
