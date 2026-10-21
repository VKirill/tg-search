// Model replies use Markdown (**bold**, `code`, [text](url), ### headings); Telegram shows it literally unless the
// marks become entities. Offsets are in UTF-16 code units — the same as JS string indices.
import type { formattedText, textEntity } from 'tdlib-types';

type Kind = 'textEntityTypeBold' | 'textEntityTypeItalic' | 'textEntityTypeCode' | 'textEntityTypeTextUrl';

const TOKEN = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+?)`|\[([^\]\n]+?)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g;

export function markdownToFormatted(input: string): formattedText {
  // headings become bold lines
  const src = input.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
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
    last = m.index! + m[0].length;
  }
  out += src.slice(last);
  return { _: 'formattedText', text: out, entities };
}

// Worth a Rich Message: Markdown structure beyond a plain sentence
export function hasRichMarkup(text: string): boolean {
  return /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^>|^\|.+\||\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]]+\]\(https?:|<details|^---$/m.test(text);
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
    if (!line.trim()) flush();
    else if (heading) {
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
