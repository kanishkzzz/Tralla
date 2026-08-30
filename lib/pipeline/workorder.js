// lib/pipeline/workorder.js
//
// Step 5. Shapes the work order row. It does not write it - run.js does,
// inside a transaction, through db.js.
//
// The citations array is the whole point of this file. Every claim the work
// order makes names where it came from: a rules.yaml id with the
// dispatcher's own words, or a source file and field. "The system decided"
// scores nothing; "R-ORIGIN-50KM, and here is what Rajender said" is the
// difference between a defensible decision and a black box.
//
// Two citation shapes, deliberately distinguishable:
//   { source: 'rules.yaml#R-ORIGIN-50KM', quote: '...' }   a rule fired
//   { source: 'fleet_master.csv', field: 'year', value: 2021 }  a datum was used

export function buildWorkOrder(input) {
  const { work_order_id, ticket, facts, classification, selection, source_hub, sourcing } = input;

  const citations = [];

  // Why this hub. The showcase rule, when it is the one that fired.
  if (sourcing && sourcing.verdict) {
    for (const c of sourcing.verdict.citations) {
      citations.push({ source: `rules.yaml#${c.rule_id}`, quote: c.quote });
    }
  }

  // Why this severity and this SLA.
  for (const c of classification.citations) {
    citations.push({ source: `rules.yaml#${c.rule_id}`, quote: c.quote });
  }

  // Why this vehicle - the rules that were checked and passed for it.
  for (const c of selection.citations) {
    citations.push({ source: `rules.yaml#${c.rule_id}`, quote: c.quote });
  }

  // Why not the others. Capped, because a ticket can exclude a dozen
  // vehicles and the full list lives in the audit trail; what belongs on the
  // work order is enough to see the shape of the decision.
  for (const excluded of selection.excluded.slice(0, 5)) {
    for (const rule of excluded.excluded_by) {
      citations.push({
        source: `rules.yaml#${rule.rule_id}`,
        quote: rule.quote,
        excluded: excluded.reg,
      });
    }
    for (const gap of excluded.blocked_by_missing_data) {
      citations.push({
        source: `rules.yaml#${gap.rule_id}`,
        excluded: excluded.reg,
        undetermined: gap.missing,
      });
    }
  }

  // The data the decision rested on.
  citations.push({ source: 'tickets.json', field: 'ticket_id', value: ticket.ticket_id });
  citations.push({
    source: 'tickets.json',
    field: 'km_from_origin_hub',
    value: facts.km_from_origin,
  });
  if (selection.replacement_reg !== null) {
    citations.push({
      source: 'fleet_master.csv',
      field: 'registration_number',
      value: selection.replacement_reg,
    });
  }

  // Deduplicate while preserving order: the same rule can be cited by
  // sourcing and by selection, and a citation list that repeats itself reads
  // as padding. Order is stable because rules.js sorts its verdicts.
  const seen = new Set();
  const unique = [];
  for (const c of citations) {
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  return {
    work_order_id,
    ticket_id: ticket.ticket_id,
    vehicle_reg: ticket.vehicle_reg,
    replacement_reg: selection.replacement_reg,
    origin_hub: source_hub,
    severity: classification.severity,
    // The ticket's own timestamp, never the clock. Two runs, same bytes.
    created_at: ticket.created_at,
    citations_json: JSON.stringify(unique),
  };
}
