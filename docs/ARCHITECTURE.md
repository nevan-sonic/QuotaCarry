# QuotaCarry request-credit architecture

The gateway authenticates wallets using NEP-413 and finalized NEAR access keys. It resolves developer credentials to a finalized NFT allowance, then uses the allowance's issuer to select a verified adapter. Jobs persist the issuer and adapter revision. The Worker verifies the credential and route before reserving, persists the reservation intent before broadcast, and verifies the route again before provider dispatch. The live contract checks the owner and epoch during reservation. Success consumes one request credit. An explicit adapter rejection releases it. An ambiguous response or interrupted dispatch enters manual review.

## Issuer setup for staging

Use vetted Workers on the gateway's Cloudflare account with HTTP service bindings `QC_ADAPTER_A` and `QC_ADAPTER_B`. Configure one dedicated Worker, D1 database, and Groq secret per issuer. Set the gateway Worker secret `QC_ADAPTER_KEYS` to a JSON array of objects with `issuer`, `slot` (`A` or `B`), and `key` (64 lowercase hex characters from 32 random bytes). Set the corresponding adapter's `ADAPTER_SHARED_KEY` to that same key. Keep the Groq key exclusively in the adapter. Configure each slot to a different Worker. Rotating the key changes the route revision and requires a new challenge.

The on-chain issuer must designate QuotaCarry's existing relayer and settler. After NEP-413 authentication, the finalized controller can submit `POST /v2/issuer-adapter` with `{"action":"verify","issuer":"<id>","model":"openai/gpt-oss-20b","dailyLimit":1}` from the configured browser origin. Verification signs a challenge without calling Groq. The controller can inspect configuration and audit events with `GET /v2/issuer-adapter?issuer=<id>` and disable the route with `POST /v2/issuer-adapter` using `{"action":"revoke","issuer":"<id>"}`.

Service bindings keep issuer-provided URLs out of the gateway's dispatch path. The gateway refuses redirects and uses independent HMAC credentials. This preview requires trusted operators to provision bindings. Cross-account arbitrary endpoint onboarding needs a separate reviewed transport. The on-chain authorizer is trusted to enforce wallet ownership and session checks.

The live beta has independent admission counters and its existing provider. V2 has separate issuer and platform admission counters and shares the global active-job lock with beta so signed writes cannot run concurrently. An ambiguous job can hold that lock for operator reconciliation. Before enabling V2, exercise that behavior and the complete two-issuer flow in an isolated environment.

## Metered extension

A separate versioned contract would use integer provider tokens and checked arithmetic with explicit maximum prompt and completion reservations. Resolve settlement to verified actual usage bounded by the reservation, then return the difference. An ownership transfer bumps the authorization epoch and leaves prior open reservations payable. Expiration stops new reservations and must leave settlement and operator reconciliation possible. Ship alongside existing request-credit balances with a distinct denomination and migration checks. Rust tests should cover overflow, over-settlement, transfer races, duplicate settlement, expiry and conservation, followed by an independent security review before deployment.
