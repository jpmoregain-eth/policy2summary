/**
 * Where the free-tier summaries are generated.
 *
 * Agnes has retired a model three times now (1.5-pro, then 1.5-flash and
 * 2.0-flash, now 3.0-flash), and each time it meant a code change and a deploy
 * to chase it. The model id is an environment variable so the next one is a
 * Vercel setting instead.
 *
 * Paid reports do not come through here — they run on Claude via lib/tiers.js.
 */

const PROVIDERS = {
  agnes: {
    label: 'Agnes AI',
    baseUrl: process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
    model: process.env.AGNES_MODEL || 'agnes-3.0-flash',
    apiKey: () => process.env.AGNES_API_KEY || ''
  },
  kimi: {
    label: 'Kimi',
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    model: process.env.KIMI_MODEL || 'kimi-k2.6',
    apiKey: () => process.env.KIMI_API_KEY || ''
  }
};

function getProvider(id) {
  return PROVIDERS[id] || null;
}

/**
 * One OpenAI-compatible chat call. Both Agnes and Kimi speak this shape, and
 * every route that talks to them was otherwise repeating the same fetch.
 * Returns the raw assistant text; parsing is the caller's job.
 */
async function chatCompletion(providerId, { system, user, maxTokens = 6000, temperature = 0.1 }) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const apiKey = provider.apiKey();
  if (!apiKey) throw new Error(`${providerId} API not configured`);

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`${providerId} API error: ${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }

  const data = await response.json();
  return { content: data.choices?.[0]?.message?.content || '', model: provider.model };
}

module.exports = { PROVIDERS, getProvider, chatCompletion };
