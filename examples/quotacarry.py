"""Submit and poll a QuotaCarry request without changing its idempotency key."""
import time
from urllib.parse import urlsplit

import requests


def complete(base_url, token, model, prompt, idempotency_key):
    url = urlsplit(base_url)
    if url.scheme != "https" and url.hostname != "localhost":
        raise ValueError("Gateway requires HTTPS")
    endpoint = base_url.rstrip("/") + "/v1/chat/completions"
    headers = {"Authorization": "Bearer " + token, "Idempotency-Key": idempotency_key}
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_completion_tokens": 256,
    }
    for _ in range(60):
        response = requests.post(endpoint, json=body, headers=headers, timeout=15,
                                 allow_redirects=False)
        if response.status_code == 200:
            return response.json()
        if response.status_code != 202:
            raise RuntimeError(f"QuotaCarry request failed with HTTP {response.status_code}")
        time.sleep(10)
    raise TimeoutError("QuotaCarry job pending. Resume with the same idempotency key.")
