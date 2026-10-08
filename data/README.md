# Drainer list

SignLens checks every spender, recipient and contract against a list of addresses publicly reported as wallet drainers. The list comes from two places:

1. **Scam Sniffer's open scam database** (https://github.com/scamsniffer/scam-database, `blacklist/address.json`). The app fetches it at startup and refreshes it every 12 hours (`src/drainers.ts`). It is GPL-3.0 licensed, so we read it live rather than copy it into this MIT repo. Override the URL with `DRAINER_LIST_URL`.
2. **`drainers.json`** in this folder: our own reviewed additions, a flat JSON array of EVM addresses. It ships empty. Add an address only with a public report you can link to.

If the feed cannot be reached, the app keeps the last list it loaded. `GET /api/drainers` shows the count, when it loaded and any feed error.

An empty or stale list never makes a transaction look safe. The other checks (unlimited approvals, approve-all, free listings, never-expiring permits, approvals to wallets that are not contracts) run regardless.
