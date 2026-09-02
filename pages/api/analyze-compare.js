import { comparePrompt, buildComparisonMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';

export const config = { maxDuration: 60 };

const MAX_DOCUMENTS = 5;
const MAX_INPUT_CHARS = 400000;

// Split across however many policies were uploaded, with a floor so a
// five-policy comparison still sees the exclusions in each one.
const TOTAL_COMPARE_CHARS = Number(process.env.COMPARE_CONTEXT_CHARS || 60000);
const MIN_CHARS_PER_DOC = 9000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { documents } = req.body;

    if (!Array.isArray(documents) || documents.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 documents to compare.' });
    }
    if (documents.length > MAX_DOCUMENTS) {
      return res.status(400).json({ error: `Please compare at most ${MAX_DOCUMENTS} policies at a time.` });
    }

    const totalChars = documents.reduce((sum, d) => sum + String(d?.text || '').length, 0);
    if (totalChars > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: 'Those documents are too large to compare. Please upload shorter extracts.' });
    }

    const API_KEY = process.env.AGNES_API_KEY || '';
    if (!API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    const perDoc = Math.max(MIN_CHARS_PER_DOC, Math.floor(TOTAL_COMPARE_CHARS / documents.length));
    let anyTruncated = false;

    const prepared = documents.map((doc, idx) => {
      const condensed = condensePolicyText(doc.text, perDoc, { headChars: 3000 });
      if (condensed.truncated) anyTruncated = true;
      return { name: doc.name || `Policy ${idx + 1}`, text: condensed.text, condensed };
    });

    const userMessage = buildComparisonMessage(prepared) + (anyTruncated
      ? '\n\nNOTE: One or more documents were shortened to fit; removed sections are marked [...]. Treat anything you cannot see as unknown rather than absent, and say so in document_assessment.'
      : '');

    const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'agnes-2.0-flash',
        messages: [
          { role: 'system', content: comparePrompt(documents.length) },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.1,
        max_tokens: 8000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Agnes API error:', errorText);
      return res.status(502).json({ error: 'AI comparison service temporarily unavailable.', retry: true });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(content);

    if (!parsed.ok) {
      console.error('JSON parse failed:', parsed.reason, 'Sample:', parsed.sample);
      return res.status(500).json({ error: 'AI response format error. Please try with fewer or clearer documents.', retry: true });
    }

    res.status(200).json({
      comparison: parsed.data,
      meta: {
        provider: 'agnes',
        model: 'agnes-2.0-flash',
        documents: documents.length,
        truncated: anyTruncated,
        json_repaired: parsed.repaired
      }
    });

  } catch (err) {
    console.error('Comparison error:', err);
    res.status(500).json({ error: err.message || 'Comparison failed. Please try again.', retry: true });
  }
}
