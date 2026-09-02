# Policy2Summary — Project Notes

> **Context preservation file.** If you're a new session agent, read this first before touching anything.

---

## What This Is

AI-powered insurance document summarizer, with one paid product.

- **Free**: per-policy summary on screen via `/api/analyze` (agnes-2.0-flash). 3 per IP per day. No PDF.
- **Paid — the report**: `S$4.90` one-off. Upload 1-5 policies, pay, get one combined PDF. Runs on `claude-haiku-4-5` via `/api/report`.

**The product is the report.** Priced per report, not per policy — one price whether
you upload one policy or five. Charging per policy would tax the exact behaviour
that makes this useful: putting a household's whole set in front of the model at once.

Domain: **policy2summary.com**
Repo: **jpmoregain-eth/policy2summary**

---

## Architecture

### Frontend (`pages/index.js`)
- Next.js pages router, static export (or Vercel serverless)
- React hooks: `useState`, `useCallback`, `useRef`
- PDF extraction: `pdfjs-dist` (dynamic import, worker from CDN)
- DOCX extraction: `mammoth` (dynamic import)
- PDF generation: `jspdf` + `jspdf-autotable` (dynamic import inside click handler — NEVER import at top level, crashes SSR)
- Error Boundary added to catch client-side React crashes and show "Reload App" UI
- Supports up to 5 documents simultaneously

### API Routes
| Route | Purpose | Model | Paid? |
|-------|---------|-------|-------|
| `/api/analyze` | Free per-policy summary, rate limited | agnes-2.0-flash | No |
| `/api/analyze-fallback` | Free summary, alternate provider | agnes-1.5-flash / kimi-k2.6 | No |
| `/api/checkout` | Creates a Stripe Checkout session | — | — |
| `/api/report` | The paid combined report | claude-haiku-4-5 | **Yes** |
| `/api/analyze-compare` | Retired stub, returns 402 | — | — |

Every route exports `config = { maxDuration: 60 }` — without it Vercel applied
its default limit regardless of the Pro plan.

### The paywall

Executive and comparison analysis are the paid product, so **every free route
returns 402 for those modes**. `/api/analyze-claude` was deleted outright: it
read the tier from the request body, which meant the caller could simply declare
itself paid. Entitlement now comes from Stripe and nowhere else.

### Environment Variables (Vercel)
```
AGNES_API_KEY=<key>          # Free tier summaries
KIMI_API_KEY=<key>           # Fallback provider (optional)

ANTHROPIC_API_KEY=<key>      # Paid reports only — spent only when revenue arrives
STRIPE_SECRET_KEY=<key>      # Enables /api/checkout and /api/report
NEXT_PUBLIC_SITE_URL=https://policy2summary.com   # Stripe return URLs

# Shared state for rate limiting and payment redemption. WITHOUT THESE THE
# FREE-TIER LIMIT DOES NOT HOLD — each Vercel instance counts separately.
KV_REST_API_URL=<upstash url>
KV_REST_API_TOKEN=<upstash token>

ANALYZE_CONTEXT_CHARS=30000  # optional
```
- **NEVER hardcode API keys in source** — GitHub push protection will block commits containing keys
- Kimi endpoint: `https://api.moonshot.ai/v1` (NOT apihub.agnes-ai.com)

---

## Known Issues & Fixes (Chronological)

### 1. jsPDF SSR Crash
**Symptom**: Vercel build fails or runtime crash when clicking Export PDF.
**Cause**: `import { jsPDF } from 'jspdf'` at top level triggers server-side rendering of browser-only library.
**Fix**: Dynamic import inside click handler:
```javascript
const { jsPDF } = await import('jspdf');
const autoTable = (await import('jspdf-autotable')).default;
```
**Commit**: `369654d`

### 2. Stray `</span>` JSX Syntax Error
**Symptom**: Build fails with "Unexpected token" near footer.
**Cause**: Incomplete edit left a stray closing span tag.
**Fix**: Removed stray tag.
**Commit**: `e81e8f5`

### 3. Duplicate `let pdfjsLib = null`
**Symptom**: Build fails with "Identifier 'pdfjsLib' has already been declared".
**Cause**: Two declarations at top of file.
**Fix**: Removed duplicate.
**Commit**: `df43fa3`

### 4. Hardcoded Kimi API Key
**Symptom**: Security risk + GitHub push protection blocks commits.
**Fix**: Removed hardcoded key, reads from env var.
**Commit**: `b79d338`

### 5. Wrong Kimi Endpoint
**Symptom**: Kimi fallback fails with connection error.
**Cause**: Used Agnes endpoint for Kimi.
**Fix**: Reverted to `https://api.moonshot.ai/v1`.
**Commit**: `01e05a6`

### 6. Timeout Too Short
**Symptom**: "Request timed out" on complex PDFs.
**Fix**: Increased timeouts to 55s for free analysis, 55s for PDF extraction.
**Commit**: `c778d02`

### 7. PDF Export Per-Attempt Timeout Too Short
**Symptom**: Executive PDF generation times out on first attempt.
**Fix**: Increased per-attempt timeout to 25s.
**Commit**: `3ba8980`

### 8. Free Summary Model Too Slow
**Symptom**: Free tier frequently times out (agnes-1.5-pro is heavy).
**Fix**: Switched free summary to `agnes-1.5-flash` (3x faster).
**Commit**: `5fee32b`

### 9. `generatePdfReport` Function Declaration Lost
**Symptom**: Build fails with "Expression expected" at line 483.
**Cause**: During multi-policy comparison edit, the function declaration was accidentally deleted, leaving orphaned code.
**Fix**: Restored `const generatePdfReport = async (doc, analysis) => {`.
**Commit**: `9ee3fa1`

### 10. Duplicate `runExecutiveAnalysis` Code Block
**Symptom**: Build fails with "await isn't allowed in non-async function" at lines 752, 764, 768, 778.
**Cause**: After fixing #9, a 140-line duplicate of `runExecutiveAnalysis` was left after `runComparison`'s closing brace — making it a regular function body containing `await`.
**Fix**: Removed the entire duplicate block.
**Commit**: `55482fe`

### 11. `arrayBuffer` Scoped Inside `try` Block
**Symptom**: Client-side crash (white/black screen) when uploading second PDF. Intermittent.
**Cause**: `const arrayBuffer = await selectedFile.arrayBuffer()` declared inside `try`, but `catch` block references `arrayBuffer` — `ReferenceError` on any exception after that line.
**Fix**: Moved declarations outside `try`:
```javascript
let arrayBuffer = null;
let clonedBuffer = null;
try {
  arrayBuffer = await selectedFile.arrayBuffer();
  clonedBuffer = arrayBuffer.slice(0);
```
**Commit**: `a267d6a`

### 12. Navbar Buttons Too Large on Mobile
**Symptom**: "Export PDF" and "Compare & Export" buttons overflow navbar on mobile.
**Fix**: Responsive sizing — smaller padding, shorter labels ("PDF" / "Compare"), smaller icons on mobile; full labels on desktop (`sm:` breakpoint).
**Commit**: `5f36aa2`

### 13. Intermittent Client-Side Crashes (Black Screen)
**Symptom**: "Application error: a client-side exception has occurred" — intermittent, no server error logs.
**Cause**: Likely null reference during render (e.g., `analysis.policy_type` when `analysis` is malformed).
**Fix**: Added React Error Boundary to catch crashes and show recoverable UI with "Reload App" button + console logging.
**Commit**: `a9483f3`

---

## Critical Code Patterns

### Never Do This (SSR Crash)
```javascript
// BAD — crashes on server
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
```

### Always Do This (Dynamic Import)
```javascript
// GOOD — only loads in browser when clicked
const generatePdfReport = async (doc, analysis) => {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const pdf = new jsPDF('p', 'mm', 'a4');
  // ... build PDF ...
  pdf.save(`policy2summary-report-${doc.file?.name?.replace(/\.[^/.]+$/, '') || 'document'}.pdf`);
};
```

### Variable Scope in try/catch
```javascript
// BAD — arrayBuffer undefined in catch
function processFile() {
  try {
    const arrayBuffer = await file.arrayBuffer(); // scoped to try
  } catch (err) {
    updateDoc(id, { pendingBuffer: arrayBuffer }); // ReferenceError!
  }
}

// GOOD — declare outside
try {
  let arrayBuffer = null;
  arrayBuffer = await file.arrayBuffer();
} catch (err) {
  updateDoc(id, { pendingBuffer: arrayBuffer }); // OK
}
```

---

## Feature: Multi-Policy Comparison

### Flow
1. User uploads and analyzes 2+ policies (free summary)
2. "Compare & Export" button appears (amber) in navbar when `analyzedCount >= 2`
3. Click → calls `/api/analyze-compare` with all extracted texts
4. Backend sends consolidated prompt to Agnes AI
5. Returns structured comparison object
6. Frontend calls `generateComparisonPdf()` to produce single PDF with:
   - Executive Summary
   - Financial Overview (total premium vs optimal)
   - Coverage Overlap Analysis (where user is wasting money)
   - Coverage Gap Analysis (what's missing)
   - Per-Policy Verdict (Keep / Review / Cancel)
   - Action Plan

### API Input
```json
{
  "documents": [
    { "name": "Policy A", "text": "..." },
    { "name": "Policy B", "text": "..." }
  ]
}
```

### API Output
```json
{
  "comparison": {
    "executive_summary": "...",
    "financial_overview": { "total_annual_premium": "...", "optimal_annual_premium": "...", "potential_savings": "..." },
    "coverage_overlap_analysis": "...",
    "coverage_gap_analysis": "...",
    "per_policy_verdict": [
      { "policy_name": "Policy A", "verdict": "Keep", "rationale": "..." }
    ],
    "action_plan": "..."
  }
}
```

---

## Vercel Deployment Notes

- **Plan**: Vercel Pro (60s serverless timeout)
- **Build command**: `npm run build` (Next.js)
- **Output**: Static + serverless API routes
- **Cache**: May serve stale JS bundles — if Derek sees old errors after deploy, tell him to **hard refresh** (Ctrl+Shift+R on desktop, or clear app data on mobile Chrome)
- **Logs**: Function logs show only server-side errors. Client-side crashes appear in browser console only (unless Error Boundary catches them).

---

## Common User Issues

| User Report | Likely Cause | Fix |
|-------------|--------------|-----|
| "Export PDF greyed out" | Stale JS bundle | Hard refresh browser |
| "Request timed out" | Free tier slow on complex docs | Normal — flash model is fast but complex PDFs still take time |
| "Application error" after upload | `arrayBuffer` scope bug (fixed) or null render | Reload app; check console |
| "Black screen" | React crash | Error Boundary now shows "Reload App" button |

---

## Model Assignment Rules

| Feature | Model | Why |
|---------|-------|-----|
| Free summary | `agnes-2.0-flash` | Already paid for. Keeps the Anthropic credit for paying customers |
| Fallback | `kimi-k2.6` (moonshot) | Backup when Agnes is rate-limited |
| Paid report | `claude-haiku-4-5` | 200K context reads a whole policy wording; ~6 cents per report |

---

## Files to Know

| File | Purpose |
|------|---------|
| `pages/index.js` | Main UI — 2400+ lines, be careful with large edits |
| `lib/prompts.js` | **Every analysis prompt lives here.** Single source of truth |
| `lib/policy-text.js` | Signal-weighted condensation — keeps exclusions, drops boilerplate |
| `lib/json-response.js` | Tolerant JSON parsing, including repair of truncated responses |
| `lib/tiers.js` | Free vs paid-report definitions, including the price |
| `lib/store.js` | Shared state over Upstash REST — rate limits and payment redemption |
| `pages/api/analyze.js` | Quick summary endpoint |
| `pages/api/analyze-fallback.js` | Executive endpoint with provider fallback |
| `pages/api/analyze-compare.js` | Retired stub (402) |
| `pages/api/checkout.js` | Stripe Checkout session |
| `pages/api/report.js` | The paid report — verifies payment, then generates |
| `public/googlef0b1253b37cd8c20.html` | Google Search Console verification |

---

## Prompt Design Rules

`lib/prompts.js` is the whole prompt surface. Never paste prompt text into a
route — the two copies that used to live in `analyze.js` and
`analyze-fallback.js` had already drifted apart.

Three rules do most of the work and should not be relaxed:

1. **Missing means null.** A guessed policy number is worse than a blank one.
2. **Absence is not exclusion.** The model must never write "this policy does
   not cover X" when it means "X was not in the text I was given". Anything it
   looked for and could not find goes into `not_found_in_document`.
3. **No invented market pricing.** The model has no quotes, no competitor
   rates and no underwriting data. `optimal_premium_estimate` and
   `potential_savings` are deliberately hard-nulled in the comparison prompt —
   a confident fake savings figure could push someone to cancel cover they
   cannot be underwritten for again.

`DOMAIN_CHECKLIST` is the quality lever. It tells the model where the money
hides in an insurance contract — sub-limits, waiting periods, allocation rates,
bid-offer spreads, incontestability windows. Extend it rather than rewriting
the schemas.

### Fields the prompts return

Beyond the original keys (all preserved), responses now carry
`document_assessment`, `not_found_in_document`, `questions_for_your_agent`,
`red_flags` (objects with `severity` / `issue` / `why_it_matters` /
`evidence`), `market_context`, and per-section `evidence` quotes. All are
rendered on-page and in the executive PDF.

---

## How Much Of The Document Gets Read

This was the single largest quality bug. The client capped `extractedText` at
5,000 characters, so the executive report and the comparison — the deeper
analyses — saw *less* of the policy than the free summary, which sent the full
text and let the server truncate at 8,000. Both are gone.

- Client keeps up to `MAX_RETAINED_CHARS` (200,000) and reads up to
  `MAX_PDF_PAGES` (60) pages, up from 20.
- The server decides the budget per mode and condenses with
  `condensePolicyText`, which keeps the front matter whole and then spends the
  rest of the budget on the highest-signal passages, in document order, marking
  each cut with `[...]`.
- Whenever text is dropped the model is told so explicitly, so a partial upload
  is reported as partial rather than as a clean bill of health.

---

## If You're Starting a New Session

1. **Read this file first** (you're doing it now — good)
2. **Check git log**: `git log --oneline -10` to see recent changes
3. **Build locally before pushing**: `npx next build` — catches syntax errors before Vercel
4. **Always backup before big edits**: `git diff` to see what changed
5. **For large refactors**: Consider spawning a subagent instead of editing 2000-line file inline
6. **Derek wants**: Terse replies, no fluff, Singlish, 1-3 sentences max

---

## Derek's Preferences

- **Communication**: Terse, Singlish, 1-3 sentences max
- **Wants to be notified**: After CanYouHearMe 08:30 SGT cron runs
- **Does NOT want**: Long explanations, backend details, fluff, sign-offs
- **Ask before**: External actions (email, post, anything leaving the machine)
- **Skeptical of**: AI safety scare stories, enterprise marketing BS

---

*Last updated: 2026-09-02 — prompt overhaul, context-budget fixes, Claude Haiku tier route.*

## Contact
- **Email:** thejpmoregainproject@gmail.com
- **Added to footer:** 2026-05-20


---

## The Payment Flow

No accounts, no database. The document text rides in the browser across the
Stripe redirect, which means there is nothing to build and no policy text
sitting on a server waiting to be breached.

1. Visitor uploads 1-5 policies. Each gets a free on-screen summary (Agnes).
2. They click **Get the report — S$4.90**. The extracted text goes into
   `sessionStorage`; `/api/checkout` creates a Stripe session; the browser
   redirects to Stripe.
3. Stripe returns them to `/?report=<checkout_session_id>`.
4. The page posts that id plus the stashed text to `/api/report`, which asks
   Stripe whether the session is actually paid before doing any work.
5. The finished report is cached in `localStorage`, so re-downloading the PDF
   costs nothing and never touches the API again.

### Two rules that must not be broken

**Generate only after payment.** The expensive call sits on the far side of the
paywall, so there is nothing to bypass and the Anthropic bill only moves when
revenue does.

**Release the claim when generation fails.** `/api/report` claims the payment
before it starts work so two tabs cannot double-spend it — but every failure
path calls `release()`. A customer whose report died on a transient API error
has already paid and must be able to try again.

### What is not yet handled

- **Refunds are manual.** Errors surface the Stripe payment reference and ask
  the customer to get in touch.
- **A cleared browser loses the pending documents.** The payment is still
  redeemable — re-uploading in the same browser regenerates the report without
  a second charge — but if they clear storage entirely, that is a manual refund.
- **No Stripe webhook.** Payment is verified by retrieving the session on
  demand, which is sufficient for one-off purchases and needs no endpoint
  secret. Add a webhook only if you move to subscriptions.
