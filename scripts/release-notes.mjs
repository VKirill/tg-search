#!/usr/bin/env node
// The GitHub Release text: how to install the unsigned app and what is new (the newest CHANGELOG section)
import { readFileSync } from 'node:fs';

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const sections = changelog.split(/\n(?=## )/).slice(1);
const latest = (sections[0] ?? '').replace(/\n---\s*$/, '').trim();

console.log(`## Установка

1. Скачайте файл под свой Mac: **arm64** — Apple Silicon (M1–M5), **x64** — Intel.
2. Откройте \`.dmg\` и перетащите **TG Search** в «Программы».
3. Приложение не подписано сертификатом Apple, поэтому при первом запуске macOS его остановит. Откройте его правой кнопкой → «Открыть» → «Открыть»,
   или выполните в Терминале: \`xattr -cr "/Applications/TG Search.app"\`.
4. В приложении: Настройки → Telegram (api_id и api_hash с my.telegram.org), Аккаунты → вход в рабочий аккаунт. ИИ-движок OpenCode приложение поставит само.
5. Чтобы настраивать приложение из Claude Code или Codex: Настройки → ИИ-ассистенты → «Подключить».

Подробно — в [README](https://github.com/VKirill/tg-search#readme).

${latest}
`);
