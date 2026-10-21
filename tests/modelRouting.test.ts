import { describe, expect, it } from 'vitest';
import { isFreeModel, rankModels, sizeB, type CatalogModel } from '../src/main/opencode/models';

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
    expect(catalog.filter(isFreeModel).map((x) => x.id)).toHaveLength(6);
    expect(isFreeModel(m('openrouter', 'openrouter/auto'))).toBe(false);
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
    expect(vision).toEqual(['openrouter/google/gemma-4-31b-it:free', 'openrouter/openrouter/free', 'router9/gemini-3.8-flash', 'openlux-claude/claude-sonnet-5-5']);
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
});
