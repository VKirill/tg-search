// The app's own OpenCode v2: downloaded from the npm registry for this platform into userData, verified (sha512),
// smoke-tested and switched atomically; the previous version stays for rollback. Nothing global is touched — the
// user's own `opencode` (and its data) is never used by the app.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const KEEP_VERSIONS = 2;

export interface RuntimeState {
  current: string | null; // installed version in use
  previous: string | null; // for rollback
  latest: string | null; // last seen in the registry
  checkedAt: number | null;
}

export function platformPackage(platform = process.platform, arch = process.arch): string {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform as string];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error(`OpenCode не поставляется для ${platform}-${arch}`);
  return `@opencode/cli-${os}-${arch}`;
}

export const newer = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

export function createOpencodeRuntime(root: string, fetchFn: typeof fetch = fetch) {
  const versions = join(root, 'versions');
  const stateFile = join(root, 'runtime.json');
  mkdirSync(versions, { recursive: true });
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';

  const readState = (): RuntimeState => {
    try {
      return { current: null, previous: null, latest: null, checkedAt: null, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
    } catch {
      return { current: null, previous: null, latest: null, checkedAt: null };
    }
  };
  const writeState = (s: RuntimeState) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
  const binary = (version: string) => join(versions, version, 'package', 'bin', exe);

  async function latestVersion(): Promise<string> {
    const res = await fetchFn(`${REGISTRY}/@opencode%2fcli/latest`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`npm registry: HTTP ${res.status}`);
    const version = String(((await res.json()) as { version?: string }).version ?? '');
    if (!/^2\./.test(version)) throw new Error(`Неожиданная версия OpenCode: ${version || 'пусто'}`);
    return version;
  }

  async function versionOf(path: string): Promise<string> {
    const { stdout } = await run(path, ['--version'], { timeout: 30_000 });
    return stdout.trim().replace(/^opencode v?/i, '');
  }

  async function install(version: string, onProgress?: (stage: string) => void): Promise<string> {
    if (existsSync(binary(version))) return binary(version);
    const pkg = platformPackage();
    onProgress?.(`Скачиваю OpenCode ${version}`);
    const meta = await fetchFn(`${REGISTRY}/${pkg.replace('/', '%2f')}/${version}`, { signal: AbortSignal.timeout(30_000) });
    if (!meta.ok) throw new Error(`npm registry: HTTP ${meta.status}`);
    const { dist } = (await meta.json()) as { dist: { tarball: string; integrity: string } };
    const tmp = join(root, `download-${version}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const tgz = join(tmp, 'package.tgz');
    const res = await fetchFn(dist.tarball, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Скачивание OpenCode: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tgz));

    onProgress?.('Проверяю подпись архива');
    const [algo, expected] = dist.integrity.split('-');
    const hash = createHash(algo);
    await pipeline(createReadStream(tgz), hash);
    if (hash.digest('base64') !== expected) throw new Error('Архив OpenCode повреждён: контрольная сумма не совпала');

    onProgress?.('Распаковываю');
    await run('tar', ['-xzf', tgz, '-C', tmp, 'package/bin', 'package/package.json'], { timeout: 5 * 60_000 });
    rmSync(tgz, { force: true });
    const bin = join(tmp, 'package', 'bin', exe);
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
    const got = await versionOf(bin);
    if (got !== version) throw new Error(`OpenCode ${version} не запустился (ответил «${got}»)`);
    rmSync(join(versions, version), { recursive: true, force: true });
    renameSync(tmp, join(versions, version));
    return binary(version);
  }

  function prune(state: RuntimeState) {
    const keep = new Set([state.current, state.previous].filter(Boolean) as string[]);
    for (const v of readdirSync(versions)) if (!keep.has(v) && keep.size >= KEEP_VERSIONS) rmSync(join(versions, v), { recursive: true, force: true });
  }

  return {
    state: readState,
    binary: () => {
      const s = readState();
      return s.current && existsSync(binary(s.current)) ? binary(s.current) : null;
    },

    // First run: install the latest v2 when nothing is installed yet
    async ensure(onProgress?: (stage: string) => void): Promise<string> {
      const s = readState();
      if (s.current && existsSync(binary(s.current))) return binary(s.current);
      const latest = await latestVersion();
      const path = await install(latest, onProgress);
      writeState({ ...s, current: latest, latest, checkedAt: Date.now() });
      return path;
    },

    // Daily: a newer v2 is installed beside the current one; activate() switches, rollback() returns
    async checkForUpdate(onProgress?: (stage: string) => void): Promise<string | null> {
      const s = readState();
      const latest = await latestVersion();
      writeState({ ...s, latest, checkedAt: Date.now() });
      if (s.current && !newer(latest, s.current)) return null;
      await install(latest, onProgress);
      return latest;
    },

    activate(version: string) {
      const s = readState();
      if (!existsSync(binary(version))) throw new Error(`OpenCode ${version} не установлен`);
      const next = { ...s, previous: s.current !== version ? s.current : s.previous, current: version };
      writeState(next);
      prune(next);
      return binary(version);
    },

    rollback(): string | null {
      const s = readState();
      if (!s.previous || !existsSync(binary(s.previous))) return null;
      writeState({ ...s, current: s.previous, previous: s.current });
      return binary(s.previous);
    },
  };
}

export type OpencodeRuntime = ReturnType<typeof createOpencodeRuntime>;
