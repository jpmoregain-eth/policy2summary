import Stripe from 'stripe';
import { REPORT } from '../../lib/tiers';
import { rateLimit, clientKey } from '../../lib/store';

export const config = { maxDuration: 30 };

/**
 * Creates a Stripe Checkout session for one combined report.
 *
 * No document text touches this route. The browser holds the extracted text
 * across the redirect and posts it to /api/report on the way back, which means
 * there is no database to build and no policy text sitting on a server waiting
 * to be breached.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!secretKey) {
    return res.status(503).json({ error: 'Payments are not enabled on this deployment.' });
  }

  try {
    // A checkout session costs nothing to create, but an open endpoint that
    // creates them is still worth a ceiling.
    const limit = await rateLimit(`checkout:${clientKey(req)}`, 20, 3600);
    if (!limit.allowed) {
      return res.status(429).json({ error: 'Too many attempts. Please try again shortly.' });
    }

    const { documentCount = 1 } = req.body || {};
    const count = Math.max(1, Math.min(Number(documentCount) || 1, REPORT.maxDocuments));

    const origin = process.env.NEXT_PUBLIC_SITE_URL
      || (req.headers.origin
        || `https://${req.headers['x-forwarded-host'] || req.headers.host}`);

    const stripe = new Stripe(secretKey);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: REPORT.price.currency,
          unit_amount: REPORT.price.unitAmount,
          product_data: {
            name: count > 1
              ? `Policy2Summary combined report (${count} policies)`
              : 'Policy2Summary full policy report',
            description: 'One PDF report covering every policy you uploaded, read in full.'
          }
        }
      }],
      success_url: `${origin}/?report={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      metadata: { documentCount: String(count) }
    });

    res.status(200).json({ id: session.id, url: session.url });

  } catch (err) {
    console.error('Checkout error:', err);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
}
