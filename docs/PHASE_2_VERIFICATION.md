# Phase 2 verification

## Predeployment evidence

- A fresh download of the CI artifact matched its manifest and WASM header. It hashes to `1bae619e7c7dbfc12d710468a4a9cfed78c55eed3854e79802b5a1a648956e5c`. Its [artifact-producing run](https://github.com/nevan-sonic/QuotaCarry/actions/runs/43550812750) succeeded at `c62abe6d04205a992120bcc7eff4d8c3af099bf4`. The [Phase 1 closeout CI](https://github.com/nevan-sonic/QuotaCarry/actions/runs/43551324409) succeeded and changed only documentation from that commit.
- Source and API preflight checked the one-time initializer, predecessor checks for roles and ownership, private resolver, checked credit transitions, and issuer storage allowances. The three Rust unit tests and explicit Workspaces integration step ran in CI. Internal resolver out-of-gas remains untested, and the review is not an audit. See [Phase 1 verification](PHASE_1_VERIFICATION.md).
- Read-only RPC reported the `testnet` chain and finalized block 277602564 (hash `BrtKDFKxYChdeVncG8gbKKghH8vsyLt6JbQc2mW2SaKf`). The observed storage price was 10¹⁹ yoctoNEAR per byte. Gitleaks reported no findings in Git history, printable WASM strings, or the Phase 2 preparation files. The verifier passed syntax checks and rejected missing configuration with a nonzero exit. At that stage no contract was deployed. Phase 1 measurements of 441 bytes for a split and 8.37–19.21 Tgas for sampled callback chains are sandbox measurements. Testnet measurements are pending.

## Finalized deployment

- Contract and governance are both `quotacarry-fund-7b29e1.testnet`. The [deployment transaction](https://explorer.testnet.near.org/transactions/4Heee5uhjhYXu3Z6tEpczJLxcCawGYqcfKXopeUNZrhC) finalized with successful deployment and initialization receipts.
- At finalized block 277619227, the deployed bytes matched the pinned SHA-256 and initialized state named the contract account as governance. The account held 7.7981254644438838 NEAR, with 2.28344 NEAR in storage stake and 5.5146854644438838 NEAR spendable. The deployment fee was 0.0018298990436162 NEAR.
- The original Meteor flow blocked full-access key installation on a child account. The approved deployment used NEAR CLI 0.31.1 directly with the Windows keychain. Role provisioning, issuance, handoff, settlement, and live receiver compatibility remain pending.
