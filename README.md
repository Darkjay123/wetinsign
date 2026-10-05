# WetinSign

**Know what you are signing.** Paste a crypto signature request, a raw transaction or a transaction hash and get a plain English or Nigerian Pidgin explanation of what you are about to give away, with wallet-drainer warnings.

Built for the Devcenter Hacktober Sprint 2026 and deployed on [Rumpty Cloud](https://rumptycloud.com) in Lagos.

## The problem

Most crypto theft in Nigeria does not break any cryptography. People are tricked into signing something they cannot read: an unlimited token approval, an "approve all" for their NFTs, an off-chain permit that costs no gas and shows nothing on-chain until the thief uses it. Wallets show a wall of hex and a "Confirm" button. Nigeria ranked 6th in the world in the Chainalysis 2025 Global Crypto Adoption Index, so a lot of people are making that blind call every day.

## What it does

- **Signature requests (EIP-712):** EIP-2612 permits, Uniswap Permit2 (single and batch) and Seaport marketplace orders.
- **Raw transactions:** token approvals, increaseAllowance, transfers, transferFrom, NFT setApprovalForAll, Permit2 approvals and plain native sends.
- **Transaction hashes:** looked up live on Ethereum, BNB Smart Chain, Base, Polygon and Arbitrum.

Each result gets a verdict (danger, be careful, good to know, looks fine), a short explanation in English or Pidgin, and the decoded facts it is based on.

### Red flags it catches

| Flag | Why it matters |
|---|---|
| Unlimited approval | The spender can drain that token at any time, forever |
| Approve all NFTs | Hands over every NFT in the collection; the classic NFT drainer move |
| Free listing | A Seaport order where you receive nothing back |
| Off-chain signature | No gas, nothing on-chain until used; scammers' favourite |
| Never expires | A permit with no real deadline |
| Spender is not a contract | Real apps approve contracts, not plain wallets |
| Known drainer | Address appears on a reported drainer list |
| Unreadable | We refuse to guess; do not sign blind |

## The rule that makes it trustworthy: the AI never invents a number

Amounts, tokens, dates and addresses are decoded deterministically from the calldata or the signature payload. The language model (an open model on Rumpty Cloud's Lagos GPUs) only turns those facts into a sentence.

Every AI explanation then passes a **number guard**: any figure in the text that is not in the decoded facts gets the whole explanation thrown away and replaced with a hand-written template that is always correct. A second rule stops the model from softening a danger verdict. If the model is slow or down, the templates answer instantly. The app never depends on the AI to be right.

## Built on Rumpty Cloud

| Rumpty service | Used for |
|---|---|
| Deployments (Git) | The app itself, deployed from this repo |
| AI Inference (OpenAI-compatible, `llama3.2:3b`) | Plain-language explanations, generated in Lagos |
| Managed PostgreSQL | Caching decoded results so repeat lookups are instant |

## Run it locally

Requires Node 20+.

```bash
npm install
cp .env.example .env   # optional: add RUMPTY_API_KEY and DATABASE_URL
npm run dev            # http://localhost:8080
npm test               # 22 tests, all offline
```

Without `RUMPTY_API_KEY` the app uses its templates. Without `DATABASE_URL` it caches in memory.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `RUMPTY_API_KEY` | none | Rumpty Cloud inference key (`rmp_live_...`) |
| `RUMPTY_BASE_URL` | `https://chat.rumptycloud.com/v1` | Inference endpoint |
| `RUMPTY_MODEL` | `llama3.2:3b` | Model name |
| `DATABASE_URL` | none | Rumpty managed Postgres connection string |
| `RPC_<chainId>` | public nodes | Override the RPC for a chain, e.g. `RPC_56` |

## API

`POST /api/explain/signature` with `{ "typedData": {...}, "lang": "en" | "pcm" }`

`POST /api/explain/call` with `{ "chainId": 1, "to": "0x...", "data": "0x...", "value": "0", "lang": "pcm" }`

`POST /api/explain/tx` with `{ "chainId": 56, "hash": "0x...", "lang": "en" }`

Each returns `{ facts, flags, explanation: { verdict, text, source, rejected } }`.

`GET /healthz` reports whether AI is configured and how many results are cached.

## Project layout

```
src/decode.ts     calldata and EIP-712 decoding (pure, no network)
src/risk.ts       red-flag rules and the verdict
src/explain.ts    templates (English and Pidgin), prompt, number guard
src/inference.ts  Rumpty Cloud AI client
src/rpc.ts        on-chain lookups: tx by hash, token metadata, contract check
src/store.ts      Postgres cache with in-memory fallback
src/server.ts     HTTP API and page
public/           mobile-first web page
test/             offline test suite
```

## Licence

MIT

## Credits

Known-drainer addresses come from [Scam Sniffer's open scam database](https://github.com/scamsniffer/scam-database) (GPL-3.0), fetched live and refreshed every 12 hours. See `data/README.md`.
