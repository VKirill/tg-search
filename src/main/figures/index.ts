// Pictures inside solutions. A model can't draw, but it can describe: a ```plot``` block (functions, points) becomes a
// drawn graph, a ```crop``` block (a box on the client's photo) becomes the task's figure cut out. Both turn into
// `![caption](file)` lines that a Rich Message shows as photos; two pictures on one line make a collage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plotSvg, PLOT_H, PLOT_W, type PlotSpec } from './plot';

export interface FigureHost {
  svgToPng(svg: string, width: number, height: number): Promise<Buffer>;
  // box in percent of the image: [left, top, right, bottom], 0–100
  crop(imagePath: string, box: [number, number, number, number]): Promise<Buffer>;
}

let host: FigureHost | null = null;
export const setFigureHost = (h: FigureHost | null) => {
  host = h;
};

const BLOCK = /```(plot|crop)\s*\n([\s\S]*?)\n```/g;

export async function renderFigures(text: string, opts: { images: string[]; dir: string }): Promise<string> {
  if (!BLOCK.test(text)) return text;
  BLOCK.lastIndex = 0;
  mkdirSync(opts.dir, { recursive: true });
  let n = 0;
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(BLOCK)) {
    parts.push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    parts.push(await renderOne(m[1] as 'plot' | 'crop', m[2], opts, ++n).catch((err) => {
      console.warn('figure', m[1], err instanceof Error ? err.message : err);
      return ''; // a broken figure must not break the solution
    }));
  }
  parts.push(text.slice(last));
  return parts.join('');
}

async function renderOne(kind: 'plot' | 'crop', body: string, opts: { images: string[]; dir: string }, n: number): Promise<string> {
  if (!host) throw new Error('рисунки недоступны вне приложения');
  const spec = JSON.parse(body) as (PlotSpec | { image?: number; box: number[] }) & { caption?: string };
  const caption = String(spec.caption ?? (kind === 'plot' ? 'График' : 'Рисунок')).replace(/[[\]]/g, '');
  let png: Buffer;
  if (kind === 'plot') {
    png = await host.svgToPng(plotSvg(spec as PlotSpec), PLOT_W, PLOT_H);
  } else {
    const c = spec as { image?: number; box: number[] };
    const image = opts.images[(c.image ?? 1) - 1];
    if (!image) throw new Error(`нет картинки №${c.image ?? 1}`);
    const box = c.box.map((v) => Math.max(0, Math.min(100, Number(v)))) as [number, number, number, number];
    if (box.length !== 4 || box[2] <= box[0] || box[3] <= box[1]) throw new Error(`неверная рамка ${JSON.stringify(c.box)}`);
    png = await host.crop(image, box);
  }
  const path = join(opts.dir, `figure-${Date.now()}-${n}.png`);
  writeFileSync(path, png);
  return `![${caption}](${path})`;
}

// What the solving model is told about figures
export const FIGURES_GUIDE = [
  'Рисунки. Если в условии есть рисунок, график или схема — вставь его в решение рядом с шагом, где он нужен, блоком',
  '```crop\n{"image": 1, "box": [левый, верхний, правый, нижний], "caption": "Рис. 1"}\n```',
  '(рамка — в процентах от ширины и высоты фото задания, номер фото по порядку; бери рамку с небольшим запасом).',
  'Если нужно построить график (функции, движения, зависимости) или он поможет понять ответ — блок',
  '```plot\n{"title": "s(t)", "x": {"label": "t, с", "min": 0, "max": 10}, "y": {"label": "s, м"}, "series": [{"fn": "2*x", "label": "s = 2t"}], "marks": [{"x": 5, "y": 10, "label": "A"}], "caption": "График пути"}\n```',
  '(fn — формула от x: + - * / ^, sin, cos, tg, sqrt, abs, ln, lg, exp, pi; или "points": [[x, y], …] для ломаной по точкам).',
  'Блок приложение заменит картинкой. Две картинки рядом (рисунок из условия и твой график) — два блока подряд.',
].join('\n');
