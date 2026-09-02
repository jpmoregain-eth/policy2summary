# Policy2Summary — Project Notes

> **Context preservation file.** If you're a new session agent, read this first before touching anything.

---

## What This Is

AI-powered insurance document summarizer.
- **Quick summary** via `/api/analyze` (agnes-2.0-flash, 55s timeout)
- **Executive PDF report** via `/api/analyze-fallback` (agnes-2.0-flash, 25s per attempt, 4 retries with 10s backoff)
- **Multi-policy comparison** via `/api/analyze-compare` (analyzes 2+ docs together, generates consolidated comparison PDF)
- **Claude Haiku 4.5 route** via `/api/analyze-claude` — tier-aware, handles all three modes, inert unless `ANTHROPIC_API_KEY` is set

Note: nothing is actually gated behind payment yet. Every feature is free to every visitor.

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
| Route | Purpose | Model | Timeout |
|-------|---------|-------|---------|
| `/api/analyze` | Quick summary | agnes-2.0-flash | 55s |
| `/api/analyze-fallback` | Executive PDF + Kimi fallback | agnes-2.0-flash / kimi-k2.6 | 25s per attempt |
| `/api/analyze-compare` | Multi-policy comparison | agnes-2.0-flash | 55s |
| `/api/analyze-claude` | Tier-aware analysis (all modes) | claude-haiku-4-5 | 60s |

All four routes now export `config = { maxDuration: 60 }` — without it Vercel
applied its default limit regardless of the Pro plan.

### Environment Variables (Vercel)
```
AGNES_API_KEY=<key>          # Required for the Agnes routes
KIMI_API_KEY=<key>           # Fallback provider (optional)
ANTHROPIC_API_KEY=<key>      # Enables /api/analyze-claude (optional)

# Optional tuning — how many characters of the document each mode sends
ANALYZE_CONTEXT_CHARS=30000
EXECUTIVE_CONTEXT_CHARS=45000
COMPARE_CONTEXT_CHARS=60000
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
| Quick summary | `agnes-2.0-flash` | Fast, cheap, good enough for basic extraction |
| Executive PDF | `agnes-2.0-flash` | Deeper prompt, same model |
| Comparison | `agnes-2.0-flash` | Multi-doc reasoning |
| Fallback | `kimi-k2.6` (moonshot) | Backup when Agnes is rate-limited |
| Tiered route | `claude-haiku-4-5` | 200K context (reads whole policies), prompt caching, stable JSON |

---

## Files to Know

| File | Purpose |
|------|---------|
| `pages/index.js` | Main UI — 2400+ lines, be careful with large edits |
| `lib/prompts.js` | **Every analysis prompt lives here.** Single source of truth |
| `lib/policy-text.js` | Signal-weighted condensation — keeps exclusions, drops boilerplate |
| `lib/json-response.js` | Tolerant JSON parsing, including repair of truncated responses |
| `lib/tiers.js` | Free / Pro tier definitions |
| `pages/api/analyze.js` | Quick summary endpoint |
| `pages/api/analyze-fallback.js` | Executive endpoint with provider fallback |
| `pages/api/analyze-compare.js` | Multi-policy comparison endpoint |
| `pages/api/analyze-claude.js` | Claude Haiku 4.5, tier-aware |
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
