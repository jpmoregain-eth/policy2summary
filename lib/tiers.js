/**
 * Tier definitions.
 *
 * The tiers differ along three axes, in descending order of how much they
 * actually change the output the reader sees:
 *
 *   1. How much of the document the model reads. This is the largest quality
 *      lever by a wide margin — a 30-page policy read to page 4 will miss the
 *      exclusions no matter how good the model is.
 *   2. Which analysis modes are available (single summary vs. executive report
 *      vs. multi-policy comparison).
 *   3. How many runs per day.
 *
 * Deliberately NOT a difference: the grounding rules. Free users get the same
 * "never invent a figure" discipline as paid ones. Accuracy is not an upsell.
 */

const TIERS = {
  free: {
    id: 'free',
    label: 'Free',
    model: 'claude-haiku-4-5',
    contextChars: 30000,
    maxTokens: 6000,
    modes: ['standard'],
    maxDocuments: 1,
    dailyRuns: 3,
    pdfExport: false,
    features: [
      'Plain-English summary of one policy',
      'Coverage, exclusions, premiums and key dates',
      'What the document does not tell you',
      'Questions to ask your agent'
    ]
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    model: 'claude-haiku-4-5',
    contextChars: 150000,
    maxTokens: 8000,
    modes: ['standard', 'executive', 'compare'],
    maxDocuments: 5,
    dailyRuns: 100,
    pdfExport: true,
    features: [
      'Everything in Free, on the full policy wording rather than the first few pages',
      'Executive report with severity-ranked red flags and evidence quotes',
      'Branded PDF export',
      'Multi-policy comparison across up to 5 policies',
      'Sub-limits, charges and waiting-period analysis'
    ]
  }
};

function getTier(id) {
  return TIERS[id] || TIERS.free;
}

/** Whether a tier may run a given analysis mode. */
function tierAllowsMode(tierId, mode) {
  return getTier(tierId).modes.includes(mode);
}

module.exports = { TIERS, getTier, tierAllowsMode };
