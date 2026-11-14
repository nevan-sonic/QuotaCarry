# Contract tests

The contract crate contains the unit tests. This separate NEAR Workspaces crate isolates the sandbox dependency graph from the pinned contract SDK. Build the QuotaCarry contract and the receiver fixture using Cargo NEAR. Set `QUOTA_PASS_WASM` and `QUOTA_RECEIVER_WASM` to their absolute artifact paths and run `cargo test --locked --test sandbox -- --ignored --nocapture` from this directory on Linux. CI runs both suites. Testnet repetitions need deployment and signing approval.
