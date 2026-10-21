// Resolves the operator's OpenAI-compatible endpoint from the provider switch in Settings.

import type { Settings } from '../../shared/types';

export interface OperatorEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const PRESETS = {
  glm: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
} as const;

export function resolveOperator(s: Settings): OperatorEndpoint {
  if (s.operatorProvider === 'glm') return { ...PRESETS.glm, apiKey: s.glmApiKey, model: s.operatorModel || PRESETS.glm.model };
  if (s.operatorProvider === 'deepseek') {
    return { ...PRESETS.deepseek, apiKey: s.deepseekApiKey, model: s.operatorModel || PRESETS.deepseek.model };
  }
  return { baseUrl: s.operatorBaseUrl, apiKey: s.operatorApiKey, model: s.operatorModel };
}
