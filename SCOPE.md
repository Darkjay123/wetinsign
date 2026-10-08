# Scope: SignLens for Devcenter Hacktober 2026

**One line:** before you sign, see in plain English or Pidgin what you are giving away, and get stopped when it looks like a drainer.

## Judging, and how we answer each criterion

1. **Live and fully functional on Rumpty Cloud.** App deployed from Git on Rumpty Deployments, explanations from Rumpty AI Inference, cache in Rumpty managed Postgres. Live URL in the README before 31 Oct.
2. **Code quality and technical docs.** Typed TypeScript, pure decoding separated from network and AI, offline test suite, README with setup, config and API.
3. **Innovation and practical utility.** A real Nigerian problem (signing scams), Pidgin output, and a design where the AI is never trusted with numbers.

## In

- EIP-712: EIP-2612 Permit, Permit2 PermitSingle/PermitBatch, Seaport OrderComponents
- Calls: approve, increaseAllowance, transfer, transferFrom, setApprovalForAll, Permit2 approve, native sends
- Tx lookup by hash on Ethereum, BSC, Base, Polygon, Arbitrum
- English and Pidgin, verdict plus explanation plus decoded facts
- Number guard and danger-cannot-be-softened rule
- Postgres cache, health endpoint

## Out (deliberately)

- Accounts, logins, wallets connecting to the site
- Transaction simulation (needs a paid simulator)
- Non-EVM chains (Tron USDT is a stretch goal only if everything else is done)
- A browser extension (stretch goal)

## Milestones

| Date | Done when |
|---|---|
| Mon 5 Oct | Core decoding, risk rules, explanations, API, page, 22 tests (done) |
| Fri 9 Oct | Deployed on Rumpty with Postgres; live AI explanations checked against real samples |
| Fri 16 Oct | Drainer list populated from a published source; tested on 20 real scam payloads |
| Fri 23 Oct | Pidgin wording reviewed by real users; mobile polish |
| Wed 28 Oct | Demo video, final README with live URL |
| Fri 31 Oct | Submitted, buffer for fixes |
| Sat 7 Nov | Demo day |
