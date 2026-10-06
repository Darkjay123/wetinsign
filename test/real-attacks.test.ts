import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCall, decodeTypedData } from '../src/decode.js';
import { assessRisk, verdict } from '../src/risk.js';

// Real drainer attacks with published losses. Run with an empty drainer list on purpose:
// WetinSign has to catch these from what the request does, not just because the address is already blacklisted.
const cases = JSON.parse(readFileSync(new URL('./fixtures/real-attacks.json', import.meta.url), 'utf8'));
const none = { drainers: new Set<string>() };

const safe = JSON.parse(readFileSync(new URL('./fixtures/real-safe.json', import.meta.url), 'utf8'));

describe('real attacks', () => {
  for (const c of cases) {
    it(`${c.title} ($${c.loss_usd} lost, ${c.date})`, async () => {
      const f = c.endpoint === 'call' ? await decodeCall(c.input) : await decodeTypedData(c.input.typedData);
      const flags = assessRisk(f, none);
      expect(f.kind).toBe(c.expect.kind);
      if (c.expect.via) expect(f.via).toBe(c.expect.via);
      for (const code of c.expect.flags) expect(flags.map((x) => x.code)).toContain(code);
      expect(verdict(flags)).toBe(c.expect.verdict);
    });
  }
});

// Everyday actions real users took. Crying wolf on these teaches people to ignore the warnings.
describe('real everyday actions are not called danger', () => {
  for (const c of safe) {
    it(c.title, async () => {
      const f = c.endpoint === 'call' ? await decodeCall(c.input) : await decodeTypedData(c.input.typedData);
      const flags = assessRisk(f, none);
      for (const code of c.expect.flags) expect(flags.map((x) => x.code)).toContain(code);
      expect(verdict(flags)).toBe(c.expect.verdict);
    });
  }
});
