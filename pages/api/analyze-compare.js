/**
 * Superseded by /api/report, which runs the same multi-policy comparison behind
 * Stripe payment. Kept as an explicit 402 rather than deleted so any cached
 * client still calling it gets a clear answer instead of a 404.
 */
export default async function handler(req, res) {
  res.status(402).json({
    error: 'Multi-policy comparison is part of the paid report.',
    upgrade_required: true
  });
}
