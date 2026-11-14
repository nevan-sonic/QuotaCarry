# QuotaCarry contract API

Phase 1 implements this API in the quota-pass Rust crate. IDs and amounts use decimal JSON strings where typed as U64/U128. Token IDs are decimal strings. Counts and page limits are JSON numbers. State layout version is 1. The contract account initializes with `new({"governance":"governance.testnet"})`. The examples use illustrative accounts and are suitable for sandbox tests with matching accounts.

| Method | JSON arguments and return |
|---|---|
| `register_issuer` | Governance, payable. `{"controller":"issuer.testnet","authorizer":"relay.testnet","settler":"settler.testnet","lifetime_cap":"100","max_open":8}` → issuer ID string. Deposit funds storage. |
| `fund_storage` | Controller, payable. `{"issuer_id":"0"}` → total funded yoctoNEAR string. |
| `rotate_roles` | Controller. Same three account keys as registration plus `issuer_id`. |
| `set_emergency_pause` | Governance, `{"paused":true}`. |
| `set_issuer_pause` | Controller, `{"issuer_id":"0","paused":true}`. |
| `set_policy_suspension` | Controller, `{"policy_id":"0","suspended":true}`. |
| `create_policy` | Controller, `{"issuer_id":"0","policy_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","lifetime_cap":"100","max_open":4}` → policy ID string. |
| `issue` | Controller, `{"policy_id":"0","receiver_id":"alice.testnet","amount":"100","expected_issue_seq":"0"}` → token ID string. Uses prepaid storage. |
| `split` | Holder and 1 yoctoNEAR. `{"token_id":"0","amount":"10","expected_epoch":"0","expected_mutation_seq":"0"}` → child token ID string. |
| `merge` | Holder and 1 yoctoNEAR. `{"target_id":"0","source_id":"1","target_epoch":"0","source_epoch":"0","target_mutation_seq":"1","source_mutation_seq":"0"}` → null. Both mutation sequences are required. |
| `reserve` | Authorizer, zero deposit. `{"token_id":"0","holder_id":"alice.testnet","expected_epoch":"0","seq":"0","request_commitment":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","valid_through_height":"100"}` → null on success. Deadline must be current height through current height + 120. |
| `settle` | Settler, zero deposit. `{"token_id":"0","seq":"0","disposition":"release"}` → `"applied"`, `"duplicate"`, `"conflict"`, or `"no_evidence"`. `consume` is the other disposition. |
| `get_allowance` | `{"token_id":"0"}` → pass or null. After a reserve on a newly issued 100-credit pass, example `{"owner_id":"alice.testnet","issuer_id":"0","policy_id":"0","available":"99","open":1,"epoch":"0","next_reservation_seq":"1","mutation_seq":"0","pending":0}`. |
| `get_reservation` | `{"token_id":"0","seq":"0"}` → open reservation or null. |
| `get_issuer`, `get_policy`, `is_emergency_paused` | Query by issuer ID, policy ID, or empty arguments. Policy includes issued, available, open and consumed totals. |

NFT methods implement NEP-171 transfer and callback behavior. `nft_token` takes token ID, and `nft_transfer` takes receiver ID, token ID, optional approval ID and memo. `nft_transfer_call` adds `msg` and resolves to a boolean. Both transfer methods require 1 yoctoNEAR. Approval management is absent and non-null approval IDs fail. Memos are capped at 256 bytes and receiver messages at 4,096 bytes. `nft_resolve_transfer` is private and uses token ID and transfer ID. NEP-177 `nft_metadata` returns static collection metadata. NEP-181 methods are `nft_total_supply`, `nft_supply_for_owner`, `nft_tokens` and `nft_tokens_for_owner`. Pagination uses optional `from_index` and `limit` with pages capped at 50. Index order can change after a burn or transfer.

Standard event data uses the SDK event structs and a NEP-171 1.2.0 envelope, since the pinned SDK emitter hardcodes 1.0.0. QuotaCarry emits NEP-297 events with standard `quotacarry`, version `1.0.0`, event name and a one-item data array. Use successful finalized receipt logs to reconcile historic actions. A pending transfer event only records the provisional state. [NEP-171](https://github.com/near/NEPs/blob/master/neps/nep-0171.md) · [NEP-177](https://github.com/near/NEPs/blob/master/neps/nep-0177.md) · [NEP-181](https://github.com/near/NEPs/blob/master/neps/nep-0181.md) · [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md)
