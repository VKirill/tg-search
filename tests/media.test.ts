import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { sendMediaMessage } from '../src/main/pipeline/outreach';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeEngine } from './fakes';

function setup() {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 100, pauseSec: 0 });
  const project = db.createProject({
    name: 'P', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
    geo: [], languages: [], accountIds: [acc.id], materials: [], keywords: [],
  });
  const lead = db.addLead({
    projectId: project.id, sourceId: null, tgChatId: 777, tgMessageId: 0, authorUserId: 777, authorName: 'A',
    authorUsername: null, text: '', date: Date.now(), link: null, score: 90, label: 'demand', reason: '',
  })!;
  const engine = new FakeEngine();
  const deps = { db, engine, emit: () => {} } as never;
  const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/s/slide-${i + 1}.png`, mime: 'image/png' }));
  return { db, engine, deps, lead, photos };
}

describe('text with a set of pictures', () => {
  it('five slides and the text go as one album with the text under it', async () => {
    const { db, engine, deps, lead, photos } = setup();
    await sendMediaMessage(deps, lead.id, '## Карточка\n\nСлайды готовы', photos(5), true);
    expect(engine.albums).toHaveLength(1);
    expect(engine.albums[0].files).toHaveLength(5);
    expect(engine.albums[0].caption).toBe('## Карточка\n\nСлайды готовы');
    const [m] = db.listMessages(lead.id);
    expect(m.text).toMatch(/Слайды готовы\n\[вложения: 5 фото\]/);
  });

  it('more than ten photos make two albums, the text under the first; files are grouped separately', async () => {
    const { engine, deps, lead, photos } = setup();
    await sendMediaMessage(deps, lead.id, 'Готово', [...photos(12), { path: '/s/card.md', mime: 'text/markdown' }], true);
    expect(engine.albums.map((a) => [a.files.length, a.caption])).toEqual([[10, 'Готово'], [2, undefined]]);
    expect(engine.sentFiles.map((f) => [f.kind, f.caption])).toEqual([['document', undefined]]);
  });

  it('a text longer than a caption goes first as its own message', async () => {
    const { engine, deps, lead, photos } = setup();
    const long = 'x'.repeat(1500);
    await sendMediaMessage(deps, lead.id, long, photos(3), true);
    expect(engine.albums[0].caption).toBeUndefined();
    expect(engine.sent.at(-1)?.text).toBe(long);
  });
});
