/**
 * Determinism guard.
 *
 * The simulator in `@chaindrop/shared` MUST be byte-for-byte
 * reproducible from a seed — that's the property lockstep multiplayer
 * relies on. Any non-deterministic source (`Math.random`, wall-clock
 * `Date.now()` / `new Date()`) leaking into shared code would cause the
 * two clients to diverge and desync.
 *
 * This test walks the shared source tree (excluding tests) and fails if
 * any of those appear, so a regression is caught at CI time rather than
 * as a mysterious mid-match desync. Randomness must go through the
 * seeded `Xorshift32` RNG; timestamps must be passed in by the caller.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)));

const BANNED: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /Math\.random\s*\(/, label: 'Math.random()' },
  { pattern: /Date\.now\s*\(/, label: 'Date.now()' },
  { pattern: /new\s+Date\s*\(\s*\)/, label: 'new Date()' },
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('determinism guard (shared must stay seed-reproducible)', () => {
  it('contains no non-deterministic time/random sources', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const { pattern, label } of BANNED) {
        if (pattern.test(text)) {
          offenders.push(`${file.replace(SRC_ROOT, 'shared/src')} uses ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
