import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { looksLikeSweeper } from '../src/bytecode.js';

const sz = (c: string) => (c.length - 2) / 2;
// Unlisted delegates seen live on Ethereum (7702 Reality Check scan, blocks 26,018,045-26,021,045, single-operator pools).
// Each keeps a fixed recipient()/destination() or is a 1,045 B initialize(address) clone, and none checks the owner's signature.
const R: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/recipient-sweepers.json', import.meta.url), 'utf8'));
const D = JSON.parse(readFileSync(new URL('./fixtures/delegate-code.json', import.meta.url), 'utf8'));

describe('recipient-style sweepers', () => {
  for (const [a, c] of Object.entries(R)) {
    it(`flags ${a.slice(0, 10)} (${sz(c)} B)`, () => expect(looksLikeSweeper(c, sz(c))).toBe(true));
  }
  it('does not flag an Ownable wallet without isValidSignature (TokenPocket)', () => {
    const h = D.good['0x7A956fD329d0C616f2d1DDE98BB35694f397Df46'] ?? D.good['0x7a956fd329d0c616f2d1dde98bb35694f397df46'];
    expect(h).toBeTruthy();
    expect(looksLikeSweeper(D.codes[h], sz(D.codes[h]))).toBe(false);
  });
  it('still catches at least 51 of the 54 known scam codes by code alone', () => {
    const n = Object.values(D.bad as Record<string, string>).filter((h) => looksLikeSweeper(D.codes[h], sz(D.codes[h]))).length;
    expect(n).toBeGreaterThanOrEqual(51);
  });
});
