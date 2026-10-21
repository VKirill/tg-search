import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_CHARS = 4000;

export function extractDocumentText(path: string): string | null {
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.txt' || ext === '.md') {
      return readFileSync(path, 'utf8').slice(0, MAX_CHARS);
    }
    if (ext === '.pdf') {
      const r = spawnSync('pdftotext', ['-q', '-l', '5', path, '-'], { encoding: 'utf8', maxBuffer: MAX_CHARS * 4 });
      if (r.status !== 0 || !r.stdout?.trim()) return null;
      return r.stdout.slice(0, MAX_CHARS);
    }
  } catch {
    return null;
  }
  return null;
}
