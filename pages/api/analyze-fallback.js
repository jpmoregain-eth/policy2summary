export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, mode = 'standard', provider = 'agnes' } = req.body;
    
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Insufficient text extracted. Please upload a clearer document.' });
    }

    const isExecutive = mode === 'executive';
    
    // Provider configs
    const providers = {
      agnes: {
        apiKey: process.env.AGNES_API_KEY || '',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        model: isExecutive ? 'agnes-2.0-flash' : 'agnes-1.5-flash'
      },
      kimi: {
        apiKey: process.env.KIMI_API_KEY || '',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k2.6'
      }
    };

    const config = providers[provider];
    if (!config || !config.apiKey) {
      return res.status(500).json({ error: `${provider} API not configured` });
    }

    const systemPrompt = isExecutive 
      ? `You are a senior insurance analyst and virtual insurance agent. Analyze the provided insurance certificate/policy and produce a comprehensive executive report. Return ONLY a JSON object with this exact structure:

{
  "executive_summary": "A professional 2-3 paragraph executive summary written as a virtual insurance agent would explain it to a client. Highlight the overall value proposition, key strengths, and any significant concerns.",
  "policy_overview": {
    "policy_type": "Life / Health / Car / Home / Travel / Investment-Linked / Other",
    "insurer": "Company name",
    "policy_number": "Policy number if found",
    "policyholder": "Name of insured person",
    "premium_summary": "Premium amount, frequency, and annual total in one line"
  },
  "key_highlights": [
    "List 5-7 most important highlights — both positive features and potential red flags. Be specific with dollar amounts."
  ],
  "coverage_analysis": {
    "description": "Detailed plain-English explanation of what this policy covers (3-4 sentences)",
    "main_coverage": ["List each major coverage item with specific amounts"],
    "riders_and_additions": ["Any add-on coverage purchased"],
    "total_coverage_value": "Sum total of coverage amounts if stated"
  },
  "exclusions_and_warnings": {
    "critical_exclusions": ["What's NOT covered — most important exclusions first"],
    "limitations": ["Key limitations that could affect claims"],
    "waiting_periods": ["Any waiting periods"],
    "red_flags": ["Warnings or concerning clauses that a client should know about"]
  },
  "financial_analysis": {
    "premium_assessment": "Assessment of whether the premium is reasonable for the coverage provided",
    "value_score": "High / Medium / Low — rate the overall value proposition",
    "cost_efficiency_notes": "Notes on premium vs coverage ratio"
  },
  "recommendations": [
    "3-5 actionable recommendations for the policyholder — what to verify, what to ask their agent, what gaps to consider filling"
  ],
  "comparison_notes": "How this policy compares to typical market offerings for this policy type (if discernible from the text)"
}`
      : `You are an insurance document analyzer that produces a Policy Summary following the industry-standard Insuranceopedia format. Extract key information from the provided insurance certificate/policy text and return ONLY a JSON object with this exact structure:

{
  "policy_type": "Life / Health / Car / Home / Travel / Investment-Linked / Other",
  "insurer": "Company name",
  "policy_number": "Policy number if found",
  "policyholder": "Name of insured person",
  "premium": {
    "amount": "amount with currency",
    "frequency": "Monthly / Quarterly / Annual / One-time",
    "total_annual": "calculated annual amount if available",
    "currency": "Currency code or symbol"
  },
  "coverage_details": {
    "description": "A plain-English paragraph describing what this policy covers (2-3 sentences)",
    "main_coverage": ["List each major coverage item with specific dollar amounts — e.g., 'Medical expenses: S$50,000', 'Trip cancellation: S$5,000', 'Third-party liability: S$500,000'"],
    "limits": ["List coverage limits and sub-limits found"],
    "riders_add_ons": ["Any add-on coverage purchased with amounts"],
    "total_coverage_value": "Sum total of coverage amounts if stated"
  },
  "exclusions_and_limitations": {
    "exclusions": ["List what's NOT covered — be specific with conditions"],
    "limitations": ["Limitations on coverage — e.g., territorial limits, age limits, pre-existing condition clauses"],
    "waiting_periods": ["Any waiting periods before coverage takes effect"],
    "special_conditions": ["Conditions that must be met for coverage to apply"]
  },
  "terms_and_conditions": {
    "policy_term": "Duration of coverage (e.g., '1 year renewable', 'Whole life', 'Term 20 years')",
    "renewal_terms": "How renewal works, premium changes, notice periods",
    "cancellation_terms": "Cancellation rights, refunds, notice requirements",
    "claims_process": "How to file a claim — documentation needed, time limits, contact info",
    "grace_period": "Grace period for premium payment if mentioned",
    "jurisdiction": "Governing law / jurisdiction if stated"
  },
  "key_dates": {
    "issue_date": "Policy issue date",
    "commencement_date": "Coverage start date",
    "maturity_date": "Maturity date if applicable",
    "renewal_date": "Renewal date if stated"
  },
  "maturity": {
    "type": "Maturity type if applicable (e.g., Whole Life, Term, Endowment)",
    "term_years": "Term in years if applicable",
    "surrender_value_notes": "Surrender value or cash value notes if found"
  },
  "investment_linked": {
    "is_ilp": false,
    "allocation": "Premium allocation to investment if applicable",
    "projected_returns": "Projected return rates if stated",
    "funds": ["List of funds if applicable"]
  },
  "warnings": ["Important warnings, disclaimers, or notes found in the document"],
  "summary": "A concise one-paragraph summary of the entire policy in plain English (3-4 sentences)"
}`;

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this insurance document:\n\n${text.substring(0, 8000)}` }
        ],
        temperature: 0.2,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`${provider} API error:`, errorText);
      return res.status(502).json({ 
        error: `${provider} API error: ${response.status}`,
        provider,
        retry: true
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error:', e, 'Content:', content.substring(0, 200));
      return res.status(500).json({ 
        error: 'AI response format error',
        provider,
        raw: content.substring(0, 500),
        retry: true
      });
    }

    res.status(200).json({ analysis: parsed, mode, provider });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed', retry: true });
  }
}
