import { dot, normalize } from '../memory/embedder';

export function tokenSet(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
  return new Set(tokens);
}

export function jaccard(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  return dot(a, b);
}

export async function briefSimilarity(
  a: string,
  b: string,
  embed?: (text: string) => Promise<Float32Array | null>,
): Promise<number> {
  if (embed) {
    const [va, vb] = await Promise.all([embed(a), embed(b)]);
    if (va && vb) return cosineSim(normalize(va), normalize(vb));
  }
  return jaccard(a, b);
}

/** Greedy clustering; sim is async (uses max similarity to any member). */
export async function clusterBriefsAsync(
  briefs: { id: number; text: string }[],
  threshold: number,
  sim: (a: string, b: string) => Promise<number>,
): Promise<number[][]> {
  const clusters: number[][] = [];
  for (let i = 0; i < briefs.length; i++) {
    let placed = false;
    for (const cluster of clusters) {
      let max = 0;
      for (const j of cluster) {
        const s = await sim(briefs[i].text, briefs[j].text);
        if (s > max) max = s;
      }
      if (max >= threshold) {
        cluster.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([i]);
  }
  return clusters;
}
