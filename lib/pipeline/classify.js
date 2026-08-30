// lib/pipeline/classify.js
//
// STUB - replace in step 4.
//
// Step 3. Severity and required action, from the encoded rules rather than
// from vibes. The ticket's own `severity` field is a REPORTED value, not a
// decided one - it is what the caller said, and TKT-9102 shows it can be
// empty. This step decides, cites, and may disagree with the report.
//
// Contract: (facts) -> { result: { severity, action }, audit }

export function classify(facts) {
  // TODO(step 4): consult rules.js. Severity should be a function of the
  // issue category, the client's real SLA (Shakti is 36h, not the
  // contractual 48h - R-SHAKTI-36H), and whether the vehicle is stranded
  // beyond 50km of its origin hub.
  const severity = facts.severity_reported || 'MEDIUM';

  return {
    result: { severity, action: 'dispatch_replacement' },
    audit: [{
      step: 'classify',
      decision: `severity ${severity} (STUB: echoing reported severity, no rules consulted)`,
      data_used: 'ticket.severity',
      rule_id: null,
    }],
  };
}
