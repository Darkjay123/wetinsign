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
  if (c.tokens) return async (_chainId: number | undefined, address: string) => ({ address, ...(c.tokens[address.toLowerCase()] ?? c.token ?? {}) });
  return c.token ? async (_chainId: number | undefined, address: string) => ({ address, ...c.token }) : undefined;
}
async function factsFor(c: any) {
  return c.endpoint === 'call' ? decodeCall(c.input, resolverFor(c)) : decodeTypedData(c.input.typedData, resolverFor(c), undefined, c.input.from);
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

// 21 permit signatures that drainers actually redeemed on Ethereum, 17 different tokens.
// Each one was rebuilt from the drainer's permit() call and checked by recovering the signature to the victim.
const permits = JSON.parse(readFileSync(new URL('./fixtures/real-permits.json', import.meta.url), 'utf8'));
describe('real redeemed permits', () => {
  for (const c of permits) {
    it(c.title, async () => {
      const f: any = await factsFor(c);
      const flags = assessRisk(f, { ...none, spenderIsContract: false });
      expect(f.kind).toBe('permit');
      expect(f.spender.toLowerCase()).toBe(c.input.typedData.message.spender.toLowerCase());
      for (const code of c.expect.flags) expect(flags.map((x) => x.code)).toContain(code);
      expect(verdict(flags)).toBe('danger');
      // An amount bigger than the whole token supply must read as unlimited, not as a 40-digit "limit".
      if (c.token?.totalSupply && BigInt(c.input.typedData.message.value) >= BigInt(c.token.totalSupply)) {
        expect(f.amount.unlimited).toBe(true);
        expect(flags.map((x) => x.code)).toContain('UNLIMITED_APPROVAL');
      }
    });
  }
  it('stays at least a warning even without the spender code check', async () => {
    for (const c of permits) expect(['danger', 'warning'], c.id).toContain(verdict(assessRisk(await factsFor(c), none)));
  });
});
