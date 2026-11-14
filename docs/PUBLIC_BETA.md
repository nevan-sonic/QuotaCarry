# QuotaCarry public testnet beta

[Public app](https://quotacarry-web.quotacarry.workers.dev/) · [Gateway readiness](https://quotacarry-gateway.quotacarry.workers.dev/ready)

Connect a NEAR testnet wallet and authenticate with its NEP-413 message signature. The dashboard shows finalized NFT ownership and credit balances. Claims and inference opened under the approved budget below. A completed claim will appear in the dashboard after the scheduled mint and finalized receipt. One claim per account is an abuse deterrent. A person can control multiple accounts.

The Worker uses D1 to serialize claims and inference. Claims persist the transaction hash before broadcast. A pending hash is reconciled by finalized reads and is never resent automatically. An unresolved mint blocks new mints. Failed claims retain their allocation for operator review. Inference rechecks ownership when queued and again when reserving. Provider ambiguity leaves the reservation open. An operator must reconcile it before deciding on settlement. Kill switches stop new work. Existing settlement recovery can continue with the configured policy and keys.

## Approved launch limits

- Register a fresh issuer with the existing issuer, relayer and settler accounts as controller, authorizer and settler. Lifetime cap 20, max open 1, deposit 0.43 NEAR. The 42,240-byte issuer, policy and ten-pass budget costs 0.4224 NEAR at the verified storage price.
- The controller creates one policy with lifetime cap 20 and max open 1. Derive its ID from the finalized receipt. Provision the issuer signer as the Worker secret QC_ISSUER_KEY and configure QC_POLICY_ID. Enable QC_CLAIMS_ENABLED and QC_INFERENCE_ENABLED only after approval.
- Up to ten authenticated wallets can claim one NFT with two credits. The controller signs up to ten issue calls. The relayer and settler sign up to twenty reserve and twenty consume or release calls. Each service call attaches zero deposit apart from registration. No automatic retries of signed transactions.
- Up to 52 contract calls at 30 Tgas each. At 100 million yoctoNEAR per gas, budget 32 Tgas including overhead with a 4× buffer. Fee allowance 0.6656 NEAR. Before opening, authorize three zero-function-gas native transfers from governance: 0.10 NEAR to issuer, 0.25 NEAR to relayer, and 0.25 NEAR to settler. These fund the signer balances for the buffered contract-call fees. Counting the top-ups conservatively alongside the contract-call fees and deposits, authorize a 1.70 NEAR gross ceiling across at most 55 service transactions. The top-ups move funds between service accounts. User-signed transfers have a 1 yoctoNEAR deposit and wallet-paid gas.
- Groq Free only, openai/gpt-oss-20b. Maximum four requests per rolling 24 hours, twenty lifetime calls, and two attempts per NFT. Each uses at most 768 UTF-8 prompt bytes and 256 completion tokens. The admission ledger reserves 1,536 token-budget units per call, including input and framing headroom, with 6,144 units per rolling 24 hours. Maximum configured completion allowance is 5,120 tokens across the beta.
- One globally active inference job, 60-second account cooldown, IP rate limiting, and finalized owner checks. Relayer and settler remain trusted issuer operators. Stop on ambiguous writes and preserve receipts. Monitor the signer balances, D1 queue, Groq Free quota and Worker CPU errors. No paid plan or mainnet actions.

## Recording

After approval, record wallet A connecting, signing authentication, claiming, and transferring the fresh NFT. Then record wallet B authenticating, running one prompt, and opening both finalized receipts. Keep historical NFTs 0 and 1 out of the beta test. Until that run succeeds, show the prior verified transfer and production Groq response as historical evidence. See [submission notes](HACKATHON_SUBMISSION.md).

## Finalized launch evidence

Issuer 2 and policy 2 were verified at finalized block 277637486 with zero credits issued. Setup used 1.0305598249634567 NEAR gross, including 0.60 NEAR in signer top-ups, 0.43 NEAR in issuer storage funding, and 0.0005598249634567 NEAR in fees. Fifty service calls remained with a 0.64 NEAR buffered fee projection. Historical NFTs 0 and 1 matched their prelaunch snapshots.

| Action | Transaction | Fee in yoctoNEAR |
|---|---|---:|
| topup (issuer) | [24Pnh1zZ9LUJW4kboZogWheGaKLHhSnbgoewHS3Yhjpa](https://explorer.testnet.near.org/transactions/24Pnh1zZ9LUJW4kboZogWheGaKLHhSnbgoewHS3Yhjpa) | 44636512500000000000 |
| topup (relayer) | [iSiFcMrWEv7mRgpgs3qbYTSxofqBvxTfQJ1eNLE3U8o](https://explorer.testnet.near.org/transactions/iSiFcMrWEv7mRgpgs3qbYTSxofqBvxTfQJ1eNLE3U8o) | 44636512500000000000 |
| topup (settler) | [EAjVji9VMnzehDVfzQotCgBdayakaDtNQnfW5RjRumVW](https://explorer.testnet.near.org/transactions/EAjVji9VMnzehDVfzQotCgBdayakaDtNQnfW5RjRumVW) | 44636512500000000000 |
| register_issuer (gov) | [2rwZDgRojt1YraZgGaeJjTidP65cxstz5eV83mQa2iuN](https://explorer.testnet.near.org/transactions/2rwZDgRojt1YraZgGaeJjTidP65cxstz5eV83mQa2iuN) | 208224412946800000000 |
| create_policy (issuer) | [CKfJz9trt788Ssvh6VCT4nAhc8Ry36pJqvubj6GxbfxS](https://explorer.testnet.near.org/transactions/CKfJz9trt788Ssvh6VCT4nAhc8Ry36pJqvubj6GxbfxS) | 217691013009900000000 |

The operator confirmed successful browser authentication in Edge with two independent wallets. An isolated recovery test confirmed that an interrupted provider call retains its reservation and enters manual review without replay or settlement.
