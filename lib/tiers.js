/**
 * What is free and what is paid.
 *
 * The product is the report. Someone can read a per-policy summary on screen
 * for nothing, and pays once when they want the combined PDF they can keep,
 * print, or take to their agent.
 *
 * Priced per report, not per policy: one price whether you upload one policy or
 * five. Charging per policy would tax the exact behaviour that makes this
 * useful — putting a household's whole set in front of the model at once.
 *
 * What the tiers do NOT differ on: the grounding rules in lib/prompts.js. Free
 * summaries are as careful about inventing figures as paid ones. Accuracy is
 * not an upsell.
 */

const FREE = {
  id: 'free',
  label: 'Free',
  // Stays on the existing Agnes key. The Anthropic credit is reserved for
  // requests that arrive with money attached.
  provider: 'agnes',
  modes: ['standard'],
  contextChars: 30000,
  maxTokens: 6000,
  maxDocuments: 5,
  pdfExport: false,
  // Per IP per day. The one number to revisit once real usage exists.
  dailyRuns: 3,
  features: [
    'Plain-English summary of each policy, on screen',
    'Coverage, exclusions, premiums and key dates',
    'What the document does not tell you',
    'Questions to ask your agent'
  ]
};

const REPORT = {
  id: 'report',
  label: 'Full Report',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  modes: ['executive', 'compare'],
  // Haiku's 200K window is what makes reading a whole policy wording possible.
  contextChars: 150000,
  maxTokens: 8000,
  minDocuments: 1,
  maxDocuments: 5,
  pdfExport: true,
  price: {
    currency: 'sgd',
    // Stripe works in the smallest currency unit.
    unitAmount: 490,
    display: 'S$4.90'
  },
  features: [
    'Reads the full policy wording, not just the opening pages',
    'One combined report across up to 5 policies',
    'Severity-ranked red flags, each with a quote from your document',
    'Sub-limits, charges and waiting periods pulled out in full',
    'Branded PDF you can keep, print or hand to your agent'
  ]
};

const TIERS = { free: FREE, report: REPORT };

function getTier(id) {
  return TIERS[id] || FREE;
}

/** Picks the analysis mode from how many policies were uploaded. */
function modeForDocumentCount(count) {
  return count >= 2 ? 'compare' : 'executive';
}

function tierAllowsMode(tierId, mode) {
  return getTier(tierId).modes.includes(mode);
}

module.exports = { TIERS, FREE, REPORT, getTier, tierAllowsMode, modeForDocumentCount };
