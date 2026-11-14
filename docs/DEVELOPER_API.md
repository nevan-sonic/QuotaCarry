# QuotaCarry developer API preview

The preview binds each developer credential to a V2 NFT, its owner, issuer, policy, ownership epoch, and model. Authenticate with the existing NEP-413 wallet flow, then send the wallet session as a bearer credential to `POST /v2/tokens` with `{"nft":"<token ID>","name":"local integration","model":"openai/gpt-oss-20b","ttlMinutes":60}`. The response reveals the developer credential once. List credentials with `GET /v2/tokens` and revoke with `POST /v2/tokens` using `{"revokeId":"<credential ID>"}`. Times to live range from 5 to 1,440 minutes and default to 1,440.

Credentials expire after 24 hours. D1 stores a hash. The gateway checks finalized ownership and epoch on developer requests and again before reserving. The contract checks the expected epoch during reservation. A transfer invalidates credentials from the old epoch, including if the NFT later returns to the same owner. Work already reserved follows the contract's settlement rules.

Use a developer bearer credential with `GET /v1/models`, `GET /v1/entitlements`, `GET /v1/usage`, `GET /v1/jobs/{job_id}`, or `POST /v1/chat/completions`. The usage endpoint lists job states and receipt hashes. Completions accept one user message up to 768 UTF-8 bytes, the credential's model, and a 256-token completion limit. The endpoint returns HTTP 202 while the durable job is pending and an OpenAI-shaped completion after finalized settlement. This asynchronous subset requires an HTTP client that handles 202 and repeats the same request body and idempotency key. Stop on terminal errors.

```sh
curl --fail-with-body "$QC_GATEWAY/v1/entitlements" \
  -H "Authorization: Bearer $QC_DEVELOPER_TOKEN"
```

## Python

```python
import os, time, uuid, requests

url = os.environ["QC_GATEWAY"] + "/v1/chat/completions"
headers = {
    "Authorization": "Bearer " + os.environ["QC_DEVELOPER_TOKEN"],
    "Idempotency-Key": str(uuid.uuid4()),
}
body = {"model": "openai/gpt-oss-20b", "messages": [
    {"role": "user", "content": "Explain what an NFT ownership epoch is."}
], "max_completion_tokens": 256}
for _ in range(60):
    response = requests.post(url, headers=headers, json=body, timeout=20)
    response.raise_for_status()
    if response.status_code == 200:
        print(response.json()["choices"][0]["message"]["content"])
        break
    if response.status_code != 202:
        raise RuntimeError(f"Unexpected status {response.status_code}")
    time.sleep(10)
else:
    raise TimeoutError("Job still pending. Resume with the same idempotency key.")
```

## JavaScript

```js
const headers = {
  Authorization: 'Bearer ' + process.env.QC_DEVELOPER_TOKEN,
  'Idempotency-Key': crypto.randomUUID(),
  'Content-Type': 'application/json',
};
const body = JSON.stringify({
  model: 'openai/gpt-oss-20b',
  messages: [{role: 'user', content: 'Explain what an NFT ownership epoch is.'}],
  max_completion_tokens: 256,
});
for (let attempt = 0; ; attempt++) {
  const response = await fetch(process.env.QC_GATEWAY + '/v1/chat/completions', {
    method: 'POST', headers, body, signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 200) {
    console.log((await response.json()).choices[0].message.content);
    break;
  }
  if (response.status !== 202) throw Error('Request failed: ' + response.status);
  if (attempt === 59) throw Error('Job still pending. Resume with the same idempotency key.');
  await new Promise(resolve => setTimeout(resolve, 10_000));
}
```

Keep the credential in server-side configuration. Persist the idempotency key alongside an application request if it must survive a restart. Use a staging environment with both V2 flags enabled and a verified adapter for these examples.

## Issuer-operated reference adapter

Run these commands from `apps/gateway` in the issuer's own Cloudflare account. Create a D1 database using `wrangler d1 create quotacarry-issuer-adapter` and enter the returned ID in a local copy of `wrangler.adapter.toml`. Apply its separate migrations using `wrangler d1 migrations apply quotacarry-issuer-adapter --remote --config wrangler.adapter.toml`. Set `ADAPTER_SHARED_KEY` (at least 32 random bytes encoded as text) and `GROQ_API_KEY` using `wrangler secret put NAME --config wrangler.adapter.toml`. Deploy using `wrangler deploy --config wrangler.adapter.toml`. Leave `ADAPTER_ENABLED=0` until its Free-tier policy and caller are verified.

The adapter accepts a signed `POST /v1/verify` or `POST /v1/inference`. The HMAC-SHA256 is hex-encoded and computed over the JSON array `["qc-adapter-v1", timestamp, nonce, path + "\n" + rawBody]`. Send it in `X-QC-Signature` with the millisecond timestamp in `X-QC-Timestamp` and a fresh 32-hex-character nonce in `X-QC-Nonce`. Verification returns the model and a proof over the same array with the last value replaced by `"verify-response\n" + JSON.stringify([rawBody, model])`. Inference accepts a JSON object with `model`, `prompt`, and the gateway job ID. The adapter calls a fixed Groq endpoint and keeps its Groq credential in its Worker.

The production gateway keeps both preview flags off. [Architecture and issuer setup](ARCHITECTURE.md) describes the vetted deployment pattern and remaining acceptance checks.

## Contract compatibility

The deployed contract supports one request credit per reservation. Metered token allowances need a separate reviewed contract interface that reserves a maximum token budget, settles verified actual usage, releases the remainder, and preserves conservation across ownership changes and retries. Current request-credit balances cannot be represented as metered token balances. The deployed contract and existing NFTs remain unchanged by the D1 migration.
