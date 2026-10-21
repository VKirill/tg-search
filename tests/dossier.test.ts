import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import { DEFAULT_MANAGER } from '../src/shared/types';
import type { ChatMessage, Lead, Order } from '../src/shared/types';
import {
  asciiSlug,
  clientDirName,
  createDossier,
  formatMessageHistoryLine,
  formatOrderHistoryLine,
  parseProfileFrontMatter,
  resolveClientDir,
  writeOrderMarkdown,
} from '../src/main/dossier';

function setupDb() {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized' });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 'йога',
    offer: 'сайты',
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
    authorUserId: 500,
    authorName: 'Anna Yoga',
    authorUsername: 'anna_yoga',
    text: 'Нужен сайт',
    date: Date.parse('2026-10-21T12:00:00+03:00'),
    link: null,
    score: 90,
    label: 'demand',
    reason: '',
  })!;
  return { db, lead, project };
}

function msg(lead: Lead, patch: Partial<ChatMessage> & Pick<ChatMessage, 'text'>): ChatMessage {
  return {
    id: patch.id ?? 1,
    leadId: lead.id,
    accountId: null,
    direction: patch.direction ?? 'in',
    where: 'dm',
    kind: patch.kind ?? 'text',
    text: patch.text,
    mediaPath: patch.mediaPath ?? null,
    durationSec: patch.durationSec ?? null,
    tgChatId: lead.tgChatId,
    tgMessageId: patch.tgMessageId ?? 1,
    date: patch.date ?? Date.parse('2026-10-21T14:03:00+03:00'),
    auto: patch.auto ?? false,
  };
}

describe('dossier helpers', () => {
  it('builds ASCII slug and stable folder name', () => {
    const lead = { authorName: 'Anna Yoga', authorUsername: 'anna_yoga' };
    expect(asciiSlug(lead)).toBe('anna-yoga');
    expect(clientDirName(42, lead)).toBe('42-anna-yoga');
    expect(asciiSlug({ authorName: 'Анна', authorUsername: null })).toBe('client');
  });

  it('resolves existing folder by lead id prefix when name changes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-dossier-'));
    const clients = join(dataDir, 'clients');
    mkdirSync(join(clients, '5-old-slug'), { recursive: true });
    const lead = {
      id: 5,
      authorName: 'New Name',
      authorUsername: 'new',
    } as Lead;
    expect(resolveClientDir(dataDir, 5, lead)).toBe(join(clients, '5-old-slug'));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('formats history lines', () => {
    const lead = { tgChatId: 1 } as Lead;
    const text = formatMessageHistoryLine(msg(lead, { text: 'Привет', direction: 'in' }));
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} · Клиент · Привет/);
    const voice = formatMessageHistoryLine(
      msg(lead, { kind: 'voice', durationSec: 14, text: 'текст голосового', direction: 'in' }),
    );
    expect(voice).toContain('🎙 голосовое 0:14');
    const ai = formatMessageHistoryLine(msg(lead, { direction: 'out', auto: true, text: 'Ответ' }));
    expect(ai).toContain('ИИ-менеджер');
    const note = formatMessageHistoryLine(msg(lead, { kind: 'note', direction: 'out', text: 'секрет' }));
    expect(note).toContain('Заметка');
  });
});

describe('createDossier', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-dossier-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('appends history and writes order.md', () => {
    const { db, lead } = setupDb();
    const fetchFn = vi.fn();
    const dossier = createDossier({ db, dataDir, settings: () => db.getSettings(), fetchFn });
    dossier.onMessage(msg(lead, { text: 'Хочу сайт' }));
    const dir = dossier.path(lead.id);
    const history = readFileSync(join(dir, 'history.md'), 'utf8');
    expect(history).toContain('Клиент · Хочу сайт');

    const service = db.createService({
      kind: 'copywriting',
      name: 'Сайт под ключ',
      categoryId: null,
      enabled: true,
      priceMin: 1000,
      priceMax: 5000,
      instructions: '',
      model: '',
      previewEnabled: false,
      revisions: 1,
    });
    const order: Order = db.createOrder(lead.id, service.id, 'Лендинг для студии');
    const withPrice = db.updateOrder(order.id, { status: 'quoted', price: 25000 });
    dossier.onOrder(withPrice);

    const orderMd = readFileSync(join(dir, 'orders', String(order.id), 'order.md'), 'utf8');
    expect(orderMd).toContain('Сайт под ключ');
    expect(orderMd).toContain('25000 ₽');
    expect(history + readFileSync(join(dir, 'history.md'), 'utf8')).toMatch(/Заказ #/);
    dossier.stop();
  });

  it('logs handoff changes', () => {
    const { db, lead } = setupDb();
    const dossier = createDossier({ db, dataDir, settings: () => db.getSettings() });
    dossier.onLeadUpdate(lead);
    const updated = db.updateLead(lead.id, { handoff: true, handoffReason: 'Клиент просит цену' });
    dossier.onLeadUpdate(updated);
    const history = readFileSync(join(dossier.path(lead.id), 'history.md'), 'utf8');
    expect(history).toContain('Передача · Клиент просит цену');
    dossier.stop();
  });

  it('debounces profile refresh and writes front matter', async () => {
    const { db, lead } = setupDb();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '## Кто клиент\n\nСтудия йоги.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    });
    const auxSettings = () => ({ ...db.getSettings(), auxApiKey: 'test-key' });
    const dossier = createDossier({ db, dataDir, settings: auxSettings, fetchFn });
    dossier.onMessage(msg(lead, { text: 'msg1' }));
    dossier.onMessage(msg(lead, { id: 2, text: 'msg2' }));
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const body = readFileSync(join(dossier.path(lead.id), 'profile.md'), 'utf8');
    const fm = parseProfileFrontMatter(body);
    expect(fm.leadId).toBe(String(lead.id));
    expect(fm.stage).toBe('new');
    expect(body).toContain('## Кто клиент');
    const call = fetchFn.mock.calls[0];
    expect(JSON.parse(call[1].body).stream).toBe(false);
    dossier.stop();
  });

  it('keeps previous profile when aux fails', async () => {
    const { db, lead } = setupDb();
    const dir = resolveClientDir(dataDir, lead.id, lead);
    writeFileSync(join(dir, 'profile.md'), '---\nleadId: 1\n---\n\nСтарое досье\n', 'utf8');
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
    const auxSettings = () => ({ ...db.getSettings(), auxApiKey: 'test-key' });
    const dossier = createDossier({ db, dataDir, settings: auxSettings, fetchFn });
    await dossier.refreshProfile(lead.id);
    expect(readFileSync(join(dir, 'profile.md'), 'utf8')).toContain('Старое досье');
    dossier.stop();
  });
});

describe('formatOrderHistoryLine', () => {
  it('shows status transition', () => {
    const order = {
      id: 3,
      status: 'paid' as const,
      updatedAt: Date.parse('2026-10-21T15:00:00+03:00'),
    } as Order;
    expect(formatOrderHistoryLine(order, 'awaiting_payment')).toContain('ожидает оплаты → оплачен');
  });
});

describe.skipIf(!process.env.NINEROUTER_API_KEY)('live aux profile', () => {
  it(
    'generates profile.md for yoga studio dialog',
    async () => {
      vi.useRealTimers();
      const dataDir = mkdtempSync(join(tmpdir(), 'tg-dossier-live-'));
      const { db, lead } = setupDb();
      db.updateCard(lead.id, {
        stage: 'discovery',
        summary: 'Клиентка хочет сайт студии йоги с онлайн-записью.',
        anamnesis: {
          task: 'Сайт для студии йоги',
          goal: 'запись на занятия онлайн',
          audience: 'женщины 25–45, Москва',
          features: ['расписание', 'онлайн-оплата', 'блог'],
          integrations: ['ЮKassa'],
          stack: [],
          deadline: 'к концу ноября',
          budget: 'до 80 тыс ₽',
          references: ['https://example-yoga.ru'],
          contacts: '',
          openQuestions: ['нужен ли личный кабинет тренера?'],
        },
        completeness: 65,
      });
      const dialog = [
        { direction: 'in' as const, text: 'Здравствуйте! Ищу, кто сделает сайт для студии йоги.' },
        { direction: 'out' as const, text: 'Здравствуйте! Я помощник Кирилла. Расскажите, что уже есть — студия работает?' },
        { direction: 'in' as const, text: 'Да, два зала в Бутово, ведём Instagram @yoga_butovo.' },
        { direction: 'out' as const, text: 'Какие функции на сайте важны в первую очередь?' },
        { direction: 'in' as const, text: 'Расписание, запись и оплата картой. Ещё блог с советами.' },
        { direction: 'out' as const, text: 'Есть примеры сайтов, которые нравятся?' },
        { direction: 'in' as const, text: 'Нравится example-yoga.ru — чисто и просто.' },
        { direction: 'in' as const, text: 'Бюджет пока до 80 тысяч, запуск к концу ноября.' },
      ];
      const dossier = createDossier({
        db,
        dataDir,
        settings: () => ({ ...db.getSettings(), auxApiKey: process.env.NINEROUTER_API_KEY! }),
      });
      const base = Date.parse('2026-10-20T10:00:00+03:00');
      dialog.forEach((line, i) => {
        dossier.onMessage(
          msg(lead, {
            id: i + 1,
            direction: line.direction,
            text: line.text,
            date: base + i * 3600_000,
            auto: line.direction === 'out',
          }),
        );
      });
      await dossier.refreshProfile(lead.id);
      const profile = readFileSync(join(dossier.path(lead.id), 'profile.md'), 'utf8');
      expect(profile).toContain('leadId:');
      expect(profile).toContain('## Кто клиент');
      dossier.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
    120_000,
  );
});
