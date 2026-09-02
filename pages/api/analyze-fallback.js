import { standardPrompt, executivePrompt, buildUserMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';

export const config = { maxDuration: 60 };

const MAX_INPUT_CHARS = 400000;

// The executive report is the paid output, so it gets the larger slice of the
// document. Both are far above the 5,000-character cap the client used to send.
const CONTEXT_BUDGETS = {
  executive: Number(process.env.EXECUTIVE_CONTEXT_CHARS || 45000),
  standard: Number(process.env.ANALYZE_CONTEXT_CHARS || 30000)
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, mode = 'standard', provider = 'agnes', fileName = null } = req.body;

    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Insufficient text extracted. Please upload a clearer document.' });
    }
    if (text.length > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: 'Document is too large to analyse. Please upload a shorter extract.' });
    }

    const isExecutive = mode === 'executive';

    const providers = {
      agnes: {
        apiKey: process.env.AGNES_API_KEY || '',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        model: isExecutive ? 'agnes-2.0-flash' : 'agnes-1.5-flash'
      },
      kimi: {
        apiKey: process.env.KIMI_API_KEY || '',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k2.6'
      }
    };

    const providerConfig = providers[provider];
    if (!providerConfig || !providerConfig.apiKey) {
      return res.status(500).json({ error: `${provider} API not configured` });
    }

    const systemPrompt = isExecutive ? executivePrompt() : standardPrompt();
    const condensed = condensePolicyText(text, CONTEXT_BUDGETS[isExecutive ? 'executive' : 'standard']);

    const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerConfig.apiKey}`
      },
      body: JSON.stringify({
        model: providerConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildUserMessage(condensed.text, { ...condensed, fileName }) }
        ],
        temperature: 0.1,
        max_tokens: isExecutive ? 8000 : 6000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`${provider} API error:`, errorText);
      return res.status(502).json({
        error: `${provider} API error: ${response.status}`,
        provider,
        retry: true
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(content);

    if (!parsed.ok) {
      console.error('JSON parse failed:', parsed.reason, 'Sample:', parsed.sample);
      return res.status(500).json({
        error: 'AI response format error',
        provider,
        raw: parsed.sample,
        retry: true
      });
    }

    res.status(200).json({
      analysis: parsed.data,
      mode,
      provider,
      meta: {
        provider,
        model: providerConfig.model,
        truncated: condensed.truncated,
        chars_analysed: condensed.text.length,
        chars_supplied: condensed.originalChars,
        json_repaired: parsed.repaired
      }
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed', retry: true });
  }
}
