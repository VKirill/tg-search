// Function graphs for solutions: a model describes the plot (functions of x, points), the app draws it. Expressions are
// parsed, never evaluated as code — the text may come from a client's message.

type Node =
  | { k: 'num'; v: number }
  | { k: 'x' }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { k: 'fn'; name: string; a: Node };

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, tg: Math.tan, ctg: (v) => 1 / Math.tan(v), cot: (v) => 1 / Math.tan(v),
  asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctg: Math.atan,
  sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, lg: Math.log10, exp: Math.exp,
};

export function parseExpr(src: string): (x: number) => number {
  const s = src.replace(/\s+/g, '').replace(/·|×/g, '*').replace(/−/g, '-').replace(/,/g, '.');
  let i = 0;
  const peek = () => s[i];
  const fail = (): never => {
    throw new Error(`не разобрать выражение «${src}» около «${s.slice(i, i + 8)}»`);
  };
  function primary(): Node {
    const c = peek();
    if (c === '(') {
      i++;
      const n = add();
      if (s[i++] !== ')') fail();
      return n;
    }
    if (c === '-') {
      i++;
      return { k: 'neg', a: power() };
    }
    const num = /^\d+(?:\.\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return { k: 'num', v: Number(num[0]) };
    }
    const id = /^[a-zA-Zπ]+/.exec(s.slice(i));
    if (!id) return fail();
    i += id[0].length;
    const name = id[0].toLowerCase();
    if (name === 'x' || name === 't') return { k: 'x' };
    if (name === 'pi' || name === 'π') return { k: 'num', v: Math.PI };
    if (name === 'e') return { k: 'num', v: Math.E };
    if (FUNCS[name] && peek() === '(') return { k: 'fn', name, a: primary() };
    return fail();
  }
  // implicit multiplication: 2x, 3(x+1), 2sin(x)
  function implicit(): Node {
    let n = primary();
    while (i < s.length && /[\d(a-zA-Zπ]/.test(peek()) && n.k !== 'neg') n = { k: 'bin', op: '*', a: n, b: primary() };
    return n;
  }
  function power(): Node {
    const base = implicit();
    if (peek() === '^') {
      i++;
      return { k: 'bin', op: '^', a: base, b: power() };
    }
    return base;
  }
  function mul(): Node {
    let n = power();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++] as '*' | '/';
      n = { k: 'bin', op, a: n, b: power() };
    }
    return n;
  }
  function add(): Node {
    let n = mul();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++] as '+' | '-';
      n = { k: 'bin', op, a: n, b: mul() };
    }
    return n;
  }
  const tree = add();
  if (i !== s.length) fail();
  const ev = (n: Node, x: number): number => {
    switch (n.k) {
      case 'num': return n.v;
      case 'x': return x;
      case 'neg': return -ev(n.a, x);
      case 'fn': return FUNCS[n.name](ev(n.a, x));
      case 'bin': {
        const a = ev(n.a, x);
        const b = ev(n.b, x);
        return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a ** b;
      }
    }
  };
  return (x) => ev(tree, x);
}

export interface PlotSpec {
  title?: string;
  x?: { label?: string; min?: number; max?: number };
  y?: { label?: string; min?: number; max?: number };
  series: { fn?: string; points?: [number, number][]; label?: string }[];
  marks?: { x: number; y: number; label?: string }[]; // highlighted points (intersections, answers)
}

export const PLOT_W = 800;
export const PLOT_H = 560;
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// A «nice» step for grid lines: 1, 2 or 5 × 10^n
function step(span: number): number {
  const raw = span / 8;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw)!;
}

export function plotSvg(spec: PlotSpec): string {
  const lines = spec.series.map((s) => {
    if (s.points?.length) return s.points.filter((p) => p.every(Number.isFinite));
    if (!s.fn) return [];
    const f = parseExpr(s.fn);
    const x0 = spec.x?.min ?? -10;
    const x1 = spec.x?.max ?? 10;
    return Array.from({ length: 401 }, (_, k) => x0 + ((x1 - x0) * k) / 400).map((x) => [x, f(x)] as [number, number]);
  });
  const finite = lines.flat().filter(([, y]) => Number.isFinite(y));
  const xs = finite.map((p) => p[0]).concat(spec.marks?.map((m) => m.x) ?? []);
  const ys = finite.map((p) => p[1]).concat(spec.marks?.map((m) => m.y) ?? []);
  let xMin = spec.x?.min ?? Math.min(0, ...xs);
  let xMax = spec.x?.max ?? Math.max(1, ...xs);
  let yMin = spec.y?.min ?? Math.min(0, ...ys);
  let yMax = spec.y?.max ?? Math.max(1, ...ys);
  if (xMax <= xMin) xMax = xMin + 1;
  if (yMax <= yMin) yMax = yMin + 1;
  const padY = (yMax - yMin) * 0.06;
  if (spec.y?.min === undefined) yMin -= yMin < 0 ? padY : 0;
  if (spec.y?.max === undefined) yMax += padY;
  if (spec.x?.max === undefined) xMax += (xMax - xMin) * 0.04;

  const L = 70, R = 60, T = spec.title ? 50 : 24, B = 56;
  const W = PLOT_W - L - R, H = PLOT_H - T - B;
  const sx = (x: number) => L + ((x - xMin) / (xMax - xMin)) * W;
  const sy = (y: number) => T + H - ((y - yMin) / (yMax - yMin)) * H;
  const out: string[] = [];
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', ',');

  const dx = step(xMax - xMin), dy = step(yMax - yMin);
  for (let x = Math.ceil(xMin / dx) * dx; x <= xMax + 1e-9; x += dx) {
    out.push(`<line x1="${sx(x)}" y1="${T}" x2="${sx(x)}" y2="${T + H}" stroke="#e5e7eb"/>`);
    out.push(`<text x="${sx(x)}" y="${T + H + 20}" font-size="14" text-anchor="middle" fill="#374151">${fmt(x)}</text>`);
  }
  for (let y = Math.ceil(yMin / dy) * dy; y <= yMax + 1e-9; y += dy) {
    out.push(`<line x1="${L}" y1="${sy(y)}" x2="${L + W}" y2="${sy(y)}" stroke="#e5e7eb"/>`);
    out.push(`<text x="${L - 8}" y="${sy(y) + 5}" font-size="14" text-anchor="end" fill="#374151">${fmt(y)}</text>`);
  }
  // axes through zero when it is in view, else along the edges
  const ax = xMin <= 0 && xMax >= 0 ? sx(0) : L;
  const ay = yMin <= 0 && yMax >= 0 ? sy(0) : T + H;
  out.push(`<line x1="${L}" y1="${ay}" x2="${L + W + 12}" y2="${ay}" stroke="#111827" stroke-width="2" marker-end="url(#arrow)"/>`);
  out.push(`<line x1="${ax}" y1="${T + H}" x2="${ax}" y2="${T - 12}" stroke="#111827" stroke-width="2" marker-end="url(#arrow)"/>`);
  if (spec.x?.label) out.push(`<text x="${L + W + 18}" y="${ay + 5}" font-size="16" font-style="italic" fill="#111827">${esc(spec.x.label)}</text>`);
  if (spec.y?.label) out.push(`<text x="${ax + 10}" y="${T - 2}" font-size="16" font-style="italic" fill="#111827">${esc(spec.y.label)}</text>`);

  lines.forEach((pts, k) => {
    const color = COLORS[k % COLORS.length];
    // break the line where the function leaves the view or is undefined (asymptotes)
    const parts: string[] = [];
    let path = '';
    for (const [x, y] of pts) {
      if (!Number.isFinite(y) || y < yMin - (yMax - yMin) || y > yMax + (yMax - yMin)) {
        if (path) parts.push(path);
        path = '';
        continue;
      }
      path += `${path ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
    }
    if (path) parts.push(path);
    for (const d of parts) out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="3" clip-path="url(#plot)"/>`);
    const label = spec.series[k].label;
    if (label) out.push(`<text x="${L + 12}" y="${T + 22 + k * 22}" font-size="16" fill="${color}">${esc(label)}</text>`);
  });
  for (const m of spec.marks ?? []) {
    out.push(`<circle cx="${sx(m.x)}" cy="${sy(m.y)}" r="5" fill="#111827"/>`);
    if (m.label) out.push(`<text x="${sx(m.x) + 8}" y="${sy(m.y) - 8}" font-size="14" fill="#111827">${esc(m.label)}</text>`);
  }
  if (spec.title) out.push(`<text x="${PLOT_W / 2}" y="30" font-size="20" font-weight="600" text-anchor="middle" fill="#111827">${esc(spec.title)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PLOT_W}" height="${PLOT_H}" viewBox="0 0 ${PLOT_W} ${PLOT_H}" font-family="-apple-system, Helvetica, Arial, sans-serif">
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111827"/></marker>
<clipPath id="plot"><rect x="${L}" y="${T}" width="${W}" height="${H}"/></clipPath></defs>
<rect width="100%" height="100%" fill="#ffffff"/>
${out.join('\n')}
</svg>`;
}
