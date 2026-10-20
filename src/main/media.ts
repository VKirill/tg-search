// Local media under `${userData}/media/`.
//
// Renderer playback: use mediaUrlFromPath(absolutePath) → `tgmedia://local/<url-encoded-path>`.
// Call registerMediaProtocol() once before the app is ready (see index.ts).

import { protocol } from 'electron';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const SCHEME = 'tgmedia';

export function mediaDir(dataDir: string): string {
  return join(dataDir, 'media');
}

export function ensureMediaDir(dataDir: string): string {
  const dir = mediaDir(dataDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function storeMediaCopy(dataDir: string, srcPath: string, namePrefix: string): string {
  const dir = ensureMediaDir(dataDir);
  const ext = extname(srcPath) || '.ogg';
  const safe = basename(namePrefix).replace(/[^\w.-]+/g, '_');
  const dest = join(dir, `${safe}-${Date.now()}${ext}`);
  copyFileSync(srcPath, dest);
  return dest;
}

export function mimeToCallExt(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  return 'webm';
}

export function writeCallRecording(
  dataDir: string,
  leadId: number,
  audio: Uint8Array,
  mimeType: string,
): string {
  const dir = ensureMediaDir(dataDir);
  const ext = mimeToCallExt(mimeType);
  const path = join(dir, `call-${leadId}-${Date.now()}.${ext}`);
  writeFileSync(path, audio);
  return path;
}

export function mediaUrlFromPath(filePath: string): string {
  return `${SCHEME}://local/${encodeURIComponent(filePath)}`;
}

export function registerMediaSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

export function registerMediaProtocol(): void {
  protocol.registerFileProtocol(SCHEME, (request, callback) => {
    const prefix = `${SCHEME}://local/`;
    if (!request.url.startsWith(prefix)) {
      callback({ error: -2 });
      return;
    }
    const filePath = decodeURIComponent(request.url.slice(prefix.length));
    callback({ path: filePath });
  });
}
