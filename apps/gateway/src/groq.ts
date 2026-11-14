export class ProviderError extends Error {
  constructor(readonly outcome: 'rejected' | 'ambiguous', message: string) {
    super(message);
  }
}

export function createGroqProvider(apiKey: string, model: string, request: typeof fetch = fetch) {
  if (!apiKey || !/^[a-zA-Z0-9/_-]{1,128}$/.test(model)) throw Error('Invalid Groq configuration');
  return async (prompt: string) => {
    if (!prompt.trim() || prompt.length > 4000) throw new ProviderError('rejected', 'Invalid prompt');
    let response: Response;
    try {
      response = await request('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {Authorization: 'Bearer '+apiKey, 'Content-Type': 'application/json'},
        body: JSON.stringify({model, messages:[{role:'user',content:prompt}], max_completion_tokens:512}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ProviderError('ambiguous', 'Provider response unavailable');
    }
    if ([400,401,403,404,413,422,429].includes(response.status)) {
      throw new ProviderError('rejected', 'Provider rejected request');
    }
    if (!response.ok) throw new ProviderError('ambiguous', 'Provider outcome uncertain');
    const payload = await response.json().catch(()=>null);
    const text: unknown = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError('ambiguous', 'Provider returned no usable output');
    return text;
  };
}
