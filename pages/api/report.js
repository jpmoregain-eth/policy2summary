import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { executivePrompt, comparePrompt, buildUserMessage, buildComparisonMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';
import { REPORT, modeForDocumentCount } from '../../lib/tiers';
import { claimOnce, release, isShared } from '../../lib/store';

export const config = { maxDuration: 60 };

const MAX_INPUT_CHARS = 600000;
// A paid session stays redeemable for a week, so someone who loses the tab can
// come back to their link rather than paying twice.
const REDEMPTION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Generates the paid report, and only after Stripe confirms payment.
 *
 * Running the expensive analysis on this side of the paywall does three things
 * at once: there is nothing to bypass, the Anthropic bill only moves when
 * revenue does, and a visitor who never pays costs nothing beyond the free
 * summaries they already read.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  if (!stripeKey || !anthropicKey) {
    return res.status(503).json({ error: 'Paid reports are not enabled on this deployment.' });
  }

  try {
    const { sessionId, documents } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing payment reference.' });
    }
    if (!Array.isArray(documents) || documents.length < REPORT.minDocuments) {
      return res.status(400).json({ error: 'Upload at least one policy to generate a report.' });
    }
    if (documents.length > REPORT.maxDocuments) {
      return res.status(400).json({ error: `A report covers up to ${REPORT.maxDocuments} policies.` });
    }

    const totalChars = documents.reduce((sum, d) => sum + String(d?.text || '').length, 0);
    if (totalChars < 50) {
      return res.status(400).json({ error: 'Not enough text was extracted from those documents.' });
    }
    if (totalChars > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: 'Those documents are too large to analyse.' });
    }

    // 1. Confirm the money actually arrived. Stripe is the source of truth;
    //    nothing the browser sends is trusted here beyond the session id.
    const stripe = new Stripe(stripeKey);
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
      return res.status(404).json({ error: 'That payment reference could not be found.' });
    }

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'This payment has not completed.', payment_status: session.payment_status });
    }

    // 2. One generation per payment. The client caches the result so ordinary
    //    re-downloads never come back here.
    const claimed = await claimOnce(`report:${sessionId}`, REDEMPTION_TTL_SECONDS);
    if (!claimed) {
      return res.status(409).json({
        error: 'This report has already been generated. It is saved in this browser — reload the page to download it again.',
        already_redeemed: true
      });
    }
    if (!isShared()) {
      console.warn('Redemption claimed in per-instance memory: set KV_REST_API_URL/TOKEN so it holds across invocations.');
    }

    // 3. Do the work. From here on every failure path must release the claim —
    //    a customer whose report died on a transient API error has to be able
    //    to try again, and they have already paid.
    const mode = modeForDocumentCount(documents.length);
    const client = new Anthropic({ apiKey: anthropicKey });

    let systemPrompt;
    let userMessage;
    let truncated = false;
    let charsAnalysed = 0;

    if (mode === 'compare') {
      const perDoc = Math.max(9000, Math.floor(REPORT.contextChars / documents.length));
      const prepared = documents.map((doc, idx) => {
        const condensed = condensePolicyText(doc.text, perDoc, { headChars: 3000 });
        if (condensed.truncated) truncated = true;
        charsAnalysed += condensed.text.length;
        return { name: doc.name || `Policy ${idx + 1}`, text: condensed.text };
      });
      systemPrompt = comparePrompt(documents.length);
      userMessage = buildComparisonMessage(prepared);
    } else {
      const only = documents[0];
      const condensed = condensePolicyText(only.text, REPORT.contextChars);
      truncated = condensed.truncated;
      charsAnalysed = condensed.text.length;
      systemPrompt = executivePrompt();
      userMessage = buildUserMessage(condensed.text, { ...condensed, fileName: only.name || null });
    }

    let response;
    try {
      response = await client.messages.create({
        model: REPORT.model,
        max_tokens: REPORT.maxTokens,
        temperature: 0.1,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }]
      });
    } catch (err) {
      await release(`report:${sessionId}`);
      throw err;
    }

    if (response.stop_reason === 'refusal') {
      await release(`report:${sessionId}`);
      return res.status(422).json({ error: 'Those documents could not be analysed. Contact us with your payment reference for a refund.' });
    }

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    const parsed = parseModelJson(content);
    if (!parsed.ok) {
      console.error('Paid report parse failed:', parsed.reason, 'Sample:', parsed.sample);
      await release(`report:${sessionId}`);
      return res.status(500).json({
        error: 'The report could not be generated, and you have not been charged for a second attempt. Please try again.',
        sessionId,
        retry: true
      });
    }

    const usage = response.usage || {};
    const payload = {
      mode,
      sessionId,
      meta: {
        provider: 'anthropic',
        model: REPORT.model,
        documents: documents.length,
        truncated,
        chars_analysed: charsAnalysed,
        chars_supplied: totalChars,
        json_repaired: parsed.repaired,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens
        }
      }
    };

    if (mode === 'compare') payload.comparison = parsed.data;
    else payload.analysis = parsed.data;

    res.status(200).json(payload);

  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'The AI service is busy. Your payment is safe — try again in a minute.', retry: true });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${err.status}:`, err.message);
      return res.status(502).json({ error: 'The AI service is temporarily unavailable. Your payment is safe — try again shortly.', retry: true });
    }
    console.error('Report generation error:', err);
    res.status(500).json({ error: 'Report generation failed. Contact us with your payment reference.', retry: true });
  }
}
