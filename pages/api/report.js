import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { executivePrompt, comparePrompt, buildUserMessage, buildComparisonMessage } from '../../lib/prompts';
import { condensePolicyText } from '../../lib/policy-text';
import { parseModelJson } from '../../lib/json-response';
import { REPORT, modeForDocumentCount, paidReportsEnabled, FREE_REPORTS_PER_DAY } from '../../lib/tiers';
import { claimOnce, release, isShared, rateLimit, clientKey } from '../../lib/store';
import { chatCompletion } from '../../lib/providers';

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

  const paid = paidReportsEnabled();

  try {
    const { sessionId, documents } = req.body || {};

    if (paid && (!sessionId || typeof sessionId !== 'string')) {
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

    let freeLimit = null;

    if (paid) {
      // 1. Confirm the money actually arrived. Stripe is the source of truth;
      //    nothing the browser sends is trusted here beyond the session id.
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    } else {
      // Free mode: nothing to verify, so the meter is the only thing standing
      // between this route and an open LLM proxy.
      freeLimit = await rateLimit(`freereport:${clientKey(req)}`, FREE_REPORTS_PER_DAY, 24 * 60 * 60);
      if (!freeLimit.allowed) {
        return res.status(429).json({
          error: `That is ${FREE_REPORTS_PER_DAY} full reports today. Come back tomorrow.`,
          limit_reached: true
        });
      }
      if (!isShared()) {
        console.warn('Free report limit is per-instance: set KV_REST_API_URL/TOKEN to enforce it.');
      }
    }

    /** Hands back whatever was spent to get here, so a failure costs nobody. */
    const refund = async () => {
      if (paid) await release(`report:${sessionId}`);
      else if (freeLimit) await freeLimit.refund();
    };

    // 3. Do the work. From here on every failure path must release the claim —
    //    a customer whose report died on a transient API error has to be able
    //    to try again, and they have already paid.
    const mode = modeForDocumentCount(documents.length);

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

    let content = '';
    let usage = {};
    let usedModel;
    let usedProvider;

    try {
      if (paid) {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
          model: REPORT.model,
          max_tokens: REPORT.maxTokens,
          temperature: 0.1,
          // Byte-identical across every request in a mode, so it caches.
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userMessage }]
        });

        if (response.stop_reason === 'refusal') {
          await refund();
          return res.status(422).json({ error: 'Those documents could not be analysed. Contact us with your payment reference for a refund.' });
        }

        content = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        usage = response.usage || {};
        usedModel = REPORT.model;
        usedProvider = 'anthropic';
      } else {
        const result = await chatCompletion('agnes', {
          system: systemPrompt,
          user: userMessage,
          maxTokens: REPORT.maxTokens
        });
        content = result.content;
        usedModel = result.model;
        usedProvider = 'agnes';
      }
    } catch (err) {
      await refund();
      throw err;
    }

    const parsed = parseModelJson(content);
    if (!parsed.ok) {
      console.error('Report parse failed:', parsed.reason, 'Sample:', parsed.sample);
      await refund();
      return res.status(500).json({
        error: paid
          ? 'The report could not be generated, and you have not been charged for a second attempt. Please try again.'
          : 'The report could not be generated. Please try again.',
        sessionId: paid ? sessionId : undefined,
        retry: true
      });
    }

    const payload = {
      mode,
      paid,
      sessionId: paid ? sessionId : null,
      meta: {
        provider: usedProvider,
        model: usedModel,
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
    const safeNote = paidReportsEnabled() ? ' Your payment is safe —' : '';

    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: `The AI service is busy.${safeNote} try again in a minute.`, retry: true });
    }
    if (err instanceof Anthropic.APIError || err.status) {
      console.error(`Report provider error ${err.status}:`, err.message, err.detail || '');
      return res.status(502).json({ error: `The AI service is temporarily unavailable.${safeNote} try again shortly.`, retry: true });
    }
    console.error('Report generation error:', err);
    res.status(500).json({ error: 'Report generation failed. Please try again.', retry: true });
  }
}
