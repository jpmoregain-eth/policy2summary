export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { documents } = req.body;
    
    if (!documents || documents.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 documents to compare.' });
    }

    const API_KEY = process.env.AGNES_API_KEY || '';
    if (!API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    const systemPrompt = `You are a senior insurance comparison analyst. You will receive MULTIPLE insurance policies and produce a comprehensive comparison report. 

Analyze each policy individually, then compare them across:
1. Coverage overlap (what's covered by multiple policies = wasted money)
2. Coverage gaps (what NO policy covers = risk exposure)
3. Premium efficiency (total spent vs. optimal spend)
4. Redundancy score (how much coverage is duplicated)

Return ONLY a JSON object with this exact structure:

{
  "comparison_summary": "2-3 paragraph executive summary. What's the overall picture? Are they over-insured, under-insured, or optimally covered? Key recommendation in one sentence.",
  "total_policies": number,
  "total_annual_premium": "calculated total of all premiums",
  "policies": [
    {
      "name": "Policy 1 name",
      "insurer": "Company",
      "type": "Life/Health/etc",
      "annual_premium": "amount",
      "key_coverages": ["Brief list of main coverage items with amounts"],
      "strengths": ["What this policy does best"],
      "weaknesses": ["What this policy lacks"]
    }
  ],
  "overlap_analysis": {
    "redundant_coverage": [
      "Specific coverage areas that appear in multiple policies — e.g., 'Personal Accident: Covered by Policy A ($50K) AND Policy B ($100K) — overlap of $50K wasted'"
    ],
    "overlap_score": "High / Medium / Low / None",
    "wasted_premium_estimate": "Rough estimate of how much they're over-paying due to duplication"
  },
  "gap_analysis": {
    "missing_coverage": [
      "Specific coverage gaps across ALL policies — e.g., 'No critical illness coverage found across any policy'"
    ],
    "risk_exposure": "High / Medium / Low",
    "recommended_additions": ["What coverage they should consider adding"]
  },
  "financial_optimization": {
    "current_total_premium": "Total annual amount",
    "optimal_premium_estimate": "What they SHOULD be paying with no overlap",
    "potential_savings": "Estimated annual savings by removing redundant coverage",
    "efficiency_score": "Poor / Fair / Good / Excellent"
  },
  "consolidation_recommendations": [
    "Actionable recommendations — e.g., 'Cancel Policy B and increase coverage on Policy A to save $X/year while maintaining same protection'"
  ],
  "keep_cancel_ranking": [
    {
      "policy_name": "Name",
      "verdict": "KEEP / REVIEW / CANCEL",
      "reason": "Why"
    }
  ],
  "comparison_notes": "How these policies compare to typical market offerings"
}`;

    // Build combined text
    let combinedText = '';
    documents.forEach((doc, idx) => {
      combinedText += `\n\n=== POLICY ${idx + 1}: ${doc.name} ===\n${doc.text.substring(0, 5000)}\n`;
    });

    const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'agnes-2.0-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Compare these ${documents.length} insurance policies:\n${combinedText}` }
        ],
        temperature: 0.2,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Agnes API error:', errorText);
      return res.status(502).json({ error: 'AI comparison service temporarily unavailable.', retry: true });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error:', e, 'Content:', content.substring(0, 200));
      return res.status(500).json({ error: 'AI response format error. Please try with fewer or clearer documents.', retry: true });
    }

    res.status(200).json({ comparison: parsed });

  } catch (err) {
    console.error('Comparison error:', err);
    res.status(500).json({ error: err.message || 'Comparison failed. Please try again.', retry: true });
  }
}
