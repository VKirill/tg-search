import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import { createSkillsStore } from '../src/main/skills';
import { DEFAULT_MANAGER } from '../src/shared/types';

describe('skill lessons', () => {
  it('a finished order teaches the skill the agent used; lessons ride along when it is loaded', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lessons-'));
    const builtinDir = join(dataDir, 'builtin');
    mkdirSync(join(builtinDir, 'content-plan-week'), { recursive: true });
    writeFileSync(join(builtinDir, 'content-plan-week', 'SKILL.md'), `---
name: content-plan-week
description: Контент-план на неделю
metadata:
  status: active
  source: builtin
---
## Шаги
1. Темы на неделю.
`);
    const db = new Db(':memory:');
    const project = db.createProject({
      name: 'P', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
      geo: [], languages: [], accountIds: [], materials: [], keywords: [],
    });
    const lead = db.addLead({
      projectId: project.id, sourceId: null, tgChatId: 1, tgMessageId: 1, authorUserId: 7, authorName: 'A', authorUsername: null,
      text: 'нужен контент-план', date: Date.now(), link: null, score: 90, label: 'demand', reason: '',
    })!;
    const answers = [
      { lessons: ['Сразу спрашивай площадки и частоту постов', 'Предлагай обложки вместе с планом'] },
      { lessons: ['Сразу спроси площадки и частоту постов'] }, // a repeat of a known lesson
    ];
    const fetchAux = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }) }));
    const skills = createSkillsStore({
      dataDir, db, builtinDir, emit: () => {}, fetchAux: fetchAux as any,
      getSettings: () => ({ ...db.getSettings(), auxBaseUrl: 'https://aux', auxApiKey: 'k', auxModel: 'm' }),
    });

    const done = () => {
      const o = db.createOrder(lead.id, db.listServices()[0].id, 'контент-план для кофейни');
      return db.updateOrder(o.id, { status: 'done', result: 'план', revisionsUsed: 1 });
    };
    await skills.onOrderUpdated(done());
    expect(fetchAux).not.toHaveBeenCalled(); // the agent never loaded a skill for this lead

    skills.loadSkillBody('content-plan-week', lead.id);
    await skills.onOrderUpdated(done());
    await skills.onOrderUpdated(done());
    const sk = skills.list().find((s) => s.name === 'content-plan-week')!;
    expect(sk.lessons).toEqual(['Сразу спрашивай площадки и частоту постов', 'Предлагай обложки вместе с планом']);
    expect(skills.loadSkillBody('content-plan-week')).toMatch(/## Уроки из прошлых заказов\n\n- Сразу спрашивай площадки/);

    expect(skills.removeLesson('content-plan-week', 0).lessons).toEqual(['Предлагай обложки вместе с планом']);
  });
});
