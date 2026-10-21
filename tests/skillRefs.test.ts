import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script
import { renderApi, renderTypes } from '../scripts/gen-skill-refs.mjs';

describe('the skill\'s API reference', () => {
  it('matches the app\'s contracts (run `npm run skill:refs` after changing src/shared/types.ts)', () => {
    const types = readFileSync(join(__dirname, '../src/shared/types.ts'), 'utf8');
    const dir = join(__dirname, '../skills/tg-search/references');
    expect(readFileSync(join(dir, 'api.md'), 'utf8')).toBe(renderApi(types));
    expect(readFileSync(join(dir, 'types.md'), 'utf8')).toBe(renderTypes(types));
  });
});
