import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIntegrations } from '../src/main/integrations';

const ROOT = join(__dirname, '..');

describe('AI assistants', () => {
  it('Codex: the skill, the commands on the app\'s runtime and the MCP server in config.toml; the server answers', () => {
    const home = mkdtempSync(join(tmpdir(), 'assist-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-6-sol"\n');
    const it = createIntegrations({ appDir: ROOT, execPath: process.execPath, home, findCli: () => null });
    const report = it.install('codex');
    expect(report.join('\n')).toContain('config.toml');
    expect(existsSync(join(home, '.codex/skills/tg-search/SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.codex/skills/tg-search/references/api.md'))).toBe(true);
    const config = readFileSync(join(home, '.codex/config.toml'), 'utf8');
    expect(config).toContain('model = "gpt-6-sol"');
    expect(config).toContain(`[mcp_servers.tg-search]\ncommand = "${join(home, '.local/bin/tgs-mcp')}"`);
    it.install('codex'); // again: the block is replaced, not duplicated
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8').match(/mcp_servers\.tg-search/g)).toHaveLength(1);
    expect(readFileSync(join(home, '.local/bin/tgs-mcp'), 'utf8')).toContain(`ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}"`);

    // the launcher runs the MCP server: it answers the handshake and lists its tools
    const out = execFileSync(join(home, '.local/bin/tgs-mcp'), {
      input: [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'describe', arguments: { namespace: 'helper' } } }),
      ].join('\n') + '\n',
      encoding: 'utf8', env: { ...process.env, HOME: home, TG_SEARCH_DATA: join(home, 'none') }, timeout: 15_000,
    });
    const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe('tg-search');
    expect(msgs.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(['status', 'describe', 'call', 'events']);
    expect(msgs.find((m) => m.id === 3).result.content[0].text).toContain('saveScenario');
    expect(it.status()).toMatchObject({ tools: true, codex: { skill: true, mcp: true } });
  });

  it('Claude Code: without its CLI the report says how to add the server; a developer\'s symlink to the repo stays', () => {
    const home = mkdtempSync(join(tmpdir(), 'assist-'));
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(join(ROOT, 'skills/tg-search'), join(home, '.claude/skills/tg-search'));
    const it = createIntegrations({ appDir: ROOT, execPath: process.execPath, home, findCli: () => null });
    const report = it.install('claude');
    expect(report.join('\n')).toContain('claude mcp add --scope user tg-search');
    expect(lstatSync(join(home, '.claude/skills/tg-search')).isSymbolicLink()).toBe(true);
  });
});
