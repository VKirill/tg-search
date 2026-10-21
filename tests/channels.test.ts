import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { applyFixes, createChannels, parseIssue, renderIssue, stripLinks } from '../src/main/channels';
import { markdownToBlocks } from '../src/main/telegram/markdown';
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

function setup(opts: { fetchFn?: typeof fetch; now?: () => number; sameStory?: (item: { title: string }, c: { title: string }[]) => Promise<number[]> } = {}) {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+34600000000');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 1, pauseSec: 0 });
  const engine = new FakeEngine();
  engine.resolveMap.set('t.me/city_demo', { chatId: CHANNEL, title: 'Sevilla al día', username: 'city_demo', kind: 'channel', memberCount: 0, description: null, isMember: true, isAdmin: true });
  engine.resolveMap.set('@noticias_city', { chatId: SOURCE, title: 'Noticias City', username: 'noticias_city', kind: 'channel', memberCount: 900, description: null, isMember: false });
  const prompts: string[] = [];
  const editor = () => prompts.filter((x) => x.startsWith('Ты — редактор')).at(-1)!;
  const scored: string[] = [];
  const channels = createChannels({
    db, engine, dataDir: mkdtempSync(join(tmpdir(), 'channels-')), emit: () => {}, getSettings: () => db.getSettings(),
    llm: async (prompt, { title }) => {
      prompts.push(prompt);
      // a search page → concrete items; a JSON array with text around it, as models write it
      if (title === 'channel-factcheck') return '{"fixes": [], "drop": []}';
      if (title === 'channel-cover-prompt') return 'A poster of the city day';
      if (title === 'channel-clone') return JSON.stringify({
        language: 'español', about: 'Málaga for locals', area: 'Málaga and its metropolitan area', editorPrompt: 'Escribe como un vecino de Málaga. 📲 Síguenos: @city_demo',
        coverStyle: 'sunny', queries: [{ kind: 'gnews', title: 'Ayuntamiento', target: '"Ayuntamiento de Málaga"' }, { kind: 'rss', title: 'bad', target: 'x' }],
        feeds: [{ title: 'Diario Málaga', url: 'https://news.example/feed' }, { title: 'Inventada', url: 'https://nope.example/rss' }], pages: [],
      });
      if (title === 'channel-places') return /La EMT/.test(prompt) ? '{"1": {"title": "📍 Ver las 2 paradas", "places": [{"name": "Plaza Nueva", "where": "Plaza Nueva, Sevilla"}, {"name": "Prado de San Sebastián", "where": "Prado de San Sebastián, Sevilla"}]}}' : '{}';
      if (title === 'channel-extract') return 'Aquí tienes:\n```json\n[{"title": "2x1 en horchata en Triana", "text": "Solo este fin de semana", "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"}]\n```';
      // the editor writes the issue as data; a link slipped into a field must not survive
      return JSON.stringify({
        title: 'Sevilla hoy · miércoles 21', lead: 'Lo que importa hoy.',
        sections: [{ title: '📰 La ciudad', items: [{ story: 1, emoji: '🚌', title: 'La EMT amplía el servicio', text: 'Tres líneas nocturnas nuevas. [Fuente](https://news.example/emt)', when: 'desde el lunes', where: 'Plaza Nueva, Sevilla', price: '', tags: ['🆓 gratis'] }] }],
        footer: '📲 Síguenos: @city_demo · vía @other_channel',
      });
    },
    // «oferta» is a deal; «fútbol» is off-topic; «Madrid» is outside the channel's area
    score: async (_desk, items) => (scored.push(...items.map((it) => it.title)), items.map((it) => (
      /fútbol/i.test(it.title) ? { p: 0.2, local: 0.9, kind: 'news', category: 'events.sport', audiences: [] }
        : /Madrid/.test(it.title) ? { p: 0.9, local: 0.1, kind: 'news', category: 'city.transport', audiences: [] }
          : /oferta|2x1/i.test(it.title) ? { p: 0.9, local: 0.9, kind: 'deal', category: 'deals.food', audiences: ['evening', 'weekend'] }
            : /huelga/i.test(it.title) ? { p: 0.9, local: 0.9, kind: 'news', category: 'city.transport', audiences: [], urgent: 0.95 }
              : { p: 0.8, local: 0.9, kind: 'news', category: 'city.transport', audiences: [] }))),
    // one direction per topic: the same story told in other words lands on the same vector
    embed: async (text) => {
      const topic = /EMT|autob[uú]s/i.test(text) ? 0 : /horchata/i.test(text) ? 1 : /Madrid/.test(text) ? 2 : 3 + (text.length % 5);
      const v = new Float32Array(8);
      v[topic] = 1;
      return v;
    },
    search: async () => [{ title: 'deals.example', url: 'https://deals.example/', content: 'Las mejores ofertas: 2x1 en horchata en Triana solo este fin de semana, y más planes en la ciudad.' }],
    fetchFn: opts.fetchFn ?? (async (url: string) => url.includes('grounding-api-redirect')
      ? new Response(null, { status: 302, headers: { location: 'https://deals.example/horchata' } })
      : new Response(url.includes('feed') ? RSS : '<html></html>', { headers: { 'content-type': 'application/rss+xml' } })) as unknown as typeof fetch,
    now: opts.now,
    sameStory: opts.sameStory,
  });
  return { db, engine, channels, acc, prompts, scored, editor };
}

describe('issue layout', () => {
  it('several places of one story fold into a list, each on the map; a lone-emoji tag is dropped', () => {
    const issue = parseIssue(JSON.stringify({
      title: 'T', lead: '', footer: 'F',
      sections: [{ title: 'S', items: [{ emoji: '🏛️', title: 'Open House', text: 'Edificios abiertos.', tags: ['🆓', '🆓 gratis'],
        places: [{ name: 'Finca Roja', where: 'Finca Roja, Valencia' }, { name: 'Parque Gulliver' }], placesTitle: '📍 Ver los 2 edificios' }] }],
    }));
    expect(issue.sections[0].items[0].tags).toEqual(['🆓 gratis']);
    const text = renderIssue(issue, { own: true, username: null });
    expect(text).toContain([
      '<details><summary>📍 Ver los 2 edificios</summary>', '',
      '- [Finca Roja](https://www.google.com/maps/search/?api=1&query=Finca%20Roja%2C%20Valencia)',
      '- [Parque Gulliver](https://www.google.com/maps/search/?api=1&query=Parque%20Gulliver)', '', '</details>',
    ].join('\n'));
    const blocks = markdownToBlocks(text);
    const details = blocks.find((b) => b._ === 'inputPageBlockDetails') as { blocks: { _: string }[]; is_open: boolean };
    expect(details.is_open).toBe(false);
    expect(details.blocks[0]._).toBe('inputPageBlockList');
  });

  it('title, lead as a quote, sections divided, items with tags and a when · where (map) · price line', () => {
    const issue = parseIssue(JSON.stringify({
      title: 'Valencia Hoy · 21 oct', lead: 'Un finde lleno de planes.',
      sections: [
        { title: '📰 La ciudad', items: [{ emoji: '🏗️', title: 'Benimaclet tendrá 1.345 viviendas', text: 'El pleno lo aprueba el viernes.', when: '', where: 'Benimaclet', price: '', tags: [] }] },
        { title: '🎭 Agenda', items: [
          { emoji: '🎶', title: 'Tardeo remember', text: 'Éxitos de los 90.', when: 'sáb 24, 17:00', where: 'Recinto Ágora, Torrent', price: 'gratis con invitación', tags: ['🆓 gratis', '🌙 tarde'] },
          { emoji: '', title: '', text: 'sin título: fuera' },
        ] },
        { title: 'vacía', items: [] },
      ],
      footer: '📲 Síguenos',
    }));
    expect(issue.sections).toHaveLength(2);
    expect(renderIssue(issue, { own: true, username: 'x' })).toBe([
      '## Valencia Hoy · 21 oct', '', '> Un finde lleno de planes.', '', '---', '', '### 📰 La ciudad', '',
      '#### 🏗️ Benimaclet tendrá 1.345 viviendas', '', 'El pleno lo aprueba el viernes.', '*📍 Benimaclet*', '', '---', '', '### 🎭 Agenda', '',
      '#### 🎶 Tardeo remember', '', 'Éxitos de los 90.',
      '*🆓 gratis · 🌙 tarde · 🗓 sáb 24, 17:00 · 📍 [Recinto Ágora, Torrent](https://www.google.com/maps/search/?api=1&query=Recinto%20%C3%81gora%2C%20Torrent) · 💶 gratis con invitación*',
      '', '---', '', '📲 Síguenos',
    ].join('\n'));
  });
});

describe('proofreading', () => {
  it('fixes are applied to the editor\'s issue; an item can be dropped; a section is never lost by rewriting', () => {
    const issue = parseIssue(JSON.stringify({
      title: 'T', lead: '', footer: '📲 Síguenos',
      sections: [
        { title: 'A', items: [{ title: 'Festival', text: 'Conciertos gratis.', price: 'gratis', tags: ['🆓 gratis'] }, { title: 'Inventado', text: 'x' }] },
        { title: 'B', items: [{ title: 'Mercado', text: 'Sábado.' }] },
      ],
    }));
    const fixed = applyFixes(issue, {
      fixes: [{ section: 0, item: 0, field: 'price', value: 'visitas guiadas gratis' }, { section: 0, item: 0, field: 'tags', value: [] }, { section: 9, item: 0, field: 'text', value: 'nope' }, { section: 1, item: 0, field: 'emoji', value: 'x' }],
      drop: [{ section: 0, item: 1 }],
    });
    expect(applyFixes(issue, { fixes: [{ field: 'lead', value: 'Sin adornos.' }] }).lead).toBe('Sin adornos.');
    expect(fixed.sections.map((s) => s.items.map((i) => i.title))).toEqual([['Festival'], ['Mercado']]);
    expect(fixed.sections[0].items[0]).toMatchObject({ price: 'visitas guiadas gratis', tags: [] });
    expect(fixed.footer).toBe('📲 Síguenos');
  });
});

describe('own stories', () => {
  it('a post leaves no way out: links become text, sources and other channels go, the own channel stays', () => {
    const text = [
      '🎃 **Fiesta de la calabaza** — viernes 30, 17:30. [Más info](https://t.me/other/2429)',
      'Entrada 12 € en el [Centro de Arte](https://cah.example/kiefer). Fuente: https://news.example/x',
      'Vía @other_channel',
      '📲 Síguenos: @city_demo',
    ].join('\n');
    expect(stripLinks(text, 'city_demo')).toBe([
      '🎃 **Fiesta de la calabaza** — viernes 30, 17:30.',
      'Entrada 12 € en el Centro de Arte. Fuente:',
      'Vía',
      '📲 Síguenos: @city_demo',
    ].join('\n'));
  });
});

describe('channel assistant', () => {
  it('Google News: the real article address and its paragraphs; a known headline is not fetched again', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.startsWith('https://news.google.com/rss/search')) {
        expect(decodeURIComponent(url)).toContain('q=ofertas Sevilla when:1d');
        expect(url).toContain('hl=es&gl=ES');
        return new Response(`<rss><channel><item><title>Abre un mercado de otoño en Triana - Diario Local</title>
          <link>https://news.google.com/rss/articles/CBMiABC?oc=5</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
      }
      if (url.startsWith('https://news.google.com/rss/articles/CBMiABC')) return new Response('<c-wiz data-n-a-sg="SIG" data-n-a-ts="1792600000"></c-wiz>');
      if (url.includes('batchexecute')) {
        expect(String(init?.body)).toContain('CBMiABC');
        return new Response(')]}\'\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://diario.example/mercado-otono\\",1]",null]]');
      }
      if (url === 'https://diario.example/mercado-otono') {
        return new Response('<nav><p>Menú</p></nav><p>El mercado de otoño abre el sábado en la plaza del Altozano, de 10:00 a 20:00, con 40 puestos de artesanía.</p><p>Aceptamos cookies para mejorar tu experiencia de navegación en nuestra web.</p>', { headers: { 'content-type': 'text/html' } });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const { channels, acc } = setup({ fetchFn });
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveSource({ deskId: d.id, kind: 'gnews', title: 'Google', target: 'ofertas Sevilla', enabled: true, intervalMin: 60 });
    const [src] = channels.sources(d.id);
    expect(await channels.runSource(src.id)).toBe(1);
    const [it] = channels.items(d.id);
    expect(it).toMatchObject({ title: 'Abre un mercado de otoño en Triana', url: 'https://diario.example/mercado-otono' });
    expect(it.text).toBe('El mercado de otoño abre el sábado en la plaza del Altozano, de 10:00 a 20:00, con 40 puestos de artesanía.');
    calls.length = 0;
    expect(await channels.runSource(src.id)).toBe(0);
    expect(calls).toHaveLength(1); // only the search: the headline is known
  });

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

  it('the same story from several sources is one story: Jev scores it once, the feed shows its sources, a post tells it once', async () => {
    const { channels, engine, acc, scored, prompts, editor } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, area: 'Sevilla y su área metropolitana', links: 'none' });
    channels.saveSource({ deskId: d.id, kind: 'rss', title: 'News', target: 'https://news.example/feed', enabled: true, intervalMin: 30 });
    channels.saveSource({ deskId: d.id, kind: 'telegram', title: 'Noticias City', target: '@noticias_city', enabled: true, intervalMin: 15 });
    engine.setHistory(SOURCE, [
      makeMsg(SOURCE, 1, 'Más autobuses por la noche: la EMT suma tres líneas nocturnas desde el lunes, cada 20 minutos'),
      makeMsg(SOURCE, 2, 'Madrid cierra dos estaciones de metro por obras durante todo el mes de noviembre, avisan'),
    ]);
    const [rss, tg] = channels.sources(d.id);
    await channels.runSource(rss.id);
    await channels.runSource(tg.id);

    expect(scored.filter((t) => /EMT|autobuses/i.test(t))).toHaveLength(1); // the Telegram retelling took the RSS story's verdict
    const fits = channels.stories(d.id, 'new', 50);
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({ title: 'La EMT amplía el servicio nocturno', category: 'city.transport' });
    expect(fits[0].items.map((i) => i.sourceTitle)).toEqual(['News', 'Noticias City']);
    expect(channels.stories(d.id, 'skipped', 50).map((s) => s.title)).toContain('Madrid cierra dos estaciones de metro por obras durante todo el mes de noviembre, avisan'); // not our area

    const stats = channels.feedStats(d.id, 1);
    expect(stats).toMatchObject({ items: 3, stories: 2, duplicates: 1, kept: 1 });
    expect(stats.sources.find((s) => s.title === 'Noticias City')).toMatchObject({ items: 2, first: 1, duplicates: 1 });

    const p = await channels.compose(d.id, 'digest');
    const prompt = editor();
    const checker = prompts.find((x) => x.includes('фактчекер'))!;
    expect(checker).toContain('<materials>');
    expect(prompt).toContain('собственные материалы редакции');
    expect(prompt).toContain('География канала: Sevilla');
    expect(prompt.match(/<story /g)).toHaveLength(1);
    expect(prompt.match(/<source /g)).toHaveLength(2);
    expect(prompt).not.toContain('url=');
    expect(p.text.replace(/\]\(https:\/\/www\.google\.com\/maps\/search\/[^)]+\)/g, '')).not.toMatch(/https?:|\]\(|other_channel/); // only map links remain
    expect(p.text).toContain('📍 [Plaza Nueva, Sevilla](https://www.google.com/maps/search/?api=1&query=Plaza%20Nueva%2C%20Sevilla)*');
    expect(channels.stories(d.id, 'used', 50)[0].items).toHaveLength(2); // both tellings are used
    expect(p.text).toContain('<details><summary>📍 Ver las 2 paradas</summary>'); // the places step filled the list the editor skipped
  });

  it('a close neighbour is the same story only if Jev says so', async () => {
    const asked: string[] = [];
    const { channels, engine, acc } = setup({ sameStory: async (item, c) => (asked.push(`${item.title} ~ ${c[0].title}`), c.map(() => (/tres líneas/.test(item.title) ? 0.9 : 0.1))) });
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveSource({ deskId: d.id, kind: 'rss', title: 'News', target: 'https://news.example/feed', enabled: true, intervalMin: 30 });
    channels.saveSource({ deskId: d.id, kind: 'telegram', title: 'Noticias City', target: '@noticias_city', enabled: true, intervalMin: 15 });
    engine.setHistory(SOURCE, [
      makeMsg(SOURCE, 1, 'La EMT sube el precio del bonobús a partir de enero, el abono mensual costará dos euros más'), // same topic, other news
      makeMsg(SOURCE, 2, 'La EMT suma tres líneas nocturnas desde el lunes con autobuses cada 20 minutos por la noche'),
    ]);
    for (const s of channels.sources(d.id)) await channels.runSource(s.id);
    expect(asked).toHaveLength(2);
    const stories = channels.stories(d.id, 'new', 50);
    expect(stories).toHaveLength(2);
    expect(stories.find((s) => s.title === 'La EMT amplía el servicio nocturno')?.items).toHaveLength(2);
  });

  it('a post for an audience takes only stories that suit it', async () => {
    const { channels, acc, editor } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    channels.saveSource({ deskId: d.id, kind: 'rss', title: 'News', target: 'https://news.example/feed', enabled: true, intervalMin: 30 });
    for (const s of channels.sources(d.id)) await channels.runSource(s.id);
    expect(channels.stories(d.id, 'new', 50).find((st) => st.kind === 'deal')?.audiences).toEqual(['evening', 'weekend']);
    expect(channels.feedStats(d.id, 1).byAudience).toEqual({ evening: 1, weekend: 1 });
    await expect(channels.compose(d.id, 'digest', undefined, { audiences: ['kids'] })).rejects.toThrow(/Нет свежих/);
    await channels.compose(d.id, 'digest', undefined, { audiences: ['evening'] });
    expect(editor()).toContain('для аудитории: Куда сходить вечером');
    expect(editor()).toContain('2x1 en horchata');
    expect(editor()).not.toContain('La EMT');
  });

  it('the calendar: a slot prepared in advance is published at its time, once; past slots without a post are missed', async () => {
    let t = new Date(2026, 9, 21, 12, 0).getTime();
    const { channels, engine, acc } = setup({ now: () => t });
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, autopublish: false, slots: [{ time: '09:00', kind: 'digest' }, { time: '19:00', kind: 'deals' }] });
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    await channels.runSource(channels.sources(d.id)[0].id);

    let cal = channels.calendar(d.id, 0, 1);
    expect(cal.map((e) => [new Date(e.at).getHours(), e.state, e.ready])).toEqual([[9, 'missed', null], [19, 'planned', 1], [9, 'planned', 1], [19, 'planned', 1]]);

    // the owner prepares tonight's post now: it waits as a scheduled draft
    const key = cal[1].slotKey!;
    const p = await channels.compose(d.id, 'deals', undefined, { slotKey: key, scheduledAt: cal[1].at });
    cal = channels.calendar(d.id, 0, 0);
    expect(cal[1]).toMatchObject({ state: 'scheduled', post: { id: p.id } });

    t = cal[1].at + 60_000;
    await channels.tick();
    await channels.tick();
    expect(engine.posted).toHaveLength(1); // the prepared post, not a second one written by the slot
    expect(channels.calendar(d.id, 0, 0)[1]).toMatchObject({ state: 'published', post: { id: p.id } });

    // a draft scheduled by hand for later
    const q = await channels.compose(d.id, 'top', undefined, {}).catch(() => null);
    expect(q).toBeNull(); // nothing fresh left for it
  });

  it('an urgent story goes out at once as a short post without a cover — not at night, a few a day', async () => {
    let t = new Date(2026, 9, 21, 8, 0).getTime();
    const { channels, engine, acc, editor } = setup({ now: () => t });
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, alerts: true, autopublish: true, slots: [] });
    channels.saveSource({ deskId: d.id, kind: 'telegram', title: 'Noticias City', target: '@noticias_city', enabled: true, intervalMin: 15 });
    const [src] = channels.sources(d.id);
    engine.setHistory(SOURCE, [makeMsg(SOURCE, 1, 'Huelga de metro mañana: la línea 3 no circulará de 7:00 a 10:00, habrá autobuses de sustitución', { date: t })]);
    await channels.runSource(src.id);
    expect(engine.posted).toHaveLength(1);
    const alert = channels.posts(d.id, 5)[0];
    expect(alert).toMatchObject({ kind: 'alert', status: 'published', image: null });
    expect(editor()).toContain('срочное сообщение');
    // at night it waits
    t = new Date(2026, 9, 21, 23, 30).getTime();
    engine.setHistory(SOURCE, [makeMsg(SOURCE, 2, 'Huelga de autobuses nocturnos esta noche: sin servicio en tres líneas hasta las 6:00 de la mañana', { date: t })]);
    await channels.runSource(src.id);
    expect(engine.posted).toHaveLength(1);
  });

  it('a slot with days runs only on them, in the calendar and on the clock', async () => {
    let t = new Date(2026, 9, 21, 18, 59).getTime(); // a Wednesday
    const { channels, engine, acc } = setup({ now: () => t });
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, autopublish: true, slots: [{ time: '19:00', kind: 'deals', days: [4] }] }); // Thursdays
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    await channels.runSource(channels.sources(d.id)[0].id);
    expect(channels.calendar(d.id, 0, 6).map((e) => new Date(e.at).getDay())).toEqual([4]);
    t += 2 * 60_000;
    await channels.tick();
    expect(engine.posted).toHaveLength(0); // Wednesday: no
    t = new Date(2026, 9, 22, 19, 1).getTime();
    await channels.tick();
    expect(engine.posted).toHaveLength(1); // Thursday: yes
  });

  it('the same desk for another city: structure copied, texts rewritten, only feeds that answer are kept', async () => {
    const { channels, engine, acc } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, alerts: true, slots: [{ time: '19:00', kind: 'deals', days: [4], audiences: ['weekend'] }] });
    channels.saveSource({ deskId: d.id, kind: 'gnews', title: 'Ayuntamiento', target: '"Ayuntamiento de Sevilla"', enabled: true, intervalMin: 60 });
    engine.resolveMap.set('t.me/malaga_demo', { chatId: -1009000000077, title: 'Málaga hoy', username: 'malaga_demo', kind: 'channel', memberCount: 0, description: null, isMember: true, isAdmin: true });
    const r = await channels.cloneForCity(d.id, acc.id, 'Málaga', { link: 't.me/malaga_demo' });
    expect(r.desk).toMatchObject({ title: 'Málaga hoy', area: 'Málaga and its metropolitan area', alerts: true, autopublish: false, slots: [{ time: '19:00', kind: 'deals', days: [4], audiences: ['weekend'] }] });
    expect(r.desk.editorPrompt).toContain('@malaga_demo'); // the new channel's own name, not the source's
    expect(channels.sources(r.desk.id).map((x) => `${x.kind}:${x.title}`)).toEqual(['gnews:Ayuntamiento', 'rss:Diario Málaga']);
    expect(r.rejected).toEqual(['https://nope.example/rss']);
  });

  it('a slot made of chosen rubrics takes only their stories', async () => {
    const { channels, engine, acc, editor } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    channels.saveSource({ deskId: d.id, kind: 'rss', title: 'News', target: 'https://news.example/feed', enabled: true, intervalMin: 30 });
    for (const s of channels.sources(d.id)) await channels.runSource(s.id);
    await channels.compose(d.id, 'digest', undefined, { categories: ['deals'] });
    expect(editor()).toContain('2x1 en horchata');
    expect(editor()).not.toContain('La EMT');
    expect(editor()).toContain('рубрики: Акции и скидки');
    void engine;
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
    const { channels, engine, acc, editor, db } = setup();
    const d = await channels.createDesk(acc.id, 't.me/city_demo');
    channels.saveDesk({ ...d, language: 'español', about: 'noticias y ofertas de Sevilla' });
    channels.saveSource({ deskId: d.id, kind: 'search', title: 'Ofertas', target: 'oferta', enabled: true, intervalMin: 180 });
    await channels.runSource(channels.sources(d.id)[0].id);

    const p = await channels.compose(d.id, 'deals');
    expect(p.status).toBe('draft');
    expect(editor()).toContain('Язык всех текстов — español');
    expect(editor()).toContain('2x1 en horchata');
    expect(editor()).toContain('Вид поста: deals — «Акции, скидки и события»');
    expect(channels.items(d.id)[0].status).toBe('used');
    await expect(channels.compose(d.id, 'deals')).rejects.toThrow(/Нет свежих/); // used items are not reused

    const before = db.getAccount(acc.id).sentToday;
    const done = await channels.publish(p.id);
    expect(done.status).toBe('published');
    expect(engine.posted.at(-1)).toMatchObject({ chatId: CHANNEL, text: p.text });
    expect(db.getAccount(acc.id).sentToday).toBe(before); // a channel post is not a cold message: no daily cap

    // taken down: deleted from the channel, the stories back in work
    const down = await channels.unpublish(p.id);
    expect(down.status).toBe('rejected');
    expect(engine.deleted.at(-1)).toBe(done.messageId);
    expect(channels.items(d.id)[0].status).toBe('new');

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
