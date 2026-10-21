import { createHash } from 'node:crypto';
import { normalizeMessageText } from './normalize';

export const MIN_NEAR_LEN = 20;
export const MAX_HAMMING = 3;

export interface TextFingerprint {
  normalized: string;
  exactHash: string;
  simhash: bigint;
  len: number;
}

export function fingerprintText(raw: string): TextFingerprint {
  const { text: normalized } = normalizeMessageText(raw);
  const exactHash = createHash('sha256').update(normalized).digest('hex');
  const simhash = computeSimhash(normalized);
  return { normalized, exactHash, simhash, len: normalized.length };
}

function computeSimhash(normalized: string): bigint {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  let shingles: string[];
  if (tokens.length >= 3) {
    shingles = [];
    for (let i = 0; i <= tokens.length - 3; i++) {
      shingles.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  } else if (normalized.length >= 4) {
    shingles = [];
    for (let i = 0; i <= normalized.length - 4; i++) {
      shingles.push(normalized.slice(i, i + 4));
    }
  } else {
    shingles = normalized ? [normalized] : [];
  }
  const vec = new Array<number>(64).fill(0);
  for (const sh of shingles) {
    const h = hash64(sh);
    for (let i = 0; i < 64; i++) {
      vec[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (vec[i] > 0) out |= 1n << BigInt(i);
  }
  return out;
}

function hash64(s: string): bigint {
  const buf = createHash('sha256').update(s).digest();
  return buf.readBigUInt64BE(0);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export function isNearDuplicate(a: TextFingerprint, b: TextFingerprint): boolean {
  if (a.normalized === b.normalized) return true;
  const short = a.len < MIN_NEAR_LEN || b.len < MIN_NEAR_LEN;
  if (short) return a.exactHash === b.exactHash;
  return hammingDistance(a.simhash, b.simhash) <= MAX_HAMMING;
}

export function simhashToDb(n: bigint): string {
  return n.toString();
}

export function simhashFromDb(s: string): bigint {
  return BigInt(s);
}
