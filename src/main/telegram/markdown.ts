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
