import type { Settings } from '../../shared/types';
import { PRESETS, type OperatorEndpoint } from './provider';
import type { OperatorLlmOverride } from './llm';

/** Map agent front-matter model field to LLM endpoint overrides. */
export function resolveAgentModel(model: string, settings: Settings): OperatorLlmOverride | undefined {
  const m = model.trim();
  if (!m) return undefined;
  if (m === 'glm') {
    return { baseUrl: PRESETS.glm.baseUrl, apiKey: settings.glmApiKey, model: settings.operatorModel || PRESETS.glm.model };
  }
  if (m === 'deepseek') {
    return {
      baseUrl: PRESETS.deepseek.baseUrl,
      apiKey: settings.deepseekApiKey,
      model: settings.operatorModel || PRESETS.deepseek.model,
    };
  }
  if (m.includes('/')) {
    const slash = m.indexOf('/');
    const provider = m.slice(0, slash);
    const modelId = m.slice(slash + 1);
    if (provider === 'glm') {
      return { baseUrl: PRESETS.glm.baseUrl, apiKey: settings.glmApiKey, model: modelId };
    }
    if (provider === 'deepseek') {
      return { baseUrl: PRESETS.deepseek.baseUrl, apiKey: settings.deepseekApiKey, model: modelId };
    }
    if (provider === 'custom' || provider === 'openrouter') {
      return {
        baseUrl: settings.operatorBaseUrl || settings.llmBaseUrl,
        apiKey: settings.operatorApiKey || settings.llmApiKey,
        model: modelId,
      };
    }
    return {
      baseUrl: settings.operatorBaseUrl || settings.llmBaseUrl,
      apiKey: settings.operatorApiKey || settings.llmApiKey,
      model: m,
    };
  }
  return { model: m };
}

export type { OperatorEndpoint };
