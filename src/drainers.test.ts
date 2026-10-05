import { describe, expect, it } from 'vitest';
import { drainerSet, parseAddressList, refreshDrainers } from './drainers.js';
import { lang } from './server.js';

describe('drainer list', () => {
  it('keeps only well-formed addresses, lowercased and deduped', () => {
    expect(
      parseAddressList(['0xABCDEFabcdef0123456789abcdef0123456789AB', '0xabcdefabcdef0123456789abcdef0123456789ab', 'not-an-address', 42, '0x123']),
    ).toEqual(['0xabcdefabcdef0123456789abcdef0123456789ab']);
    expect(parseAddressList({ nope: true })).toEqual([]);
  });

  it('loads the feed and keeps the last good list when a refresh fails', async () => {
    const addr = '0x101ce0cedd142f199c9ef61739ae59b6611a0fc0';
    const ok = (async () => new Response(JSON.stringify([addr]))) as unknown as typeof fetch;
    const s1 = await refreshDrainers(ok, 'https://example.test/list.json');
    expect(s1.remote).toBe(1);
    expect(drainerSet().has(addr)).toBe(true);

    const broken = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const s2 = await refreshDrainers(broken, 'https://example.test/list.json');
    expect(s2.lastError).toBe('HTTP 500');
    expect(drainerSet().has(addr)).toBe(true);
  });
});

describe('language', () => {
  it('accepts pcm and the plain word pidgin', () => {
    expect(lang('pcm')).toBe('pcm');
    expect(lang('Pidgin')).toBe('pcm');
    expect(lang('en')).toBe('en');
    expect(lang(undefined)).toBe('en');
  });
});
