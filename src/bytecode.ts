import { toFunctionSelector } from 'viem';

/** 4-byte selectors pushed in runtime bytecode (PUSH4 operands), skipping other PUSH data so it is not misread as code. */
export function codeSelectors(code: string): Set<string> {
  const c = code.startsWith('0x') ? code.slice(2).toLowerCase() : code.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 1 < c.length; ) {
    const op = parseInt(c.slice(i, i + 2), 16);
    if (op === 0x63) out.add(c.slice(i + 2, i + 10));
    i += 2 + (op >= 0x60 && op <= 0x7f ? 2 * (op - 0x5f) : 0);
  }
  return out;
}

const sel = (sig: string) => toFunctionSelector(sig).slice(2);

/** Functions only the CrimeEnjoyor sweeper family uses (v2 and v3 per nullteilerfrei, 30 Jun 2026). */
const SWEEPER_ONLY = [
  'loserSweepETH_11435948882()', 'loserMulticall_3869193990(address[],bytes[])', 'loserFallback_8092318215()',
  'destroyContract()', 'moonBox()', 'conjure(address)', 'byteDance(bytes32,uint256)',
].map(sel);
/** v1: a stored destination set by initialize(address), the whole contract. */
const V1_PAIR = ['destination()', 'initialize(address)'].map(sel);
/** A wallet checks that the owner approved: ERC-1271 isValidSignature or ERC-4337 validateUserOp. */
const SIG_CHECK = ['isValidSignature(bytes32,bytes)', 'validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)'].map(sel);

/**
 * A getter for a fixed address the money goes to. A real 7702 wallet sends where its owner signs for, so code that keeps
 * its own recipient/destination and has no owner-signature check works for someone else. owner() alone is NOT used:
 * real wallets (TokenPocket 0x7A956fD3) are Ownable without isValidSignature.
 */
const BENEFICIARY = ['recipient()', 'destination()'].map(sel);

export function looksLikeSweeper(code: string, size: number): boolean {
  if (size === 0) return true;
  const s = codeSelectors(code);
  if (SWEEPER_ONLY.some((x) => s.has(x))) return true;
  const sigCheck = SIG_CHECK.some((x) => s.has(x));
  if (!sigCheck && V1_PAIR.every((x) => s.has(x))) return true;
  if (!sigCheck && BENEFICIARY.some((x) => s.has(x))) return true;
  // Copy-paste sweepers are small; every real wallet we sampled under 2 KB is on a named list.
  return size < 2000 && !sigCheck;
}
