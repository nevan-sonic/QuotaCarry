# Testnet NFT demo approval

The deployed contract is `quotacarry-fund-7b29e1.testnet` and finalized issuer ID is `0`. Role names below refer to its five child accounts. This is an unsigned plan.

Proposed policy JSON (UTF-8, no trailing newline)

```json
{"version":1,"purpose":"quotacarry-testnet-nft-demo","lifetime_cap":"100","max_open":4}
```

The issuer signs `create_policy` with issuer ID `0`, the SHA-256 of the policy JSON, lifetime cap `100` and max open `4`. Then the issuer calls `issue` with the finalized policy ID, Alice as receiver, amount `100`, and expected issue sequence `0`. Read the token ID from the finalized mint.

| Signer | Call | Expected result |
|---|---|---|
| Relayer | Reserve separately for Alice, epoch 0, sequences 0, 1, 2 | Alice owns the NFT with 97 available and 3 open |
| Alice | Transfer the NFT to Bob with 1 yoctoNEAR attached | Bob owns the NFT at epoch 1 with 97 available and 3 open |
| Relayer | Attempt reserve for Alice, epoch 0, sequence 3 | Expected stale-owner rejection with unchanged accounting |
| Relayer | Reserve for Bob, epoch 1, sequence 3 | 96 available and 4 open |
| Settler | Consume sequences 0 and 1, then release 2 and 3 | Bob owns the NFT with 98 available, 0 open and 2 consumed |

Use 30 Tgas per call and zero attached deposit except the transfer. Generate distinct request commitments and fresh finalized-height deadlines for the reserve calls. Verify each finalized outcome before proceeding. The expected rejection requires explicit inclusion in the demo approval. Verify child signer bindings before signature.

Policy SHA-256: 77259025c2e07bb91f9be935367dd1aab596fa8a95af545e8322d3772f376d0a
## Exact unsigned sequence

All calls target `quotacarry-fund-7b29e1.testnet` on NEAR testnet. Account aliases expand to `<alias>.quotacarry-fund-7b29e1.testnet`. Each call prepays 30 Tgas. The attached deposit is zero except for step 6, which attaches one yoctoNEAR.

| Step | Signer | Method | Arguments |
|---|---|---|---|
| 1 | issuer | create_policy | `{"issuer_id":"0","policy_hash":"77259025c2e07bb91f9be935367dd1aab596fa8a95af545e8322d3772f376d0a","lifetime_cap":"100","max_open":4}` |
| 2 | issuer | issue | `{"policy_id":"P","receiver_id":"alice.quotacarry-fund-7b29e1.testnet","amount":"100","expected_issue_seq":"0"}` |
| 3–5 | relayer | reserve | `{"token_id":"T","holder_id":"alice.quotacarry-fund-7b29e1.testnet","expected_epoch":"0","seq":"0 / 1 / 2","request_commitment":"C","valid_through_height":"H"}` |
| 6 | alice | nft_transfer | `{"receiver_id":"bob.quotacarry-fund-7b29e1.testnet","token_id":"T","approval_id":null,"memo":null}` |
| 7 | relayer | reserve (expected Stale ownership failure) | `{"token_id":"T","holder_id":"alice.quotacarry-fund-7b29e1.testnet","expected_epoch":"0","seq":"3","request_commitment":"C","valid_through_height":"H"}` |
| 8 | relayer | reserve | `{"token_id":"T","holder_id":"bob.quotacarry-fund-7b29e1.testnet","expected_epoch":"1","seq":"3","request_commitment":"C","valid_through_height":"H"}` |
| 9–12 | settler | settle | `{"token_id":"T","seq":"0 / 1 / 2 / 3","disposition":"consume / consume / release / release"}` |

P and T are the policy and token IDs from finalized receipts. Substitute each listed sequence and disposition as its own string. For each reserve, C is SHA-256 of the UTF-8 string `quotacarry-testnet-nft-demo-v1:<step>:<T>` with no trailing newline. H is the finalized block height immediately before signing plus 100, serialized as a decimal string. The contract allows a deadline up to 120 blocks ahead of execution. If it expires or another unexpected failure occurs, stop.

Finalized RPC found issuer 0 active with zero issued credits and zero open reservations, no policy 0, and NFT supply zero. After the handoff, verify Alice's original three reservation records remain and sequence 3 is absent before and after step 7. Only continue from the expected stale-owner failure after confirming accounting is unchanged. The holder and epoch checks can be corroborated by read-only state, but the deployed interface has no read-only authorization simulator for a mutating reserve call.

Total 12 calls, 360 Tgas prepaid, and one yoctoNEAR deposited. At the observed 100 million yoctoNEAR per gas, budget 32 Tgas per call including overhead, or approximately 0.0384 NEAR across all signers. The expected failure is included and separately budgeted at 0.0032 NEAR at the observed gas price. With a 4× fee buffer, the proposed aggregate ceiling is 0.16 NEAR. Recheck projected spend and each signer's spendable balance before signing. Verify local encrypted signer bindings before execution. Bob and governance do not sign this sequence.
