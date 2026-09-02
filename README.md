# Policy2Summary

**AI Insurance Document Reader** — Upload your insurance policies, get an instant plain-English summary.

No signup. No data stored.

- **Free** — a plain-English summary of each policy, on screen.
- **Full report, S$4.90** — upload up to 5 policies, get one combined PDF that reads the whole wording. One price whether you upload one policy or five.

## What It Does

1. **Upload** your insurance policy (PDF or text)
2. **AI reads** the fine print and extracts key details
3. **Get a summary** of:
   - What you're covered for
   - What's NOT covered (exclusions)
   - Premium amount and frequency
   - Key dates (issue, maturity, renewal)
   - Investment-linked policy details (if applicable)
   - Important warnings

## Tech Stack

- **Frontend:** Next.js + Tailwind CSS
- **PDF Parsing:** pdfjs-dist (client-side)
- **AI Analysis:** Agnes AI API, with Kimi fallback and an optional Claude Haiku 4.5 route
- **Privacy:** Documents are not stored by this app. Extracted text is sent to a third-party AI provider for analysis and is not retained here.

## Local Development

```bash
npm install
cat > .env.local <<'ENV'
AGNES_API_KEY=your_key_here          # free-tier summaries
# Paid reports:
# ANTHROPIC_API_KEY=your_key_here    # Claude Haiku 4.5
# STRIPE_SECRET_KEY=sk_test_...      # Stripe Checkout
# NEXT_PUBLIC_SITE_URL=http://localhost:3000
# Shared state (rate limits + payment redemption) — required in production:
# KV_REST_API_URL=...
# KV_REST_API_TOKEN=...
ENV
npm run dev
```

Without the Stripe and Anthropic keys the app still runs: free summaries work
and the paid routes return a clear "not enabled" response.

Open http://localhost:3000

## Deployment

Deploy to Vercel:
1. Push repo to GitHub
2. Import to Vercel
3. Add the environment variables above in the Vercel dashboard

The free-tier rate limit needs `KV_REST_API_URL` / `KV_REST_API_TOKEN`
(Upstash Redis, free tier is enough). Serverless instances do not share memory,
so without them the daily limit does not actually hold.

## How The Analysis Works

Prompts live in one place: `lib/prompts.js`. They are built around three rules
that matter more than model choice:

- **Missing means null.** If a figure is not in your document, the summary says
  so rather than guessing one.
- **Absence is not exclusion.** Anything the analysis looked for and could not
  find appears under *Not Found In This Document* — separate from what your
  policy actually excludes.
- **No invented savings figures.** An "optimal premium" cannot be derived from
  policy documents alone, so the comparison does not pretend to produce one.

Long policies are condensed by `lib/policy-text.js`, which keeps the schedule
and the passages carrying exclusions, sub-limits, waiting periods and charges,
rather than simply reading the first few pages.

## Notes

- Supports text-based PDFs, DOCX and text files
- Reads up to 60 pages per PDF
- Scanned/image PDFs may need OCR (not yet supported)
- For scanned docs, paste extracted text into the manual input field

## Disclaimer

AI-generated summaries for reference only. Always verify details with your insurer. Not financial advice.
