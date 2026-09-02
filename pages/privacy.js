import React from 'react';
import Head from 'next/head';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white text-slate-800">
      <Head>
        <title>Privacy Policy — Policy2Summary | Insurance Document Summarizer</title>
        <meta name="description" content="Policy2Summary privacy policy. We do not store your uploaded insurance documents. All processing is done in-memory and files are deleted immediately after analysis." />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href="https://www.policy2summary.com/privacy" />
        <meta property="og:title" content="Privacy Policy — Policy2Summary" />
        <meta property="og:description" content="How Policy2Summary handles your insurance documents and data." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://www.policy2summary.com/privacy" />
      </Head>

      {/* Nav */}
      <nav className="border-b border-slate-200 bg-white sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <a href="/" className="font-bold text-slate-900">Policy2Summary</a>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-slate-500 mb-8">Last updated: {new Date().toLocaleDateString('en-SG', { year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <div className="prose prose-slate max-w-none">
          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">1. No Data Collection</h2>
            <p className="text-slate-600 leading-relaxed mb-3">
              Policy2Summary is designed with privacy at its core. We <strong>do not collect, store, or retain</strong> any documents you upload. All processing happens in your browser and in temporary server memory only — files are deleted immediately after analysis.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">2. How It Works</h2>
            <ul className="list-disc pl-5 text-slate-600 space-y-2">
              <li>You upload a document (PDF, DOCX, or text) through your browser.</li>
              <li>The document is parsed <strong>client-side</strong> where possible (PDF text extraction, Word document parsing).</li>
              <li>Extracted text is sent to our AI analysis API for processing.</li>
              <li>Neither the file nor the extracted text is stored on our servers.</li>
              <li>All data is discarded immediately after the analysis response is sent back to your browser.</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">3. No Cookies or Tracking</h2>
            <p className="text-slate-600 leading-relaxed mb-3">
              We do not use advertising cookies or third-party advertising scripts. We use Vercel Analytics to count page views; it is cookieless and does not identify you personally, and it never sees your documents.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">4. No Account Required</h2>
            <p className="text-slate-600 leading-relaxed mb-3">
              Policy2Summary does not require sign-up, login, or any personal information. You can use the tool immediately without providing your name, email, phone number, or any other identifying information.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">5. AI Processing</h2>
            <p className="text-slate-600 leading-relaxed mb-3">
              Extracted text is sent to a third-party AI service for analysis. We do not control how the AI provider handles this data, but the transmission is encrypted via HTTPS. We recommend you do not upload documents containing highly sensitive personal information such as full NRIC numbers, bank account details, or passwords.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">6. Your Responsibility</h2>
            <p className="text-slate-600 leading-relaxed mb-3">
              You are responsible for ensuring you have the right to upload and analyze any document. Do not upload documents you do not own or are not authorized to access.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-3">7. Contact</h2>
            <p className="text-slate-600 leading-relaxed">
              If you have any questions about this privacy policy, please reach out through the contact details provided on our homepage.
            </p>
          </section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50 py-8">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center text-sm text-slate-500">
          Policy2Summary — Free AI Insurance Document Reader
        </div>
      </footer>
    </div>
  );
}
