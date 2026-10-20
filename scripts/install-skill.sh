#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SRC="$ROOT/skills/tg-search"
SKILL_DST="${HOME}/.claude/skills/tg-search"
CLI_SRC="$ROOT/bin/tgs.mjs"
CLI_DST="${HOME}/.local/bin/tgs"

mkdir -p "${HOME}/.claude/skills" "${HOME}/.local/bin"

if [[ -L "$SKILL_DST" || -e "$SKILL_DST" ]]; then
  rm -rf "$SKILL_DST"
fi
ln -s "$SKILL_SRC" "$SKILL_DST"
echo "Linked skill: $SKILL_DST -> $SKILL_SRC"

if [[ -L "$CLI_DST" || -e "$CLI_DST" ]]; then
  rm -f "$CLI_DST"
fi
ln -s "$CLI_SRC" "$CLI_DST"
chmod +x "$CLI_SRC"
echo "Linked CLI: $CLI_DST -> $CLI_SRC"
echo "Ensure ~/.local/bin is on your PATH."
