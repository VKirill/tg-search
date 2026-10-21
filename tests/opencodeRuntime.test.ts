import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpencodeRuntime, newer, platformPackage } from '../src/main/opencode/runtime';

describe('opencode runtime', () => {
  it('picks the platform package and compares versions', () => {
    expect(platformPackage('darwin', 'arm64')).toBe('@opencode/cli-darwin-arm64');
    expect(platformPackage('win32', 'x64')).toBe('@opencode/cli-windows-x64');
    expect(() => platformPackage('sunos', 'x64')).toThrow();
    expect(newer('2.1.3', '2.1.2')).toBe(true);
    expect(newer('2.10.0', '2.9.9')).toBe(true);
    expect(newer('2.1.2', '2.1.2')).toBe(false);
  });

  it('refuses a v1 «latest» and keeps state when nothing is installed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-rt-'));
    const fakeFetch = (async () => new Response(JSON.stringify({ version: '1.18.30' }))) as typeof fetch;
    const rt = createOpencodeRuntime(root, fakeFetch);
    await expect(rt.ensure()).rejects.toThrow(/Неожиданная версия/);
    expect(rt.binary()).toBeNull();
    expect(rt.rollback()).toBeNull();
  });
});
