import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { chunkText, createKnowledge, htmlText, knowledgeContext } from '../src/main/knowledge';
import { createFakeEmbedder } from '../src/main/memory/embedder';

const MANUAL = `# Справка по Директу

## Ставки

### Автостратегии
Стратегия «Максимум кликов» сама подбирает ставки в пределах недельного бюджета. Минимальный недельный бюджет — 300 ₽.

### Ручное управление
Ставку задаёте вы для каждой фразы.

## Минус-слова
Минус-слова исключают показы по нерелевантным запросам: «бесплатно», «скачать», «своими руками».`;

describe('knowledge bases', () => {
  it('passages follow headings and keep the heading path', () => {
    const chunks = chunkText(MANUAL);
    expect(chunks.map((c) => c.heading)).toEqual([
      'Справка по Директу › Ставки › Автостратегии',
      'Справка по Директу › Ставки › Ручное управление',
      'Справка по Директу › Минус-слова',
    ]);
    expect(chunkText('а'.repeat(5000)).length).toBeGreaterThan(1); // one huge «word» is still cut
    const long = Array.from({ length: 60 }, (_, i) => `Предложение номер ${i} про ставки и бюджет.`).join(' ');
    const parts = chunkText(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => /^Предложение/.test(p.text) && /\.$/.test(p.text))).toBe(true); // cut between sentences
  });

  it('HTML keeps headings, lists and paragraphs, drops scripts and menus', () => {
    const t = htmlText('<nav>меню</nav><h2>Ставки</h2><p>Первый абзац</p><ul><li>раз</li><li>два</li></ul><script>x()</script>');
    expect(t).toContain('## Ставки');
    expect(t).toContain('- раз');
    expect(t).not.toContain('меню');
    expect(t).not.toContain('x()');
  });

  it('a question finds the right passage by words and meaning, with its source', async () => {
    const kb = createKnowledge({ db: new Db(':memory:'), embedder: createFakeEmbedder() });
    const [base] = kb.createBase('Директ', 'справка');
    const doc = kb.addText(base.id, 'Справка Директа', MANUAL, 'https://example.com/direct');
    expect(doc).toMatchObject({ chunks: 3, status: 'indexing' });
    await kb.idle();
    expect(kb.docs(base.id)[0]).toMatchObject({ status: 'ready', embedded: 3 });
    expect(kb.listBases()[0]).toMatchObject({ docs: 1, chunks: 3 });

    const hits = await kb.search([base.id], 'какой минимальный недельный бюджет у автостратегии?', 2);
    expect(hits[0]).toMatchObject({ docTitle: 'Справка Директа', heading: 'Справка по Директу › Ставки › Автостратегии' });
    expect(hits[0].text).toContain('300 ₽');
    expect(await kb.search([999], 'бюджет')).toEqual([]); // other bases are not searched

    kb.removeDoc(doc.id);
    expect(await kb.search([base.id], 'бюджет')).toEqual([]);
  });

  it('«only from the materials»: nothing found means saying so, not inventing', () => {
    expect(knowledgeContext([], true)).toContain('ничего по этому вопросу не нашлось');
    expect(knowledgeContext([], false)).toBe('');
    const ctx = knowledgeContext([{ docTitle: 'Справка', source: '', heading: 'Ставки', text: 'Бюджет от 300 ₽' }], true);
    expect(ctx).toContain('[1] Справка — Ставки');
    expect(ctx).toContain('Отвечай только по этим материалам');
  });
});
