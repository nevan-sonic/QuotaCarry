# Developer Console

Connect and authenticate a NEAR testnet wallet, then load your NFTs. The console reads finalized available request credits and outstanding reservation counts. The existing My NFTs panel prepares a transfer for wallet approval and checks finalized transaction receipts.

In an enabled environment, select an NFT with a verified issuer adapter, name a credential, select the issuer's model, and set its expiration. Copy the secret while displayed and keep it in server-side environment configuration. Rotation preserves the credential's scope and expiry and immediately invalidates the old secret. Revocation closes the selected credential. See the [API guide](DEVELOPER_API.md) and the [Python wrapper](../examples/quotacarry.py).
