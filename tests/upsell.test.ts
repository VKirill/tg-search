import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { recordAddonOffer, suggestAddons, upsellBlock } from '../src/main/agent/upsell';
import { DEFAULT_MANAGER } from '../src/shared/types';

function setup() {
  const db = new Db(':memory:'); // seeds the default services: homework, marketplace card, images, texts, assistant
  const project = db.createProject({
    name: 'P', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
    geo: [], languages: [], accountIds: [], materials: [], keywords: [],
  });
  let msg = 1;
  const lead = () => db.addLead({
    projectId: project.id, sourceId: null, tgChatId: 1, tgMessageId: msg++, authorUserId: msg, authorName: 'A',
    authorUsername: null, text: 'нужен контент-план', date: Date.now(), link: null, score: 90, label: 'demand', reason: '',
  })!;
  const svc = (kind: string) => db.listServices().find((s) => s.kind === kind)!;
  return { db, lead, svc };
}

describe('upsell', () => {
  it('nothing before a deal; after a content plan — images and posts, with reasons', () => {
    const { db, lead, svc } = setup();
    const l = lead();
    expect(suggestAddons(db, l.id)).toEqual([]);
    db.createOrder(l.id, svc('copywriting').id, 'контент-план на неделю для кофейни');
    const addons = suggestAddons(db, l.id);
    expect(addons.map((a) => a.service.kind)).toEqual(['image_gen', 'copywriting']);
    expect(addons[0].why).toMatch(/обложки/);
    expect(upsellBlock(db, l.id)).toMatch(/offer_addon/);
  });

  it('an offered addon is not pushed again for a month', () => {
    const { db, lead, svc } = setup();
    const l = lead();
    db.createOrder(l.id, svc('copywriting').id, 'план');
    recordAddonOffer(db, l.id, svc('image_gen').id);
    expect(suggestAddons(db, l.id).map((a) => a.service.kind)).toEqual(['copywriting']);
    expect(suggestAddons(db, l.id, Date.now() + 31 * 86400_000).map((a) => a.service.kind)).toContain('image_gen');
  });

  it('what other clients bought next lifts a service', () => {
    const { db, lead, svc } = setup();
    for (let i = 0; i < 4; i++) {
      const other = lead();
      db.createOrder(other.id, svc('marketplace_card').id, 'карточка');
      db.createOrder(other.id, svc('homework').id, 'задачи по экономике для курса продавца');
    }
    const l = lead();
    db.createOrder(l.id, svc('marketplace_card').id, 'карточка крема');
    const addons = suggestAddons(db, l.id);
    expect(addons[0].service.kind).toBe('homework');
    expect(addons[0].why).toMatch(/часто заказывают/);
  });
});
