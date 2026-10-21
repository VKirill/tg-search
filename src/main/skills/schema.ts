// Local state beside userData/skills/* (usage counters, learning dedupe).

export interface SkillsState {
  uses: Record<string, number>;
  /** Cluster keys for which a learned draft was already created */
  learnedClusters: string[];
}

export const EMPTY_SKILLS_STATE: SkillsState = {
  uses: {},
  learnedClusters: [],
};

export function clusterKey(serviceId: number, orderIds: number[]): string {
  const sorted = [...orderIds].sort((a, b) => a - b);
  return `s${serviceId}:${sorted.join(',')}`;
}
