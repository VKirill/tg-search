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

describe('rich message text', () => {
  it('turns blocks into plain lines for history', async () => {
    const { richMessageText } = await import('../src/main/telegram/mappers');
    const plain = (text: string) => ({ _: 'richTextPlain', text });
    const blocks = [
      { _: 'pageBlockHeader', header: { _: 'richTextBold', text: plain('Что умею') } },
      { _: 'pageBlockParagraph', text: { _: 'richTexts', texts: [plain('Поиск '), { _: 'richTextBold', text: plain('и тексты') }] } },
      { _: 'pageBlockList', items: [{ _: 'pageBlockListItem', label: '•', page_blocks: [{ _: 'pageBlockParagraph', text: plain('карточки') }] }] },
    ];
    expect(richMessageText(blocks)).toBe('Что умею\nПоиск и тексты\nкарточки');
  });
});

describe('educational rich blocks', () => {
  const solution = [
    '## Задача 1',
    '> Найдите корни $x^2 - 5x + 6 = 0$',
    '1. Дискриминант $D = 25 - 24 = 1$',
    '<details>',
    '<summary>Почему так</summary>',
    'Для $ax^2+bx+c$ дискриминант $D = b^2 - 4ac$.',
    '</details>',
    '$$',
    'x = \\frac{5 \\pm 1}{2}',
    '$$',
    '**Ответ: 2 и 3**, проверка ||подставь сам||',
    '<details open><summary>Проверка</summary>4 - 10 + 6 = 0</details>',
  ].join('\n');

  it('collapsible blocks, formulas and spoilers become Rich Message blocks', async () => {
    const { markdownToBlocks, hasRichMarkup } = await import('../src/main/telegram/markdown');
    expect(hasRichMarkup('<details><summary>a</summary>b</details>')).toBe(true);
    const blocks = markdownToBlocks(solution) as any[];
    expect(blocks.map((b) => b._)).toEqual([
      'inputPageBlockSectionHeading', 'inputPageBlockBlockQuote', 'inputPageBlockList', 'inputPageBlockDetails',
      'inputPageBlockMathematicalExpression', 'inputPageBlockParagraph', 'inputPageBlockDetails',
    ]);
    const why = blocks[3];
    expect(why.header).toEqual({ _: 'richTextPlain', text: 'Почему так' });
    expect(why.is_open).toBe(false);
    expect(why.blocks[0].text.texts).toContainEqual({ _: 'richTextMathematicalExpression', expression: 'D = b^2 - 4ac' });
    expect(blocks[4].expression).toBe('x = \\frac{5 \\pm 1}{2}');
    expect(blocks[5].text.texts).toContainEqual({ _: 'richTextSpoiler', text: { _: 'richTextPlain', text: 'подставь сам' } });
    expect(blocks[6].is_open).toBe(true);
    expect(blocks[6].blocks[0].text).toEqual({ _: 'richTextPlain', text: '4 - 10 + 6 = 0' });
  });

  it('without Rich Messages the same text stays readable: no tags, formulas as code, spoiler entity', () => {
    const f = markdownToFormatted(solution);
    expect(f.text).not.toMatch(/<\/?(details|summary)/);
    expect(f.text).toContain('Почему так');
    expect(f.text).toContain('x = \\frac{5 \\pm 1}{2}');
    expect(f.entities.some((e) => e.type._ === 'textEntityTypeSpoiler')).toBe(true);
  });

  it('prices with dollars are not formulas', () => {
    expect(markdownToFormatted('стоит 5$ или $10 за $ штуку').entities).toEqual([]);
  });
});

describe('rich message history text', () => {
  it('a collapsible block reads heading first; formulas keep their LaTeX', async () => {
    const { richMessageText } = await import('../src/main/telegram/mappers');
    const plain = (text: string) => ({ _: 'richTextPlain', text });
    const blocks = [
      { _: 'pageBlockDetails', header: plain('Почему так'), page_blocks: [{ _: 'pageBlockParagraph', text: { _: 'richTexts', texts: [plain('D = '), { _: 'richTextMathematicalExpression', expression: 'b^2-4ac' }] } }], is_open: false },
      { _: 'pageBlockMathematicalExpression', expression: 'x=1' },
    ];
    expect(richMessageText(blocks)).toBe('Почему так\nD = b^2-4ac\nx=1');
  });
});

describe('formulas inside bold', () => {
  it('«**Ответ: $v = 20\\text{ м/с}$**» renders the formula, not raw LaTeX', async () => {
    const { inlineRich } = await import('../src/main/telegram/markdown');
    const r = inlineRich('**Ответ: $v_{\\text{ср}} = 20\\text{ м/с}$ (или $72\\text{ км/ч}$)**') as any;
    expect(r._).toBe('richTextBold');
    expect(r.text.texts).toContainEqual({ _: 'richTextMathematicalExpression', expression: 'v_{\\text{ср}} = 20\\text{ м/с}' });
    expect(markdownToFormatted('**Ответ: $s \\approx 2444\\text{ м}$**').text).toBe('Ответ: s \\approx 2444 м');
  });
});
