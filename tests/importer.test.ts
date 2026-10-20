import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { createImporter, parseCsvLinks } from '../src/main/pipeline/importer';
import { FakeEngine, makeChat } from './fakes';

describe('parseCsvLinks', () => {
  it('parses BOM, semicolon, quotes and skips header', () => {
    const csv = '\uFEFF"Ссылка"\n@one;extra\nhttps://t.me/two\n';
    expect(parseCsvLinks(csv)).toEqual(['@one', 'https://t.me/two']);
  });

  it('dedupes and skips blank lines', () => {
    const csv = '@dup\n@dup\n\n@other\n';
    expect(parseCsvLinks(csv)).toEqual(['@dup', '@other']);
  });

  it('accepts joinchat links', () => {
    const csv = 't.me/joinchat/AAAA\n';
    expect(parseCsvLinks(csv)).toEqual(['t.me/joinchat/AAAA']);
  });
});

describe('createImporter', () => {
  let db: Db;
  let engine: FakeEngine;

  beforeEach(() => {
    db = new Db(':memory:');
    engine = new FakeEngine();
    const chat = makeChat(42, 'Import chat');
    engine.chats.set(42, chat);
    const acc = db.upsertAccountByPhone('+1');
    db.updateAccount(acc.id, { status: 'authorized' });
    db.createProject({
      name: 'P',
      task: 'clients',
      target: 't',
      offer: 'o',
      criteria: '',
      geo: [],
      languages: [],
      accountIds: [acc.id],
      materials: [],
      keywords: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records resolve errors as failed', async () => {
    engine.resolveChat = async () => {
      throw new Error('not found');
    };
    const imp = createImporter({ db, engine, emit: () => {} });
    const r = await imp.importCsv(1, '@bad\n');
    expect(r.added).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toContain('not found');
  });

  it('join queue paces joinChat per account', async () => {
    vi.useFakeTimers();
    const notMember = { ...makeChat(55, 'Need join'), isMember: false };
    engine.chats.set(55, notMember);
    let resolveCount = 0;
    engine.resolveChat = async () => {
      resolveCount++;
      return notMember;
    };
    const joins: number[] = [];
    engine.joinChat = async (_acc, chatId) => {
      joins.push(chatId);
    };
    const imp = createImporter({ db, engine, emit: () => {} });
    const p = imp.importCsv(1, '@chat1\n@chat2\n');
    await vi.runAllTimersAsync();
    await p;
    expect(resolveCount).toBe(2);
    expect(joins.length).toBeGreaterThanOrEqual(1);
    imp.stop();
  });
});
