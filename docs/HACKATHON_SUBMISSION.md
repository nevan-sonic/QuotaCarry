# QuotaCarry submission notes

**Track:** NFTs That Do Something · **Project:** QuotaCarry · **Pitch:** Transfer AI compute rights, not API keys.

API keys are difficult to transfer safely and do not carry a portable, auditable allowance. QuotaCarry represents an issuer-funded credit balance as a NEAR NFT. The NFT transfers the ability to request new credits. Reservations opened before a transfer retain their original identity and can still settle.

- Repository: [QuotaCarry](https://github.com/nevan-sonic/QuotaCarry)
- Contract: [quotacarry-fund-7b29e1.testnet](https://explorer.testnet.near.org/accounts/quotacarry-fund-7b29e1.testnet)
- Demo token and policy: both 0
- Evidence: [transfer](https://explorer.testnet.near.org/transactions/davp7Z7GTM4FBzRxKLyAFRhJSf6moJg49K5dN3PZxiQ), [stale owner rejected](https://explorer.testnet.near.org/transactions/2cUdDxFQT3cbAjexjxE6MgYNgkFPVFe3wy2MtnrADb8t), [Bob reserved](https://explorer.testnet.near.org/transactions/8nT3aUGXtz57Zw8Bs4JefpaFAHcdLuxNtczndRvvZgEF), [final settlement](https://explorer.testnet.near.org/transactions/J7TceTF9PqfMM1MREFnnVs59FLF6zNnjddJoBHwXgNRK)
- Public application, gateway and recorded demo URLs: pending

NEAR supplies standard NFT ownership and transfer, explicit role accounts, finalized receipts, and an independently readable ledger. The relayer is issuer-operated and trusted to authenticate users. See [threat model](THREAT_MODEL.md).

## Recording plan

| Time | Shot and narration |
|---|---|
| 0–15s | Open the landing page and explain how the NFT carries a bounded allowance without sharing the issuer API key. |
| 15–40s | Show finalized RPC data for token 0. Point out Bob, epoch 1, 98 available, zero open and two consumed. |
| 40–70s | Open the historical transfer and stale-owner rejection links. Explain why Alice's existing reservations survived but her next request failed. |
| 70–90s | Show Bob's reserve and final settlement. Explain 100 = 98 + 0 + 2 and identify which features were verified live. |
| 90–150s (extended) | Show the deployed contract, role separation, and how the intended gateway gates provider work on finalized reservations. Keep the current inference status visible. |

Suggested screenshots: landing page with contract link, dashboard showing the finalized block, and transfer receipt showing Alice and Bob. Label the earlier transaction sequence historical. Do not record account credentials.

Before submission, confirm the current rules and form at the [official hackathon site](https://nearhackathon.com/). Prepare project title, lead/contact, team size, NEAR account, repository, demo post link, and short description. Publish actual screenshots or video and tag @NEARProtocol and #NEARHackathon as directed by the official site. Submission and external posting are pending.

## Operational handoff

Install workspace packages with `npm ci`. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Start the production frontend with `npm exec -w @quotacarry/web -- next start`. Start the gateway health server with `npm run start -w @quotacarry/gateway` after building.

The frontend reads snapshots from finalized testnet RPC with read-only failover, refreshes every 20 seconds, and checks the final receipt after a wallet transfer. The local production API returned the expected token state and independently resolved the historical transfer. An app-initiated wallet transfer still needs a live browser test with a separately approved transaction.

Gateway modules provide NEP-413 challenge and signature primitives, SQLite replay/idempotency primitives, a Groq chat completions adapter, and a reservation-first orchestration interface. The HTTP gateway currently serves health only. It needs an authenticated HTTP integration, finalized access-key authorization, privileged chain adapters, a durable result journal and a restart recovery worker before serving inference. Ambiguous provider outcomes require reconciliation before release. No Groq model or API credential has been configured or exercised. The issuer lifetime cap of 100 is exhausted, so fresh integration tests require separately approved issuance capacity.
