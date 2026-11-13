# QuotaCarry

QuotaCarry is a NEAR-based project for issuing and transferring bounded AI inference allowances. This foundation provides a Next.js landing page, a local HTTP gateway, shared package boundaries and a minimal Rust contract.

## Try the foundation

1. Install Node from `.node-version` (bundled npm 11.19.1). Run `npm ci` from the repository root. Use `npm.cmd` in PowerShell if the npm PowerShell shim is unavailable.
2. Run `npm run dev -w @quotacarry/web` and open http://localhost:3000. The landing page describes the intended product.
3. Run `npm run build -w @quotacarry/gateway`, then `npm start -w @quotacarry/gateway`. Open http://127.0.0.1:3001/health. The gateway reports local process readiness and sends an X-Request-ID header.
4. Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. The workspace checks cover TypeScript, the health endpoint and the production web build.
5. Use the Ubuntu [Foundation checks workflow](https://github.com/nevan-sonic/QuotaCarry/actions) for Rust verification when Windows Application Control blocks Cargo build scripts. On a Linux development machine, install Rust via rustup and Cargo NEAR 0.23.0. From `contracts/quota-pass`, run `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, and `cargo near build non-reproducible-wasm --locked --no-abi`.
6. For a successful workflow run, match its commit SHA to your branch, download `quota-pass-wasm-<commit-sha>`, and run `sha256sum -c SHA256SUMS` on Linux or compare `Get-FileHash quota_pass.wasm -Algorithm SHA256` with the manifest on Windows. The artifact is the foundation contract build.

Gateway configuration is optional and documented in `.env.example`. Set values in the process environment. Never enter provider API keys in chat, browser storage or Git. Later stages will use dedicated provider projects and managed secrets. Browser imports may use the public DTO and SDK workspaces. The gateway remains a private application, with no browser export.

See the [product and architecture plan](docs/QUOTACARRY_PLAN.md), [Phase 0 risk ADR](docs/ADR-0001-FOUNDATION.md) and [verification report](docs/PHASE_0_VERIFICATION.md). The MIT license is the default repository license.
