/**
 * @fileoverview Lightweight HTML→markdown normalizer for Stack Exchange post bodies.
 * Handles SE's known tag set: p, pre/code, strong, em, a, ul, ol, li, h1-h6,
 * blockquote, inline code. No external dependency required.
 * @module services/stackexchange/html-normalizer
 */

/**
 * Convert a Stack Exchange HTML post body to clean markdown.
 * Operates on SE's predictable, limited HTML tag set.
 */
export function normalizeHtml(html: string): string {
  if (!html) return '';

  let md = html;

  // Decode common HTML entities before processing
  md = decodeEntities(md);

  // Fenced code blocks: <pre><code>...</code></pre> → ```\n...\n```
  // SE wraps code blocks in both tags; capture the language hint from class if present.
  md = md.replace(
    /<pre[^>]*>\s*<code[^>]*class="[^"]*language-([^"\s]+)[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, lang: string, code: string) => {
      const cleaned = stripTags(code)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      return `\`\`\`${lang}\n${cleaned.trim()}\n\`\`\``;
    },
  );
  // Fenced code blocks without language class
  md = md.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code: string) => {
    const cleaned = stripTags(code)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return `\`\`\`\n${cleaned.trim()}\n\`\`\``;
  });

  // Headings h1–h6
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, content: string) => {
    const hashes = '#'.repeat(parseInt(level, 10));
    return `\n${hashes} ${stripTags(content).trim()}\n`;
  });

  // Blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content: string) => {
    const inner = normalizeHtml(content).trim();
    return inner
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  });

  // Bold
  md = md.replace(
    /<strong[^>]*>([\s\S]*?)<\/strong>/gi,
    (_, content: string) => `**${stripTags(content).trim()}**`,
  );
  md = md.replace(
    /<b[^>]*>([\s\S]*?)<\/b>/gi,
    (_, content: string) => `**${stripTags(content).trim()}**`,
  );

  // Italic
  md = md.replace(
    /<em[^>]*>([\s\S]*?)<\/em>/gi,
    (_, content: string) => `_${stripTags(content).trim()}_`,
  );
  md = md.replace(
    /<i[^>]*>([\s\S]*?)<\/i>/gi,
    (_, content: string) => `_${stripTags(content).trim()}_`,
  );

  // Inline code (not already inside pre blocks)
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content: string) => {
    const raw = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return `\`${raw}\``;
  });

  // Links
  md = md.replace(
    /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, text: string) => {
      const linkText = stripTags(text).trim() || href;
      return `[${linkText}](${href})`;
    },
  );
  md = md.replace(
    /<a[^>]+href='([^']*)'[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, text: string) => {
      const linkText = stripTags(text).trim() || href;
      return `[${linkText}](${href})`;
    },
  );

  // Ordered lists
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content: string) => {
    let counter = 0;
    const items = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item: string) => {
      counter++;
      return `${counter}. ${normalizeHtml(item).trim()}\n`;
    });
    return `\n${items}\n`;
  });

  // Unordered lists
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content: string) => {
    const items = content.replace(
      /<li[^>]*>([\s\S]*?)<\/li>/gi,
      (__, item: string) => `- ${normalizeHtml(item).trim()}\n`,
    );
    return `\n${items}\n`;
  });

  // Paragraphs → double newline
  md = md.replace(
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
    (_, content: string) => `\n${normalizeHtml(content).trim()}\n`,
  );

  // Line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Strip any remaining tags
  md = stripTags(md);

  // Re-decode entities that may have been introduced
  md = decodeEntities(md);

  // Normalize excessive blank lines (max 2 consecutive newlines)
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

/** Strip all HTML tags from a string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** Decode basic HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
