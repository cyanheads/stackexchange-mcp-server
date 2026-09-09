/**
 * @fileoverview Lightweight HTML→markdown normalizer for Stack Exchange post bodies.
 * Handles SE's tag set: p, pre/code, inline code, strong/b, em/i, a, ul/ol/li
 * (nested), h1-h6, blockquote, br, table, img, sup, sub, del/s, kbd, hr.
 * No external dependency required.
 * @module services/stackexchange/html-normalizer
 */

/**
 * Named entities Stack Exchange emits. An entity outside this set is left
 * encoded rather than guessed at.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * One alternation covering every entity form, so a single left-to-right pass
 * consumes each match and never rescans its own replacement. A chain of
 * independent replaces starting with `&amp;` decodes `&amp;lt;` twice — into a
 * real `<` — fabricating markup out of text the author escaped precisely so it
 * would not be markup.
 */
const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

const PLACEHOLDER_PREFIX = 'MDCODEBLOCK';
const PLACEHOLDER_SUFFIX = 'ENDMDCODEBLOCK';
const PLACEHOLDER = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g');

/** SE marks the language on the `<pre>` class (`lang-cpp`), never on `<code>`. */
const FENCED_CODE_WITH_LANG =
  /<pre\b[^>]*class="[^"]*?\blang(?:uage)?-([^"\s]+)[^"]*"[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
const FENCED_CODE = /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
const INLINE_CODE = /<code\b[^>]*>([\s\S]*?)<\/code>/gi;

const LIST_OPEN = /<(?:ul|ol)\b[^>]*>/i;
const BLOCKQUOTE_OPEN = /<blockquote\b[^>]*>/i;

const IMG_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const IMG_ALT = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * Convert a Stack Exchange HTML post body to clean markdown.
 *
 * One ordered pipeline, no re-entry into this function. Entity decoding happens
 * exactly once per span of text, and never before the tag passes that span
 * travels through have finished — decoding `&lt;`/`&gt;` early turns them into
 * real angle brackets that the markup regexes then match and destroy, and it
 * splits `stripTags` mid-tag on attribute values containing `>`.
 *
 * Code is the one span that must be decoded early, because its brackets are
 * content rather than markup: each code span is decoded once and immediately
 * swapped for an opaque placeholder, so no later tag pass and no second decode
 * can reach it. Placeholders are restored after the final decode.
 */
export function normalizeHtml(html: string): string {
  if (!html) return '';

  const codeSpans: string[] = [];
  const stash = (text: string): string =>
    `${PLACEHOLDER_PREFIX}${codeSpans.push(text) - 1}${PLACEHOLDER_SUFFIX}`;

  let md = html;

  // Fenced code blocks, language hint first so the class is still on the <pre>.
  md = md.replace(FENCED_CODE_WITH_LANG, (_, lang: string, code: string) =>
    stash(`\`\`\`${lang}\n${decodeEntities(stripTags(code)).trim()}\n\`\`\``),
  );
  md = md.replace(FENCED_CODE, (_, code: string) =>
    stash(`\`\`\`\n${decodeEntities(stripTags(code)).trim()}\n\`\`\``),
  );
  // Inline code — whatever <pre><code> did not already claim.
  md = md.replace(INLINE_CODE, (_, code: string) => stash(`\`${decodeEntities(code)}\``));

  // Images before links, so an <a>-wrapped <img> keeps both.
  md = md.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const src = attrValue(tag, IMG_SRC);
    return src ? `![${attrValue(tag, IMG_ALT) ?? ''}](${src})` : '';
  });

  md = md.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, c: string) => `^${stripTags(c).trim()}`);
  md = md.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, c: string) => `_${stripTags(c).trim()}`);
  md = md.replace(
    /<(del|s)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, __: string, c: string) => `~~${stripTags(c).trim()}~~`,
  );
  md = md.replace(
    /<kbd\b[^>]*>([\s\S]*?)<\/kbd>/gi,
    (_, c: string) => `\`${stripTags(c).trim()}\``,
  );

  // Emphasis keeps its inner markup rather than stripping it, so a nested <a>
  // survives into the link pass below. Stripping here deleted the href of every
  // bolded link — the shape markdown `**[docs](url)**` produces. Anything no
  // later pass claims is still cleared by the final stripTags.
  md = md.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, (_, c: string) => `**${c.trim()}**`);
  md = md.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, (_, c: string) => `**${c.trim()}**`);
  md = md.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, (_, c: string) => `_${c.trim()}_`);
  md = md.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, (_, c: string) => `_${c.trim()}_`);

  md = md.replace(
    /<a\b[^>]+href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_, dq: string | undefined, sq: string | undefined, text: string) => {
      const href = dq ?? sq ?? '';
      return `[${stripTags(text).trim() || href}](${href})`;
    },
  );

  // Tables after the inline passes, so cells carry converted markdown.
  // `<table\b[^>]*>` matches SE's real shape (`<div class="s-table-container">
  // <table class="s-table">`) as well as a bare tag; the wrapping div falls to
  // the final stripTags.
  md = md.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body: string) => renderTable(body));

  md = md.replace(/<hr\b[^>]*>/gi, '\n---\n');

  md = md.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, content: string) => {
    const hashes = '#'.repeat(parseInt(level, 10));
    return `\n${hashes} ${stripTags(content).trim()}\n`;
  });

  // Paragraphs before lists and blockquotes, so a <p> inside an <li> or a
  // <blockquote> is already plain text when those containers render.
  md = md.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, content: string) => `\n${content.trim()}\n`);

  md = md.replace(/<br\s*\/?>/gi, '\n');

  md = convertLists(md);
  md = convertBlockquotes(md);

  md = stripTags(md);
  md = decodeEntities(md);
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.replace(PLACEHOLDER, (_, idx: string) => codeSpans[parseInt(idx, 10)] ?? '');

  return md.trim();
}

/** Strip all HTML tags from a string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** Read a quoted attribute value out of a raw tag, or undefined when absent. */
function attrValue(tag: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2];
}

/**
 * Locate the close tag matching an element whose content starts at `contentStart`,
 * counting nesting across every tag in `group` (`ul` nests inside `ol`,
 * `blockquote` inside `blockquote`). Returns undefined for unbalanced markup, so
 * the caller can leave the fragment for the final `stripTags`.
 */
function sliceElement(
  html: string,
  contentStart: number,
  group: string,
): { inner: string; end: number } | undefined {
  const scanner = new RegExp(`<\\/?(?:${group})\\b[^>]*>`, 'gi');
  scanner.lastIndex = contentStart;
  let depth = 0;
  let match = scanner.exec(html);
  while (match) {
    if (match[0].startsWith('</')) {
      if (depth === 0)
        return { inner: html.slice(contentStart, match.index), end: scanner.lastIndex };
      depth -= 1;
    } else {
      depth += 1;
    }
    match = scanner.exec(html);
  }
  return undefined;
}

/** Convert every top-level `<ul>`/`<ol>` in a fragment, nested lists included. */
function convertLists(html: string): string {
  let out = '';
  let rest = html;
  for (;;) {
    const open = LIST_OPEN.exec(rest);
    if (!open) return out + rest;
    const slice = sliceElement(rest, open.index + open[0].length, 'ul|ol');
    if (!slice) return out + rest;
    const lines = renderListLines(open[0], slice.inner, 0);
    out += `${rest.slice(0, open.index)}\n${lines.join('\n')}\n`;
    rest = rest.slice(slice.end);
  }
}

/**
 * Render one list to markdown lines. `depth` is what keeps a nested list under
 * its parent item instead of merging into it — each level indents two spaces.
 */
function renderListLines(openTag: string, inner: string, depth: number): string[] {
  const ordered = /^<ol\b/i.test(openTag);
  const indent = '  '.repeat(depth);
  const lines: string[] = [];

  for (const [index, item] of splitListItems(inner).entries()) {
    const { text, nested } = splitNestedLists(item, depth + 1);
    const marker = ordered ? `${index + 1}. ` : '- ';
    const body = text
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    lines.push(`${indent}${marker}${body[0] ?? ''}`);
    for (const line of body.slice(1)) lines.push(`${indent}  ${line}`);
    lines.push(...nested);
  }

  return lines;
}

/** Split list content into item fragments, ignoring `<li>`s owned by nested lists. */
function splitListItems(inner: string): string[] {
  const items: string[] = [];
  const scanner = /<\/?(?:li|ul|ol)\b[^>]*>/gi;
  let listDepth = 0;
  let itemStart = -1;
  let match = scanner.exec(inner);

  while (match) {
    const closing = match[0].startsWith('</');
    if (/^<\/?(?:ul|ol)\b/i.test(match[0])) {
      listDepth += closing ? -1 : 1;
    } else if (listDepth <= 0) {
      if (closing) {
        if (itemStart >= 0) items.push(inner.slice(itemStart, match.index));
        itemStart = -1;
      } else {
        // An unclosed <li> ends where the next one begins.
        if (itemStart >= 0) items.push(inner.slice(itemStart, match.index));
        itemStart = scanner.lastIndex;
      }
    }
    match = scanner.exec(inner);
  }

  if (itemStart >= 0) items.push(inner.slice(itemStart));
  return items;
}

/** Separate an item's own text from the lists nested inside it, rendering those one level deeper. */
function splitNestedLists(item: string, childDepth: number): { text: string; nested: string[] } {
  const nested: string[] = [];
  let text = '';
  let rest = item;

  for (;;) {
    const open = LIST_OPEN.exec(rest);
    if (!open) return { text: text + rest, nested };
    const slice = sliceElement(rest, open.index + open[0].length, 'ul|ol');
    if (!slice) return { text: text + rest, nested };
    text += rest.slice(0, open.index);
    nested.push(...renderListLines(open[0], slice.inner, childDepth));
    rest = rest.slice(slice.end);
  }
}

/** Prefix blockquote content with `> `, one level per nesting depth. */
function convertBlockquotes(html: string): string {
  let out = '';
  let rest = html;
  for (;;) {
    const open = BLOCKQUOTE_OPEN.exec(rest);
    if (!open) return out + rest;
    const slice = sliceElement(rest, open.index + open[0].length, 'blockquote');
    if (!slice) return out + rest;
    const quoted = convertBlockquotes(slice.inner)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    out += `${rest.slice(0, open.index)}\n${quoted}\n`;
    rest = rest.slice(slice.end);
  }
}

/**
 * Render a table body to a markdown table. A separator row is emitted only when
 * the first row actually carries `<th>` cells — a table with no header would
 * otherwise have its first data row relabelled as one.
 */
function renderTable(body: string): string {
  const rows: { cells: string[]; header: boolean }[] = [];

  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    let header = false;
    for (const cell of (row[1] ?? '').matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)) {
      if ((cell[1] ?? '').toLowerCase() === 'th') header = true;
      cells.push(renderCell(cell[2] ?? ''));
    }
    if (cells.length > 0) rows.push({ cells, header });
  }

  const [first, ...others] = rows;
  if (!first) return '';

  const width = Math.max(...rows.map((row) => row.cells.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;

  const out = [line(first.cells)];
  if (first.header) out.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  for (const row of others) out.push(line(row.cells));

  return `\n${out.join('\n')}\n`;
}

/** Flatten one table cell to a single line, escaping the pipe that would split it. */
function renderCell(cell: string): string {
  return stripTags(cell.replace(/<br\s*\/?>/gi, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Decode basic HTML entities in a plain-text string (not HTML).
 * Use this for SE API fields like site names and audiences that arrive
 * HTML-encoded but contain no markup.
 */
export function decodeHtmlEntities(text: string): string {
  return decodeEntities(text);
}

/**
 * Decode a numeric character reference to a string. Per the HTML5 rules, an
 * out-of-range (> U+10FFFF) or surrogate (U+D800–U+DFFF) code point yields the
 * replacement character — and String.fromCodePoint (unlike the truncating
 * String.fromCharCode it replaces) throws a RangeError on out-of-range input,
 * so those values must be handled before the call.
 */
function decodeCodePoint(code: number): string {
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  return String.fromCodePoint(code);
}

/** Decode each HTML entity exactly once; leave an unrecognized one encoded. */
function decodeEntities(text: string): string {
  return text.replace(
    ENTITY,
    (
      match: string,
      dec: string | undefined,
      hex: string | undefined,
      name: string | undefined,
    ): string => {
      if (dec !== undefined) return decodeCodePoint(parseInt(dec, 10));
      if (hex !== undefined) return decodeCodePoint(parseInt(hex, 16));
      return (name === undefined ? undefined : NAMED_ENTITIES[name]) ?? match;
    },
  );
}
