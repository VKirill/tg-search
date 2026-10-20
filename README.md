# TG Search

Desktop app (macOS) that finds leads in Telegram: clients, partners, investors, jobs and announcements.
It works on Telegram's own search engine (TDLib) from your work accounts. AI qualifies every message,
and an optional autopilot keeps the source list fresh and answers leads within per-account limits.

```
Projects ─▶ Leads (AI score, 👍/👎) ─▶ Dialog (DM or reply in chat)
```

## How it works

1. **Project**: who you are looking for and what you offer. AI turns it into search phrases.
2. **Sources**: public chats and channels found through Telegram search (`searchPublicChats`,
   `searchPublicPosts`, `searchMessages`), rated by AI, up to N active ones.
3. **Scan**: new messages from active sources within the freshness window, qualified by AI in batches.
   Your 👍/👎 become examples for later qualification.
4. **Reply**: AI draft or full autopilot to DM or the chat, with a daily limit and pauses per account.

## Run

```sh
npm install
npm run dev        # Electron with hot reload
npm test           # vitest
npm run typecheck
npm run dist       # .dmg into release/
```

On first start open Settings: Telegram `api_id`/`api_hash` (my.telegram.org) and an OpenAI-compatible LLM
endpoint (OpenRouter by default, model `anthropic/claude-haiku-5.5`). Then add a work account in Accounts.

Data (SQLite database, TDLib sessions) lives in `~/Library/Application Support/TG Search/`.

## Stack

Electron 44 · electron-vite 6 · React 19 · TypeScript 7 · TDLib 1.8.67 via `tdl` + `prebuilt-tdlib` · `node:sqlite` · Vitest 5.

> Use work accounts and keep limits conservative: unsolicited mass messaging gets accounts restricted by Telegram.
