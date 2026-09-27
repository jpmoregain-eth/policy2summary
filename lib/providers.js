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

module.exports = { PROVIDERS, getProvider };
