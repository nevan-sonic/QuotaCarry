# Two-issuer testnet acceptance budget

This is a proposed ceiling, pending independently provisioned issuer controllers, recipient wallets, verified adapter mappings and separate Groq Free credentials. Keep V2 disabled until isolated acceptance passes and the live run is approved.

Run the following sequence once for each of two new issuers. Use IDs, issuance sequence, ownership epoch and reservation sequence read from finalized state.

| Signer | Method | Deposit |
| --- | --- | --- |
| Contract governance | `register_issuer` with the respective controller, existing relayer and settler, cap 2, max open 1 | 0.06 NEAR |
| Respective controller | `create_policy`, cap 2 and max open 1 | 0 |
| Respective controller | `issue`, two request credits to the controller | 0 |
| Respective controller | `nft_transfer` to the respective recipient | 1 yoctoNEAR |
| Existing relayer | `reserve` one request for the recipient | 0 |
| Existing settler | `settle` consume on success, release only on definitive rejection | 0 |

Maximum 12 calls at 30 Tgas each, with fee budget 32 Tgas per call at 100 million yoctoNEAR per gas, the gateway's signed-write limit. Projected gross impact is 0.158400000000000000000002 testnet NEAR. Proposed hard ceiling is 0.16 testnet NEAR. Recheck current fees, spendable balances and all signer roles before signing. No top-ups or retries are included.

Maximum two Groq Free requests, one per verified issuer adapter, `openai/gpt-oss-20b` with 256 completion tokens each. Before transfer, mint a developer credential for each controller. After transfer, show each stale credential is rejected without a provider call, then use the corresponding recipient's fresh credential and verify routing, usage, receipts and settlement. Expected successful final state per NFT is one available, one consumed, zero open, and the recipient as owner. Preserve issuer 2 and NFTs 0 and 1.

On unexpected results close the V2 flags. Reconcile by finalized transaction hash and adapter dispatch ID. Preserve an ambiguous reservation for manual review and do not replay provider requests. A finalized mint or transfer cannot be undone by a Worker rollback.
