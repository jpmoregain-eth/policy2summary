import Anthropic from '@anthropic-ai/sdk';
import { standardPrompt, executivePrompt, comparePrompt, buildUserMessage, buildComparisonMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';
import { getTier, tierAllowsMode } from '../../lib/tiers';

export const config = { maxDuration: 60 };

const MAX_INPUT_CHARS = 600000;

/**
 * Claude Haiku 4.5 analysis endpoint, tier-aware.
 *
 * Two things this route does that the Agnes routes cannot:
 *  - a 200K context window, so the Pro tier reads the whole policy wording
 *    instead of the first few pages;
 *  - prompt caching on the system prompt, which is byte-identical on every
 *    request in a mode. Worth having, but keep it in proportion: the prompt is
 *    ~3.1K tokens against a document of up to ~37K, so caching trims a fraction
 *    of a cent. Output tokens are the larger cost on the free tier, and the
 *    document is the larger cost on Pro.
 *
 * Inert without ANTHROPIC_API_KEY — the existing routes are untouched.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(503).json({ error: 'Claude analysis is not enabled on this deployment.' });
  }

  try {
    const { text, documents, mode = 'standard', tier: tierId = 'free', fileName = null } = req.body || {};
    const tier = getTier(tierId);

    if (!tierAllowsMode(tier.id, mode)) {
      return res.status(402).json({
        error: `The ${tier.label} plan does not include ${mode} analysis.`,
        upgrade_required: true,
        tier: tier.id
      });
    }

    const client = new Anthropic({ apiKey });
    const isCompare = mode === 'compare';

    let systemPrompt;
    let userMessage;
    let truncated = false;
    let charsAnalysed = 0;
    let charsSupplied = 0;

    if (isCompare) {
      if (!Array.isArray(documents) || documents.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 documents to compare.' });
      }
      if (documents.length > tier.maxDocuments) {
        return res.status(402).json({
          error: `The ${tier.label} plan compares up to ${tier.maxDocuments} policies at a time.`,
          upgrade_required: true,
          tier: tier.id
        });
      }

      const totalChars = documents.reduce((sum, d) => sum + String(d?.text || '').length, 0);
      if (totalChars > MAX_INPUT_CHARS) {
        return res.status(413).json({ error: 'Those documents are too large to compare.' });
      }
      charsSupplied = totalChars;

      const perDoc = Math.max(9000, Math.floor(tier.contextChars / documents.length));
      const prepared = documents.map((doc, idx) => {
        const condensed = condensePolicyText(doc.text, perDoc, { headChars: 3000 });
        if (condensed.truncated) truncated = true;
        charsAnalysed += condensed.text.length;
        return { name: doc.name || `Policy ${idx + 1}`, text: condensed.text };
      });

      systemPrompt = comparePrompt(documents.length);
      userMessage = buildComparisonMessage(prepared);
    } else {
      if (!text || text.length < 50) {
        return res.status(400).json({ error: 'Insufficient text extracted. Please upload a clearer document.' });
      }
      if (text.length > MAX_INPUT_CHARS) {
        return res.status(413).json({ error: 'Document is too large to analyse.' });
      }

      const condensed = condensePolicyText(text, tier.contextChars);
      truncated = condensed.truncated;
      charsAnalysed = condensed.text.length;
      charsSupplied = condensed.originalChars;

      systemPrompt = mode === 'executive' ? executivePrompt() : standardPrompt();
      userMessage = buildUserMessage(condensed.text, { ...condensed, fileName });
    }

    const response = await client.messages.create({
      model: tier.model,
      max_tokens: tier.maxTokens,
      temperature: 0.1,
      // The system prompt is byte-identical across every request in a mode, so
      // it caches cleanly. The document goes in the user turn, after the
      // breakpoint, where it cannot invalidate the cached prefix.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }]
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'This document could not be analysed. Please try a different file.' });
    }

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    const parsed = parseModelJson(content);
    if (!parsed.ok) {
      console.error('JSON parse failed:', parsed.reason, 'Sample:', parsed.sample);
      return res.status(500).json({ error: 'AI response format error. Please try again.', retry: true });
    }

    const usage = response.usage || {};
    const payload = {
      mode,
      tier: tier.id,
      meta: {
        provider: 'anthropic',
        model: tier.model,
        truncated,
        chars_analysed: charsAnalysed,
        chars_supplied: charsSupplied,
        json_repaired: parsed.repaired,
        stop_reason: response.stop_reason,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens
        }
      }
    };

    if (isCompare) payload.comparison = parsed.data;
    else payload.analysis = parsed.data;

    res.status(200).json(payload);

  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Too many requests right now. Please try again in a minute.', retry: true });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic auth error:', err.message);
      return res.status(500).json({ error: 'AI service not configured correctly.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${err.status}:`, err.message);
      return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.', retry: true });
    }
    console.error('Claude analysis error:', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.', retry: true });
  }
}
