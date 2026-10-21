import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createChannels } from '../src/main/channels';
import { parseFeed } from '../src/main/channels/feeds';
import { FakeEngine, makeMsg } from './fakes';

const CHANNEL = -1009000000001;
const SOURCE = -1009000000002;
const HOUR = 3600_000;

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title><![CDATA[La EMT amplía el servicio nocturno]]></title><link>https://news.example/emt</link>
<description>&lt;p&gt;Desde el lunes, &lt;b&gt;tres líneas&lt;/b&gt; nuevas.&lt;/p&gt;</description>
<pubDate>${new Date(Date.now() - HOUR).toUTCString()}</pubDate><media:content url="https://news.example/emt.jpg"/></item>
<item><title>Noticia de hace un mes</title><link>https://news.example/old</link><description>vieja</description>
<pubDate>${new Date(Date.now() - 30 * 24 * HOUR).toUTCString()}</pubDate></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Feria de julio</title><link href="https://news.example/feria"/>
<summary>Conciertos en la Alameda</summary><updated>2026-10-21T10:00:00Z</updated></entry></feed>`;

describe('feeds', () => {
  it('reads RSS 2.0 (CDATA, HTML description, picture) and Atom', () => {
    const rss = parseFeed(RSS);
    expect(rss[0]).toMatchObject({ title: 'La EMT amplía el servicio nocturno', url: 'https://news.example/emt', image: 'https://news.example/emt.jpg' });
    expect(rss[0].text).toContain('tres líneas');
    expect(rss[0].text).not.toContain('<b>');
    const atom = parseFeed(ATOM);
    expect(atom[0]).toMatchObject({ title: 'Feria de julio', url: 'https://news.example/feria', publishedAt: Date.parse('2026-10-21T10:00:00Z') });
  });
});

function setup(opts: { now?: () => number } = {}) {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+34600000000');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 1, pauseSec: 0 });
  const engine = new FakeEngine();
  engine.resolveMap.set('t.me/city_demo', { chatId: CHANNEL, title: 'Sevilla al día', username: 'city_demo', kind: 'channel', memberCount: 0, description: null, isMember: true, isAdmin: true });
  engine.resolveMap.set('@noticias_city', { chatId: SOURCE, title: 'Noticias City', username: 'noticias_city', kind: 'channel', memberCount: 900, description: null, isMember: false });
  const prompts: string[] = [];
  const channels = createChannels({
    db, engine, dataDir: mkdtempSync(join(tmpdir(), 'channels-')), emit: () => {}, getSettings: () => db.getSettings(),
    llm: async (prompt, { title }) => {
      prompts.push(prompt);
      // a search page → concrete items; a JSON array with text around it, as models write it
      if (title === 'channel-extract') return 'Aquí tienes:\n```json\n[{"title": "2x1 en horchata en Triana", "text": "Solo este fin de semana", "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"}]\n```';
      return '**🌆 Sevilla hoy**\n\n- La EMT amplía el servicio. [Fuente](https://news.example/emt)';
    },
    // «oferta» is a deal; «fútbol» is off-topic for this channel
    score: async (_about, items) => items.map((it) => (/fútbol/i.test(it.title) ? { p: 0.2, kind: 'news' } : /oferta|2x1/i.test(it.title) ? { p: 0.9, kind: 'deal' } : { p: 0.8, kind: 'news' })),
    search: async () => [{ title: 'deals.example', url: 'https://deals.example/', content: 'Las mejores ofertas: 2x1 en horchata en Triana solo este fin de semana, y más planes en la ciudad.' }],
    fetchFn: (async (url: string) => url.includes('grounding-api-redirect')
      ? new Response(null, { status: 302, headers: { location: 'https://deals.example/horchata' } })
      : new Response(url.includes('feed') ? RSS : '<html></html>', { headers: { 'content-type': 'application/rss+xml' } })) as unknown as typeof fetch,
    now: opts.now,
  });
  return { db, engine, channels, acc, prompts };
}

describe('channel assistant', () => {
  it('connects only a channel the account administers', async () => {
    const { channels, engine, acc } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    expect(d).toMatchObject({ chatId: CHANNEL, autopublish: false, slots: [{ time: '09:00', kind: 'digest' }, { time: '19:00', kind: 'deals' }] });
    engine.resolveMap.set('t.me/not_mine', { chatId: -100777, title: 'Чужой', username: 'not_mine', kind: 'channel', memberCount: 1, description: null, isMember: true, isAdmin: false });
    await expect(channels.createDesk(acc.id, 't.me/not_mine')).rejects.toThrow(/администратор/);
    await expect(channels.createDesk(acc.id, '@noticias_city')).resolves.toBeTruthy(); // isAdmin unknown: allowed
  });

  it('creates a new channel owned by the account and connects it; a taken link creates nothing', async () => {
    const { channels, acc } = setup();
    const d = await channels.createChannel(acc.id, { title: 'Sevilla al día', description: 'Noticias', username: 'city_demo_new' });
    expect(d).toMatchObject({ title: 'Sevilla al día', username: 'city_demo_new' });
    await expect(channels.createChannel(acc.id, { title: 'X', description: '', username: 'taken_name' })).rejects.toThrow(/занята/);
    expect(channels.desks()).toHaveLength(1);
  });

  it('collects RSS, search and Telegram sources; old items, duplicates and off-topic ones are left out', async () => {
    const { channels, engine, acc } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveSource({ deskId: d.id, kind: 'rss', title: 'News', target: 'https://news.example/feed', enabled: true, intervalMin: 30 });
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta hoy Sevilla', enabled: true, intervalMin: 180 });
    channels.saveSource({ deskId: d.id, kind: 'telegram', title: 'Noticias City', target: '@noticias_city', enabled: true, intervalMin: 15 });
    engine.setHistory(SOURCE, [
      makeMsg(SOURCE, 1, 'Partido de fútbol esta noche en el estadio: todo lo que hay que saber del Betis y su rival'),
      makeMsg(SOURCE, 2, 'ok'), // too short to be news
      makeMsg(SOURCE, 3, 'La EMT amplía el servicio nocturno\nTres líneas nuevas desde el lunes, con frecuencia cada 20 minutos'),
    ]);
    const [rss, search, tg] = channels.sources(d.id);
    expect(await channels.runSource(rss.id)).toBe(1); // the month-old item is skipped
    expect(await channels.runSource(search.id)).toBe(1);
    expect(await channels.runSource(tg.id)).toBe(1); // the same EMT headline as the RSS item: a duplicate
    expect(await channels.runSource(rss.id)).toBe(0); // read again: nothing new

    const items = channels.items(d.id);
    expect(items.map((i) => [i.title.slice(0, 20), i.kind, i.status])).toEqual(expect.arrayContaining([
      ['La EMT amplía el ser', 'news', 'new'],
      ['2x1 en horchata en T', 'deal', 'new'],
      ['Partido de fútbol es', 'news', 'skipped'],
    ]));
    expect(channels.sources(d.id).find((s) => s.id === tg.id)?.found).toBe(1);
    expect(items.find((i) => i.kind === 'deal')?.url).toBe('https://deals.example/horchata'); // the search's redirect link resolved
  });

  it('a source that fails keeps its error and does not stop the others', async () => {
    const { channels, acc } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveSource({ deskId: d.id, kind: 'rss', title: 'Local', target: 'http://127.0.0.1/feed', enabled: true, intervalMin: 30 });
    const [s] = channels.sources(d.id);
    expect(await channels.runSource(s.id)).toBe(0);
    expect(channels.sources(d.id)[0].lastError).toBeTruthy();
  });

  it('writes a post from the best fresh items in the channel language and publishes it through the limiter', async () => {
    const { channels, engine, acc, prompts, db } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, language: 'español', about: 'noticias y ofertas de Sevilla' });
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    await channels.runSource(channels.sources(d.id)[0].id);

    const p = await channels.compose(d.id, 'deals');
    expect(p.status).toBe('draft');
    expect(prompts.at(-1)).toContain('Язык поста — español');
    expect(prompts.at(-1)).toContain('2x1 en horchata');
    expect(prompts.at(-1)).toContain('Вид поста: deals — «Акции, скидки и события»');
    expect(channels.items(d.id)[0].status).toBe('used');
    await expect(channels.compose(d.id, 'deals')).rejects.toThrow(/Нет свежих/); // used items are not reused

    const before = db.getAccount(acc.id).sentToday;
    const done = await channels.publish(p.id);
    expect(done.status).toBe('published');
    expect(engine.posted.at(-1)).toMatchObject({ chatId: CHANNEL, text: p.text });
    expect(db.getAccount(acc.id).sentToday).toBe(before); // a channel post is not a cold message: no daily cap

    // a rejected draft gives its items back
    const { channels: c2, acc: a2 } = setup();
    const d2 = await c2.createDesk(a2.id, 't.me/city_demo');
    c2.saveSource({ deskId: d2.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    await c2.runSource(c2.sources(d2.id)[0].id);
    c2.rejectPost((await c2.compose(d2.id, 'deals')).id);
    expect(c2.items(d2.id)[0].status).toBe('new');
  });

  it('runs due sources and the slots on the clock: once a day, never more than an hour late', async () => {
    let t = new Date(2026, 9, 21, 18, 59).getTime();
    const { channels, engine, acc } = setup({ now: () => t });
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, autopublish: true, slots: [{ time: '19:00', kind: 'deals' }] });
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });

    await channels.tick(); // reads the source; the slot is not due yet
    expect(channels.items(d.id)).toHaveLength(1);
    expect(engine.posted).toHaveLength(0);
    t += 2 * 60_000; // 19:01
    await channels.tick();
    expect(engine.posted).toHaveLength(1);
    t += 10 * 60_000;
    await channels.tick(); // the same slot again: no second post
    expect(engine.posted).toHaveLength(1);

    // the next day the app starts at 20:30: the 19:00 slot is skipped, not posted late
    t = new Date(2026, 9, 22, 20, 30).getTime();
    await channels.tick();
    expect(engine.posted).toHaveLength(1);
  });
});
