import { REPORT, FREE, paidReportsEnabled, FREE_REPORTS_PER_DAY } from '../../lib/tiers';

/**
 * Tells the page which world it is in, so the button can say the right thing
 * before anyone clicks it. Cheap, cacheable, and contains no secrets.
 */
export default async function handler(req, res) {
  const paid = paidReportsEnabled();

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.status(200).json({
    paidReports: paid,
    price: paid ? REPORT.price.display : null,
    maxDocuments: REPORT.maxDocuments,
    freeSummariesPerDay: FREE.dailyRuns,
    freeReportsPerDay: paid ? null : FREE_REPORTS_PER_DAY
  });
}
