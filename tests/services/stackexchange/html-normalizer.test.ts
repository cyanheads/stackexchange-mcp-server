/**
 * @fileoverview Unit tests for the HTML→markdown normalizer.
 * Tests SE's known tag set: code blocks, headings, blockquotes, bold, italic,
 * inline code, links, lists, paragraphs, entity decoding, and accepted-answer ordering.
 * @module tests/services/stackexchange/html-normalizer.test
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, normalizeHtml } from '@/services/stackexchange/html-normalizer.js';

describe('normalizeHtml', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeHtml('')).toBe('');
  });

  describe('fenced code blocks', () => {
    it('converts <pre><code> without language to fenced block', () => {
      const html = '<pre><code>const x = 1;\nconst y = 2;</code></pre>';
      const result = normalizeHtml(html);
      expect(result).toBe('```\nconst x = 1;\nconst y = 2;\n```');
    });

    it('captures the language hint from the pre lang-* class', () => {
      const html =
        '<pre class="lang-python prettyprint-override"><code>def foo():\n    pass</code></pre>';
      const result = normalizeHtml(html);
      expect(result).toBe('```python\ndef foo():\n    pass\n```');
    });

    it('decodes HTML entities inside code blocks', () => {
      // Entities inside <pre><code> (e.g. &lt;, &gt;) must survive as literal
      // characters in the fenced code block output. The normalizer defers
      // entity decoding until after HTML tags are processed, so &lt;algorithm&gt;
      // in a code block becomes <algorithm> in the markdown output — not stripped.
      const html = '<pre><code>#include &lt;algorithm&gt;\nx = 1;</code></pre>';
      const result = normalizeHtml(html);
      expect(result).toMatch(/^```\n/);
      expect(result).toContain('#include <algorithm>');
      expect(result).toContain('x = 1;');
    });

    it('captures the SE lang-* language and preserves < > literals', () => {
      // SE marks code as <pre class="lang-cpp ...">, not <code class="language-...">;
      // the language is read from the <pre> class and entities still decode.
      const html =
        '<pre class="lang-cpp prettyprint-override"><code>if (x &lt; 0) return;</code></pre>';
      const result = normalizeHtml(html);
      expect(result).toBe('```cpp\nif (x < 0) return;\n```');
    });

    it('captures the language- prefix on the pre class too', () => {
      const html = '<pre class="language-rust"><code>let x = 1;</code></pre>';
      expect(normalizeHtml(html)).toBe('```rust\nlet x = 1;\n```');
    });

    it('falls back to a bare fence when the pre carries no language class', () => {
      const html = '<pre class="prettyprint-override"><code>plain();</code></pre>';
      expect(normalizeHtml(html)).toBe('```\nplain();\n```');
    });

    it('wraps code in triple backtick fences (not inline backtick)', () => {
      const html = '<pre><code>x = 1</code></pre>';
      const result = normalizeHtml(html);
      expect(result).toMatch(/^```\n/);
      expect(result).toMatch(/\n```$/);
    });
  });

  describe('inline code', () => {
    it('converts <code> to backtick inline', () => {
      const html = 'Use <code>Array.prototype.map</code> here.';
      const result = normalizeHtml(html);
      expect(result).toContain('`Array.prototype.map`');
    });

    it('decodes HTML entities inside inline code', () => {
      const html = 'Try <code>x &lt; y</code>.';
      const result = normalizeHtml(html);
      expect(result).toContain('`x < y`');
    });
  });

  describe('headings', () => {
    it('converts h1–h3 with correct hashes', () => {
      expect(normalizeHtml('<h1>Title</h1>')).toContain('# Title');
      expect(normalizeHtml('<h2>Section</h2>')).toContain('## Section');
      expect(normalizeHtml('<h3>Sub</h3>')).toContain('### Sub');
    });
  });

  describe('blockquotes', () => {
    it('prefixes each line with >', () => {
      const html = '<blockquote><p>Quoted text here.</p></blockquote>';
      const result = normalizeHtml(html);
      const lines = result.split('\n').filter((l) => l.trim());
      expect(lines.some((l) => l.startsWith('> '))).toBe(true);
    });

    it('handles multi-line blockquote content', () => {
      const html = '<blockquote>Line one\nLine two</blockquote>';
      const result = normalizeHtml(html);
      const lines = result.split('\n').filter((l) => l.trim());
      expect(lines.every((l) => l.startsWith('> '))).toBe(true);
    });
  });

  describe('bold and italic', () => {
    it('converts <strong> to **bold**', () => {
      expect(normalizeHtml('<strong>bold</strong>')).toContain('**bold**');
    });

    it('converts <b> to **bold**', () => {
      expect(normalizeHtml('<b>bold</b>')).toContain('**bold**');
    });

    it('converts <em> to _italic_', () => {
      expect(normalizeHtml('<em>italic</em>')).toContain('_italic_');
    });

    it('converts <i> to _italic_', () => {
      expect(normalizeHtml('<i>italic</i>')).toContain('_italic_');
    });
  });

  describe('links', () => {
    it('converts <a href> to markdown link', () => {
      const html = '<a href="https://example.com">Example</a>';
      const result = normalizeHtml(html);
      expect(result).toContain('[Example](https://example.com)');
    });

    it('uses href as link text when anchor text is empty', () => {
      const html = '<a href="https://example.com"></a>';
      const result = normalizeHtml(html);
      expect(result).toContain('[https://example.com](https://example.com)');
    });
  });

  describe('lists', () => {
    it('converts <ul> to markdown bullet list', () => {
      const html = '<ul><li>First</li><li>Second</li></ul>';
      const result = normalizeHtml(html);
      expect(result).toContain('- First');
      expect(result).toContain('- Second');
    });

    it('converts <ol> to numbered list', () => {
      const html = '<ol><li>Alpha</li><li>Beta</li></ol>';
      const result = normalizeHtml(html);
      expect(result).toContain('1. Alpha');
      expect(result).toContain('2. Beta');
    });
  });

  describe('paragraphs and line breaks', () => {
    it('converts <p> to surrounding newlines', () => {
      const html = '<p>Hello</p><p>World</p>';
      const result = normalizeHtml(html);
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });

    it('converts <br> to newline', () => {
      const html = 'Line one<br>Line two';
      const result = normalizeHtml(html);
      expect(result).toContain('Line one\nLine two');
    });
  });

  describe('entity decoding', () => {
    it('decodes &amp; to &', () => {
      expect(normalizeHtml('a &amp; b')).toContain('a & b');
    });

    it('decodes &quot; and &#39; to quote characters', () => {
      const result = normalizeHtml('say &quot;hello&quot; it&#39;s fine');
      expect(result).toContain('"hello"');
      expect(result).toContain("it's fine");
    });

    it('decodes &lt; and &gt; in plain text (not code)', () => {
      // In non-code text, &lt; and &gt; should decode to < and > in the output.
      // stripTags runs before decodeEntities, so &lt; stays as &lt; during
      // the tag-strip pass and only becomes < at the final decode step.
      expect(normalizeHtml('a &lt; b')).toBe('a < b');
      expect(normalizeHtml('a &gt; b')).toBe('a > b');
    });

    it('decodes &nbsp; to space', () => {
      const result = normalizeHtml('a&nbsp;b');
      expect(result).toContain('a b');
    });

    it('decodes numeric decimal entities', () => {
      // &#65; = 'A'
      expect(normalizeHtml('&#65;')).toContain('A');
    });

    it('decodes numeric hex entities', () => {
      // &#x41; = 'A'
      expect(normalizeHtml('&#x41;')).toContain('A');
    });

    it('decodes non-BMP decimal entities (emoji above U+FFFF)', () => {
      // &#128105; = 👩 (U+1F469). String.fromCharCode truncated this to a bogus
      // BMP glyph; String.fromCodePoint yields the correct astral character.
      expect(normalizeHtml('&#128105;')).toBe('👩');
    });

    it('decodes non-BMP hex entities', () => {
      // &#x1F469; = 👩 (U+1F469)
      expect(normalizeHtml('&#x1F469;')).toBe('👩');
    });

    it('maps out-of-range numeric entities to the replacement character', () => {
      // > U+10FFFF is invalid; decode to U+FFFD rather than throwing a RangeError.
      expect(normalizeHtml('&#99999999;')).toBe('�');
    });
  });

  describe('excessive blank lines', () => {
    it('collapses 3+ consecutive newlines to 2', () => {
      const html = '<p>Para one</p>\n\n\n\n<p>Para two</p>';
      const result = normalizeHtml(html);
      expect(result).not.toMatch(/\n{3,}/);
    });
  });

  describe('strips remaining unknown tags', () => {
    it('strips unrecognized tags, preserving text', () => {
      const html = '<div><span>Hello</span></div>';
      const result = normalizeHtml(html);
      expect(result).toBe('Hello');
    });
  });

  describe('decodeHtmlEntities (plain-text fields like question titles)', () => {
    it('decodes &#39; to apostrophe in question titles', () => {
      expect(
        decodeHtmlEntities('Why can&#39;t I store a value and a reference in the same struct?'),
      ).toBe("Why can't I store a value and a reference in the same struct?");
    });

    it('decodes &amp; to & in multi-word tag names', () => {
      expect(decodeHtmlEntities('Unix &amp; Linux')).toBe('Unix & Linux');
    });

    it('leaves already-decoded strings unchanged', () => {
      expect(decodeHtmlEntities("Why can't I store a value?")).toBe("Why can't I store a value?");
    });

    it('decodes non-BMP numeric entities in plain-text fields', () => {
      // The exported helper backs display-name/location decoding — astral code
      // points (emoji, rare CJK) must survive intact.
      expect(decodeHtmlEntities('woman: &#128105;')).toBe('woman: 👩');
      expect(decodeHtmlEntities('woman: &#x1F469;')).toBe('woman: 👩');
    });
  });

  describe('real-world SE snippet', () => {
    it('handles a typical SE answer body with code and explanation', () => {
      const html = [
        '<p>Use <code>Array.from()</code> to convert:</p>',
        '<pre class="lang-javascript prettyprint-override"><code>const arr = Array.from(set);</code></pre>',
        '<p>This preserves insertion order.</p>',
      ].join('');
      const result = normalizeHtml(html);
      expect(result).toContain('`Array.from()`');
      expect(result).toContain('```javascript');
      expect(result).toContain('const arr = Array.from(set);');
      expect(result).toContain('```');
      expect(result).toContain('This preserves insertion order.');
    });
  });
});
