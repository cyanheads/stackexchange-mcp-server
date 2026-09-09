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

  describe('characterization of the supported tag set', () => {
    it('renders a blockquote wrapping a list as quoted bullets', () => {
      expect(normalizeHtml('<blockquote><ul><li>alpha</li><li>beta</li></ul></blockquote>')).toBe(
        '> - alpha\n> - beta',
      );
    });

    it('converts every inline mark inside one paragraph', () => {
      const html =
        '<p>See <strong>this</strong> and <em>that</em> at <a href="https://e.com">e</a>.</p>';
      expect(normalizeHtml(html)).toBe('See **this** and _that_ at [e](https://e.com).');
    });

    it('numbers ordered items sequentially and bullets unordered ones', () => {
      expect(normalizeHtml('<ol><li>Alpha</li><li>Beta</li></ol>')).toBe('1. Alpha\n2. Beta');
      expect(normalizeHtml('<ul><li>First</li><li>Second</li></ul>')).toBe('- First\n- Second');
    });

    it('drops an unknown self-closing tag and keeps the surrounding text', () => {
      expect(normalizeHtml('a <wbr/> b')).toBe('a  b');
    });

    it('leaves an unrecognized entity reference encoded', () => {
      expect(decodeHtmlEntities('&notanentity; stays')).toBe('&notanentity; stays');
    });

    it('decodes a mixed entity run in a plain-text field', () => {
      expect(decodeHtmlEntities('AT&amp;T &lt;tag&gt; &quot;q&quot;')).toBe('AT&T <tag> "q"');
    });
  });

  describe('escaped angle brackets survive every wrapper (#13)', () => {
    it('survives inside a paragraph', () => {
      expect(normalizeHtml('<p>Use the &lt;div&gt; element instead of &lt;span&gt;.</p>')).toBe(
        'Use the <div> element instead of <span>.',
      );
    });

    it('survives a bare comparison inside a paragraph', () => {
      expect(normalizeHtml('<p>Check whether a &lt; b and b &gt; c.</p>')).toBe(
        'Check whether a < b and b > c.',
      );
    });

    it('survives inside a list item', () => {
      expect(normalizeHtml('<ul><li>Wrap it in &lt;pre&gt; tags</li></ul>')).toBe(
        '- Wrap it in <pre> tags',
      );
    });

    it('survives inside a blockquote', () => {
      const html = '<blockquote><p>Declare it as List&lt;String&gt; myList.</p></blockquote>';
      expect(normalizeHtml(html)).toBe('> Declare it as List<String> myList.');
    });

    it('survives inside inline code', () => {
      expect(normalizeHtml('<p>Use <code>&lt;div&gt;</code> here.</p>')).toBe('Use `<div>` here.');
    });

    it('round-trips a post alternating prose with entity-heavy code fences', () => {
      const html = [
        '<p>I need to match all of these opening tags:</p>',
        '<pre><code>&lt;p&gt;\n&lt;a href=&quot;foo&quot;&gt;\n</code></pre>',
        '<p>But not self-closing tags:</p>',
        '<pre><code>&lt;br /&gt;\n&lt;hr class=&quot;foo&quot; /&gt;\n</code></pre>',
      ].join('');
      const result = normalizeHtml(html);
      expect(result).toContain('<p>');
      expect(result).toContain('<a href="foo">');
      expect(result).toContain('But not self-closing tags:');
      expect(result).toContain('<br />');
      expect(result).toContain('<hr class="foo" />');
    });
  });

  describe('tables, media, and inline semantics (#14)', () => {
    it('renders the real SE table shape as a markdown table', () => {
      const html =
        '<div class="s-table-container"><table class="s-table"><thead><tr><th>Method</th><th>Time</th></tr></thead><tbody><tr><td>sorted</td><td>1.93s</td></tr></tbody></table></div>';
      expect(normalizeHtml(html)).toBe('| Method | Time |\n| --- | --- |\n| sorted | 1.93s |');
    });

    it('separates cells without inventing a header row when the table has no th', () => {
      const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';
      const result = normalizeHtml(html);
      expect(result).toBe('| a | b |\n| c | d |');
      expect(result).not.toContain('---');
    });

    it('escapes a pipe inside a cell so it cannot split the row', () => {
      const html = '<table><tr><th>op</th></tr><tr><td>a | b</td></tr></table>';
      expect(normalizeHtml(html)).toBe('| op |\n| --- |\n| a \\| b |');
    });

    it('converts a bare image to markdown image syntax', () => {
      expect(normalizeHtml('<img src="https://i.sstatic.net/xyz.png" alt="chart">')).toBe(
        '![chart](https://i.sstatic.net/xyz.png)',
      );
    });

    it('keeps both the link and the image for an anchor-wrapped image', () => {
      const html =
        '<a href="https://i.sstatic.net/abc.png"><img src="https://i.sstatic.net/abc.png" alt="architecture diagram"></a>';
      expect(normalizeHtml(html)).toBe(
        '[![architecture diagram](https://i.sstatic.net/abc.png)](https://i.sstatic.net/abc.png)',
      );
    });

    it('renders sup and sub distinguishably from the surrounding text', () => {
      expect(normalizeHtml('<p>x<sup>2</sup> and H<sub>2</sub>O</p>')).toBe('x^2 and H_2O');
    });

    it('renders del and s as strikethrough', () => {
      expect(normalizeHtml('<p><del>old</del> new</p>')).toBe('~~old~~ new');
      expect(normalizeHtml('<p><s>gone</s> here</p>')).toBe('~~gone~~ here');
    });

    it('renders kbd as inline code', () => {
      expect(normalizeHtml('<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd></p>')).toBe('Press `Ctrl`+`C`');
    });

    it('renders hr as a rule on its own line', () => {
      expect(normalizeHtml('<p>above</p><hr><p>below</p>')).toBe('above\n\n---\n\nbelow');
    });

    it('indents a nested list under its parent item', () => {
      const html = '<ul><li>outer<ul><li>inner a</li><li>inner b</li></ul></li></ul>';
      expect(normalizeHtml(html)).toBe('- outer\n  - inner a\n  - inner b');
    });

    it('indents three levels, mixing ordered and unordered', () => {
      const html =
        '<ul><li>one<ol><li>two<ul><li>three</li></ul></li></ol></li><li>sibling</li></ul>';
      expect(normalizeHtml(html)).toBe('- one\n  1. two\n    - three\n- sibling');
    });

    it('nests blockquote levels rather than flattening them', () => {
      const html = '<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>';
      expect(normalizeHtml(html)).toBe('> outer\n> \n> > inner');
    });
  });

  describe('entities decode exactly once (#22)', () => {
    it('yields a literal &lt;div&gt; from a double-escaped tag', () => {
      expect(normalizeHtml('<p>Write &amp;lt;div&amp;gt; to show a literal tag.</p>')).toBe(
        'Write &lt;div&gt; to show a literal tag.',
      );
    });

    it('yields a literal numeric reference from a double-escaped one', () => {
      expect(normalizeHtml('<p>The literal text &amp;#39; is an escaped apostrophe.</p>')).toBe(
        'The literal text &#39; is an escaped apostrophe.',
      );
      expect(normalizeHtml('<p>Use &amp;#x27; in HTML.</p>')).toBe('Use &#x27; in HTML.');
    });

    it('decodes once inside a code fence too', () => {
      expect(normalizeHtml('<pre><code>&amp;lt;div&amp;gt;</code></pre>')).toBe(
        '```\n&lt;div&gt;\n```',
      );
    });

    it('decodes once through the exported plain-text helper', () => {
      expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
      expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
    });

    it('still decodes an ordinary single-escaped entity', () => {
      expect(normalizeHtml('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
      expect(decodeHtmlEntities('a &lt; b')).toBe('a < b');
    });
  });

  describe('links nested inside emphasis (#23)', () => {
    it('keeps the href of a link wrapped in <strong>', () => {
      expect(
        normalizeHtml('<p><strong><a href="https://ex.com/a">docs</a></strong> first.</p>'),
      ).toBe('**[docs](https://ex.com/a)** first.');
    });

    it('keeps the href of a link wrapped in <b>', () => {
      expect(normalizeHtml('<p><b><a href="https://ex.com/b">docs</a></b></p>')).toBe(
        '**[docs](https://ex.com/b)**',
      );
    });

    it('keeps the href of a link wrapped in <em>', () => {
      expect(normalizeHtml('<p><em><a href="https://ex.com/c">spec</a></em> second.</p>')).toBe(
        '_[spec](https://ex.com/c)_ second.',
      );
    });

    it('keeps the href of a link wrapped in <i>', () => {
      expect(normalizeHtml('<p><i><a href="https://ex.com/d">spec</a></i></p>')).toBe(
        '_[spec](https://ex.com/d)_',
      );
    });

    it('leaves the already-correct link-outside-emphasis nesting unchanged', () => {
      expect(
        normalizeHtml('<p><a href="https://ex.com/e"><strong>docs</strong></a> third.</p>'),
      ).toBe('[**docs**](https://ex.com/e) third.');
    });

    it('keeps inline code and images inside emphasis', () => {
      expect(normalizeHtml('<p><strong><code>flag</code></strong></p>')).toBe('**`flag`**');
      expect(normalizeHtml('<p><em><img src="https://ex.com/i.png" alt="chart"></em></p>')).toBe(
        '_![chart](https://ex.com/i.png)_',
      );
    });
  });

  describe('numeric entity boundaries', () => {
    it('maps a surrogate code point to the replacement character', () => {
      expect(normalizeHtml('&#xD800;')).toBe('�');
      expect(normalizeHtml('&#55296;')).toBe('�');
    });

    it('decodes a non-BMP entity inside a code fence', () => {
      expect(normalizeHtml('<pre><code>emoji &#128105; here</code></pre>')).toBe(
        '```\nemoji 👩 here\n```',
      );
    });
  });

  describe('malformed and empty inputs', () => {
    it('keeps item text when a list is never closed', () => {
      expect(normalizeHtml('<ul><li>orphan')).toBe('orphan');
    });

    it('keeps quoted text when a blockquote is never closed', () => {
      expect(normalizeHtml('<blockquote>orphan')).toBe('orphan');
    });

    it('drops an empty table rather than emitting an empty row', () => {
      expect(normalizeHtml('<table></table>')).toBe('');
    });

    it('drops an image that carries no src', () => {
      expect(normalizeHtml('<p><img alt="nothing to link">text</p>')).toBe('text');
    });
  });
});
