#!/usr/bin/env bash
# From the source tree: links the tg-search skill for Claude Code (and Codex, if installed), the tgs CLI and the tgs-mcp
# MCP server. Users of the packaged app do the same with «Настройки → ИИ-ассистенты».
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SRC="$ROOT/skills/tg-search"
mkdir -p "${HOME}/.local/bin"

link() { # link <source> <destination>
  if [[ -L "$2" || -e "$2" ]]; then rm -rf "$2"; fi
  ln -s "$1" "$2"
  echo "Linked: $2 -> $1"
}

mkdir -p "${HOME}/.claude/skills"
link "$SKILL_SRC" "${HOME}/.claude/skills/tg-search"
if [[ -d "${HOME}/.codex" ]]; then
  mkdir -p "${HOME}/.codex/skills"
  link "$SKILL_SRC" "${HOME}/.codex/skills/tg-search"
fi

chmod +x "$ROOT/bin/tgs.mjs" "$ROOT/bin/tgs-mcp.mjs"
link "$ROOT/bin/tgs.mjs" "${HOME}/.local/bin/tgs"
link "$ROOT/bin/tgs-mcp.mjs" "${HOME}/.local/bin/tgs-mcp"

echo
echo "MCP server — add it to your assistant:"
echo "  Claude Code:  claude mcp add --scope user tg-search -- ${HOME}/.local/bin/tgs-mcp"
echo "  Codex:        add to ~/.codex/config.toml:"
echo "                [mcp_servers.tg-search]"
echo "                command = \"${HOME}/.local/bin/tgs-mcp\""
echo "Ensure ~/.local/bin is on your PATH."
