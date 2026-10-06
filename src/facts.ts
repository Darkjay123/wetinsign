import type { Amount, Deadline } from './format.js';
import type { TokenRef } from './tokens.js';

export type Kind =
  | 'erc20_approve'
  | 'nft_approve_all'
  | 'nft_approve'
  | 'transfer'
  | 'transfer_from'
  | 'native_send'
  | 'permit'
  | 'permit2'
  | 'seaport_order'
  | 'ownership_transfer'
  | 'permit2_transfer'
  | 'blur_order'
  | 'blur_bulk'
  | 'swap_order'
  | 'delegation'
  | 'tron_permission'
  | 'tron_action'
  | 'sol_authority'
  | 'unknown_call'
  | 'unknown_signature';

export interface SeaportItem {
  itemType: number;
  token: string;
  amount: Amount;
  recipient?: string;
}

/**
 * Everything we know for certain, decoded from the chain or the signature payload.
 * The explanation layer may only restate what is in here.
 */
export interface Facts {
  kind: Kind;
  chainId?: number;
  chain: string;
  contract?: string;
  token?: TokenRef;
  spender?: string;
  recipient?: string;
  from?: string;
  owner?: string;
  amount?: Amount;
  approved?: boolean;
  /** For nft_approve: which NFT. */
  tokenId?: string;
  /** For permit2_transfer with several tokens. */
  batch?: Array<{ token: TokenRef; amount: Amount }>;
  /** For blur_order. */
  side?: 'sell' | 'buy';
  collection?: string;
  price?: Amount;
  deadline?: Deadline;
  selector?: string;
  /** Set when the real action was found hidden inside a bundle call such as multicall. */
  via?: 'multicall' | 'batch';
  /** For via 'batch' (EIP-7702 / ERC-7821 wallet batch): every approval or transfer found inside. */
  bundle?: Array<{ kind: string; token?: TokenRef; spender?: string; amount?: Amount }>;
  nativeValue?: Amount;
  offer?: SeaportItem[];
  consideration?: SeaportItem[];
  /** For swap_order (CoW Swap, 1inch limit orders): what you get back. */
  buyToken?: TokenRef;
  buyAmount?: Amount;
  swapKind?: 'sell' | 'buy';
  protocol?: string;
  primaryType?: string;
  appName?: string;
  /** Tron AccountPermissionUpdate: who can control the account after this, per permission. */
  permission?: Array<{ scope: 'owner' | 'active'; threshold: number; yourWeight: number; others: string[]; othersCanActAlone: boolean }>;
  /** Tron native actions such as staking or lending energy. */
  action?: 'delegate_resource' | 'undelegate_resource' | 'stake' | 'unstake' | 'vote' | 'claim_rewards';
  resource?: string;
  /** Solana: which control this hands over. wallet_owner is System Assign on your wallet; the rest are SPL Token SetAuthority. */
  authority?: 'wallet_owner' | 'token_owner' | 'close' | 'mint' | 'freeze' | 'remove' | 'other' | 'setup';
}
