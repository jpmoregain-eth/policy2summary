/**
 * Fitting a policy into a context window without throwing away the parts that
 * matter.
 *
 * A naive `text.substring(0, N)` keeps the cover page and the benefit summary
 * and discards the exclusions, the waiting periods and the charges — which is
 * to say it keeps the marketing and deletes the fine print, the exact inverse
 * of what this product is for. This module keeps the front matter (where the
 * insurer, policy number, premium and sums assured live) and then spends the
 * remaining budget on the passages that score highest for claim-critical
 * language, preserving document order and marking every cut with [...].
 */

/** Terms that signal a passage decides whether a claim gets paid. */
const SIGNAL_TERMS = [
  // exclusions and limits
  ['exclusion', 8], ['excluded', 8], ['not covered', 8], ['shall not', 5],
  ['we will not pay', 9], ['no benefit', 6], ['does not cover', 8],
  ['sub-limit', 8], ['sublimit', 8], ['limit', 3], ['maximum', 3], ['cap', 2],
  ['deductible', 8], ['excess', 5], ['co-insurance', 8], ['coinsurance', 8],
  ['co-payment', 8], ['copayment', 8],
  // time
  ['waiting period', 9], ['survival period', 9], ['grace period', 6],
  ['free look', 6], ['cooling-off', 6], ['incontestab', 8],
  ['pre-existing', 9], ['preexisting', 9], ['lapse', 5], ['reinstat', 5],
  ['non-forfeiture', 7], ['suicide', 7],
  // money
  ['premium', 5], ['sum assured', 7], ['sum insured', 7], ['benefit amount', 6],
  ['surrender value', 8], ['cash value', 7], ['allocation rate', 8],
  ['bid-offer', 8], ['fund management charge', 8], ['policy fee', 7],
  ['mortality charge', 8], ['administration charge', 7], ['surrender charge', 8],
  ['guaranteed', 6], ['non-guaranteed', 8], ['illustrated', 5], ['projected', 4],
  // scope
  ['territorial', 6], ['geographical', 5], ['pre-authorisation', 6],
  ['hazardous', 6], ['war', 3], ['terrorism', 5], ['renewal', 5],
  ['claim', 4], ['notify', 4], ['rider', 5], ['endorsement', 5],
  ['schedule of benefits', 7], ['table of benefits', 7]
];

const CUT_MARKER = '\n\n[...]\n\n';

/** Scores one block by claim-critical signal density. */
function scoreBlock(block) {
  const lower = block.toLowerCase();
  let score = 0;
  for (const [term, weight] of SIGNAL_TERMS) {
    let from = 0;
    let hits = 0;
    // count occurrences, but cap the contribution so one repeated word
    // cannot drown out a block that mentions many different signals
    while (hits < 3) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      hits++;
      from = at + term.length;
    }
    score += hits * weight;
  }
  // currency amounts are a strong signal that a block carries real figures
  const amounts = block.match(/(?:[A-Z]{0,3}\$|S\$|USD|SGD|MYR|EUR|GBP|RM)\s?[\d,]+(?:\.\d{2})?/g);
  if (amounts) score += Math.min(amounts.length, 8) * 3;
  // percentages matter for allocation rates, co-insurance and illustration rates
  const percents = block.match(/\d+(?:\.\d+)?\s?%/g);
  if (percents) score += Math.min(percents.length, 6) * 2;
  // normalise so a long block is not favoured purely for being long
  return score / Math.sqrt(Math.max(block.length, 1));
}

/** Splits text into blocks on paragraph boundaries, targeting ~targetSize each. */
function splitIntoBlocks(text, targetSize) {
  const paragraphs = text.split(/\n\s*\n/);
  const blocks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current && current.length + para.length > targetSize) {
      blocks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    // a single paragraph longer than the target gets hard-split
    while (current.length > targetSize * 2) {
      blocks.push(current.slice(0, targetSize));
      current = current.slice(targetSize);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Condenses policy text to fit maxChars.
 *
 * Returns { text, truncated, omittedChars, originalChars } — pass truncated and
 * omittedChars through to buildUserMessage so the model is told, rather than
 * left to assume it saw the whole contract.
 */
function condensePolicyText(rawText, maxChars = 60000, options = {}) {
  const { headChars = 6000, blockSize = 1200 } = options;
  const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  const originalChars = text.length;

  if (originalChars <= maxChars) {
    return { text, truncated: false, omittedChars: 0, originalChars };
  }

  // The front matter is always worth keeping whole: insurer, policy number,
  // policyholder, premium and the benefit schedule almost always sit here.
  const headBudget = Math.min(headChars, Math.floor(maxChars * 0.35));
  const head = text.slice(0, headBudget);
  const rest = text.slice(headBudget);

  const blocks = splitIntoBlocks(rest, blockSize);
  const scored = blocks.map((block, index) => ({ block, index, score: scoreBlock(block) }));

  // Spend the remaining budget on the highest-signal blocks.
  let budget = maxChars - headBudget - CUT_MARKER.length;
  const chosen = [];
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (item.block.length + CUT_MARKER.length > budget) continue;
    chosen.push(item);
    budget -= item.block.length + CUT_MARKER.length;
    if (budget <= 0) break;
  }

  // Restore document order so the model reads the policy, not a ranked list.
  chosen.sort((a, b) => a.index - b.index);

  let assembled = head;
  let previousIndex = -1;
  for (const item of chosen) {
    assembled += item.index === previousIndex + 1 && previousIndex !== -1 ? '\n\n' : CUT_MARKER;
    assembled += item.block;
    previousIndex = item.index;
  }
  if (previousIndex < blocks.length - 1) assembled += CUT_MARKER;

  return {
    text: assembled,
    truncated: true,
    omittedChars: originalChars - assembled.length,
    originalChars
  };
}

module.exports = { condensePolicyText, scoreBlock };
