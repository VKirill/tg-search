// Model replies use Markdown (**bold**, `code`, [text](url), ### headings); Telegram shows it literally unless the
// marks become entities. Offsets are in UTF-16 code units — the same as JS string indices.
import type { formattedText, textEntity } from 'tdlib-types';

type Kind = 'textEntityTypeBold' | 'textEntityTypeItalic' | 'textEntityTypeCode' | 'textEntityTypeTextUrl' | 'textEntityTypeSpoiler';

// **bold** __bold__ `code` [text](url) *italic* ||spoiler|| $math$ (a price like «5$ и 10$» is not math: no space inside the marks)
const TOKEN = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+?)`|\[([^\]\n]+?)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])|\|\|([^|\n]+?)\|\||(?<![\w$])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g;

export function markdownToFormatted(input: string): formattedText {
  // headings and <summary> become bold lines, <details> wrappers go, $$ formulas become code
  const src = input
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/<summary>([\s\S]*?)<\/summary>[ \t]*\n?/gi, (_, t: string) => `**${t.trim()}**\n`)
    .replace(/^[ \t]*<\/?details[^>]*>[ \t]*\n/gim, '')
    .replace(/<\/?details[^>]*>/gi, '')
    .replace(/\$\$\s*([\s\S]+?)\s*\$\$/g, (_, t: string) => `\`${t.replace(/\s*\n\s*/g, ' ')}\``);
  let out = '';
  const entities: textEntity[] = [];
  let last = 0;
  const add = (inner: string, kind: Kind, url?: string) => {
    const offset = out.length;
    out += inner;
    const type = kind === 'textEntityTypeTextUrl' ? { _: kind, url: url! } : { _: kind };
    entities.push({ _: 'textEntity', offset, length: inner.length, type } as textEntity);
  };
  for (const m of src.matchAll(TOKEN)) {
    out += src.slice(last, m.index);
    if (m[1] ?? m[2]) add((m[1] ?? m[2])!, 'textEntityTypeBold');
    else if (m[3]) add(m[3], 'textEntityTypeCode');
    else if (m[4]) add(m[4], 'textEntityTypeTextUrl', m[5]);
    else if (m[6]) add(m[6], 'textEntityTypeItalic');
    else if (m[7]) add(m[7], 'textEntityTypeSpoiler');
    else if (m[8]) add(m[8], 'textEntityTypeCode');
    last = m.index! + m[0].length;
  }
  out += src.slice(last);
  return { _: 'formattedText', text: out, entities };
}

// Worth a Rich Message: Markdown structure beyond a plain sentence
export function hasRichMarkup(text: string): boolean {
  return /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^>|^\|.+\||\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]]+\]\(https?:|<details|\$\$|\|\|[^|\n]+\|\||^---$/m.test(text);
}

// Rich Message blocks from Markdown — the source TDLib accepts from user accounts (Markdown/HTML sources are for bots)
type RichText = Record<string, unknown>;
type Block = Record<string, unknown>;

const plain = (text: string): RichText => ({ _: 'richTextPlain', text });

export function inlineRich(src: string): RichText {
  const parts: RichText[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    if (m.index! > last) parts.push(plain(src.slice(last, m.index)));
    if (m[1] ?? m[2]) parts.push({ _: 'richTextBold', text: plain((m[1] ?? m[2])!) });
    else if (m[3]) parts.push({ _: 'richTextFixed', text: plain(m[3]) });
    else if (m[4]) parts.push({ _: 'richTextUrl', text: plain(m[4]), url: m[5], is_cached: false });
    else if (m[6]) parts.push({ _: 'richTextItalic', text: plain(m[6]) });
    else if (m[7]) parts.push({ _: 'richTextSpoiler', text: plain(m[7]) });
    else if (m[8]) parts.push({ _: 'richTextMathematicalExpression', expression: m[8] });
    last = m.index! + m[0].length;
  }
  if (last < src.length) parts.push(plain(src.slice(last)));
  return parts.length === 1 ? parts[0] : { _: 'richTexts', texts: parts };
}

const paragraph = (text: string): Block => ({ _: 'inputPageBlockParagraph', text: inlineRich(text) });
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(paragraph(para.join('\n')));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
    const details = /^\s*<details(\s+open)?\s*>/i.exec(line);
    const math = /^\s*\$\$(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (details) {
      // <details><summary>Почему так</summary> … </details> — a collapsible block, closed unless <details open>
      flush();
      const body = [line.slice(details[0].length)];
      for (let depth = /<\/details>\s*$/i.test(body[0]) ? 0 : 1; depth > 0 && ++i < lines.length;) {
        if (/^\s*<details/i.test(lines[i])) depth++;
        if (/<\/details>\s*$/i.test(lines[i]) && --depth === 0) {
          body.push(lines[i].replace(/<\/details>\s*$/i, ''));
          break;
        }
        body.push(lines[i]);
      }
      let inner = body.join('\n').replace(/<\/details>\s*$/i, '');
      const summary = /^\s*<summary>([\s\S]*?)<\/summary>/i.exec(inner);
      if (summary) inner = inner.slice(summary[0].length);
      blocks.push({ _: 'inputPageBlockDetails', header: inlineRich(summary?.[1].trim() || 'Подробнее'), blocks: markdownToBlocks(inner), is_open: !!details[1] });
    } else if (math) {
      // $$ formula $$ on one line or across several
      flush();
      let expr = math[1];
      if (/\$\$\s*$/.test(expr)) expr = expr.replace(/\$\$\s*$/, '');
      else {
        const rest: string[] = [];
        while (++i < lines.length && !/\$\$\s*$/.test(lines[i])) rest.push(lines[i]);
        rest.push((lines[i] ?? '').replace(/\$\$\s*$/, ''));
        expr = [expr, ...rest].join('\n');
      }
      blocks.push({ _: 'inputPageBlockMathematicalExpression', expression: expr.trim() });
    } else if (heading) {
      flush();
      blocks.push({ _: 'inputPageBlockSectionHeading', text: inlineRich(heading[2]), size: Math.min(heading[1].length, 6) });
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ _: 'inputPageBlockDivider' });
    } else if (item) {
      flush();
      const items: Block[] = [];
      const ordered = !!item[2];
      for (; i < lines.length; i++) {
        const it = /^\s*(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(lines[i]);
        if (!it || !!it[2] !== ordered) break;
        items.push({
          _: 'inputPageBlockListItem', blocks: [paragraph(it[4])], has_checkbox: it[3] != null,
          is_checked: /[xX]/.test(it[3] ?? ''), value: ordered ? Number(it[2]) : 0, type: ordered ? '1' : '',
        });
      }
      i--;
      blocks.push({ _: 'inputPageBlockList', items });
    } else if (line.startsWith('>')) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      i--;
      blocks.push({ _: 'inputPageBlockBlockQuote', blocks: [paragraph(quote.join('\n'))], credit: plain('') });
    } else if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') && c.startsWith(':') ? 'Center' : c.endsWith(':') ? 'Right' : 'Left'));
      const rows = [head];
      for (i += 2; i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({
        _: 'inputPageBlockTable', caption: plain(''), is_bordered: true, is_striped: true, is_compact: false,
        cells: rows.map((r, ri) => r.map((c, ci) => ({
          _: 'pageBlockTableCell', text: inlineRich(c), is_header: ri === 0, colspan: 1, rowspan: 1,
          align: { _: `pageBlockHorizontalAlignment${align[ci] ?? 'Left'}` }, valign: { _: 'pageBlockVerticalAlignmentMiddle' },
        }))),
      });
    } else para.push(line);
  }
  flush();
  return blocks;
}
