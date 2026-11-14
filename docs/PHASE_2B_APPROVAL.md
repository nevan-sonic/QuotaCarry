# Phase 2B approval review

## Direct testnet deployment

The active manifest uses `quotacarry-fund-7b29e1.testnet` as funding account, contract, and governance. The existing Windows NEAR CLI keychain signs one self-directed transaction containing DeployContract and then `new({"governance":"quotacarry-fund-7b29e1.testnet"})` with 30 Tgas and zero deposit. The pinned 227,993-byte WASM and its SHA-256 are unchanged. Use the unsigned planner's Deploy operation to check the artifact and display the exact inputs.

After deployment verification, the same signer can create issuer, relayer, settler, alice, and bob under its account with 0.05 NEAR each and the public keys pinned in the manifest. Governance then calls register_issuer with 0.15 NEAR attached, lifetime cap 100, and max open 4. Each subsequent transaction requires separate authorization. The remaining original Meteor review below is historical.


**Blocked on signers.** Read-only preflight passed on NEAR testnet at finalized block hash `6SsrVCxqtnmKcTAiXLbG6HZM3PF1W7B8YhweWh5JGFKA`. All six proposed accounts were unoccupied. `nevanrg.testnet` has one on-chain full-access key. The CLI public-key lookup found no matching key in the local keychain. Confirm a wallet or hardware signer that can approve parent-signed child creation and issuer registration. The six child accounts will each need a distinct approved key and signing flow.

## Funding

The finalized balance was 3.2 NEAR, with 0.00182 NEAR reserved for 182 bytes of storage and 3.19818 NEAR spendable. Parent allocations are 2.50 NEAR to the contract, 0.25 NEAR across the five other roles and 0.15 NEAR to the contract for issuer storage. This totals 2.90 NEAR before fees. The 2.27993 NEAR WASM stake is inside the 2.50 NEAR allocation. The remaining 0.22007 NEAR there covers contract account, key, initializer state and deploy fees. The issuer pool covers one issuer, one policy, two passes and four callbacks at 0.11520 NEAR. Reservation and settlement storage are covered within each live pass allocation.

At the observed gas price of 100 million yoctoNEAR per gas, six basic child-creation batches at about 8.35 Tgas each cost about 0.00501 NEAR. Budgeting the full 30 Tgas for registration and its action overhead gives a parent base estimate of about 2.9082 NEAR and about 0.2900 NEAR spendable remaining. The manifest's conservative planned envelope is 3.00 NEAR, including a 0.10 NEAR reserve, leaving 0.19818 NEAR. Recheck fees and balances before signing. Each role starts with 0.05 NEAR and pays its own later fees. Receiver contract deployment and live transfer-call compatibility need a separately priced checkpoint.

## Artifact and authority

[CI artifact 14096755900](https://github.com/nevan-sonic/QuotaCarry/actions/runs/43550812750/artifacts/14096755900) is tied to source `c62abe6d04205a992120bcc7eff4d8c3af099bf4`. The cached `quota_pass.wasm` is 227,993 bytes and hashes to `1bae619e7c7dbfc12d710468a4a9cfed78c55eed3854e79802b5a1a648956e5c`. The current contract source has no diff from that commit. Deploy and initialize in one self-signed action batch on the contract account. The initializer requires the contract account as predecessor and takes `{"governance":"nevanrg.testnet"}`. Governance registers the issuer. The controller owns policy creation and issuance, the authorizer can reserve on behalf of a current holder, and the settler can consume or release an open reservation. The relayer remains trusted to authenticate holders. The contract-account full-access key can replace the WASM and needs separate custody. The sandbox covered NEP-171 receiver and handoff behavior. Internal resolver out-of-gas and testnet gas remain unverified.

## Transaction sequence

All rows use NEAR testnet. Names abbreviated below expand to `<role>.nevanrg.testnet`. Parent means `nevanrg.testnet`. Contract calls target `contract.nevanrg.testnet`, attach 30 Tgas, and have zero attached deposit unless shown. The controller and settler must reconcile finalized state between dependent transactions. The faucet funding account has no role.

| Step | Signer | Receiver and actions | Deposit in NEAR and yoctoNEAR | Finalized check |
|---|---|---|---|---|
| 1 | Parent | Contract: CreateAccount, Transfer, AddKey | 2.50 / 2500000000000000000000000 | Account, balance and approved full-access public key |
| 2 | Parent | Issuer: same actions | 0.05 / 50000000000000000000000 | Account, balance and approved key |
| 3 | Parent | Relayer: same actions | 0.05 / 50000000000000000000000 | Account, balance and approved key |
| 4 | Parent | Settler: same actions | 0.05 / 50000000000000000000000 | Account, balance and approved key |
| 5 | Parent | Alice: same actions | 0.05 / 50000000000000000000000 | Account, balance and approved key |
| 6 | Parent | Bob: same actions | 0.05 / 50000000000000000000000 | Account, balance and approved key |
| 7 | Contract | Contract: DeployContract and `new({"governance":"nevanrg.testnet"})` | 0 / 0 | Successful action receipt, decoded code SHA-256 and initialized empty state |
| 8 | Parent | Contract: `register_issuer` with controller issuer, authorizer relayer, settler settler, lifetime cap `"100"`, max open `4` | 0.15 / 150000000000000000000000 | Issuer ID and all roles via `get_issuer` |
| 9 | Issuer | Contract: `create_policy` with finalized issuer ID, reviewed policy hash, lifetime cap `"100"`, max open `4` | 0 / 0 | Policy ID, hash and limits via `get_policy` |
| 10 | Issuer | Contract: `issue` with finalized policy ID, receiver Alice, amount `"100"`, issue sequence `"0"` | 0 / 0 | Mint event and 100 available under Alice |
| 11 | Relayer | Contract: `reserve` for Alice, epoch `"0"`, seq `"0"` | 0 / 0 | 99 available, one open |
| 12 | Relayer | Contract: `reserve` for Alice, epoch `"0"`, seq `"1"` | 0 / 0 | 98 available, two open |
| 13 | Relayer | Contract: `reserve` for Alice, epoch `"0"`, seq `"2"` | 0 / 0 | 97 available, three open |
| 14 | Alice | Contract: `nft_transfer` to Bob | 0.000000000000000000000001 / 1 | Bob owns pass at epoch 1, three open |
| 15 | Relayer | Contract: `reserve` naming Alice, stale epoch `"0"`, seq `"3"` | 0 / 0 | Finalized stale-owner failure and unchanged state |
| 16 | Relayer | Contract: `reserve` for Bob, epoch `"1"`, seq `"3"` | 0 / 0 | 96 available, four open |
| 17 | Settler | Contract: `settle` seq `"0"`, consume | 0 / 0 | One consumed, three open |
| 18 | Settler | Contract: `settle` seq `"1"`, consume | 0 / 0 | Two consumed, two open |
| 19 | Settler | Contract: `settle` seq `"2"`, release | 0 / 0 | 97 available under Bob, one open |
| 20 | Settler | Contract: `settle` seq `"3"`, release | 0 / 0 | Conservation 100 = 98 available + 0 open + 2 consumed |

Steps 1–6 each require the verified parent signer and the corresponding approved public key. Allow a proposed maximum of 2.77 NEAR total for this checkpoint, covering 2.75 NEAR in child funding and up to 0.02 NEAR in fees. Each subsequent signer depends on confirmed provisioning of its own key. Use interactive approval when using a wallet or hardware signer. Account creation and plain transfers have protocol action fees without prepaid function-call gas. The quoted fee cap is an approval limit, not an enforced on-chain cap.

Separate approvals are required before steps 1–6, step 7, steps 8–9, step 10 and steps 11–20. The initial checkpoint needs six approved public keys and a confirmed parent signer before it is executable. Later JSON depends on finalized issuer, policy and token IDs, a reviewed policy hash, and a distinct opaque commitment and fresh height deadline for each reserve. Use the [unsigned PowerShell planner](../scripts/New-TestnetTransactionPlan.ps1) and [API reference](CONTRACT_SPEC.md) to materialize and review those exact values at each checkpoint. No ready-to-sign command is supplied with unresolved key or transaction inputs. If any receipt fails or is ambiguous, stop, query the original hash to FINAL and reconcile account, code or ledger state before asking for a retry. Verify all prior receipts before continuing.
