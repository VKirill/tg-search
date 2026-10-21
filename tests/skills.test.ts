import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import {
  createSkillsStore,
  parseSkillMd,
  serializeSkillMd,
  validateSkillName,
  hintSkillsForMessage,
} from '../src/main/skills';
import { createSkillsTool } from '../src/main/agent/tools/skills';
import { freshTurnState } from '../src/main/agent/tools';

function sampleMd(name: string, status: 'active' | 'draft' | 'disabled' = 'active') {
  return `---
name: ${name}
description: Test skill ${name}
metadata:
  status: ${status}
  source: owner
---

Body for ${name}.
`;
}

describe('skills front matter', () => {
  it('validates names', () => {
    expect(validateSkillName('wb-card')).toBeNull();
    expect(validateSkillName('Bad')).not.toBeNull();
    expect(validateSkillName('')).not.toBeNull();
  });

  it('round-trips parse and serialize', () => {
    const raw = sampleMd('content-plan-week');
    const parsed = parseSkillMd(raw);
    expect(parsed.name).toBe('content-plan-week');
    expect(parsed.description).toContain('Test skill');
    expect(parsed.body.trim()).toContain('Body for');
    const again = parseSkillMd(serializeSkillMd(parsed));
    expect(again.name).toBe(parsed.name);
    expect(again.body).toBe(parsed.body);
  });
});

describe('skills store', () => {
  function store(db?: Db) {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-skills-'));
    const builtinDir = mkdtempSync(join(tmpdir(), 'tg-skills-builtin-'));
    mkdirSync(join(builtinDir, 'wb-card'), { recursive: true });
    writeFileSync(join(builtinDir, 'wb-card', 'SKILL.md'), sampleMd('wb-card', 'active').replace('source: owner', 'source: builtin'));
    const database = db ?? new Db(':memory:');
    const events: import('../src/shared/types').AppEvent[] = [];
    return {
      skills: createSkillsStore({
        dataDir,
        db: database,
        getSettings: () => database.getSettings(),
        emit: (e) => events.push(e),
        builtinDir,
        postJev: vi.fn(async () => ({
          answers: { pick: { type: 'choice', choice: 'none', probabilities: { none: 1 } } },
        })) as any,
        fetchAux: vi.fn(),
      }),
      events,
      db: database,
    };
  }

  it('user skill overrides builtin by name', () => {
    const { skills } = store();
    const list0 = skills.list();
    expect(list0.find((s) => s.name === 'wb-card')?.source).toBe('builtin');

    skills.save({
      name: 'wb-card',
      description: 'Override',
      body: 'Custom body',
      status: 'active',
      source: 'owner',
    });
    const list1 = skills.list();
    expect(list1.find((s) => s.name === 'wb-card')?.description).toBe('Override');
    expect(skills.loadSkillBody('wb-card')).toContain('Custom body');
  });

  it('load_skill increments uses and draft is not loadable', () => {
    const { skills } = store();
    skills.save({
      name: 'draft-skill',
      description: 'Draft',
      body: 'Draft body',
      status: 'draft',
      source: 'owner',
    });

    expect(() => skills.loadSkillBody('draft-skill')).toThrow();
    const before = skills.list().find((s) => s.name === 'wb-card')?.uses ?? 0;
    const body = skills.loadSkillBody('wb-card');
    expect(body).toContain('Body for');
    expect(skills.list().find((s) => s.name === 'wb-card')?.uses).toBe(before + 1);

    const tool = createSkillsTool({
      skills,
      turnState: freshTurnState(),
      db: new Db(':memory:'),
      engine: {} as any,
      ai: {} as any,
      emit: () => {},
      getSettings: () => new Db(':memory:').getSettings(),
    });
    expect(tool.name).toBe('load_skill');
  });

  it('disabled skills are not in active catalog', () => {
    const { skills } = store();
    skills.save({
      name: 'off-skill',
      description: 'Off',
      body: 'x',
      status: 'disabled',
      source: 'owner',
    });
    expect(skills.activeCatalog().some((s) => s.name === 'off-skill')).toBe(false);
    expect(skills.formatAvailableBlock()).not.toContain('off-skill');
  });

  it('approve activates draft', () => {
    const { skills } = store();
    skills.save({
      name: 'new-draft',
      description: 'D',
      body: 'B',
      status: 'draft',
      source: 'learned',
    });
    const approved = skills.approve('new-draft');
    expect(approved.status).toBe('active');
    expect(skills.loadSkillBody('new-draft').trim()).toBe('B');
  });
});

describe('jev skill hint', () => {
  afterEach(() => vi.restoreAllMocks());

  it('picks skills above threshold from fake Jev', async () => {
    const postFn = vi.fn(async () => ({
      answers: {
        pick: {
          type: 'choice',
          choice: 'wb-card',
          probabilities: { 'wb-card': 0.6, 'homework-photo': 0.4, none: 0.1 },
        },
      },
    }));
    const hints = await hintSkillsForMessage(
      () => ({ jevApiKey: 'k', jevBaseUrl: 'https://x', jevModel: 'jev' } as import('../src/shared/types').Settings),
      'нужна карточка на вб',
      [
        { name: 'wb-card', description: 'WB' },
        { name: 'homework-photo', description: 'HW' },
      ],
      0.35,
      postFn as any,
    );
    expect(hints).toContain('wb-card');
    expect(hints).toContain('homework-photo');
  });
});

describe('skill learning', () => {
  it('creates one draft after third similar done order, not before', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-learn-'));
    const builtinDir = mkdtempSync(join(tmpdir(), 'tg-learn-builtin-'));
    const db = new Db(':memory:');
    const acc = db.upsertAccountByPhone('+79990001122');
    const project = db.createProject({
      name: 'P',
      task: 'clients',
      target: 't',
      offer: 'o',
      criteria: '',
      sequence: [],
      manager: DEFAULT_MANAGER,
      geo: [],
      languages: ['ru'],
      accountIds: [acc.id],
      materials: [],
      keywords: [],
    });
    const lead = db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 1,
      authorUserId: 1,
      authorName: 'A',
      authorUsername: 'a',
      text: 'hi',
      date: Date.now(),
      link: null,
      score: 80,
      label: 'demand',
      reason: '',
    })!;
    const service = db.listServices()[0]!;
    const brief = 'найти поставщиков мёда оптом москва список контактов';

    const draftRaw = `---
name: learned-suppliers
description: Learned supplier search
metadata:
  status: draft
  source: learned
---

Learned body.
`;

    const fetchAux = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: draftRaw } }] }),
    }));

    const postJev = vi.fn(async () => ({
      answers: { cover: { type: 'noul', noul: 0.1 } },
    }));

    const events: import('../src/shared/types').AppEvent[] = [];
    const skills = createSkillsStore({
      dataDir,
      db,
      getSettings: () => ({ ...db.getSettings(), auxBaseUrl: 'https://aux', auxApiKey: 'k', auxModel: 'm' }),
      emit: (e) => events.push(e),
      builtinDir,
      postJev: postJev as any,
      fetchAux: fetchAux as any,
    });

    const markDone = (n: number) => {
      const order = db.createOrder(lead.id, service.id, brief);
      db.updateOrder(order.id, { status: 'done', brief, result: `ok ${n}` });
      return db.getOrder(order.id);
    };

    await skills.onOrderUpdated(markDone(1));
    await skills.onOrderUpdated(markDone(2));
    expect(skills.list().some((s) => s.name === 'learned-suppliers')).toBe(false);

    await skills.onOrderUpdated(markDone(3));
    expect(skills.list().find((s) => s.name === 'learned-suppliers')?.status).toBe('draft');
    expect(fetchAux).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'job' && e.stage.includes('learned-suppliers'))).toBe(true);

    await skills.onOrderUpdated(markDone(4));
    expect(fetchAux).toHaveBeenCalledTimes(1);
  });
});
