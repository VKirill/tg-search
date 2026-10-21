// Normalize message text for duplicate and spam-template detection.

const ZW_RE = /[\u200B-\u200D\uFEFF\u2060\u180E\u00AD]/g;
const FORMAT_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{20E3}\u{E0020}-\u{E007F}]/gu;

// Latin / Greek / digit look-alikes → Cyrillic when the token is mostly Cyrillic letters.
const HOMO_TO_CYR: Record<string, string> = {
  a: 'а', A: 'а', b: 'в', B: 'в', c: 'с', C: 'с', d: 'д', D: 'д', e: 'е', E: 'е',
  g: 'г', G: 'г', h: 'н', H: 'н', i: 'і', I: 'і', j: 'ј', J: 'ј', k: 'к', K: 'к',
  l: 'л', L: 'л', m: 'м', M: 'м', n: 'н', N: 'н', o: 'о', O: 'о', p: 'р', P: 'р',
  r: 'р', R: 'р', s: 'с', S: 'с', t: 'т', T: 'т', u: 'у', U: 'у', v: 'в', V: 'в',
  w: 'ш', W: 'ш', x: 'х', X: 'х', y: 'у', Y: 'у', z: 'з', Z: 'з',
  α: 'а', Α: 'а', β: 'в', Β: 'в', ε: 'е', Ε: 'е', ο: 'о', Ο: 'о', ρ: 'р', Ρ: 'р',
  τ: 'т', Τ: 'т', υ: 'у', Υ: 'у', χ: 'х', Χ: 'х', κ: 'к', Κ: 'к', μ: 'м', Μ: 'м',
  ν: 'н', Ν: 'н', η: 'н', Η: 'н', δ: 'д', Δ: 'д', γ: 'г', Γ: 'г', λ: 'л', Λ: 'л',
  '0': 'о', '3': 'з', '4': 'ч', '6': 'б', '9': 'д',
};

function isCyrillic(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x0400 && c <= 0x04ff) || (c >= 0x0500 && c <= 0x052f);
}

function mapHomoglyphs(text: string): string {
  let cyr = 0;
  let hom = 0;
  for (const ch of text) {
    if (isCyrillic(ch)) cyr++;
    else if (HOMO_TO_CYR[ch]) hom++;
  }
  if (cyr === 0 || hom === 0 || cyr < hom) return text;
  let out = '';
  for (const ch of text) {
    out += HOMO_TO_CYR[ch] ?? ch;
  }
  return out;
}

function collapseRepeats(s: string): string {
  return s.replace(/(.)\1{2,}/g, '$1$1');
}

export interface NormalizedText {
  text: string;
  urls: string[];
  mentions: string[];
}

export function normalizeMessageText(raw: string): NormalizedText {
  const urls: string[] = [];
  const mentions: string[] = [];
  let s = raw.normalize('NFKC').toLowerCase();
  s = s.replace(ZW_RE, '').replace(FORMAT_RE, '');
  s = s.replace(EMOJI_RE, ' ');
  s = s.replace(/https?:\/\/[^\s]+/gi, (u) => {
    urls.push(u);
    return ' ';
  });
  s = s.replace(/@[a-z0-9_]{3,}/gi, (m) => {
    mentions.push(m);
    return ' ';
  });
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  s = mapHomoglyphs(s.replace(/\s+/g, ' ').trim());
  s = collapseRepeats(s);
  s = s.replace(/\s+/g, ' ').trim();
  return { text: s, urls, mentions };
}
