// Connecting AI assistants to the app: the tg-search skill for Claude Code or Codex, the `tgs` CLI and the `tgs-mcp`
// MCP server. The scripts run on the app's own runtime (ELECTRON_RUN_AS_NODE) — nothing else to install; the MCP server
// is registered in Claude Code (its CLI) or Codex (~/.codex/config.toml); other MCP clients get a config snippet.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiAssistant, AiAssistantsStatus } from '../shared/types';

// a directory copy that also reads from the app bundle's asar archive (plain readdir/readFile, which Electron serves)
function copyDir(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

export function createIntegrations(deps: { appDir: string; execPath: string; home?: string; findCli?: (name: string) => string | null }) {
  const home = deps.home ?? homedir();
  const share = join(home, '.local', 'share', 'tg-search');
  const binDir = join(home, '.local', 'bin');
  const launcher = (name: string) => join(binDir, name);
  const skillDir = (a: AiAssistant) => join(home, a === 'claude' ? '.claude' : '.codex', 'skills', 'tg-search');
  const codexConfig = join(home, '.codex', 'config.toml');

  // the GUI app's PATH lacks the usual tool folders: look there too
  const findCli = deps.findCli ?? ((name: string) => {
    for (const dir of [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin')]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const r = spawnSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  });

  // the scripts and their launchers (shared by every assistant)
  function installTools(): string[] {
    mkdirSync(join(share, 'bin'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    for (const name of ['tgs.mjs', 'tgs-mcp.mjs']) writeFileSync(join(share, 'bin', name), readFileSync(join(deps.appDir, 'bin', name)));
    rmSync(join(share, 'bin', 'skill'), { recursive: true, force: true });
    copyDir(join(deps.appDir, 'skills', 'tg-search'), join(share, 'bin', 'skill')); // the API reference for tgs-mcp
    for (const [cmd, script] of [['tgs', 'tgs.mjs'], ['tgs-mcp', 'tgs-mcp.mjs']]) {
      writeFileSync(launcher(cmd), [
        '#!/bin/sh',
        '# TG Search: runs the bundled script with the app\'s own runtime — no Node.js needed',
        `ELECTRON_RUN_AS_NODE=1 exec "${deps.execPath}" "${join(share, 'bin', script)}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(launcher(cmd), 0o755);
    }
    return [`Команды tgs и tgs-mcp — в ${binDir}`];
  }

  function installSkill(a: AiAssistant): string {
    const dst = skillDir(a);
    const src = join(deps.appDir, 'skills', 'tg-search');
    // a developer's symlink to the repo stays: it is always up to date
    if (existsSync(dst) && lstatSync(dst).isSymbolicLink() && realpathSync(dst) === realpathSync(src)) return `Навык уже связан с ${src}`;
    rmSync(dst, { recursive: true, force: true });
    copyDir(src, dst);
    return `Навык tg-search — в ${dst}`;
  }

  function registerMcp(a: AiAssistant): string {
    if (a === 'codex') {
      const current = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
      const block = `[mcp_servers.tg-search]\ncommand = "${launcher('tgs-mcp')}"\n`;
      if (/^\[mcp_servers\.tg-search\]/m.test(current)) {
        writeFileSync(codexConfig, current.replace(/^\[mcp_servers\.tg-search\][^[]*/m, `${block}\n`));
      } else {
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexConfig, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}`);
      }
      return `MCP-сервер tg-search — в ${codexConfig}`;
    }
    const claude = findCli('claude');
    if (!claude) return `Claude Code не найден: выполните «claude mcp add --scope user tg-search -- ${launcher('tgs-mcp')}» после его установки`;
    spawnSync(claude, ['mcp', 'remove', '--scope', 'user', 'tg-search'], { encoding: 'utf8' });
    const r = spawnSync(claude, ['mcp', 'add', '--scope', 'user', 'tg-search', '--', launcher('tgs-mcp')], { encoding: 'utf8' });
    if (r.status !== 0) return `Не удалось добавить MCP в Claude Code: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    return 'MCP-сервер tg-search добавлен в Claude Code (для всех проектов)';
  }

  return {
    status(): AiAssistantsStatus {
      const codex = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
      return {
        tools: existsSync(launcher('tgs-mcp')),
        claude: { skill: existsSync(join(skillDir('claude'), 'SKILL.md')), cli: !!findCli('claude') },
        codex: { skill: existsSync(join(skillDir('codex'), 'SKILL.md')), cli: !!findCli('codex'), mcp: /^\[mcp_servers\.tg-search\]/m.test(codex) },
        mcpCommand: launcher('tgs-mcp'),
        mcpConfig: JSON.stringify({ mcpServers: { 'tg-search': { command: launcher('tgs-mcp') } } }, null, 2),
      };
    },
    install(a: AiAssistant): string[] {
      return [...installTools(), installSkill(a), registerMcp(a)];
    },
    // other MCP clients (Cursor, Claude Desktop…) need only the launcher
    installTools,
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
