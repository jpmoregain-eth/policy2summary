import { standardPrompt, executivePrompt, buildUserMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';

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

    const systemPrompt = mode === 'executive' ? executivePrompt() : standardPrompt();
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
      return res.status(502).json({ error: 'AI analysis service temporarily unavailable. Please try again.' });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(content);

    if (!parsed.ok) {
      console.error('JSON parse failed:', parsed.reason, 'Sample:', parsed.sample);
      return res.status(500).json({
        error: 'AI response format error. Please try again with a clearer document.',
        raw: parsed.sample
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
