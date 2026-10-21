export interface RankedHit {
  ownerType: string;
  ownerId: number;
  score: number;
}

const RRF_K = 60;

/** Reciprocal rank fusion of several ranked lists (higher score is better). */
export function reciprocalRankFusion(lists: { ownerType: string; ownerId: number }[][]): RankedHit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const key = `${item.ownerType}:${item.ownerId}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
    }
  }
  const hits: RankedHit[] = [];
  for (const [key, score] of scores) {
    const [ownerType, ownerId] = key.split(':');
    hits.push({ ownerType, ownerId: Number(ownerId), score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}
