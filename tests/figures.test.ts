import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseExpr, plotSvg } from '../src/main/figures/plot';
import { renderFigures, setFigureHost } from '../src/main/figures';
import { markdownToBlocks, markdownToFormatted } from '../src/main/telegram/markdown';

describe('plot expressions', () => {
  it('parses school formulas without running code', () => {
    expect(parseExpr('2x+1')(3)).toBe(7);
    expect(parseExpr('x^2 - 4x + 3')(1)).toBe(0);
    expect(parseExpr('-x^2')(3)).toBe(-9);
    expect(parseExpr('2sin(x)')(Math.PI / 2)).toBeCloseTo(2);
    expect(parseExpr('sqrt(x)·3')(4)).toBe(6);
    expect(parseExpr('5 + 2*t')(10)).toBe(25);
    expect(() => parseExpr('process.exit()')).toThrow(/не разобрать/);
    expect(() => parseExpr('constructor')).toThrow();
  });

  it('draws axes, grid, labels and every series', () => {
    const svg = plotSvg({ title: 's(t)', x: { label: 't, с', min: 0, max: 10 }, y: { label: 's, м' }, series: [{ fn: '2x', label: 's = 2t' }, { points: [[0, 5], [10, 5]] }], marks: [{ x: 5, y: 10, label: 'A' }] });
    expect(svg).toContain('t, с');
    expect(svg).toContain('s = 2t');
    expect(svg.match(/stroke-width="3"/g)).toHaveLength(2);
    expect(svg).toContain('<circle');
  });
});

describe('figures in solutions', () => {
  afterEach(() => setFigureHost(null));

  it('plot and crop blocks become pictures; a broken block is dropped, the text stays', async () => {
    const calls: string[] = [];
    setFigureHost({
      svgToPng: async (svg) => (calls.push('plot'), Buffer.from(svg.slice(0, 10))),
      crop: async (path, box) => (calls.push(`crop ${path} ${box.join(',')}`), Buffer.from('png')),
    });
    const dir = join(mkdtempSync(join(tmpdir(), 'fig-')), 'figures');
    const text = [
      'Шаг 1',
      '```crop', '{"image": 1, "box": [5, 40, 30, 70], "caption": "Рис. 1"}', '```',
      '```plot', '{"x": {"min": 0, "max": 5}, "series": [{"fn": "2x"}], "caption": "Мой график"}', '```',
      'Шаг 2',
      '```plot', '{not json}', '```',
    ].join('\n');
    const out = await renderFigures(text, { images: ['/tmp/page.jpg'], dir });
    expect(calls).toEqual(['crop /tmp/page.jpg 5,40,30,70', 'plot']);
    const pics = [...out.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
    expect(pics.map((p) => p[1])).toEqual(['Рис. 1', 'Мой график']);
    expect(pics.every((p) => existsSync(p[2]))).toBe(true);
    expect(out).not.toContain('```');
    expect(out).toContain('Шаг 2');

    // two pictures in a row are a collage, one is a photo; plain text keeps only the captions
    const blocks = markdownToBlocks(out) as any[];
    expect(blocks.map((b) => b._)).toEqual(['inputPageBlockParagraph', 'inputPageBlockCollage', 'inputPageBlockParagraph']);
    expect(blocks[1].blocks[0].photo.photo.path).toBe(pics[0][2]);
    expect(markdownToBlocks('![Рис. 1](/tmp/a.png)')[0]._).toBe('inputPageBlockPhoto');
    expect(markdownToFormatted(out).text).toContain('[Рис. 1]');
  });
});
