# Issuer Studio

Connect a NEAR testnet wallet and authenticate it in QuotaCarry. The studio can inspect, verify, and revoke an operator-bound adapter when V2 routing is enabled. Use an existing finalized on-chain issuer ID. The controller or an accepted administrator can verify the configured model and select a daily cap from one to four.

The team API at `/v2/team` supports `GET ?issuer=<id>` and wallet-authenticated POST actions `create` with `name`, `invite` and `role` with `account` and `role`, `remove` with `account`, and `accept` by the invited wallet. Each action includes `issuer`. Use the configured browser origin and wallet session.

Submit an issuer profile from Issuer Studio. Governance can approve or reject the application. After governance separately registers the issuer on-chain, it records the finalized issuer ID. The gateway checks the finalized controller before it marks the application finalized. From the controller's wallet, create a policy and mint a request-credit NFT after reviewing each transaction in the wallet. The UI checks finalized receipts before displaying IDs.

The operator supplies a vetted binding, an independent adapter identity, and the issuer's own free provider configuration. See [adapter setup](ARCHITECTURE.md).
