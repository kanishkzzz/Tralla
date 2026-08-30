// lib/pipeline/select.js
//
// STUB - replace in step 4. This is the file the evaluators will push on
// hardest, because it is where the dispatcher's rules either bite or don't.
//
// Step 4. Two exported functions, because choosing WHERE to look is itself
// a rule decision that has to happen before we can fetch candidates:
//
//   chooseSourceHub(facts)              -> which hub may send a replacement
//   selectReplacement(facts, candidates) -> which vehicle, and why not the others
//
// Both pure. run.js fetches the candidates between the two calls.
//
// The showcase rule lives here. R-ORIGIN-50KM says that within 50km of the
// origin hub, the ORIGIN hub sends - not the nearest one, which is what any
// routing engine would tell you. Rajender keeps the small hubs free for
// premium client dispatches. That is the "rule overrides the obvious
// choice" case the brief asks for, so make sure the work order cites both
// the rule id and his words.

export function chooseSourceHub(facts) {
  // TODO(step 4): R-ORIGIN-50KM / R-ORIGIN-BEYOND-50KM via rules.js.
  // Note km_from_origin can be null (TKT-9101) - a rule that cannot be
  // evaluated must escalate, never quietly assume 0 and pick the origin hub.
  const hub = facts.origin_hub;

  return {
    hub,
    audit: [{
      step: 'select_source_hub',
      decision: `source hub ${hub} (STUB: origin hub assumed, 50km rule not applied)`,
      data_used: 'ticket.origin_hub',
      rule_id: null,
    }],
  };
}

export function selectReplacement(facts, candidates) {
  // TODO(step 4): filter candidates through the eligibility rules -
  // R-SERVICE-OVERDUE-30 (grounded means grounded), R-BS4-NCR-WINTER,
  // R-HILL-HEATER, R-HILL-BRAKE-30, R-JUGAAD-7DAY, R-ORION-NEWEST - and
  // record the rule id that excluded each rejected vehicle. "Why not that
  // truck?" is a question you will be asked live.
  const chosen = candidates.length > 0 ? candidates[0] : null;

  return {
    result: {
      replacement_reg: chosen ? chosen.reg_canon : null,
      considered: candidates.length,
      excluded: [],
    },
    audit: [{
      step: 'select_vehicle',
      decision: chosen
        ? `${chosen.reg_canon} from ${candidates.length} candidates (STUB: no eligibility rules applied)`
        : `no candidate available at source hub (STUB)`,
      data_used: 'vehicles, maintenance',
      rule_id: null,
    }],
  };
}
