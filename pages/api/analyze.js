import { standardPrompt, buildUserMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';
import { FREE } from '../../lib/tiers';
import { rateLimit, clientKey, isShared } from '../../lib/store';

// Vercel Pro allows 60s; the client aborts at 55s.
export const config = { maxDuration: 60 };

const MAX_INPUT_CHARS = 400000;
const CONTEXT_BUDGET = Number(process.env.ANALYZE_CONTEXT_CHARS || 30000);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, mode = 'standard', fileName = null } = req.body;

    if (mode !== 'standard') {
      return res.status(402).json({
        error: 'Full reports are a paid feature. Use /api/report after checkout.',
        upgrade_required: true
      });
    }

    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Insufficient text extracted. Please upload a clearer document.' });
    }
    if (text.length > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: 'Document is too large to analyse. Please upload a shorter extract.' });
    }

    const API_KEY = process.env.AGNES_API_KEY || '';
    if (!API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    // The free tier is the only unauthenticated path that spends money, so it
    // is the one that needs a ceiling. Keyed on IP, reset daily.
    const limit = await rateLimit(`free:${clientKey(req)}`, FREE.dailyRuns, 24 * 60 * 60);
    if (!limit.allowed) {
      return res.status(429).json({
        error: `That is ${FREE.dailyRuns} free summaries today. Come back tomorrow, or get a full report covering every policy at once.`,
        limit_reached: true,
        daily_limit: FREE.dailyRuns
      });
    }
    if (!isShared()) {
      console.warn('Rate limiting is per-instance: set KV_REST_API_URL/TOKEN to enforce it across invocations.');
    }

    const systemPrompt = standardPrompt();
    const condensed = condensePolicyText(text, CONTEXT_BUDGET);

    const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'agnes-2.0-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildUserMessage(condensed.text, { ...condensed, fileName }) }
        ],
        temperature: 0.1,
        max_tokens: 6000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Agnes API error:', errorText);
      await limit.refund();
      return res.status(502).json({ error: 'AI analysis service temporarily unavailable. Please try again.' });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(content);

    if (!parsed.ok) {
      console.error('JSON parse failed:', parsed.reason, 'Sample:', parsed.sample);
      await limit.refund();
      return res.status(500).json({
        error: 'AI response format error. Please try again with a clearer document.'
      });
    }

    res.status(200).json({
      analysis: parsed.data,
      mode,
      meta: {
        provider: 'agnes',
        model: 'agnes-2.0-flash',
        truncated: condensed.truncated,
        chars_analysed: condensed.text.length,
        chars_supplied: condensed.originalChars,
        json_repaired: parsed.repaired
      }
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
}
