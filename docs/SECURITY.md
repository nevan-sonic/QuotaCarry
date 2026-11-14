# V2 security and recovery

The live contract recognizes a designated relayer and trusts it to authenticate the holder. The gateway uses NEP-413 and a finalized full-access key check for wallet sessions. An opaque developer credential delegates access to one NFT, one issuer and policy, one model, and one ownership epoch. The contract rechecks owner and epoch when it applies a reservation.

Credential rotation requires a wallet session and finalized entitlement. The old credential is revoked in the same D1 statement that creates its successor. Rotation preserves scope and expiration. Already dispatched jobs retain their settlement obligations.

An issuer team belongs to a finalized controller. Administrators can manage adapters and developer or viewer memberships. Only the controller can appoint or remove administrators. Invitations are accepted by the target wallet. Team permissions grant no right to spend someone else's NFT credits or sign on-chain calls.

The gateway only sends requests to configured Worker bindings. Each adapter uses a separate HMAC identity and D1 replay database. Treat adapter usage as issuer-reported telemetry. One successful eligible request consumes one credit regardless of reported token usage.

## Recovery

Use the job ID, issuer, adapter revision, reservation hash, and settlement hash to reconcile a job. Read finalized receipt and reservation state before any operator action. If a provider outcome is unknown, preserve the reservation and leave the job in manual review. Never replay the provider request or infer a settlement from HTTP failure alone. Leave the V2 kill switches closed until manual review has a documented and verified resolution.
