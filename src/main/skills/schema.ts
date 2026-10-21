// Local state beside userData/skills/* (usage counters, learning dedupe).

export interface SkillsState {
  uses: Record<string, number>;
  /** Lessons per skill, learned from finished orders */
  lessons: Record<string, { text: string; at: number; orderId: number }[]>;
  /** Skills the agent loaded for a lead: a finished order teaches these */
  leadSkills: Record<string, string[]>;
  /** Cluster keys for which a learned draft was already created */
  learnedClusters: string[];
}

export const EMPTY_SKILLS_STATE: SkillsState = {
  uses: {},
  lessons: {},
  leadSkills: {},
  learnedClusters: [],
};

export function clusterKey(serviceId: number, orderIds: number[]): string {
  const sorted = [...orderIds].sort((a, b) => a - b);
  return `s${serviceId}:${sorted.join(',')}`;
}
