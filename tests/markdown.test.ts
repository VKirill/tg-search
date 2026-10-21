import { describe, expect, it } from 'vitest';
import { markdownToFormatted } from '../src/main/telegram/markdown';

describe('markdown → Telegram entities', () => {
  it('bold, code, links and headings become entities; text keeps no marks', () => {
    const f = markdownToFormatted('### Что умею\n- **Поиск** — найду `инфу` 🙂 и [сайт](https://ex.com), *быстро*');
    expect(f.text).toBe('Что умею\n- Поиск — найду инфу 🙂 и сайт, быстро');
    const at = (s: string) => f.text.indexOf(s);
    expect(f.entities.map((e) => [e.offset, e.length, e.type._])).toEqual([
      [0, 8, 'textEntityTypeBold'],
      [at('Поиск'), 5, 'textEntityTypeBold'],
      [at('инфу'), 4, 'textEntityTypeCode'],
      [at('сайт'), 4, 'textEntityTypeTextUrl'],
      [at('быстро'), 6, 'textEntityTypeItalic'],
    ]);
  });

  it('plain text and lone asterisks stay as they are', () => {
    expect(markdownToFormatted('2 * 3 = 6, цена 5*')).toEqual({ _: 'formattedText', text: '2 * 3 = 6, цена 5*', entities: [] });
  });
});
