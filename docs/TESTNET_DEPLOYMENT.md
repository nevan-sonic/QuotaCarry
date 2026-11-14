# QuotaCarry testnet deployment manifest

**Status: deployed and initialized on NEAR testnet.** See [finalized evidence](PHASE_2_VERIFICATION.md).

| Field | Proposed value |
|---|---|
| Network | NEAR testnet |
| WASM source commit | `c62abe6d04205a992120bcc7eff4d8c3af099bf4` |
| Reviewed branch at preflight | `2c130f75b089f107a7c4ca9e59fb75422ff25588`, with only documentation changes from the artifact source |
| Artifact | `quota_pass.wasm` from [CI artifact 14096755900](https://github.com/nevan-sonic/QuotaCarry/actions/runs/43550812750/artifacts/14096755900) |
| SHA-256 | `1bae619e7c7dbfc12d710468a4a9cfed78c55eed3854e79802b5a1a648956e5c` |
| Contract/deployer | quotacarry-fund-7b29e1.testnet |
| Initialization | `new` with JSON key `governance`. Governance is quotacarry-fund-7b29e1.testnet. Use a self-signed deployment transaction with deploy and initializer actions in the same receipt, subject to approval. Initializer deposit is zero. |
| Controller, relayer, settler, holders | See the exact account IDs in [roles](ACCOUNT_ROLES.md) and the machine-readable manifest. |
| Initial gas and code storage | Proposed 30 Tgas for initialization. The 227,993-byte WASM alone represents 2.27993 testnet NEAR in storage at the observed byte price. The account also needs headroom for account and state storage, deploy action fees, and any approved issuer funding. |
| Issuer funding | Propose 0.15 testnet NEAR for one issuer, one policy, two live passes, and four pending callbacks in the issuer pool. The current RPC returned 10¹⁹ yoctoNEAR/byte, making 11,520 budgeted bytes cost 0.1152 NEAR. The remaining deposit is headroom. Registration and later mutations require their own signed transaction approval. |
| Upgrade and recovery | Retain a reviewed contract-account signer for testnet. Document key custody and keep deployment, recovery and role permissions visible. A wedged callback holds new reservations. Recovery requires a separately reviewed and approved migration. |

Once the full manifest is approved, use the approved local signing flow and confirm the signer, network, receiver, artifact and initializer arguments before signing. Wait for RPC `FINAL` and inspect the relevant successful receipts. Read `view_code` and hash its decoded bytes, then verify contract metadata and initial state at a finalized block. Treat missing or ambiguous results as unresolved. Reconcile by hash and receipt before considering a retry. [NEAR testnet deployment guide](https://docs.near.org/web3-apps/tutorials/mastering-near/1.3-deploy) · [Transaction RPC](https://docs.near.org/api/rpc/transactions)

## Read-only evidence collection

### Historical Phase 2A budget and signing

The original plan used `nevanrg.testnet` for funding and governance. At finalized block 277605250 it held 1 NEAR, 0 locked, 182 bytes of account storage, one full-access key, and no contract code. Its estimated spendable balance after account storage is 0.99818 NEAR. The six proposed role subaccounts each returned `UNKNOWN_ACCOUNT`. Availability can change before execution.

| Budget component | Testnet NEAR |
|---|---:|
| Verified WASM bytes at current storage rate | 2.27993 |
| Contract initial funding, including WASM and headroom for account, key, initializer state and gas | 2.50 |
| Five separate role accounts at 0.05 each, including their account/key storage and gas funding | 0.25 |
| Issuer registration funding, including one issuer (0.00768), one policy (0.00512), two live passes (0.08192) and four callback entries (0.02048) | 0.15 |
| Additional parent fee and contingency reserve | 0.10 |
| Planned allocation plus reserve | **3.00** |
| Minimum spendable balance before creation | **3.10** |

Reserve adds no attached deposit. Its storage is covered by the pass allocation, which also includes the bounded settlement cache. Role account creation and code deployment are charged action fees. Observed gas price was 100,000,000 yoctoNEAR/gas, or 0.0001 NEAR/Tgas. Current runtime fees imply about 8.35 Tgas for a basic parent-funded create/transfer/full-access-key receipt before any variant-specific costs, and about 16.86 Tgas for the self-deploy action and its receipt before initialization. The manifest budgets 30 Tgas per simple contract call. These were predeployment estimates and allocations. Actual fees, account overhead and storage deltas require finalized receipts. Recheck funding and protocol costs before signing.

One NEAR cannot cover the verified bytecode alone. Preserve distinct holder, issuer, relayer, settler and contract accounts, with governance already sharing the funding account. Existing funded and explicitly approved accounts could replace new role accounts, but that cannot close the code-storage gap. Prefer testnet-only funding before any account creation. No locally usable signer was established under the no-credential-inspection restriction. Use the wallet that controls the funding account to review and approve testnet transactions, or a compatible hardware signer. New accounts need wallet-generated public keys and independently available signers. CLI 0.31.1 was verified through help/version commands.

Run `scripts/Test-TestnetDeployment.ps1 -WasmPath <file>` for read-only validation of a fresh deployment. It stops if the target already has code. Use `scripts/New-TestnetTransactionPlan.ps1` to produce unsigned, reviewable inputs for CreateAccounts, Deploy, RegisterIssuer, CreatePolicy, Mint, Reserve, Transfer and Settle. The planner does not send the transactions. Before each approved signature, verify that account balances and role state still match the plan. After a failed or ambiguous transaction, inspect final receipts and state before any retry. If account creation partially succeeds, keep its verified receipts and seek review for remaining accounts. A failed deployment or initializer must be reconciled by finalized code and state checks before retrying or considering any upgrade.

Set `QUOTACARRY_CONTRACT_ID` in the process environment and run `node scripts/verify-testnet.mjs <expectations.json>` using Node from the repository pin. Supply a local JSON file with string fields `issuerId`, `policyId`, `tokenId`, `owner`, `epoch`, `available` and `wasmSha256`, numeric `open`, an optional `roles` map with `controller`, `authorizer` and `settler`, and a nonempty `transactions` array. Each transaction has an observed `hash`, `signer`, `method` and expected boolean `success`. For initial deployment evidence, use the batched initializer method `new`. Only enter actual identifiers from finalized evidence.

The script pins views to one finalized testnet block, independently sums live passes for the selected policy, checks the NFT owner and epoch, and verifies each supplied transaction and its contract receipts. It exits nonzero on mismatch. Run the verifier after each handoff stage with independently derived expected state. The verifier does not send transactions. Receiver-specific compatibility also requires checking downstream receipt outcomes and is recorded separately.
