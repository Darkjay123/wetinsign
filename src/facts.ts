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
  | 'account_control'
  | 'ledger_action'
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
  /** TON: several different assets going to the same address in one request. */
  sweep?: { recipient: string; assets: string[] };
  /** Flagged as a scam by a wallet's own database (Tonkeeper on TON). */
  reportedScam?: boolean;
  /** A text note attached to the transfer (TON comments). Shown verbatim, never trusted. */
  memo?: string;
  /** Sui, Aptos, XRP Ledger: handing someone power over the whole account. */
  control?: 'regular_key' | 'signer_list' | 'signer_capability' | 'rotation_capability' | 'rotate_key' | 'account_delete' | 'disable_master' | 'remove_key' | 'full_access_key' | 'deploy_code' | 'guardian' | 'trading_agent';
  /** Sui, Aptos, XRP Ledger: everyday ledger actions that are not plain sends. */
  ledgerAction?: 'trustline' | 'trustline_remove' | 'dex_order' | 'swap' | 'app_deposit' | 'nft_sell_free' | 'nft_sell' | 'nft_buy' | 'nft_accept' | 'check' | 'escrow' | 'amm' | 'stake' | 'cancel' | 'setup' | 'settings' | 'app_key' | 'builder_fee' | 'internal_move';
  /** Hyperliquid ApproveBuilderFee: the most a builder may charge per trade, as signed (e.g. "0.1%"). */
  feeRate?: string;
  /** XRP Ledger: the destination tag exchanges use to credit your account. */
  destinationTag?: string;
  authority?: 'wallet_owner' | 'token_owner' | 'close' | 'mint' | 'freeze' | 'remove' | 'other' | 'setup';
}
