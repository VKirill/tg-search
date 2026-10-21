// RSS 2.0 and Atom without a dependency: the items' title, link, text, date and picture
import { htmlText } from '../knowledge';

export interface FeedEntry {
  title: string;
  url: string | null;
  text: string;
  publishedAt: number;
  image: string | null;
}

const decode = (s: string) => s
  .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1].trim()) : null;
}

function attr(block: string, name: string, attribute: string): string | null {
  const m = new RegExp(`<${name}\\s[^>]*${attribute}=["']([^"']+)["']`, 'i').exec(block);
  return m ? decode(m[1]) : null;
}

const plain = (html: string) => htmlText(html).replace(/\s+\n/g, '\n').trim();

export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocks.map((b) => {
    const html = tag(b, 'content:encoded') ?? tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content') ?? '';
    const date = tag(b, 'pubDate') ?? tag(b, 'dc:date') ?? tag(b, 'published') ?? tag(b, 'updated');
    const image = attr(b, 'enclosure', 'url') ?? attr(b, 'media:content', 'url') ?? attr(b, 'media:thumbnail', 'url')
      ?? /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
    const link = tag(b, 'link') || attr(b, 'link', 'href');
    const parsed = date ? Date.parse(date) : NaN;
    return {
      title: plain(tag(b, 'title') ?? '').slice(0, 300),
      url: link?.trim() || null,
      text: plain(html).slice(0, 3000),
      publishedAt: Number.isFinite(parsed) ? parsed : Date.now(),
      image: image && /^https?:/.test(image) ? image : null,
    };
  }).filter((e) => e.title || e.text);
}
