// Dev helper: log a work Telegram account into the app's data without the UI.
// The TDLib session and the account row land in the same place the app uses, so the app picks them up.
//
// Build and run (the app must be closed: TDLib locks its database):
//   npx rolldown scripts/tg-login.ts --platform node --format cjs -e tdl -e prebuilt-tdlib -o tmp/tg-login.cjs
//   node tmp/tg-login.cjs start +34600000000
//   node tmp/tg-login.cjs code +34600000000 12345
//   node tmp/tg-login.cjs password +34600000000 'secret'
//   node tmp/tg-login.cjs status

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/main/db';
import { TdlEngine } from '../src/main/telegram/engine';
import { startLogin, submitCode, submitPassword } from '../src/main/pipeline/accounts';

const dataDir = process.env.TG_SEARCH_DATA ?? join(homedir(), 'Library/Application Support/TG Search');
const db = new Db(join(dataDir, 'tg-search.db'));
const s = db.getSettings();
db.setSettings({
  tgApiId: s.tgApiId || process.env.TG_API_ID || '',
  tgApiHash: s.tgApiHash || process.env.TG_API_HASH || '',
});
const engine = new TdlEngine(join(dataDir, 'tdlib'), () => db.getSettings());
const deps = { db, engine, emit: () => {} };

const [cmd, phoneArg, value] = process.argv.slice(2);
const phone = phoneArg?.replace(/[^\d+]/g, '');
const accountId = () => {
  const acc = db.listAccounts().find((a) => a.phone === phone);
  if (!acc) throw new Error(`no account ${phone}; run start first`);
  return acc.id;
};

async function main() {
  if (cmd === 'start' && phone) return startLogin(deps, phone);
  if (cmd === 'code' && phone && value) return submitCode(deps, accountId(), value);
  if (cmd === 'password' && phone && value) return submitPassword(deps, accountId(), value);
  if (cmd === 'status') return db.listAccounts().map(({ id, phone, status, username, firstName }) => ({ id, phone, status, username, firstName }));
  throw new Error('usage: start <phone> | code <phone> <code> | password <phone> <password> | status');
}

main()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => engine.close());
