import type { Amount, Deadline } from './format.js';
import type { TokenRef } from './tokens.js';

export type Kind =
  | 'erc20_approve'
  | 'nft_approve_all'
  | 'transfer'
  | 'transfer_from'
  | 'native_send'
  | 'permit'
  | 'permit2'
  | 'seaport_order'
  | 'ownership_transfer'
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
  deadline?: Deadline;
  selector?: string;
  /** Set when the real action was found hidden inside a bundle call such as multicall. */
  via?: 'multicall';
  nativeValue?: Amount;
  offer?: SeaportItem[];
  consideration?: SeaportItem[];
  primaryType?: string;
  appName?: string;
}
