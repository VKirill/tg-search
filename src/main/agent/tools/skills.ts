import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';
import type { SkillsStore } from '../../skills';

export function createSkillsTool(deps: ToolHostDeps & { skills?: SkillsStore }): AgentTool {
  return {
    name: 'load_skill',
    description: 'Загрузить инструкции активного умения по имени (см. available_skills).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async run(args, ctx) {
      if (!deps.skills) return 'Умения пока не подключены';
      const name = String(args.name ?? '').trim();
      if (!name) return 'Ошибка: укажите name';
      if (ctx.dryRun) return `[dryRun] Загрузили бы умение ${name}`;
      try {
        const body = deps.skills.loadSkillBody(name);
        return body;
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
