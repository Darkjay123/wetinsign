# Drainer list

`drainers.json` is a flat JSON array of lowercase EVM addresses that have been publicly reported as wallet drainers.

It ships empty on purpose. We do not hand-type addresses from memory: a wrong entry would wrongly accuse a real contract, and a missing one gives false comfort. Populate it from a published, attributable source (for example the ScamSniffer open scam database, or Etherscan's "Fake_Phishing" labels) with a script that records where each address came from.

An empty list never makes a transaction look safe. The other checks (unlimited approvals, approve-all, free listings, never-expiring permits, approvals to wallets that are not contracts) run regardless.
