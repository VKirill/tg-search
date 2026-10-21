import { describe, expect, it } from 'vitest';
import { isFreeModel, rankModels, sizeB, type CatalogModel } from '../src/main/opencode/models';
import { createProfiles, fitScore, type ModelProfile } from '../src/main/opencode/profiles';
import { Db } from '../src/main/db';

const m = (providerID: string, id: string, o: Partial<CatalogModel> = {}): CatalogModel => ({
  providerID, id, name: id, vision: false, tools: true, variants: [], costIn: 0, costOut: 0, context: 200_000, enabled: true, ...o,
});

const catalog = [
  m('zai-coding-plan', 'glm-5.3-flash', { variants: ['low', 'medium', 'high'] }),
  m('openlux-claude', 'claude-sonnet-5-5', { vision: true, costIn: 3, costOut: 15, variants: ['high'] }),
  m('router9', 'gemini-3.8-flash', { vision: true, costIn: 0.3, costOut: 2.5 }),
  m('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', { variants: ['none', 'medium', 'high'] }),
  m('openrouter', 'google/gemma-4-31b-it:free', { vision: true, variants: ['none', 'thinking'] }),
  m('openrouter', 'nvidia/nemotron-3.5-lightning:free', { variants: ['none', 'thinking'] }),
  m('openrouter', 'liquid/lfm-2.5-2.6b:free'),
  m('openrouter', 'nvidia/nemotron-3.5-content-safety:free', { vision: true }),
  m('openrouter', 'openrouter/free', { vision: true }),
  m('openrouter', 'openrouter/auto', { vision: true }), // zero price, but bills the routed model
];
const choice = { main: 'zai-coding-plan/glm-5.3-flash', helpers: ['openlux-claude/claude-sonnet-5-5', 'router9/gemini-3.8-flash'] };
const refs = (list: { providerID: string; id: string }[]) => list.map((x) => `${x.providerID}/${x.id}`);

describe('model routing', () => {
  it('knows free models and model sizes', () => {
    expect(catalog.filter(isFreeModel).map((x) => x.id)).toHaveLength(5);
    expect(isFreeModel(m('openrouter', 'openrouter/auto'))).toBe(false);
    expect(isFreeModel(m('openrouter', 'openrouter/free'))).toBe(false); // a router to unknown models, not a model
    expect(sizeB('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(550);
    expect(sizeB('liquid/lfm-2.5-2.6b:free')).toBe(2.6);
    expect(sizeB('minimax/minimax-m3.1-flash:free')).toBe(0);
  });

  it('hard jobs: big free thinkers first, then the strongest ticked model', () => {
    const list = rankModels(catalog, choice, 'smart', { tools: true }, { useFree: true });
    expect(refs(list)).toEqual([
      'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      'openrouter/google/gemma-4-31b-it:free',
      'openlux-claude/claude-sonnet-5-5',
      'router9/gemini-3.8-flash',
      'zai-coding-plan/glm-5.3-flash',
    ]);
    expect(list[0].variant).toBe('high');
    expect(list[1].variant).toBe('thinking');
  });

  it('quick jobs: fast free models first, tiny and safety models never; vision needs eyes', () => {
    expect(refs(rankModels(catalog, choice, 'fast', {}, { useFree: true })).slice(0, 2)).toEqual([
      'openrouter/nvidia/nemotron-3.5-lightning:free', 'openrouter/google/gemma-4-31b-it:free',
    ]);
    const vision = refs(rankModels(catalog, choice, 'vision', { tools: true }, { useFree: true }));
    expect(vision).toEqual(['openrouter/google/gemma-4-31b-it:free', 'router9/gemini-3.8-flash', 'openlux-claude/claude-sonnet-5-5']);
  });

  it('client chat stays on the main model; free models off means the ticked ones only', () => {
    expect(refs(rankModels(catalog, choice, 'chat', { tools: true }, { useFree: true }))[0]).toBe('zai-coding-plan/glm-5.3-flash');
    expect(refs(rankModels(catalog, choice, 'fast', {}, { useFree: false }))[0]).toBe('zai-coding-plan/glm-5.3-flash');
  });

  it('a free model that just failed rests, the next free one steps in; a failed paid one goes last', () => {
    const cooling = (ref: string) => ref.endsWith('550b-a55b:free') || ref.endsWith('claude-sonnet-5-5');
    const list = refs(rankModels(catalog, choice, 'smart', { tools: true }, { useFree: true, cooling }));
    expect(list).toEqual([
      'openrouter/google/gemma-4-31b-it:free',
      'openrouter/nvidia/nemotron-3.5-lightning:free',
      'router9/gemini-3.8-flash',
      'zai-coding-plan/glm-5.3-flash',
      'openlux-claude/claude-sonnet-5-5',
    ]);
  });

  it('with profiles from the descriptions, the job goes to the model whose strengths match the agent\'s needs', () => {
    const profiles: Record<string, ModelProfile> = {
      'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': { skills: { reasoning: 3, writing: 1, russian: 1 }, summary: 'математика', expiresAt: null },
      'openrouter/google/gemma-4-31b-it:free': { skills: { reasoning: 2, writing: 3, russian: 3, vision: 2 }, summary: 'тексты', expiresAt: null },
      'openrouter/nvidia/nemotron-3.5-lightning:free': { skills: { reasoning: 1, writing: 2, russian: 0, speed: 3 }, summary: 'быстрая', expiresAt: null },
    };
    const profile = (ref: string) => profiles[ref];
    const top = (needs: any[], role: 'smart' | 'fast' = 'fast') =>
      refs(rankModels(catalog, choice, role, { tools: true }, { useFree: true, needs, profile }))[0];
    expect(top(['writing', 'russian'])).toBe('openrouter/google/gemma-4-31b-it:free'); // copywriter
    expect(top(['reasoning'], 'smart')).toBe('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'); // solver
    // no Russian at all: never gets a Russian job, even being the fastest
    expect(refs(rankModels(catalog, choice, 'fast', {}, { useFree: true, profile }))).not.toContain('openrouter/nvidia/nemotron-3.5-lightning:free');
    // a retired free model is skipped
    profiles['openrouter/google/gemma-4-31b-it:free'].expiresAt = Date.now() - 1000;
    expect(top(['writing', 'russian'])).not.toBe('openrouter/google/gemma-4-31b-it:free');
  });

  it('profiles: only new or changed descriptions are scored, scores are clamped, no image input means no vision', async () => {
    const db = new Db(':memory:');
    const profiles = createProfiles(db);
    const meta = { id: 'x/model:free', name: 'X', description: 'Great at math', input: ['text'], params: ['tools'], context: 1000, expiresAt: null };
    const prompts: string[] = [];
    const ask = async (p: string) => {
      prompts.push(p);
      return '```json\n{"x/model:free": {"skills": {"reasoning": 7, "vision": 3, "writing": 1}, "summary": "Математика и логика"}}\n```';
    };
    expect(await profiles.refresh([meta], ask)).toBe(1);
    expect(profiles.get('openrouter/x/model:free')).toEqual({ skills: { reasoning: 3, vision: 0, writing: 1 }, summary: 'Математика и логика', expiresAt: null });
    expect(await profiles.refresh([meta], ask)).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(await profiles.refresh([{ ...meta, description: 'Now also writes' }], ask)).toBe(1);
    expect(createProfiles(db).get('openrouter/x/model:free')?.summary).toBe('Математика и логика'); // survives a restart
    expect(fitScore(profiles.get('openrouter/x/model:free'), ['reasoning', 'russian'])).toBe(4); // unknown skill counts as 1
  });
});
