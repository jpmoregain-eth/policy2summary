import React, { useState, useCallback, useRef, Component } from 'react';
import Head from 'next/head';

// Error Boundary to catch client-side crashes and show recoverable UI
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('Policy2Summary Error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-white px-4">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Something went wrong</h2>
            <p className="text-slate-500 mb-6 text-sm">The app encountered an error. This usually happens with complex PDFs or when uploading multiple files quickly.</p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const truncateText = (text, maxLength) => {
  if (!text || text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    return truncated.substring(0, lastSpace) + '...';
  }
  return truncated + '...';
};

// The paid report is priced per report, not per policy — one price whether you
// upload one policy or five.
const REPORT_PRICE = 'S$4.90';
const MAX_REPORT_DOCS = 5;

// Document text has to survive a redirect to Stripe and back. It rides in the
// browser rather than on a server, so there is no database to build and no
// policy text sitting in storage waiting to be breached.
const PENDING_KEY = 'p2s:pending-report';
const reportCacheKey = (sessionId) => `p2s:report:${sessionId}`;

// Per-document ceiling on what we stash. The server condenses anyway, so
// sending more than this would only bloat sessionStorage.
const STASH_CHARS = 150000;

const stashPendingDocs = (docs) => {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(
      docs.map(d => ({ name: d.name, text: String(d.text || '').substring(0, STASH_CHARS) }))
    ));
    return true;
  } catch (err) {
    console.error('Could not stash documents for checkout:', err);
    return false;
  }
};

const readPendingDocs = () => {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
};

const clearPendingDocs = () => {
  try { sessionStorage.removeItem(PENDING_KEY); } catch (err) { /* nothing to do */ }
};

// Caching the finished report locally means re-downloading the PDF costs
// nothing — the server is only asked to generate it once per payment.
const cacheReport = (sessionId, payload) => {
  try { localStorage.setItem(reportCacheKey(sessionId), JSON.stringify(payload)); } catch (err) { /* quota */ }
};

const readCachedReport = (sessionId) => {
  try {
    const raw = localStorage.getItem(reportCacheKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
};

// How much extracted text we keep client-side. The server decides how much of
// it to actually send, so this only needs to be generous enough not to lose the
// back half of a long policy wording before the API ever sees it.
const MAX_RETAINED_CHARS = 200000;

// Exclusions, sub-limits and charges usually sit well past page 20.
const MAX_PDF_PAGES = 60;

let pdfjsLib = null;

const loadPdfJs = async () => {
  if (pdfjsLib) return pdfjsLib;
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  pdfjsLib = pdfjs;
  return pdfjs;
};

const createEmptyDoc = (id) => ({
  id,
  file: null,
  password: '',
  needsPassword: false,
  pendingBuffer: null,
  extractedText: '',
  analysis: null,
  loading: false,
  error: '',
  stage: null,
  stageMessage: null,
  extractProgress: null,
});
const loadImageAsDataUrl = async (url) => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
};


const generateComparisonPdf = async (docs, comparison) => {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  // Load images
  const [logoDataUrl, watermarkDataUrl] = await Promise.all([
    loadImageAsDataUrl('/images/logo.jpg'),
    loadImageAsDataUrl('/images/watermark.jpg')
  ]);

  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 18;
  const contentWidth = pageWidth - margin * 2;
  const primaryColor = [6, 95, 70];
  const secondaryColor = [245, 158, 11];
  const dangerColor = [220, 38, 38];
  const textDark = [31, 41, 55];
  const textMuted = [107, 114, 128];
  const bgLight = [248, 250, 252];

  // Helper to add watermark to a page
  const addWatermark = () => {
    if (watermarkDataUrl) {
      pdf.addImage(watermarkDataUrl, 'JPEG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');
    }
  };

  // Helper to add header to a page
  const addHeader = () => {
    pdf.setFillColor(...primaryColor);
    pdf.rect(0, 0, pageWidth, 28, 'F');
    if (logoDataUrl) {
      pdf.addImage(logoDataUrl, 'JPEG', margin, 6, 16, 16, undefined, 'FAST');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Policy2Summary', margin + 20, 18);
    } else {
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(20);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Policy2Summary', margin, 18);
    }
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Multi-Policy Comparison Report  |  ${docs.length} Policies Analyzed`, margin + (logoDataUrl ? 20 : 0), 25);
    pdf.setDrawColor(6, 95, 70);
    pdf.setLineWidth(0.8);
    pdf.line(margin, 32, pageWidth - margin, 32);
  };

  addWatermark();
  addHeader();

  let y = 40;

  // Report metadata box
  pdf.setFillColor(...bgLight);
  pdf.roundedRect(margin, y, contentWidth, 22, 2, 2, 'F');
  pdf.setTextColor(...textDark);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`Report Date: ${new Date().toLocaleDateString()}`, margin + 5, y + 8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(...textMuted);
  pdf.text(`Documents analyzed: ${docs.map(d => d.file?.name?.replace(/\.[^/.]+$/, '')).join(', ')}`, margin + 5, y + 17);
  y += 30;

  // Executive Summary
  pdf.setTextColor(...primaryColor);
  pdf.setFontSize(13);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Executive Summary', margin, y);
  y += 7;
  pdf.setTextColor(...textDark);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  const summaryLines = pdf.splitTextToSize(comparison.executive_summary || comparison.comparison_summary || 'No summary available.', contentWidth);
  pdf.text(summaryLines, margin, y);
  y += summaryLines.length * 4.5 + 12;

  // Financial Overview
  if (y > 230) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
  pdf.setTextColor(...primaryColor);
  pdf.setFontSize(13);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Financial Overview', margin, y);
  y += 10;

  const finData = [];
  if (comparison.total_annual_premium) finData.push(['Current Total Premium', comparison.total_annual_premium]);
  if (comparison.financial_optimization?.optimal_premium_estimate) finData.push(['Optimal Premium', comparison.financial_optimization.optimal_premium_estimate]);
  if (comparison.financial_optimization?.potential_savings) finData.push(['Potential Savings', comparison.financial_optimization.potential_savings]);
  if (comparison.financial_optimization?.savings_note && !comparison.financial_optimization?.potential_savings) {
    finData.push(['On Savings Estimates', comparison.financial_optimization.savings_note]);
  }
  if (comparison.financial_optimization?.efficiency_score) finData.push(['Efficiency Score', comparison.financial_optimization.efficiency_score]);

  if (finData.length) {
    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Metric', 'Value']],
      body: finData,
      theme: 'striped',
      headStyles: { fillColor: primaryColor, textColor: 255, fontSize: 10, fontStyle: 'bold', halign: 'left' },
      bodyStyles: { fontSize: 9.5, textColor: textDark, cellPadding: 4 },
      columnStyles: { 0: { cellWidth: 70, fontStyle: 'bold' }, 1: { fontStyle: 'bold', textColor: primaryColor } },
      styles: { lineColor: [226, 232, 240], lineWidth: 0.3, overflow: 'linebreak' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });
    y = pdf.lastAutoTable.finalY + 12;
  }

  // Policy Comparison Table
  if (y > 220) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
  pdf.setTextColor(...primaryColor);
  pdf.setFontSize(13);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Policy Breakdown', margin, y);
  y += 10;

  if (comparison.policies?.length) {
    const policyData = comparison.policies.map(p => [
      p.name || 'Unknown',
      p.insurer || 'N/A',
      p.type || 'N/A',
      p.annual_premium || 'N/A',
      p.key_coverages?.slice(0, 2).join('; ') || 'N/A'
    ]);

    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Policy', 'Insurer', 'Type', 'Premium', 'Key Coverages']],
      body: policyData,
      theme: 'striped',
      headStyles: { fillColor: primaryColor, textColor: 255, fontSize: 9, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8.5, textColor: textDark, cellPadding: 3 },
      styles: { overflow: 'linebreak', lineColor: [226, 232, 240], lineWidth: 0.3 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 28 },
        1: { cellWidth: 38 },
        2: { cellWidth: 28 },
        3: { cellWidth: 24 },
        4: { cellWidth: 42 }
      }
    });
    y = pdf.lastAutoTable.finalY + 12;
  }

  // Overlap Analysis
  if (comparison.overlap_analysis?.redundant_coverage?.length) {
    if (y > 230) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
    pdf.setTextColor(...dangerColor);
    pdf.setFontSize(13);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Coverage Overlap  –  Money Wasted', margin, y);
    y += 10;

    const overlapData = comparison.overlap_analysis.redundant_coverage.map(c => ['Duplicated Coverage', truncateText(c, 140)]);

    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Type', 'Details']],
      body: overlapData,
      theme: 'striped',
      headStyles: { fillColor: dangerColor, textColor: 255, fontSize: 10, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9, textColor: textDark, cellPadding: 4 },
      columnStyles: { 0: { cellWidth: 35, fontStyle: 'bold' }, 1: { cellWidth: 135 } },
      alternateRowStyles: { fillColor: [254, 242, 242] },
      styles: { overflow: 'linebreak', lineColor: [254, 202, 202], lineWidth: 0.3 },
    });
    y = pdf.lastAutoTable.finalY + 12;
  }

  // Gap Analysis
  if (comparison.gap_analysis?.missing_coverage?.length) {
    if (y > 230) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
    pdf.setTextColor(...secondaryColor);
    pdf.setFontSize(13);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Coverage Gaps  –  Risk Exposure', margin, y);
    y += 10;

    const gapData = comparison.gap_analysis.missing_coverage.map(g => ['Missing Coverage', truncateText(g, 140)]);
    if (comparison.gap_analysis.recommended_additions?.length) {
      comparison.gap_analysis.recommended_additions.forEach(r => gapData.push(['Recommendation', truncateText(r, 140)]));
    }

    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Type', 'Details']],
      body: gapData,
      theme: 'striped',
      headStyles: { fillColor: secondaryColor, textColor: 255, fontSize: 10, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9, textColor: textDark, cellPadding: 4 },
      columnStyles: { 0: { cellWidth: 35, fontStyle: 'bold' }, 1: { cellWidth: 135 } },
      alternateRowStyles: { fillColor: [255, 251, 235] },
      styles: { overflow: 'linebreak', lineColor: [253, 230, 138], lineWidth: 0.3 },
    });
    y = pdf.lastAutoTable.finalY + 12;
  }

  // Keep / Cancel / Review
  if (comparison.keep_cancel_ranking?.length) {
    if (y > 230) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
    pdf.setTextColor(...primaryColor);
    pdf.setFontSize(13);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Per-Policy Verdict', margin, y);
    y += 10;

    const verdictData = comparison.keep_cancel_ranking.map(r => {
      return [truncateText(r.policy_name, 32) || 'Unknown', r.verdict, truncateText(r.reason, 160) || ''];
    });

    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Policy', 'Verdict', 'Reason']],
      body: verdictData,
      theme: 'striped',
      headStyles: { fillColor: primaryColor, textColor: 255, fontSize: 10, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9, textColor: textDark, cellPadding: 4 },
      columnStyles: {
        0: { cellWidth: 45 },
        1: { cellWidth: 25, fontStyle: 'bold', halign: 'center' },
        2: { cellWidth: 100 }
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      styles: { overflow: 'linebreak', lineColor: [226, 232, 240], lineWidth: 0.3 },
    });
    y = pdf.lastAutoTable.finalY + 12;
  }

  // Action Plan
  if (comparison.consolidation_recommendations?.length) {
    if (y > 230) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
    pdf.setTextColor(...primaryColor);
    pdf.setFontSize(13);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Action Plan', margin, y);
    y += 10;

    pdf.setTextColor(...textDark);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    comparison.consolidation_recommendations.forEach((rec, idx) => {
      if (y > 270) { pdf.addPage(); addWatermark(); addHeader(); y = 40; }
      pdf.setTextColor(...primaryColor);
      pdf.setFont('helvetica', 'bold');
      pdf.text(`${idx + 1}.`, margin, y);
      pdf.setTextColor(...textDark);
      pdf.setFont('helvetica', 'normal');
      const lines = pdf.splitTextToSize(rec, contentWidth - 12);
      pdf.text(lines, margin + 8, y);
      y += lines.length * 4.5 + 6;
    });
    y += 5;
  }

  // Professional Footer on all pages
  const totalPages = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(203, 213, 225);
    pdf.setLineWidth(0.3);
    pdf.line(margin, pdf.internal.pageSize.getHeight() - 18, pageWidth - margin, pdf.internal.pageSize.getHeight() - 18);
    pdf.setTextColor(156, 163, 175);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Page ${i} of ${totalPages}  |  Policy2Summary.com`, margin, pdf.internal.pageSize.getHeight() - 12);
    pdf.setFont('helvetica', 'italic');
    pdf.setTextColor(180, 185, 195);
    const disclaimer = 'Generated by AI for reference only. Verify with a licensed insurance advisor. Not financial advice.';
    pdf.text(disclaimer, margin, pdf.internal.pageSize.getHeight() - 6);
  }

  pdf.save(`policy2summary-comparison-${docs.length}-policies.pdf`);
};

const generatePdfReport = async (doc, analysis) => {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;

  // Header
  pdf.setFillColor(16, 185, 129);
  pdf.rect(0, 0, pageWidth, 35, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(22);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Policy2Summary', margin, 20);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'normal');
  pdf.text('AI-Powered Insurance Analysis Report', margin, 28);

  let y = 45;

  // Policy Info Box
  pdf.setFillColor(240, 253, 244);
  pdf.roundedRect(margin, y, contentWidth, 30, 3, 3, 'F');
  pdf.setTextColor(31, 41, 55);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`Policy: ${doc.file?.name?.replace(/\.[^/.]+$/, '') || 'Insurance Document'}`, margin + 5, y + 10);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(107, 114, 128);
  pdf.text(`Insurer: ${analysis.policy_overview?.insurer || analysis.insurer || 'N/A'}`, margin + 5, y + 18);
  pdf.text(`Type: ${analysis.policy_overview?.policy_type || analysis.policy_type || 'N/A'} | Date: ${new Date().toLocaleDateString()}`, margin + 5, y + 26);
  y += 40;

  // Executive Summary
  if (analysis.executive_summary) {
    pdf.setTextColor(16, 185, 129);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Executive Summary', margin, y);
    y += 8;
    pdf.setTextColor(55, 65, 81);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    const summaryLines = pdf.splitTextToSize(analysis.executive_summary, contentWidth);
    pdf.text(summaryLines, margin, y);
    y += summaryLines.length * 4.5 + 10;
  }

  // Key Highlights
  if (analysis.key_highlights?.length) {
    if (y > 250) { pdf.addPage(); y = 20; }
    pdf.setTextColor(16, 185, 129);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Key Highlights', margin, y);
    y += 8;

    analysis.key_highlights.forEach((highlight, idx) => {
      if (y > 270) { pdf.addPage(); y = 20; }
      pdf.setTextColor(16, 185, 129);
      pdf.setFontSize(10);
      pdf.text('•', margin, y);
      pdf.setTextColor(55, 65, 81);
      const lines = pdf.splitTextToSize(highlight, contentWidth - 8);
      pdf.text(lines, margin + 5, y);
      y += lines.length * 4.5 + 3;
    });
    y += 8;
  }

  // Coverage Analysis Table
  if (analysis.coverage_analysis || analysis.coverage_details) {
    if (y > 220) { pdf.addPage(); y = 20; }
    pdf.setTextColor(16, 185, 129);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Coverage Analysis', margin, y);
    y += 10;

    const coverage = analysis.coverage_analysis || analysis.coverage_details;
    const tableData = [];
    if (coverage?.description) {
      tableData.push(['Description', coverage.description]);
    }
    if (coverage?.main_coverage?.length) {
      coverage.main_coverage.forEach(item => tableData.push(['Coverage', item]));
    }
    if (coverage?.riders_and_additions?.length || coverage?.riders_add_ons?.length) {
      (coverage.riders_and_additions || coverage.riders_add_ons).forEach(item => tableData.push(['Rider/Add-on', item]));
    }
    if (coverage?.sub_limits?.length) {
      coverage.sub_limits.forEach(item => tableData.push(['Sub-limit', item]));
    }
    if (coverage?.deductible_or_excess) {
      tableData.push(['Deductible / Excess', coverage.deductible_or_excess]);
    }
    if (coverage?.total_coverage_value) {
      tableData.push(['Total Coverage', coverage.total_coverage_value]);
    }

    if (tableData.length) {
      autoTable(pdf, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Category', 'Details']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 10, fontStyle: 'bold' },
        bodyStyles: { fontSize: 9, textColor: [55, 65, 81] },
        columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } },
        alternateRowStyles: { fillColor: [249, 250, 251] },
      });
      y = pdf.lastAutoTable.finalY + 10;
    }
  }

  // Exclusions & Warnings
  const exclusions = analysis.exclusions_and_warnings || analysis.exclusions_and_limitations;
  if (exclusions) {
    if (y > 200) { pdf.addPage(); y = 20; }
    pdf.setTextColor(239, 68, 68);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Exclusions & Warnings', margin, y);
    y += 10;

    const warnData = [];
    if (exclusions.critical_exclusions?.length) {
      exclusions.critical_exclusions.forEach(e => warnData.push(['Exclusion', e]));
    } else if (exclusions.exclusions?.length) {
      exclusions.exclusions.forEach(e => warnData.push(['Exclusion', e]));
    }
    if (exclusions.limitations?.length) {
      exclusions.limitations.forEach(l => warnData.push(['Limitation', l]));
    }
    if (exclusions.pre_existing_conditions) {
      warnData.push(['Pre-Existing', exclusions.pre_existing_conditions]);
    }
    if (exclusions.waiting_periods?.length) {
      exclusions.waiting_periods.forEach(w => warnData.push(['Waiting Period', w]));
    }
    // red_flags carries objects now (severity / issue / why_it_matters /
    // evidence); older responses returned plain strings, so handle both.
    const redFlags = exclusions.red_flags || analysis.red_flags;
    if (redFlags?.length) {
      redFlags.forEach(r => {
        if (typeof r === 'string') {
          warnData.push(['Red Flag', r]);
        } else if (r) {
          const detail = [r.issue, r.why_it_matters].filter(Boolean).join(' — ');
          warnData.push([`Red Flag (${r.severity || 'Note'})`, detail || '']);
        }
      });
    }

    if (warnData.length) {
      autoTable(pdf, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Type', 'Details']],
        body: warnData,
        theme: 'grid',
        headStyles: { fillColor: [239, 68, 68], textColor: 255, fontSize: 10, fontStyle: 'bold' },
        bodyStyles: { fontSize: 9, textColor: [55, 65, 81] },
        columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } },
        alternateRowStyles: { fillColor: [254, 242, 242] },
      });
      y = pdf.lastAutoTable.finalY + 10;
    }
  }

  // Not Found In This Document — the section that keeps a partial upload from
  // reading as a clean bill of health.
  if (analysis.not_found_in_document?.length) {
    if (y > 220) { pdf.addPage(); y = 20; }
    pdf.setTextColor(100, 116, 139);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Not Found In This Document', margin, y);
    y += 10;
    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Looked for, not present in the text provided']],
      body: analysis.not_found_in_document.map(item => [item]),
      theme: 'grid',
      headStyles: { fillColor: [100, 116, 139], textColor: 255, fontSize: 10 },
      bodyStyles: { fontSize: 9, textColor: [55, 65, 81] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });
    y = pdf.lastAutoTable.finalY + 10;
  }

  // Questions For Your Agent
  if (analysis.questions_for_your_agent?.length) {
    if (y > 220) { pdf.addPage(); y = 20; }
    pdf.setTextColor(16, 185, 129);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Questions To Ask Your Agent', margin, y);
    y += 10;
    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['#', 'Question']],
      body: analysis.questions_for_your_agent.map((q, i) => [String(i + 1), q]),
      theme: 'grid',
      headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 10 },
      bodyStyles: { fontSize: 9, textColor: [55, 65, 81] },
      columnStyles: { 0: { cellWidth: 10, fontStyle: 'bold' } },
      alternateRowStyles: { fillColor: [240, 253, 244] },
    });
    y = pdf.lastAutoTable.finalY + 10;
  }

  // Financial Analysis
  if (analysis.financial_analysis) {
    if (y > 220) { pdf.addPage(); y = 20; }
    pdf.setTextColor(16, 185, 129);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Financial Assessment', margin, y);
    y += 10;

    const finData = [];
    if (analysis.financial_analysis.premium_assessment) finData.push(['Premium Assessment', analysis.financial_analysis.premium_assessment]);
    if (analysis.financial_analysis.value_score) finData.push(['Value Score', analysis.financial_analysis.value_score]);
    if (analysis.financial_analysis.cost_efficiency_notes) finData.push(['Notes', analysis.financial_analysis.cost_efficiency_notes]);
    if (analysis.premium?.amount) finData.push(['Premium', `${analysis.premium.amount} ${analysis.premium.frequency || ''}`]);

    if (finData.length) {
      autoTable(pdf, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Item', 'Details']],
        body: finData,
        theme: 'grid',
        headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 10 },
        bodyStyles: { fontSize: 9, textColor: [55, 65, 81] },
        columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } },
        alternateRowStyles: { fillColor: [249, 250, 251] },
      });
      y = pdf.lastAutoTable.finalY + 10;
    }
  }

  // Recommendations
  if (analysis.recommendations?.length) {
    if (y > 230) { pdf.addPage(); y = 20; }
    pdf.setTextColor(16, 185, 129);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Recommendations', margin, y);
    y += 10;

    pdf.setTextColor(55, 65, 81);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    analysis.recommendations.forEach((rec, idx) => {
      if (y > 270) { pdf.addPage(); y = 20; }
      pdf.setTextColor(16, 185, 129);
      pdf.text(`${idx + 1}.`, margin, y);
      pdf.setTextColor(55, 65, 81);
      const lines = pdf.splitTextToSize(rec, contentWidth - 12);
      pdf.text(lines, margin + 8, y);
      y += lines.length * 4.5 + 5;
    });
    y += 5;
  }

  // Footer Disclaimer
  if (y > 260) { pdf.addPage(); y = 20; }
  pdf.setDrawColor(229, 231, 235);
  pdf.line(margin, y, pageWidth - margin, y);
  y += 8;
  pdf.setTextColor(156, 163, 175);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'italic');
  const disclaimer = 'This report is generated by AI for reference only. Always verify details with your insurer or licensed agent. Not financial advice.';
  const discLines = pdf.splitTextToSize(disclaimer, contentWidth);
  pdf.text(discLines, margin, y);

  // Page numbers
  const totalPages = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setTextColor(156, 163, 175);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Page ${i} of ${totalPages}`, pageWidth - margin - 25, pdf.internal.pageSize.getHeight() - 10);
    pdf.text('Policy2Summary.com', margin, pdf.internal.pageSize.getHeight() - 10);
  }

  pdf.save(`policy2summary-report-${doc.file?.name?.replace(/\.[^/.]+$/, '') || 'document'}.pdf`);
};

function Home() {
  const [documents, setDocuments] = useState([createEmptyDoc(0)]);
  const [dragOverId, setDragOverId] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [comparisonResult, setComparisonResult] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  // idle | starting | generating | ready | error
  const [report, setReport] = useState({ status: 'idle', error: '', data: null, mode: null, sessionId: null });
  const fileInputRefs = useRef({});

  const updateDoc = (id, updates) => {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
  };

  const extractTextFromPdf = async (arrayBuffer, password = null, timeoutMs = 5000) => {
    const pdfjs = await loadPdfJs();
    const options = { data: arrayBuffer };
    if (password) options.password = password;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('TIMEOUT'));
      }, timeoutMs);

      try {
        const loadingTask = pdfjs.getDocument(options);

        if (loadingTask.onPassword !== undefined) {
          loadingTask.onPassword = (updatePassword, reason) => {
            clearTimeout(timeoutId);
            reject(new Error('PASSWORD_REQUIRED'));
          };
        }

        loadingTask.promise.then(pdf => {
          clearTimeout(timeoutId);
          let fullText = '';
          const maxPages = Math.min(pdf.numPages, MAX_PDF_PAGES);

          const extractPages = async () => {
            try {
              for (let i = 1; i <= maxPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + '\n\n';
              }
              resolve(fullText.trim());
            } catch (err) {
              reject(err);
            }
          };

          extractPages();
        }).catch(err => {
          clearTimeout(timeoutId);
          const msg = String(err);
          if (msg.includes('password') || msg.includes('Password') || err.name === 'PasswordException') {
            reject(new Error('PASSWORD_REQUIRED'));
          } else {
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  };

  const analyzeDocText = async (text, id) => {
    if (!text || text.length < 50) {
      updateDoc(id, { error: 'Not enough text to analyze.', loading: false });
      return;
    }
    updateDoc(id, { loading: true, error: '', analysis: null });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ text, fileName: documents.find(d => d.id === id)?.file?.name || null })
      });

      clearTimeout(timeoutId);

      const data = await res.json();

      if (data.error && !data.raw_response) {
        updateDoc(id, { error: data.error, loading: false });
      } else if (data.raw_response) {
        updateDoc(id, { error: data.error || 'Showing raw analysis', analysis: { raw: data.raw_response }, loading: false });
      } else {
        updateDoc(id, { analysis: data.analysis, loading: false });
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        updateDoc(id, { error: 'Request timed out. The AI service is taking longer than expected. Please try again.', loading: false });
      } else {
        updateDoc(id, { error: err.message || 'Failed to analyze text', loading: false });
      }
    }
  };

  /** Documents with enough text to be worth putting in a report. */
  const reportableDocs = documents
    .filter(d => d.extractedText && d.extractedText.length >= 50)
    .slice(0, MAX_REPORT_DOCS)
    .map((d, i) => ({
      name: d.file?.name?.replace(/\.[^/.]+$/, '') || `Policy ${i + 1}`,
      text: d.extractedText
    }));

  /** Renders the PDF from a report already in hand. Costs nothing to repeat. */
  const downloadReportPdf = useCallback(async (payload) => {
    if (!payload) return;
    setPdfGenerating(true);
    try {
      if (payload.mode === 'compare' && payload.comparison) {
        const docs = (payload.documents || []).map(d => ({ file: { name: d.name } }));
        await generateComparisonPdf(docs, payload.comparison);
      } else if (payload.analysis) {
        const name = payload.documents?.[0]?.name || 'policy';
        await generatePdfReport({ file: { name } }, payload.analysis);
      }
    } catch (err) {
      console.error('PDF generation failed:', err);
      setReport(prev => ({ ...prev, error: 'The report was generated but the PDF failed to build. Try Download again.' }));
    } finally {
      setPdfGenerating(false);
    }
  }, []);

  /** Sends the browser to Stripe, leaving the document text behind in the tab. */
  const startCheckout = async () => {
    if (!reportableDocs.length) return;
    setReport({ status: 'starting', error: '', data: null, mode: null, sessionId: null });

    if (!stashPendingDocs(reportableDocs)) {
      setReport({ status: 'error', error: 'Your browser blocked local storage, which this needs to hold your documents during payment. Try turning off private browsing.', data: null, mode: null, sessionId: null });
      return;
    }

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentCount: reportableDocs.length })
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
      window.location.href = data.url;
    } catch (err) {
      setReport({ status: 'error', error: err.message || 'Could not start checkout.', data: null, mode: null, sessionId: null });
    }
  };

  /** Asks the server for the report once Stripe has confirmed the payment. */
  const generateReport = useCallback(async (sessionId) => {
    const cached = readCachedReport(sessionId);
    if (cached) {
      setReport({ status: 'ready', error: '', data: cached, mode: cached.mode, sessionId });
      if (cached.mode === 'compare' && cached.comparison) setComparisonResult(cached.comparison);
      return;
    }

    const pending = readPendingDocs();
    if (!pending?.length) {
      setReport({
        status: 'error',
        sessionId,
        mode: null,
        data: null,
        error: 'Your payment went through, but this browser no longer has the documents. Re-upload them in this tab and your report will generate without charging you again.'
      });
      return;
    }

    setReport({ status: 'generating', error: '', data: null, mode: null, sessionId });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 58000);

    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ sessionId, documents: pending })
      });
      clearTimeout(timeoutId);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'The report could not be generated.');
      }

      const payload = { ...data, documents: pending.map(d => ({ name: d.name })) };
      cacheReport(sessionId, payload);
      clearPendingDocs();

      setReport({ status: 'ready', error: '', data: payload, mode: payload.mode, sessionId });
      if (payload.mode === 'compare' && payload.comparison) setComparisonResult(payload.comparison);
      downloadReportPdf(payload);

    } catch (err) {
      clearTimeout(timeoutId);
      const message = err.name === 'AbortError'
        ? 'That took longer than expected. Your payment is safe — reload this page to try again.'
        : (err.message || 'The report could not be generated.');
      setReport({ status: 'error', error: message, data: null, mode: null, sessionId });
    }
  }, [downloadReportPdf]);

  // Coming back from Stripe: ?report=<checkout session id>
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('report');
    if (!sessionId) return;

    // Clear the id out of the address bar so a refresh does not re-trigger it.
    window.history.replaceState({}, '', window.location.pathname);
    generateReport(sessionId);
    setTimeout(() => document.getElementById('report-section')?.scrollIntoView({ behavior: 'smooth' }), 400);
  }, [generateReport]);

  const processFileForDoc = async (selectedFile, id, providedPassword = null) => {
    if (!selectedFile) return;

    if (selectedFile.size === 0) {
      updateDoc(id, { error: 'This file is empty (0 bytes). Please upload a real document.', loading: false, stage: null });
      return;
    }

    const MAX_SIZE_MB = 50;
    if (selectedFile.size > MAX_SIZE_MB * 1024 * 1024) {
      updateDoc(id, { error: `File too large (${(selectedFile.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_SIZE_MB} MB.`, loading: false, stage: null });
      return;
    }

    const ext = selectedFile.name.split('.').pop().toLowerCase();
    const isPdf = selectedFile.type === 'application/pdf' || ext === 'pdf';
    const isDocx = ext === 'docx';
    const isText = selectedFile.type.startsWith('text/') || ext === 'txt' || ext === 'text';

    if (!isPdf && !isDocx && !isText) {
      updateDoc(id, { error: `Unsupported file type (.${ext}). We accept PDF, DOCX, and TXT files only.`, loading: false, stage: null });
      return;
    }

    updateDoc(id, {
      file: selectedFile,
      error: '',
      analysis: null,
      needsPassword: false,
      extractedText: '',
      loading: true
    });

    let text = '';
    let arrayBuffer = null;
    let clonedBuffer = null;

    try {
      arrayBuffer = await selectedFile.arrayBuffer();
      clonedBuffer = arrayBuffer.slice(0);

      if (selectedFile.type === 'application/pdf') {
        try {
          text = await extractTextFromPdf(arrayBuffer, null, 3000);
        } catch (firstErr) {
          if (firstErr.message === 'TIMEOUT' || firstErr.message === 'PASSWORD_REQUIRED') {
            updateDoc(id, {
              needsPassword: true,
              pendingBuffer: clonedBuffer,
              loading: false,
              stage: null,
              extractProgress: null,
              error: ''
            });
            return;
          }
          if (firstErr.message?.includes('Invalid') || firstErr.message?.includes('corrupt') || firstErr.message?.includes('structure')) {
            throw new Error('This PDF file appears to be corrupted or is not a valid PDF. Try re-saving or re-exporting from the original source.');
          }
          throw firstErr;
        }
      } else if (selectedFile.name.endsWith('.docx')) {
        let result;
        try {
          const mammoth = await import('mammoth');
          result = await mammoth.extractRawText({ arrayBuffer });
        } catch (mammothErr) {
          throw new Error('This DOCX file appears to be corrupted or not a valid Word document. Try opening it in Word and re-saving.');
        }
        text = result.value;
        if (result.messages.length > 0) {
          console.warn('DOCX parse warnings:', result.messages);
        }
      } else if (selectedFile.type.startsWith('text/')) {
        text = await selectedFile.text();
      } else {
        updateDoc(id, { error: 'Unsupported file type. Please upload a PDF, DOCX, or text file.', loading: false, stage: null });
        return;
      }

      if (text.length < 100) {
        updateDoc(id, { error: 'Could not extract enough text. It may be a scanned image PDF. Try pasting text manually.', loading: false, stage: null, extractProgress: null });
        return;
      }

      updateDoc(id, { extractedText: text.substring(0, MAX_RETAINED_CHARS), needsPassword: false, pendingBuffer: null, stage: 'analyzing', extractProgress: null });
      await analyzeDocText(text, id);

    } catch (err) {
      if (err.message === 'PASSWORD_REQUIRED' || err.message === 'TIMEOUT') {
        updateDoc(id, {
          needsPassword: true,
          pendingBuffer: arrayBuffer,
          loading: false,
          stage: null,
          extractProgress: null,
          error: ''
        });
        return;
      }
      updateDoc(id, { error: err.message || 'Failed to process document', loading: false, stage: null, extractProgress: null });
    }
  };

  const handlePasswordSubmit = async (id) => {
    const doc = documents.find(d => d.id === id);
    if (!doc || !doc.password || !doc.pendingBuffer) return;

    updateDoc(id, { needsPassword: false, loading: true, error: '', stage: 'extracting' });

    try {
      const extractPromise = extractTextFromPdf(doc.pendingBuffer, doc.password, 55000);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PDF extraction timed out. The password may be incorrect or the file is too large. Try pasting text manually.')), 55000)
      );
      const text = await Promise.race([extractPromise, timeoutPromise]);

      if (text.length < 100) {
        updateDoc(id, { error: 'Could not extract enough text. Try pasting text manually.', loading: false, stage: null, extractProgress: null });
        return;
      }

      updateDoc(id, { extractedText: text.substring(0, MAX_RETAINED_CHARS), pendingBuffer: null, stage: 'analyzing', extractProgress: null });
      await analyzeDocText(text, id);
    } catch (err) {
      if (err.message === 'PASSWORD_REQUIRED') {
        updateDoc(id, { needsPassword: true, error: 'Incorrect password. Please try again.', loading: false, stage: null, extractProgress: null });
      } else {
        updateDoc(id, { error: err.message || 'Failed to process document', loading: false, stage: null, extractProgress: null });
      }
    }
  };

  const addDocument = () => {
    if (documents.length >= 5) return;
    const newId = Math.max(...documents.map(d => d.id), -1) + 1;
    setDocuments(prev => [...prev, createEmptyDoc(newId)]);
  };

  const removeDocument = (id) => {
    if (documents.length <= 1) {
      updateDoc(id, createEmptyDoc(id));
      return;
    }
    setDocuments(prev => prev.filter(d => d.id !== id));
  };

  const handleDrop = useCallback((e, id) => {
    e.preventDefault();
    setDragOverId(null);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) processFileForDoc(droppedFile, id);
  }, []);

  const handleDragOver = useCallback((e, id) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOverId(null);
  }, []);

  const exportAllToCsv = () => {
    const analyzedDocs = documents.filter(d => d.analysis && !d.analysis.raw);
    if (analyzedDocs.length === 0) return;

    let csv = '\uFEFF';

    analyzedDocs.forEach((doc, idx) => {
      const a = doc.analysis;
      csv += `Document ${idx + 1}: ${doc.file?.name || 'Unknown'}\n`;
      csv += `Field,Value\n`;
      csv += `Policy Type,"${(a.policy_type || '').replace(/"/g, '""')}"\n`;
      csv += `Insurer,"${(a.insurer || '').replace(/"/g, '""')}"\n`;
      csv += `Policy Number,"${(a.policy_number || '').replace(/"/g, '""')}"\n`;
      csv += `Policyholder,"${(a.policyholder || '').replace(/"/g, '""')}"\n`;

      // Premium Amounts
      if (a.premium) {
        csv += `Premium Amount,"${String(a.premium.amount || '').replace(/"/g, '""')}"\n`;
        csv += `Premium Frequency,"${String(a.premium.frequency || '').replace(/"/g, '""')}"\n`;
        csv += `Annual Total,"${String(a.premium.total_annual || '').replace(/"/g, '""')}"\n`;
      }

      // Key Dates
      if (a.key_dates) {
        csv += `Issue Date,"${String(a.key_dates.issue_date || '').replace(/"/g, '""')}"\n`;
        csv += `Commencement Date,"${String(a.key_dates.commencement_date || '').replace(/"/g, '""')}"\n`;
        csv += `Expiry Date,"${String(a.key_dates.expiry_date || '').replace(/"/g, '""')}"\n`;
        csv += `Renewal Date,"${String(a.key_dates.renewal_date || '').replace(/"/g, '""')}"\n`;
      }

      // Coverage Details
      if (a.coverage_details?.description) {
        csv += `Coverage Description,"${a.coverage_details.description.replace(/"/g, '""')}"\n`;
      }
      if (a.coverage_details?.main_coverage?.length) {
        csv += `Main Coverage,"${a.coverage_details.main_coverage.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.coverage_details?.total_coverage_value) {
        csv += `Total Coverage Value,"${String(a.coverage_details.total_coverage_value).replace(/"/g, '""')}"\n`;
      }
      if (a.coverage_details?.limits?.length) {
        csv += `Limits / Sub-limits,"${a.coverage_details.limits.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.coverage_details?.riders_add_ons?.length) {
        csv += `Add-ons / Riders,"${a.coverage_details.riders_add_ons.join('; ').replace(/"/g, '""')}"\n`;
      }

      // Exclusions & Limitations
      if (a.exclusions_and_limitations?.exclusions?.length) {
        csv += `Exclusions,"${a.exclusions_and_limitations.exclusions.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.exclusions_and_limitations?.limitations?.length) {
        csv += `Limitations,"${a.exclusions_and_limitations.limitations.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.exclusions_and_limitations?.waiting_periods?.length) {
        csv += `Waiting Periods,"${a.exclusions_and_limitations.waiting_periods.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.exclusions_and_limitations?.special_conditions?.length) {
        csv += `Special Conditions,"${a.exclusions_and_limitations.special_conditions.join('; ').replace(/"/g, '""')}"\n`;
      }

      // Terms & Conditions
      if (a.terms_and_conditions?.policy_term) {
        csv += `Policy Term,"${a.terms_and_conditions.policy_term.replace(/"/g, '""')}"\n`;
      }
      if (a.terms_and_conditions?.renewal_terms) {
        csv += `Renewal Terms,"${a.terms_and_conditions.renewal_terms.replace(/"/g, '""')}"\n`;
      }
      if (a.terms_and_conditions?.cancellation_terms) {
        csv += `Cancellation Terms,"${a.terms_and_conditions.cancellation_terms.replace(/"/g, '""')}"\n`;
      }
      if (a.terms_and_conditions?.claims_process) {
        csv += `Claims Process,"${a.terms_and_conditions.claims_process.replace(/"/g, '""')}"\n`;
      }
      if (a.terms_and_conditions?.grace_period) {
        csv += `Grace Period,"${a.terms_and_conditions.grace_period.replace(/"/g, '""')}"\n`;
      }

      // Warnings & Gaps
      if (a.warnings_and_gaps?.length) {
        csv += `Warnings / Gaps,"${a.warnings_and_gaps.join('; ').replace(/"/g, '""')}"\n`;
      }

      csv += `Summary,"${(a.summary || '').replace(/"/g, '""')}"\n`;
      csv += `\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'insurance-analysis-all.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportSingleCsv = (doc) => {
    const a = doc.analysis;
    if (!a || a.raw) return;

    const rows = [['Field', 'Value']];
    rows.push(['Policy Type', a.policy_type || '']);
    rows.push(['Insurer', a.insurer || '']);
    rows.push(['Policy Number', a.policy_number || '']);
    rows.push(['Policyholder', a.policyholder || '']);
    if (a.premium) {
      rows.push(['Premium Amount', a.premium.amount || '']);
      rows.push(['Premium Frequency', a.premium.frequency || '']);
      rows.push(['Annual Total', a.premium.total_annual || '']);
    }
    if (a.key_dates) {
      rows.push(['Issue Date', a.key_dates.issue_date || '']);
      rows.push(['Commencement Date', a.key_dates.commencement_date || '']);
      rows.push(['Maturity Date', a.key_dates.maturity_date || '']);
      rows.push(['Renewal Date', a.key_dates.renewal_date || '']);
    }
    if (a.maturity) {
      rows.push(['Maturity Type', a.maturity.type || '']);
      rows.push(['Term Years', a.maturity.term_years || '']);
      rows.push(['Surrender Notes', a.maturity.surrender_value_notes || '']);
    }
    if (a.coverage?.medical_expenses) rows.push(['Medical Expenses', a.coverage.medical_expenses]);
    if (a.coverage?.trip_cancellation) rows.push(['Trip Cancellation', a.coverage.trip_cancellation]);
    if (a.coverage?.baggage_loss) rows.push(['Baggage Loss', a.coverage.baggage_loss]);
    if (a.coverage?.personal_accident) rows.push(['Personal Accident', a.coverage.personal_accident]);
    if (a.coverage?.travel_delay) rows.push(['Travel Delay', a.coverage.travel_delay]);
    if (a.coverage?.vehicle_sum_insured) rows.push(['Sum Insured / Market Value', a.coverage.vehicle_sum_insured]);
    if (a.coverage?.third_party_liability) rows.push(['Third-Party Liability', a.coverage.third_party_liability]);
    if (a.coverage?.own_damage_excess) rows.push(['Own Damage Excess', a.coverage.own_damage_excess]);
    if (a.coverage?.unnamed_driver_excess) rows.push(['Unnamed Driver Excess', a.coverage.unnamed_driver_excess]);
    if (a.coverage?.young_driver_excess) rows.push(['Young/Inexperienced Driver Excess', a.coverage.young_driver_excess]);
    if (a.coverage?.windscreen_excess) rows.push(['Windscreen Excess', a.coverage.windscreen_excess]);
    if (a.coverage?.main_benefits?.length) {
      rows.push(['', '']);
      rows.push(['Coverage Benefits', '']);
      a.coverage.main_benefits.forEach(b => rows.push(['', b]));
    }
    if (a.coverage?.riders?.length) {
      rows.push(['', '']);
      rows.push(['Riders', '']);
      a.coverage.riders.forEach(r => rows.push(['', r]));
    }
    if (a.payout_criteria?.length) {
      rows.push(['', '']);
      rows.push(['Payout Criteria', '']);
      a.payout_criteria.forEach(c => rows.push(['', c]));
    }
    if (a.deductibles_excess?.length) {
      rows.push(['', '']);
      rows.push(['Deductibles / Excess', '']);
      a.deductibles_excess.forEach(d => rows.push(['', d]));
    }
    if (a.exclusions?.length) {
      rows.push(['', '']);
      rows.push(['Exclusions', '']);
      a.exclusions.forEach(ex => rows.push(['', ex]));
    }
    if (a.investment_linked?.is_ilp) {
      rows.push(['', '']);
      rows.push(['ILP Allocation', a.investment_linked.allocation || '']);
      rows.push(['ILP Returns', a.investment_linked.projected_returns || '']);
      if (a.investment_linked.funds?.length) {
        rows.push(['ILP Funds', a.investment_linked.funds.join(', ')]);
      }
    }
    if (a.warnings?.length) {
      rows.push(['', '']);
      rows.push(['Warnings', '']);
      a.warnings.forEach(w => rows.push(['', w]));
    }
    rows.push(['', '']);
    rows.push(['Summary', a.summary || '']);

    let csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `insurance-analysis-${doc.file?.name?.replace(/\.[^/.]+$/, '') || 'doc'}.csv`;
    document.body.appendChild(el);
    el.click();
    document.body.removeChild(el);
    URL.revokeObjectURL(url);
  };


  return (
    <div className="min-h-screen bg-white text-slate-800">
      <Head>
        <title>Policy2Summary - Free AI Insurance Document Summarizer | Read Policy Fine Print Instantly</title>
        <meta name="description" content="Upload any insurance policy PDF or DOCX and get an instant AI summary. Understand coverage, exclusions, premiums, and hidden clauses in plain English. Free, private, no signup." />
        <meta name="keywords" content="insurance policy summary, insurance document reader, AI insurance analyzer, policy summary generator, insurance certificate reader, free insurance tool, understand insurance coverage, insurance fine print" />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href="https://www.policy2summary.com/" />

        {/* Open Graph */}
        <meta property="og:title" content="Policy2Summary - Free AI Insurance Document Summarizer" />
        <meta property="og:description" content="Upload any insurance policy and get an instant plain-English summary. Coverage, exclusions, premiums - all decoded by AI." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://www.policy2summary.com/" />
        <meta property="og:image" content="https://www.policy2summary.com/images/og-image.png" />
        <meta property="og:site_name" content="Policy2Summary" />
        <meta property="og:locale" content="en_SG" />

        {/* Twitter Card */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Policy2Summary - Free AI Insurance Document Summarizer" />
        <meta name="twitter:description" content="Upload any insurance policy and get an instant plain-English summary." />
        <meta name="twitter:image" content="https://www.policy2summary.com/images/og-image.png" />

        {/* JSON-LD Structured Data */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebSite",
              "@id": "https://www.policy2summary.com/#website",
              "url": "https://www.policy2summary.com/",
              "name": "Policy2Summary",
              "description": "Free AI-powered insurance policy summarizer",
              "publisher": {"@id": "https://www.policy2summary.com/#organization"},
              "inLanguage": "en-SG"
            },
            {
              "@type": "Organization",
              "@id": "https://www.policy2summary.com/#organization",
              "name": "Policy2Summary",
              "url": "https://www.policy2summary.com/",
              "logo": {
                "@type": "ImageObject",
                "url": "https://www.policy2summary.com/logo.png"
              },
              "sameAs": []
            },
            {
              "@type": "SoftwareApplication",
              "@id": "https://www.policy2summary.com/#app",
              "name": "Policy2Summary",
              "applicationCategory": "FinanceApplication",
              "operatingSystem": "Web Browser",
              "offers": {
                "@type": "Offer",
                "price": "0",
                "priceCurrency": "SGD"
              },
              "aggregateRating": {
                "@type": "AggregateRating",
                "ratingValue": "4.8",
                "ratingCount": "1"
              },
              "featureList": "PDF and DOCX upload, AI policy summary generation, Coverage details extraction, Exclusion identification, Premium amount detection, Key dates extraction"
            },
            {
              "@type": "FAQPage",
              "mainEntity": [
                {
                  "@type": "Question",
                  "name": "Is Policy2Summary free?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Yes, Policy2Summary is currently free to use. Upload your insurance document and get an instant AI summary at no cost."
                  }
                },
                {
                  "@type": "Question",
                  "name": "Is my insurance data safe?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Yes. Your documents are processed in memory only and never stored on our servers. Files are deleted immediately after analysis."
                  }
                },
                {
                  "@type": "Question",
                  "name": "What file formats are supported?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "We support PDF and DOCX files. Simply upload your insurance certificate, policy document, or coverage summary."
                  }
                }
              ]
            }
          ]
        })}} />
      </Head>

      {/* Navigation */}
      <nav className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/images/logo.jpg"
              alt="Policy2Summary logo - AI insurance document summarizer"
              className="w-9 h-9 rounded-lg object-cover"
            />
            <div>
              <h1 className="text-lg font-bold text-slate-900 tracking-tight leading-none">Policy2Summary</h1>
              <p className="text-[10px] text-slate-400 font-medium tracking-wider uppercase mt-0.5">AI Insurance Reader</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <a href="#how-it-works" className="hidden sm:inline-flex text-sm text-slate-500 hover:text-slate-800 transition-colors font-medium">How It Works</a>
            <a href="#upload-section" className="hidden sm:inline-flex text-sm text-slate-500 hover:text-slate-800 transition-colors font-medium">Analyze</a>
            {reportableDocs.length > 0 && report.status !== 'ready' && (
              <button
                onClick={startCheckout}
                disabled={report.status === 'starting' || report.status === 'generating'}
                className="inline-flex items-center gap-1 sm:gap-2 px-2.5 sm:px-3.5 py-1.5 sm:py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-lg text-xs sm:text-sm font-medium transition-colors shadow-sm"
              >
                {report.status === 'starting' || report.status === 'generating' ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                )}
                <span className="hidden sm:inline">Get full report &middot; {REPORT_PRICE}</span>
                <span className="sm:hidden">Report</span>
              </button>
            )}
            {report.status === 'ready' && (
              <button
                onClick={() => downloadReportPdf(report.data)}
                disabled={pdfGenerating}
                className="inline-flex items-center gap-1 sm:gap-2 px-2.5 sm:px-3.5 py-1.5 sm:py-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-500 text-white rounded-lg text-xs sm:text-sm font-medium transition-colors shadow-sm"
              >
                {pdfGenerating ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                )}
                <span className="hidden sm:inline">Download PDF</span>
                <span className="sm:hidden">PDF</span>
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-b from-emerald-50 to-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-12 sm:pt-12 sm:pb-16">
          <div className="mb-4">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Free Tool - No Signup Required
            </div>
          </div>
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-4xl sm:text-5xl font-bold text-slate-900 leading-tight mb-6">
                Understand Your Insurance in{' '}
                <span className="text-emerald-600">Plain English</span>
              </h2>
              <p className="text-lg text-slate-600 mb-8 leading-relaxed max-w-lg">
                Upload any insurance policy - PDF, Word, or text. Our AI reads the fine print and tells you exactly what you are covered for, what is excluded, and what it costs.
              </p>
              <div className="flex flex-wrap gap-4">
                <button
                  onClick={() => { setShowUpload(true); setTimeout(() => document.getElementById('upload-section')?.scrollIntoView({ behavior: 'smooth' }), 100); }}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-base font-semibold transition-colors shadow-lg shadow-emerald-600/20"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Upload Your Policy
                </button>
                <a href="#how-it-works" className="inline-flex items-center gap-2 px-6 py-3 bg-white border-2 border-slate-200 hover:border-slate-300 text-slate-700 rounded-xl text-base font-semibold transition-colors">
                  See How It Works
                </a>
              </div>
              <div className="flex items-center gap-6 mt-8 text-sm text-slate-500">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  No signup
                </div>
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  No data stored
                </div>
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Free forever
                </div>
              </div>
            </div>
            <div className="relative">
              <img
                src="/images/hero-image.jpg"
                alt="AI assistant transforming messy insurance documents into clear summaries"
                className="rounded-2xl w-full h-auto border border-slate-200 shadow-lg"
              />
              {/* Floating badge */}
              <div className="absolute -bottom-4 -left-4 bg-white rounded-xl shadow-lg border border-slate-100 p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">Policies Analyzed</p>
                  <p className="text-xs text-slate-500">Instant summaries in seconds</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-8 sm:py-10 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4">How It Works</h2>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Three simple steps to understand any insurance document - no insurance background needed.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {/* Step 1 */}
            <div className="text-center">
              <div className="relative mx-auto w-48 h-48 mb-6 rounded-2xl overflow-hidden border border-slate-200">
                <img
                  src="/images/step1-upload.jpg"
                  alt="Upload PDF, Word, or text files"
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold">1</div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Upload Your Policy</h3>
              <p className="text-slate-600">Drag and drop your PDF, Word document, or paste the text directly. We support password-protected PDFs too.</p>
            </div>
            {/* Step 2 */}
            <div className="text-center">
              <div className="relative mx-auto w-48 h-48 mb-6 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
                <img src="/images/step2-ai-analysis.jpg" alt="AI analyzing insurance policy" className="w-full h-full object-cover" />
                <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold">2</div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">AI Reads the Fine Print</h3>
              <p className="text-slate-600">Our AI extracts coverage details, exclusions, premiums, key dates, and hidden clauses you might have missed.</p>
            </div>
            {/* Step 3 */}
            <div className="text-center">
              <div className="relative mx-auto w-48 h-48 mb-6 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
                <img src="/images/step3-summary.jpg" alt="Policy summary output" className="w-full h-full object-cover" />
                <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold">3</div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Get Your Summary</h3>
              <p className="text-slate-600">Receive a clear, structured breakdown of each policy. Generate professional PDF analysis reports and make informed decisions.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Features / Trust Section */}
      <section className="py-16 sm:py-20 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-6">
                Why Insurance Documents Are So Hard to Read
              </h2>
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">Exclusions Buried in Pages</h3>
                    <p className="text-slate-600">The things you are NOT covered for are often hidden in dense legal paragraphs. Most people never find them until it is too late.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">Key Dates Scattered Everywhere</h3>
                    <p className="text-slate-600">Issue dates, commencement dates, maturity dates, renewal dates - each buried in different sections of a 30-page document.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">Coverage Amounts in Fine Print</h3>
                    <p className="text-slate-600">What you are actually insured for - medical limits, trip cancellation caps, excess amounts - is rarely presented clearly.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="relative">
              <img
                src="/images/feature-illustration.jpg"
                alt="Person overwhelmed by scattered insurance documents and fine print"
                className="rounded-2xl w-full h-auto border border-slate-200 shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Supported Types */}
      <section className="py-16 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">All Insurance Types Supported</h2>
            <p className="text-lg text-slate-600">From travel to life insurance - if it is a policy document, we can read it.</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {['Travel Insurance', 'Life Insurance', 'Health Insurance', 'Car Insurance', 'Home Insurance', 'Investment-Linked Policies', 'Personal Accident', 'Corporate Policies'].map((type) => (
              <div key={type} className="bg-slate-50 rounded-xl p-4 text-center border border-slate-100 hover:border-emerald-200 transition-colors">
                <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-700">{type}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Disclaimer Banner */}
      <section className="bg-amber-50 border-y border-amber-200 py-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm text-amber-800 font-medium">Important: AI-generated summaries for reference only</p>
            <p className="text-xs text-amber-600 mt-0.5">
              Always verify details with your insurer before making decisions. <a href="/disclaimer" className="underline hover:text-amber-800">Read full disclaimer</a>.
            </p>
          </div>
        </div>
      </section>

      {/* Upload Section */}
      <section id="upload-section" className="py-16 sm:py-20 bg-gradient-to-b from-emerald-50 to-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4">Upload Your Documents</h2>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Upload up to 5 policies for individual AI analysis. We accept PDF, Word, and text files.
            </p>
          </div>

          {/* Privacy Banner */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-8 flex items-start gap-3">
            <svg className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-emerald-800">Your documents are processed in memory only</p>
              <p className="text-xs text-emerald-600 mt-0.5">Nothing is stored on our servers. Files are deleted immediately after analysis.</p>
            </div>
          </div>

          {/* Document Cards */}
          <div className="space-y-6">
            {documents.map((doc, idx) => (
              <div key={doc.id} className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                {/* Card Header */}
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center text-sm font-bold text-slate-500">
                      {idx + 1}
                    </div>
                    <span className="font-medium text-slate-700">
                      {doc.file ? doc.file.name : 'Select a document'}
                    </span>
                    {doc.analysis && !doc.analysis.raw && (
                      <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-medium">
                        Analyzed
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => removeDocument(doc.id)}
                      className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                      title="Remove"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Card Body */}
                <div className="p-6">
                  {!doc.file && !doc.analysis && (
                    <div
                      className={`border-2 border-dashed rounded-xl p-10 text-center transition-all ${
                        dragOverId === doc.id
                          ? 'border-emerald-400 bg-emerald-50'
                          : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
                      }`}
                      onDrop={(e) => handleDrop(e, doc.id)}
                      onDragOver={(e) => handleDragOver(e, doc.id)}
                      onDragLeave={handleDragLeave}
                    >
                      <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                        <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                      </div>
                      <p className="text-base font-medium text-slate-700 mb-1">
                        {dragOverId === doc.id ? 'Drop your file here' : 'Drag & drop or browse'}
                      </p>
                      <p className="text-sm text-slate-500 mb-5">PDF, Word, or text files up to 50MB</p>
                      <label className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors shadow-sm">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                        Choose File
                        <input
                          ref={el => fileInputRefs.current[doc.id] = el}
                          type="file"
                          className="hidden"
                          accept=".pdf,.txt,.doc,.docx"
                          onChange={(e) => e.target.files?.[0] && processFileForDoc(e.target.files[0], doc.id)}
                        />
                      </label>
                    </div>
                  )}

                  {/* Password Prompt */}
                  {doc.needsPassword && (
                    <div className="p-5 rounded-xl bg-amber-50 border border-amber-200">
                      <div className="flex items-center gap-2 mb-3">
                        <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                        <span className="text-sm font-semibold text-amber-800">Password Required</span>
                      </div>
                      <p className="text-sm text-amber-600 mb-4">This PDF is password-protected. Please enter the password to continue.</p>
                      <div className="flex gap-3">
                        <input
                          type="password"
                          value={doc.password}
                          onChange={(e) => updateDoc(doc.id, { password: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit(doc.id)}
                          placeholder="Enter PDF password"
                          className="flex-1 px-4 py-2.5 bg-white border border-amber-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                        />
                        <button
                          onClick={() => handlePasswordSubmit(doc.id)}
                          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                          Unlock
                        </button>
                        <button
                          onClick={() => {
                            updateDoc(doc.id, { needsPassword: false, password: '', pendingBuffer: null, file: null });
                          }}
                          className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-sm font-medium transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {doc.error && (
                    <div className="mt-4 p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                      {doc.error}
                    </div>
                  )}

                  {/* Loading */}
                  {doc.loading && (
                    <div className="mt-4 flex items-center gap-3 text-sm text-slate-500">
                      <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                      {doc.stage === 'extracting' ? (
                        <span>Extracting text from PDF{doc.extractProgress ? ` (${doc.extractProgress})` : ''}...</span>
                      ) : doc.stage === 'analyzing' ? (
                        <span>Analyzing with AI...</span>
                      ) : doc.stage === 'executive_analysis' ? (
                        <span>{doc.stageMessage || 'Preparing executive PDF report...'}</span>
                      ) : doc.stage === 'comparison' ? (
                        <span>Comparing policies and generating report...</span>
                      ) : doc.stage === 'pdf_export' ? (
                        <span>Generating PDF report...</span>
                      ) : (
                        <span>Processing...</span>
                      )}
                    </div>
                  )}

                  {/* Manual Text Input */}
                  {!doc.file && !doc.analysis && !doc.loading && !doc.needsPassword && (
                    <div className="mt-5">
                      <div className="flex items-center gap-4 mb-3">
                        <div className="h-px flex-1 bg-slate-200" />
                        <span className="text-sm text-slate-400 font-medium">or paste text directly</span>
                        <div className="h-px flex-1 bg-slate-200" />
                      </div>
                      <textarea
                        className="w-full h-28 bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-50 resize-none transition-all"
                        placeholder="Paste your insurance policy text here..."
                        value={doc.extractedText}
                        onChange={(e) => updateDoc(doc.id, { extractedText: e.target.value })}
                      />
                      {doc.extractedText.length > 500 && (
                        <button
                          onClick={() => analyzeDocText(doc.extractedText, doc.id)}
                          className="mt-3 w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold transition-colors"
                        >
                          Analyze Text
                        </button>
                      )}
                    </div>
                  )}

                  {/* Results */}
                  {doc.analysis && !doc.analysis.raw && (
                    <AnalysisResults analysis={doc.analysis} />
                  )}
                  {doc.analysis?.raw && (
                    <div className="mt-5 p-5 bg-slate-50 border border-slate-200 rounded-xl">
                      <h3 className="text-sm font-semibold text-slate-700 mb-3">AI Analysis (Raw)</h3>
                      <pre className="text-xs text-slate-600 whitespace-pre-wrap overflow-auto max-h-80 bg-white p-4 rounded-lg border border-slate-100">
                        {doc.analysis.raw}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Add Document Button */}
          {documents.length < 5 && (
            <button
              onClick={addDocument}
              className="mt-6 w-full py-4 border-2 border-dashed border-slate-300 hover:border-emerald-400 hover:bg-emerald-50 rounded-2xl text-slate-500 hover:text-emerald-600 transition-all flex items-center justify-center gap-2 font-medium"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Another Document ({documents.length}/5)
            </button>
          )}
        </div>

        {/* Comparison Results */}
        {/* The paid report: the offer, the progress, and the finished thing. */}
        {(reportableDocs.length > 0 || report.status !== 'idle') && (
          <div id="report-section" className="max-w-4xl mx-auto px-4 sm:px-6 mt-10">

            {report.status === 'idle' && reportableDocs.length > 0 && (
              <div className="bg-white border border-emerald-200 rounded-xl overflow-hidden shadow-sm">
                <div className="p-6 sm:p-7">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-bold text-slate-900">
                        {reportableDocs.length > 1
                          ? `One combined report across your ${reportableDocs.length} policies`
                          : 'Your full policy report'}
                      </h2>
                      <p className="text-sm text-slate-500 mt-1">
                        The summaries above read the opening pages. The report reads the whole wording.
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-slate-900">{REPORT_PRICE}</div>
                      <div className="text-xs text-slate-500">one-off &middot; no account</div>
                    </div>
                  </div>

                  <ul className="mt-5 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-600">
                    <li className="flex gap-2"><span className="text-emerald-500">&#10003;</span> Reads the full policy wording, not the first few pages</li>
                    <li className="flex gap-2"><span className="text-emerald-500">&#10003;</span> Every policy assessed together in one report</li>
                    <li className="flex gap-2"><span className="text-emerald-500">&#10003;</span> Red flags ranked by severity, each with a quote from your document</li>
                    <li className="flex gap-2"><span className="text-emerald-500">&#10003;</span> Sub-limits, charges and waiting periods pulled out in full</li>
                    <li className="flex gap-2"><span className="text-emerald-500">&#10003;</span> Overlap and gaps across the whole set</li>
                    <li className="flex gap-2"><span className="text-emerald-500">&#10003;</span> PDF you can keep, print, or hand to your agent</li>
                  </ul>

                  <button
                    onClick={startCheckout}
                    className="mt-6 w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold transition-colors shadow-sm"
                  >
                    Get the report &middot; {REPORT_PRICE}
                  </button>
                  <p className="text-xs text-slate-400 mt-3">
                    Same price whether you upload one policy or {MAX_REPORT_DOCS}. Your documents stay in this browser until you pay.
                  </p>
                </div>
              </div>
            )}

            {(report.status === 'starting' || report.status === 'generating') && (
              <div className="bg-white border border-slate-200 rounded-xl p-6 flex items-center gap-4">
                <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {report.status === 'starting' ? 'Taking you to checkout\u2026' : 'Reading your policies in full\u2026'}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {report.status === 'starting'
                      ? 'Your documents stay in this browser.'
                      : 'This takes up to a minute. Please keep this tab open.'}
                  </p>
                </div>
              </div>
            )}

            {report.status === 'ready' && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Your report is ready</h2>
                    <p className="text-sm text-slate-600 mt-0.5">
                      {report.data?.meta?.documents > 1
                        ? `${report.data.meta.documents} policies, read in full and assessed together.`
                        : 'Read in full and assessed.'}
                      {report.data?.meta?.truncated && ' Very long sections were condensed \u2014 the report says where.'}
                    </p>
                  </div>
                  <button
                    onClick={() => downloadReportPdf(report.data)}
                    disabled={pdfGenerating}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-lg text-sm font-semibold transition-colors shadow-sm"
                  >
                    {pdfGenerating ? 'Building PDF\u2026' : 'Download PDF'}
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  Saved in this browser \u2014 you can download it again any time without paying twice.
                </p>
              </div>
            )}

            {report.status === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-6">
                <h2 className="text-sm font-semibold text-red-800">Something went wrong</h2>
                <p className="text-sm text-red-700 mt-1">{report.error}</p>
                {report.sessionId && (
                  <p className="text-xs text-red-500 mt-3">
                    Payment reference: <span className="font-mono">{report.sessionId}</span> \u2014 quote this if you contact us.
                  </p>
                )}
                <button
                  onClick={() => setReport({ status: 'idle', error: '', data: null, mode: null, sessionId: null })}
                  className="mt-4 text-sm text-red-700 underline hover:text-red-900"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}

        {comparisonResult && (
          <div className="max-w-4xl mx-auto px-4 sm:px-6 mt-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-slate-900">Multi-Policy Comparison</h2>
              <button
                onClick={() => setComparisonResult(null)}
                className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
              >
                Clear
              </button>
            </div>
            <ComparisonResults
              comparison={comparisonResult}
              docs={documents.filter(d => d.analysis && !d.analysis.raw)}
              pdfGenerating={pdfGenerating}
              onExportPdf={() => downloadReportPdf(report.data)}
            />
          </div>
        )}
      </section>

      {/* CTA Section */}
      <section className="py-16 bg-slate-900">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Never Miss What Your Insurance Actually Covers</h2>
          <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
            Thousands of claims are denied every year because policyholders did not understand their coverage. Know exactly what you have - in plain English.
          </p>
          <button
            onClick={() => { document.getElementById('upload-section')?.scrollIntoView({ behavior: 'smooth' }); }}
            className="inline-flex items-center gap-2 px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-base font-semibold transition-colors shadow-lg shadow-emerald-600/25"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Analyze My Policy Now
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <span className="font-bold text-slate-900">Policy2Summary</span>
              </div>
              <p className="text-sm text-slate-500">AI-powered insurance document reader. Making insurance understandable for everyone.</p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-3">Supported Formats</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>PDF (including password-protected)</li>
                <li>Microsoft Word (.docx)</li>
                <li>Plain text (.txt)</li>
                <li>Paste text directly</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-3">Contact</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>
                  <a href="mailto:thejpmoregainproject@gmail.com" className="hover:text-emerald-600 transition-colors">
                    thejpmoregainproject@gmail.com
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-3">Important</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>AI-generated summaries for reference only</li>
                <li>Always verify with your insurer</li>
                <li>Not financial advice</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-100 pt-6 text-center">
            <p className="text-sm text-slate-400 mb-3">
              Policy2Summary - Free tool. No data stored. Documents processed in memory only.
            </p>
            <div className="flex items-center justify-center gap-4 text-sm text-slate-400">
              <a href="/privacy" className="hover:text-slate-600 transition-colors">Privacy Policy</a>
              <span className="text-slate-300">|</span>
              <a href="/terms" className="hover:text-slate-600 transition-colors">Terms of Service</a>
              <span className="text-slate-300">|</span>
              <a href="/disclaimer" className="hover:text-slate-600 transition-colors">Disclaimer</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function AnalysisResults({ analysis }) {
  return (
    <div className="mt-6 space-y-5">
      {/* Summary */}
      <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 className="font-semibold text-emerald-800 text-sm">Policy Summary</h3>
        </div>
        <p className="text-slate-700 text-sm leading-relaxed">{analysis.summary}</p>
        <div className="flex flex-wrap gap-2 mt-4">
          {analysis.policy_type && (
            <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-medium">
              {analysis.policy_type}
            </span>
          )}
          {analysis.insurer && (
            <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs">
              {analysis.insurer}
            </span>
          )}
          {analysis.policy_number && (
            <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs">
              #{analysis.policy_number}
            </span>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Premium Amounts */}
        {analysis.premium && (analysis.premium.amount || analysis.premium.frequency || analysis.premium.total_annual) && (
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Premium Amounts
            </h3>
            <div className="space-y-2 text-sm">
              {analysis.premium.amount && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Amount</span>
                  <span className="text-slate-800 font-semibold">{analysis.premium.amount}</span>
                </div>
              )}
              {analysis.premium.frequency && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Frequency</span>
                  <span className="text-slate-600">{analysis.premium.frequency}</span>
                </div>
              )}
              {analysis.premium.total_annual && (
                <div className="flex justify-between border-t border-slate-100 pt-2 mt-2">
                  <span className="text-slate-500">Annual Total</span>
                  <span className="text-emerald-600 font-semibold">{analysis.premium.total_annual}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Key Dates */}
        {analysis.key_dates && Object.values(analysis.key_dates).some(Boolean) && (
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Key Dates
            </h3>
            <div className="space-y-2 text-sm">
              {analysis.key_dates.issue_date && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Issued</span>
                  <span className="text-slate-700">{analysis.key_dates.issue_date}</span>
                </div>
              )}
              {analysis.key_dates.commencement_date && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Commences</span>
                  <span className="text-slate-700">{analysis.key_dates.commencement_date}</span>
                </div>
              )}
              {analysis.key_dates.expiry_date && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Expires</span>
                  <span className="text-red-600 font-medium">{analysis.key_dates.expiry_date}</span>
                </div>
              )}
              {analysis.key_dates.renewal_date && (
                <div className="flex justify-between border-t border-slate-100 pt-2 mt-2">
                  <span className="text-slate-500">Renews</span>
                  <span className="text-amber-600 font-medium">{analysis.key_dates.renewal_date}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Coverage Details */}
      {(analysis.coverage_details?.main_coverage?.length || analysis.coverage_details?.description) && (
        <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-emerald-800 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Coverage Details
          </h3>
          {analysis.coverage_details?.description && (
            <p className="text-sm text-slate-700 leading-relaxed mb-4">{analysis.coverage_details.description}</p>
          )}
          {analysis.coverage_details?.main_coverage?.length > 0 && (
            <div className="space-y-2.5 text-sm">
              {analysis.coverage_details.main_coverage.map((item, i) => {
                const parts = item.split(':');
                return (
                  <div key={i} className="flex justify-between py-1">
                    <span className="text-slate-600 flex-1">{parts[0]}</span>
                    <span className="text-slate-900 font-semibold ml-4">{parts[1] ? parts[1].trim() : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
          {analysis.coverage_details?.total_coverage_value && (
            <div className="mt-4 pt-3 border-t border-emerald-200 flex justify-between">
              <span className="text-emerald-800 font-medium text-sm">Total Coverage Value</span>
              <span className="text-emerald-700 font-bold text-sm">{analysis.coverage_details.total_coverage_value}</span>
            </div>
          )}
          {analysis.coverage_details?.limits?.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Limits & Sub-limits</h4>
              <ul className="space-y-1 text-sm text-slate-600 list-disc list-inside">
                {analysis.coverage_details.limits.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.coverage_details?.riders_add_ons?.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Add-ons & Riders</h4>
              <ul className="space-y-1 text-sm text-slate-600 list-disc list-inside">
                {analysis.coverage_details.riders_add_ons.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Exclusions & Limitations */}
      {(analysis.exclusions_and_limitations?.exclusions?.length ||
        analysis.exclusions_and_limitations?.limitations?.length ||
        analysis.exclusions_and_limitations?.waiting_periods?.length ||
        analysis.exclusions_and_limitations?.special_conditions?.length) && (
        <div className="bg-white border border-red-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-red-800 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M7 21l5.618-4.017A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Exclusions & Limitations
          </h3>
          {analysis.exclusions_and_limitations?.exclusions?.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">What's NOT Covered</h4>
              <ul className="space-y-1.5 text-sm text-slate-700 list-disc list-inside">
                {analysis.exclusions_and_limitations.exclusions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.exclusions_and_limitations?.limitations?.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Limitations</h4>
              <ul className="space-y-1.5 text-sm text-slate-600 list-disc list-inside">
                {analysis.exclusions_and_limitations.limitations.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.exclusions_and_limitations?.waiting_periods?.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Waiting Periods</h4>
              <ul className="space-y-1.5 text-sm text-slate-600 list-disc list-inside">
                {analysis.exclusions_and_limitations.waiting_periods.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.exclusions_and_limitations?.special_conditions?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Special Conditions</h4>
              <ul className="space-y-1.5 text-sm text-slate-600 list-disc list-inside">
                {analysis.exclusions_and_limitations.special_conditions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Terms & Conditions */}
      {(analysis.terms_and_conditions?.policy_term ||
        analysis.terms_and_conditions?.renewal_terms ||
        analysis.terms_and_conditions?.cancellation_terms ||
        analysis.terms_and_conditions?.claims_process ||
        analysis.terms_and_conditions?.grace_period) && (
        <div className="bg-white border border-blue-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-blue-800 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Terms & Conditions
          </h3>
          <div className="space-y-4 text-sm">
            {analysis.terms_and_conditions?.policy_term && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Policy Term</h4>
                <p className="text-slate-700">{analysis.terms_and_conditions.policy_term}</p>
              </div>
            )}
            {analysis.terms_and_conditions?.renewal_terms && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Renewal Terms</h4>
                <p className="text-slate-700">{analysis.terms_and_conditions.renewal_terms}</p>
              </div>
            )}
            {analysis.terms_and_conditions?.cancellation_terms && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Cancellation</h4>
                <p className="text-slate-700">{analysis.terms_and_conditions.cancellation_terms}</p>
              </div>
            )}
            {analysis.terms_and_conditions?.claims_process && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Claims Process</h4>
                <p className="text-slate-700">{analysis.terms_and_conditions.claims_process}</p>
              </div>
            )}
            {analysis.terms_and_conditions?.grace_period && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Grace Period</h4>
                <p className="text-slate-700">{analysis.terms_and_conditions.grace_period}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Warnings. The model returns these under `warnings`; `warnings_and_gaps`
          was the key this block used to read, which no prompt ever produced, so
          the section never rendered. Accept both. */}
      {(analysis.warnings_and_gaps?.length > 0 || analysis.warnings?.length > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-800 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Warnings & Gaps
          </h3>
          <ul className="space-y-1.5 text-sm text-amber-800 list-disc list-inside">
            {(analysis.warnings_and_gaps || analysis.warnings).map((item, i) => (
              <li key={i}>{typeof item === 'string' ? item : item?.issue || ''}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Red flags, ranked by what they cost at claim time. */}
      {analysis.red_flags?.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-red-800 mb-3">Red Flags</h3>
          <ul className="space-y-3">
            {analysis.red_flags.map((flag, i) => (
              <li key={i} className="text-sm">
                <div className="flex items-start gap-2">
                  <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                    flag?.severity === 'High' ? 'bg-red-600 text-white'
                      : flag?.severity === 'Medium' ? 'bg-amber-500 text-white'
                      : 'bg-slate-400 text-white'
                  }`}>
                    {flag?.severity || 'Note'}
                  </span>
                  <div>
                    <p className="text-slate-900 font-medium">{flag?.issue}</p>
                    {flag?.why_it_matters && (
                      <p className="text-slate-600 mt-0.5">{flag.why_it_matters}</p>
                    )}
                    {flag?.evidence && (
                      <p className="text-slate-500 italic mt-0.5 text-xs">&ldquo;{flag.evidence}&rdquo;</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* What the document does not say. Distinct from what it excludes. */}
      {analysis.not_found_in_document?.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-1">Not Found In This Document</h3>
          <p className="text-xs text-slate-500 mb-3">
            These were looked for and not found in the text provided. That is not the same as being excluded &mdash; they may sit in wording that was not uploaded.
          </p>
          <ul className="space-y-1.5 text-sm text-slate-700 list-disc list-inside">
            {analysis.not_found_in_document.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The gaps above, turned into something the reader can act on. */}
      {analysis.questions_for_your_agent?.length > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-emerald-800 mb-3">Questions To Ask Your Agent</h3>
          <ol className="space-y-1.5 text-sm text-emerald-900 list-decimal list-inside">
            {analysis.questions_for_your_agent.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Says plainly what was read, so a partial upload is never mistaken for a full review. */}
      {analysis.document_assessment && (
        <div className="border border-slate-200 rounded-xl p-4 text-xs text-slate-500">
          <span className="font-semibold text-slate-600">Document read:</span>{' '}
          {analysis.document_assessment.document_kind || 'Unclear'}
          {analysis.document_assessment.completeness && ` \u00b7 ${analysis.document_assessment.completeness}`}
          {analysis.document_assessment.confidence && ` \u00b7 Confidence: ${analysis.document_assessment.confidence}`}
          {analysis.document_assessment.completeness_note && (
            <p className="mt-1">{analysis.document_assessment.completeness_note}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ComparisonResults({ comparison, docs, onExportPdf, pdfGenerating }) {
  if (!comparison) return null;
  const summary = comparison.comparison_summary || comparison.executive_summary || '';

  return (
    <div id="comparison-results" className="mt-8 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-slate-900">Multi-Policy Comparison</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={onExportPdf}
            disabled={pdfGenerating}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
          >
            {pdfGenerating ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Generating PDF...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Export PDF
              </>
            )}
          </button>
        </div>
      </div>

      {/* Executive Summary */}
      {summary && (
        <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="font-semibold text-emerald-800 text-sm">Executive Summary</h3>
          </div>
          <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-line">{summary}</p>
        </div>
      )}

      {/* Financial Overview */}
      {comparison.financial_optimization && (
        <div className="grid md:grid-cols-4 gap-4">
          {comparison.total_annual_premium && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Current Total Premium</p>
              <p className="text-lg font-bold text-slate-900">{comparison.total_annual_premium}</p>
            </div>
          )}
          {comparison.financial_optimization?.optimal_premium_estimate && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Optimal Premium</p>
              <p className="text-lg font-bold text-emerald-600">{comparison.financial_optimization.optimal_premium_estimate}</p>
            </div>
          )}
          {comparison.financial_optimization?.savings_note && !comparison.financial_optimization?.potential_savings && (
            <div className="sm:col-span-2">
              <p className="text-xs text-slate-500">{comparison.financial_optimization.savings_note}</p>
            </div>
          )}
          {comparison.financial_optimization?.potential_savings && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Potential Savings</p>
              <p className="text-lg font-bold text-amber-600">{comparison.financial_optimization.potential_savings}</p>
            </div>
          )}
          {comparison.financial_optimization?.efficiency_score && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Efficiency Score</p>
              <p className={`text-lg font-bold ${comparison.financial_optimization.efficiency_score === 'Excellent' || comparison.financial_optimization.efficiency_score === 'Good' ? 'text-emerald-600' : 'text-red-600'}`}>
                {comparison.financial_optimization.efficiency_score}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Policy Breakdown */}
      {comparison.policies?.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <h3 className="text-sm font-semibold text-slate-800 p-4 border-b border-slate-100 flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Policy Breakdown
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Policy</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Insurer</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Type</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Premium</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Key Coverages</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {comparison.policies.map((p, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-900 font-medium">{p.name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-slate-600">{p.insurer || 'N/A'}</td>
                    <td className="px-4 py-3 text-slate-600">{p.type || 'N/A'}</td>
                    <td className="px-4 py-3 text-slate-900 font-semibold">{p.annual_premium || 'N/A'}</td>
                    <td className="px-4 py-3 text-slate-600">{p.key_coverages?.slice(0, 2).join('; ') || 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Overlap Analysis */}
      {comparison.overlap_analysis?.redundant_coverage?.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-red-800 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Coverage Overlap — Money Wasted
          </h3>
          <ul className="space-y-2 text-sm text-red-700 list-disc list-inside">
            {comparison.overlap_analysis.redundant_coverage.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {comparison.overlap_analysis?.wasted_premium_estimate && (
            <p className="mt-3 text-sm font-semibold text-red-800">
              Wasted Premium Estimate: {comparison.overlap_analysis.wasted_premium_estimate}
            </p>
          )}
        </div>
      )}

      {/* Gap Analysis */}
      {comparison.gap_analysis?.missing_coverage?.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-800 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Coverage Gaps — Risk Exposure
          </h3>
          <ul className="space-y-2 text-sm text-amber-800 list-disc list-inside">
            {comparison.gap_analysis.missing_coverage.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
          {comparison.gap_analysis?.recommended_additions?.length > 0 && (
            <div className="mt-3 pt-3 border-t border-amber-200">
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Recommended Additions</p>
              <ul className="space-y-1 text-sm text-amber-700 list-disc list-inside">
                {comparison.gap_analysis.recommended_additions.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Per-policy verdict */}
      {comparison.keep_cancel_ranking?.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <h3 className="text-sm font-semibold text-slate-800 p-4 border-b border-slate-100 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Per-Policy Verdict
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Policy</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Verdict</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {comparison.keep_cancel_ranking.map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-900 font-medium">{r.policy_name || 'Unknown'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-semibold ${
                        r.verdict === 'KEEP' ? 'bg-emerald-100 text-emerald-700' :
                        r.verdict === 'CANCEL' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {r.verdict}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.reason || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Action Plan */}
      {comparison.consolidation_recommendations?.length > 0 && (
        <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-emerald-800 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Action Plan
          </h3>
          <ol className="space-y-2 text-sm text-slate-700 list-decimal list-inside">
            {comparison.consolidation_recommendations.map((rec, i) => (
              <li key={i}>{rec}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Home />
    </ErrorBoundary>
  );
}
