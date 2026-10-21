<!-- bb-project-folders:agents:start -->
# Section rules

User instructions take priority. Read the project AGENTS.md and parent sections first — their rules apply alongside these.

## Think before coding
- Don't assume silently: state assumptions; when unclear, ask.
- If a task has multiple interpretations, present the options and tradeoffs — don't pick silently.
- Prefer the simple path; if the request leads to overengineering, push back with a simpler proposal.

## Minimum and surgical changes
- Minimum code that solves the task: nothing speculative, no single-use abstractions, no error handling for impossible cases.
- Touch only what the task requires: don't "improve" adjacent code, comments or formatting; match the existing style.
- Remove only what your change made unused; mention other suspicious code instead of deleting it.
- Every changed line must trace back to the user request.

## Success criteria and verification
- Before writing, decide how you will verify the result: a test, a command, a scenario.
- "Fix the bug" means a reproducing check first, then the fix and a green result.
- Drive multi-step work as a "step → verify" list; a task is done when the original problem is verified, not when it "should work".
- If the change affects a running service, deploy and restart it so the result goes live, then check the fix on the running instance.

## Files and autonomy
- Keep the section root for real work (code, documents); everything temporary lives in its folder — artifacts/, notes/, tmp/ or a named subfolder.
- Chat files go to .bb/chats/<chat id>/: reports in artifacts/, notes and handoff in notes/, throwaway work in tmp/.
- Never edit thread.json or history/ — BB owns them.
- Inside the task scope decide yourself: don't ask what you can look up in the repository or docs.
<!-- bb-project-folders:agents:end -->

# Project: TG Search

Desktop macOS app that finds and qualifies Telegram leads. Passport: [docs/project.md](docs/project.md), decisions: [docs/decisions.md](docs/decisions.md).

## Commands
- `npm run dev` — Electron with hot reload; `npm run build` — build into `out/`
- `npm run typecheck` — must pass before every commit
- `npm test` — Vitest, tests live in `tests/**/*.test.ts`

## Rules
- Contracts are `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/telegram/types.ts`, `src/main/ai/types.ts`. Workers do not change them; if a change is needed, explain it in the final report.
- Main process code never imports from `src/renderer`; renderer talks to main only through `window.api`.
- Use only latest package versions; Node built-ins over new dependencies (`node:sqlite`, `fetch`).
- No secrets in the repo (it is public). Settings live in SQLite in userData; `.env` only for development.
- Every outgoing Telegram message goes through the per-account limiter (daily limit + pause).
- UI text is Russian; code, comments and commits are English.
- Every user-visible change adds a line to `CHANGELOG.md` (Добавлено / Изменено / Исправлено, newest date on top) in the same commit; README follows when a feature changes.
- Features are described generically. How the owner uses them (which chats, accounts, links, chat designs) never goes into the repo — only into local settings or chat notes under `.bb/`.
