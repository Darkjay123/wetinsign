import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCall, decodeTypedData } from '../src/decode.js';
import { assessRisk, verdict } from '../src/risk.js';

// Real drainer attacks with published losses. Run with an empty drainer list on purpose:
// WetinSign has to catch these from what the request does, not just because the address is already blacklisted.
const cases = JSON.parse(readFileSync(new URL('./fixtures/real-attacks.json', import.meta.url), 'utf8'));
const none = { drainers: new Set<string>() };

const safe = JSON.parse(readFileSync(new URL('./fixtures/real-safe.json', import.meta.url), 'utf8'));

// A fixture may carry what the chain says about the token or spender, recorded with its source in the fixture.
function resolverFor(c: any) {
  return c.token ? async (_chainId: number | undefined, address: string) => ({ address, ...c.token }) : undefined;
}
async function factsFor(c: any) {
  return c.endpoint === 'call' ? decodeCall(c.input, resolverFor(c)) : decodeTypedData(c.input.typedData, resolverFor(c));
}

describe('real attacks', () => {
  for (const c of cases) {
    it(`${c.title} (${c.loss}, ${c.date})`, async () => {
      const f = await factsFor(c);
      const flags = assessRisk(f, { ...none, ...(c.ctx ?? {}) });
      expect(f.kind).toBe(c.expect.kind);
      if (c.expect.via) expect(f.via).toBe(c.expect.via);
      for (const code of c.expect.flags) expect(flags.map((x) => x.code)).toContain(code);
      expect(verdict(flags)).toBe(c.expect.verdict);
    });
  }

  // Even with no on-chain lookups and no drainer list, a real theft must never come back as plain info or safe.
  it('never calls a real theft fine, even offline', async () => {
    for (const c of cases) {
      const v = verdict(assessRisk(await factsFor(c), none));
      expect(['danger', 'warning'], c.id).toContain(v);
    }
  });
});

// Everyday actions real users took. Crying wolf on these teaches people to ignore the warnings.
describe('real everyday actions are not called danger', () => {
  for (const c of safe) {
    it(c.title, async () => {
      const f = await factsFor(c);
      const flags = assessRisk(f, none);
      for (const code of c.expect.flags) expect(flags.map((x) => x.code)).toContain(code);
      expect(verdict(flags)).toBe(c.expect.verdict);
    });
  }
});
