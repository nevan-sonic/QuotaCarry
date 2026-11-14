# Cloudflare testnet deployment

The gateway Worker uses D1 for challenges, hashed sessions, rate limits and inference jobs. It does not load the local Node HTTP or SQLite entrypoint. The frontend uses OpenNext on Workers. Inference starts disabled.

1. Authenticate Wrangler to a Cloudflare Free account. Enable a workers.dev subdomain if needed.
2. Create a free D1 database named quotacarry and replace the zero UUID in apps/gateway/wrangler.toml with its database ID. Apply the migration with `npx wrangler d1 migrations apply quotacarry --remote --config apps/gateway/wrangler.toml`.
3. Set QC_ORIGIN to the final frontend HTTPS origin. Deploy the gateway with `npx wrangler deploy --config apps/gateway/wrangler.toml`. Verify /health and /ready.
4. From apps/web, set NEXT_PUBLIC_QC_GATEWAY to the gateway HTTPS URL before running `npx opennextjs-cloudflare build`, then deploy with `npx opennextjs-cloudflare deploy`. Verify the finalized dashboard and wallet origin.
5. After approval for the live test, set QC_POLICY_ID to the fresh finalized policy ID, provision GROQ_API_KEY, QC_RELAYER_KEY and QC_SETTLER_KEY as Worker secrets, and enable QC_INFERENCE_ENABLED. Restrict key custody to the Worker. Disable inference after the test. The relayer and settler are trusted issuer-operated roles.

The five-minute cron claims one queued job through a D1 compare-and-set lease. HTTP requests do not rely on the 30-second waitUntil grace period. The worker stores each signed transaction hash before sending and reconciles by hash. An ambiguous provider call or a failed settlement requires operator review. An unresolved transaction is never resent automatically. A prompt is stored while queued and cleared before provider dispatch. Model output remains in D1 for authenticated retrieval. Treat D1 as private. Inference accepts at most one job per rolling 24 hours, including failures.

Workers Free allows 10 ms CPU per HTTP or cron invocation and 50 subrequests per invocation. Network waiting is separate. Local workerd checks do not prove production CPU headroom. Check deployed logs and error 1102 during the approved test. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Proposed live verification

Keep historical token 0 unchanged. Use a fresh issuer and policy capped at one credit with one open reservation, controlled by the existing issuer, relayer and settler. Register via governance with 0.06 NEAR attached. This covers the 768-byte issuer, 512-byte policy and 4096-byte pass allocation at 10^19 yoctoNEAR per byte, with 0.00704 NEAR headroom. Mint one credit to Alice, transfer the new token to Bob, check Alice's eligibility using finalized ownership, then authenticate Bob and perform one inference. Derive issuer, policy, token, epoch and reservation IDs from finalized state and receipts.

| Step | Signer prefix under quotacarry-fund-7b29e1.testnet | Method | Deposit |
|---|---|---|---|
| 1 | Governance (parent account) | register_issuer | 0.06 NEAR |
| 2 | issuer | create_policy | 0 |
| 3 | issuer | issue | 0 |
| 4 | alice (wallet) | nft_transfer | 1 yoctoNEAR |
| 5 | relayer | reserve | 0 |
| 6 | settler | settle (consume on success, release on definitive provider rejection) | 0 |

Each call uses 30 Tgas, for 180 Tgas prepaid. Budget 32 Tgas per call including overhead at up to 400 million yoctoNEAR/gas. Fee budget 0.0768 NEAR, aggregate projection 0.136800000000000000000001 NEAR. Proposed ceiling 0.14 testnet NEAR. Recheck the fee estimate and signer balances before execution. Wallet authentication and finalized ownership reads do not sign transactions. Alice and Bob need real wallets for the fresh transfer and authentication.

One Groq chat completion using llama-3.1-8b-instant, one short test prompt and a 512-completion-token cap. No automatic provider retries. Use a Groq account with no billable usage enabled. If the model is unavailable under that account or could incur charges, stop for separate pricing approval.
