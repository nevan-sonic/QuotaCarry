# Phase 1 verification

The contract was developed on `phase-1/quota-pass` from Phase 0 baseline `c8d0a4eadd68d5c84511011d12031ec7fb1ec762`. Builds and tests use Ubuntu 24.04 because Windows Application Control blocks native Cargo-generated build scripts on this development machine.

The [Phase 1 verification run](https://github.com/nevan-sonic/QuotaCarry/actions/runs/43550812750) passed on commit `c62abe6d04205a992120bcc7eff4d8c3af099bf4`. It ran JavaScript install, lint, type checks, tests and builds, contract formatting, Clippy with warnings denied, three Rust unit tests, a Workspaces receipt-chain integration test, and tracked-file and history secret scans. The [downloaded WASM artifact](https://github.com/nevan-sonic/QuotaCarry/actions/runs/43550812750/artifacts/14096755900) had a valid WASM header and matched the manifest SHA-256 `1bae619e7c7dbfc12d710468a4a9cfed78c55eed3854e79802b5a1a648956e5c`.

Rust/Cargo 1.99.1 and Cargo NEAR 0.23.0 remain pinned. The Workspaces 0.23.0 harness has a separate Cargo graph because its NEAR crypto dependency and the pinned SDK require incompatible aws-lc-rs versions. The production contract graph remains on near-sdk 5.30.1.

## Sandbox evidence

- Alice reserved three of 100 credits and transferred 97 available credits with all three liabilities attached. A new Alice reserve failed. Bob reserved one successfully. Two original attempts consumed, one original attempt released, and Bob's attempt released, leaving 98 available and two consumed. Duplicate, conflicting and replayed calls were checked.
- Issuer, relayer and settlement authorization, issuance caps, insufficient issuer storage funding, stale ownership after return, stale mutation, incompatible merge and standard/custom events were exercised. The deterministic 280-step randomized test recomputed conservation after every step. Separate unit tests covered release with a pending callback and a maximum U128 credit balance.
- Split increased sandbox account storage by 441 bytes. Merging the child returned storage to its prior value. This sample is separate from the conservative fixed storage allowances.

| Receipt case | Observed result | Total sandbox gas |
|---|---|---:|
| Receiver accepts | Receiver owns token | Passed, gas not captured |
| Receiver asks to return | Previous owner restored | 8.589 Tgas |
| Receiver panics | Previous owner restored | 8.588 Tgas |
| Malformed response | Previous owner restored | 8.585 Tgas |
| Missing method | Previous owner restored | 8.368 Tgas |
| Onward transfer | Third-party owner preserved | 12.472 Tgas |
| Nested transfer-call | Both return paths resolve | 19.213 Tgas |
| Split or authorized reserve during callback | Mutation rejected, ownership restored | 12.484 / 12.443 Tgas |
| External resolver call | Rejected by private access | Passed, gas not captured |

The suite exercised receiver failure and unauthorized resolver invocation. It did not inject an internal resolver out-of-gas failure. The quarantine behavior in that case depends on receipt rollback preserving the pending entry. Measurements are sandbox receipt-chain totals and do not establish testnet costs or worst-case usage.

## Deployment prerequisites

Phase 2 requires explicit authorization to deploy and sign, a funded fresh NEAR testnet contract account, a governance account, distinct issuer/controller/authorizer/settler accounts, funded storage, and Alice and Bob wallets. Record the reviewed branch SHA and validated artifact hash before deploying. Initialize from the contract account, then create the issuer and immutable policy under the documented roles. Verify finalized deployment, initializer and test receipt outcomes on testnet. Measure storage and gas again on the target network. Provider execution belongs to the later gateway phase.

The contract has not been audited. Production upgrade custody, recovery from a permanently failed resolver, issuer funding policy and testnet gas costs require review. A failed resolver keeps its pending entry and therefore keeps new compute authorization held.
