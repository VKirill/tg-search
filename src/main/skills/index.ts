import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppEvent, Order, Settings, SkillDef } from '../../shared/types';
import type { Db } from '../db';
import { parseSkillMd, serializeSkillMd, validateSkillName } from './frontmatter';
import { EMPTY_SKILLS_STATE, type SkillsState } from './schema';
import { hintSkillsForMessage, type SkillOption } from './jev';
import { learnLessonsFromOrder, maybeLearnSkillFromOrders, type FetchFn } from './learning';
import type { postSystemOne } from '../ai/jev';

const STATE_FILE = '_state.json';

export interface SkillsStore {
  list(): SkillDef[];
  save(skill: Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'>): SkillDef;
  remove(name: string): void;
  approve(name: string): SkillDef;
  loadSkillBody(name: string, leadId?: number): string;
  removeLesson(name: string, index: number): SkillDef;
  activeCatalog(): SkillOption[];
  formatAvailableBlock(): string;
  hintForClientMessage(text: string): Promise<string>;
  onOrderUpdated(order: Order): Promise<void>;
}

export interface CreateSkillsDeps {
  dataDir: string;
  db: Db;
  getSettings: () => Settings;
  emit: (e: AppEvent) => void;
  builtinDir?: string;
  postJev?: typeof postSystemOne;
  embedBrief?: (text: string) => Promise<Float32Array | null>;
  fetchAux?: FetchFn;
}

function resolveBuiltinDir(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = [
    join(process.cwd(), 'skills/agent'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../skills/agent'),
    join(dirname(fileURLToPath(import.meta.url)), '../../skills/agent'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function userSkillsRoot(dataDir: string): string {
  return join(dataDir, 'skills');
}

function skillDir(root: string, name: string): string {
  return join(root, name);
}

function skillPath(root: string, name: string): string {
  return join(skillDir(root, name), 'SKILL.md');
}

function readStateFile(root: string): SkillsState {
  const p = join(root, STATE_FILE);
  if (!existsSync(p)) return { ...EMPTY_SKILLS_STATE };
  try {
    return { ...EMPTY_SKILLS_STATE, ...(JSON.parse(readFileSync(p, 'utf8')) as SkillsState) };
  } catch {
    return { ...EMPTY_SKILLS_STATE };
  }
}

function writeStateFile(root: string, state: SkillsState): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

function listBuiltinNames(builtinDir: string): string[] {
  if (!existsSync(builtinDir)) return [];
  return readdirSync(builtinDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

export function createSkillsStore(deps: CreateSkillsDeps): SkillsStore {
  const userRoot = userSkillsRoot(deps.dataDir);
  const builtinDir = resolveBuiltinDir(deps.builtinDir);

  function loadFromPath(path: string, state: SkillsState, sourceDefault: SkillDef['source']): SkillDef {
    const raw = readFileSync(path, 'utf8');
    const parsed = parseSkillMd(raw);
    const def: SkillDef = {
      ...parsed,
      source: parsed.source === 'owner' && sourceDefault === 'builtin' ? 'builtin' : parsed.source,
      uses: state.uses[parsed.name] ?? 0,
      lessons: (state.lessons[parsed.name] ?? []).map((l) => l.text),
      updatedAt: fileMtime(path),
    };
    return def;
  }

  function list(): SkillDef[] {
    const state = readStateFile(userRoot);
    const byName = new Map<string, SkillDef>();

    for (const name of listBuiltinNames(builtinDir)) {
      const err = validateSkillName(name);
      if (err) continue;
      const p = skillPath(builtinDir, name);
      if (!existsSync(p)) continue;
      try {
        byName.set(name, loadFromPath(p, state, 'builtin'));
      } catch {
        // skip broken builtin
      }
    }

    if (existsSync(userRoot)) {
      for (const ent of readdirSync(userRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('_')) continue;
        const p = skillPath(userRoot, ent.name);
        if (!existsSync(p)) continue;
        try {
          byName.set(ent.name, loadFromPath(p, state, 'owner'));
        } catch {
          // skip broken user skill
        }
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function writeUserSkill(skill: Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'>): SkillDef {
    const err = validateSkillName(skill.name);
    if (err) throw new Error(err);
    const dir = skillDir(userRoot, skill.name);
    mkdirSync(dir, { recursive: true });
    const path = skillPath(userRoot, skill.name);
    writeFileSync(path, serializeSkillMd(skill), 'utf8');
    const state = readStateFile(userRoot);
    const saved: SkillDef = {
      ...skill,
      uses: state.uses[skill.name] ?? 0,
      lessons: (state.lessons[skill.name] ?? []).map((l) => l.text),
      updatedAt: Date.now(),
    };
    return saved;
  }

  return {
    list,

    save(skill) {
      return writeUserSkill(skill);
    },

    remove(name) {
      const err = validateSkillName(name);
      if (err) throw new Error(err);
      const dir = skillDir(userRoot, name);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      const state = readStateFile(userRoot);
      delete state.uses[name];
      writeStateFile(userRoot, state);
    },

    approve(name) {
      const all = list();
      const sk = all.find((s) => s.name === name);
      if (!sk) throw new Error('Умение не найдено');
      if (sk.status !== 'draft') throw new Error('Утвердить можно только черновик');
      return writeUserSkill({ ...sk, status: 'active' });
    },

    loadSkillBody(name, leadId) {
      const sk = list().find((s) => s.name === name);
      if (!sk) throw new Error('Умение не найдено');
      if (sk.status !== 'active') throw new Error('Умение недоступно');
      const userP = skillPath(userRoot, name);
      const builtinP = skillPath(builtinDir, name);
      const path = existsSync(userP) ? userP : builtinP;
      if (!existsSync(path)) throw new Error('Файл умения не найден');
      const state = readStateFile(userRoot);
      state.uses[name] = (state.uses[name] ?? 0) + 1;
      if (leadId != null) {
        const used = state.leadSkills[leadId] ?? [];
        state.leadSkills[leadId] = [name, ...used.filter((n) => n !== name)].slice(0, 3);
      }
      writeStateFile(userRoot, state);
      const body = parseSkillMd(readFileSync(path, 'utf8')).body;
      const lessons = state.lessons[name] ?? [];
      if (!lessons.length) return body;
      return `${body}\n\n## Уроки из прошлых заказов\n\n${lessons.map((l) => `- ${l.text}`).join('\n')}`;
    },

    removeLesson(name, index) {
      const state = readStateFile(userRoot);
      state.lessons[name] = (state.lessons[name] ?? []).filter((_, i) => i !== index);
      writeStateFile(userRoot, state);
      const sk = list().find((s) => s.name === name);
      if (!sk) throw new Error('Умение не найдено');
      return sk;
    },

    activeCatalog() {
      return list()
        .filter((s) => s.status === 'active')
        .map((s) => ({ name: s.name, description: s.description }));
    },

    formatAvailableBlock() {
      const active = this.activeCatalog();
      if (!active.length) return '';
      const lines = active.map((s) => `- ${s.name}: ${s.description}`);
      return `<available_skills>\n${lines.join('\n')}\n</available_skills>`;
    },

    async hintForClientMessage(text) {
      const active = this.activeCatalog();
      const names = await hintSkillsForMessage(deps.getSettings, text, active, 0.35, deps.postJev);
      if (!names.length) return '';
      const labels = names
        .map((n) => active.find((s) => s.name === n))
        .filter(Boolean)
        .map((s) => `${s!.name} — ${s!.description}`);
      return `Скорее всего пригодится: ${labels.join('; ')}`;
    },

    async onOrderUpdated(order) {
      if (order.status !== 'done') return;
      await learnLessonsFromOrder({
        db: deps.db,
        getSettings: deps.getSettings,
        order,
        readState: () => readStateFile(userRoot),
        writeState: (s) => writeStateFile(userRoot, s),
        skillBody: (name) => {
          const sk = list().find((s) => s.name === name && s.status === 'active');
          return sk?.body ?? null;
        },
        fetchAux: deps.fetchAux,
      }).catch((err) => console.error('skill lessons', err));
      const draft = await maybeLearnSkillFromOrders({
        db: deps.db,
        getSettings: deps.getSettings,
        dataDir: deps.dataDir,
        readState: () => readStateFile(userRoot),
        writeState: (s) => writeStateFile(userRoot, s),
        saveDraftFile: (raw) => {
          const parsed = parseSkillMd(raw);
          return writeUserSkill({ ...parsed, status: 'draft', source: 'learned' });
        },
        listActiveSkills: () => this.activeCatalog(),
        embedBrief: deps.embedBrief,
        postJev: deps.postJev,
        fetchAux: deps.fetchAux,
      });
      if (draft) {
        const lead = deps.db.getLead(order.leadId);
        deps.emit({
          type: 'job',
          projectId: lead.projectId,
          stage: `Новое умение на утверждение: ${draft.name}`,
          done: true,
        });
      }
    },
  };
}

export { parseSkillMd, serializeSkillMd, validateSkillName } from './frontmatter';
export { hintSkillsForMessage, skillCoversTask } from './jev';
