# Testnet account roles

The proposed roles are defined in the machine-readable manifest. Use only public account IDs in the reviewed manifest. Verify every ID at a finalized testnet block with `view_account`. Check available balance, deployed code and access-key permissions before approval. Keep key material in the approved local signer or wallet.

| Role | Required permissions and funding |
|---|---|
| Contract account and deployer | Fresh account with an authorized full-access signer. Pays for code storage and deploy/initialization gas. The initializer requires the contract account as predecessor. Review all full-access keys because they can replace the contract. |
| Governance | Registers the issuer and can pause future issuance/reservations. Pays the issuer registration deposit and gas. May equal the contract account if explicitly selected in the manifest. |
| Issuer/controller | Creates policy, tops up storage, issues passes, rotates issuer roles, and pauses issuance/reservation. Needs gas and any separately approved funding deposit. |
| Reservation relayer | Signs zero-deposit `reserve` calls. Use a contract- and method-scoped function-call key where practical. Fund gas. The gateway will ultimately trust the relayer to authenticate holders. |
| Settlement operator | Signs zero-deposit `settle` calls. Use a separately scoped key and fund gas. |
| Alice and Bob | Distinct holders. Owner actions require 1 yoctoNEAR plus gas. Each signs using their approved wallet. |

Funding, governance, and the deployed contract use `quotacarry-fund-7b29e1.testnet`. The five pending accounts use the `issuer`, `relayer`, `settler`, `alice`, and `bob` prefixes under that account. Their exact IDs and public keys are in the [manifest](../infra/testnet-deployment.json).

Keep the issuer/controller, relayer, settler and two holders distinct from each other and the deployment/governance role. A separate receiver deployment needs separate approval. Existing local accounts for unrelated projects do not establish authorization for QuotaCarry.
