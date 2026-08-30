// lib/pipeline/select.js
//
// Step 4. The file that will be pushed on hardest, because it is where the
// dispatcher's rules either bite or do not.
//
// Two exports, because choosing WHERE to look is itself a rule decision
// that has to happen before candidates can be fetched:
//
//   chooseSourceHub(facts)               -> which hub may send
//   selectReplacement(facts, candidates) -> which vehicle, and why not the rest
//
// Both pure. run.js fetches candidates between the two calls.
//
// THE SHOWCASE RULE. R-ORIGIN-50KM says that within 50km of the origin hub,
// the ORIGIN hub sends - not the nearest one, which is what any routing
// engine would answer. Rajender's reason is capacity reserve at the small
// hubs, not distance: empty a small hub for a breakdown 40km away and the
// evening's Shakti order lands there with nothing to load. That is the
// "rule overrides the obvious choice" case, and both the rule id and his
// words travel onto the work order.
//
// THE OTHER LOAD-BEARING DECISION is what to do with a rule that could not
// be evaluated. rules.js reports those separately from rules that were
// checked and passed, and this file treats an unevaluated EXCLUSION as a
// block. A vehicle whose maintenance history we could not read has not
// demonstrated it is safe; it has only managed to be unmeasurable. Missing
// data never counts as passing a safety rule - DECISIONS.md 2.1.

import { evaluate, firstEffect, getRuleById } from '../rules.js';
import { vehicleFacts } from './enrich.js';

// Does this rule id, if it had fired, have removed a vehicle?
function isExclusionRule(ruleId) {
  const rule = getRuleById(ruleId);
  return rule !== null && rule.then && rule.then.effect === 'exclude_vehicle';
}

export function chooseSourceHub(facts) {
  const verdict = evaluate('select_vehicle', facts);
  const effect = firstEffect(verdict, 'set_source_hub');
  const audit = [];

  if (effect === null) {
    // Neither sourcing rule fired. With km_from_origin present that cannot
    // happen - the two rules partition the number line at 50 - so this means
    // km_from_origin was null and both landed in unevaluated. TKT-9101 is
    // exactly that record. Escalate rather than assume 0km and quietly pick
    // the origin hub, which is the guess R-ORIGIN-50KM exists to prevent.
    audit.push({
      step: 'select_source_hub',
      decision:
        `source hub undetermined: km_from_origin is ${facts.km_from_origin}, ` +
        `so neither R-ORIGIN-50KM nor R-ORIGIN-BEYOND-50KM could be evaluated. ` +
        `Falling back to origin hub ${facts.origin_hub} and flagging for dispatcher review.`,
      data_used: 'tickets.json:km_from_origin_hub',
      rule_id: 'ESCALATE-UNEVALUATED-SOURCING',
    });
    return { hub: facts.origin_hub, basis: 'undetermined', confident: false, verdict, audit };
  }

  if (effect.value === 'origin') {
    audit.push({
      step: 'select_source_hub',
      decision:
        `origin hub ${facts.origin_hub} sends, not the nearest hub ` +
        `(${facts.km_from_origin}km from origin, within the 50km threshold)`,
      data_used: `tickets.json:km_from_origin_hub=${facts.km_from_origin}`,
      rule_id: effect.rule_id,
    });
    return { hub: facts.origin_hub, basis: 'origin', confident: true, verdict, audit };
  }

  // 'nearest'. We cannot compute it: there is no hub distance matrix in the
  // corpus and nothing in the data gives inter-hub distances. Rather than
  // invent a proxy - destination hub, alphabetical, most stock - we say so,
  // fall back to the origin hub, and mark the work order for dispatcher
  // confirmation. A wrong hub silently chosen is worse than a right hub
  // chosen by a human who was told why.
  audit.push({
    step: 'select_source_hub',
    decision:
      `${facts.km_from_origin}km from origin, so the nearest eligible hub should send. ` +
      `Nearest-hub selection is NOT IMPLEMENTED: no inter-hub distance data exists in the ` +
      `corpus. Falling back to origin hub ${facts.origin_hub}, flagged for dispatcher review.`,
    data_used: `tickets.json:km_from_origin_hub=${facts.km_from_origin}`,
    rule_id: effect.rule_id,
  });
  return { hub: facts.origin_hub, basis: 'nearest-not-implemented', confident: false, verdict, audit };
}

export function selectReplacement(facts, candidates) {
  const considered = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    // The truck that broke down cannot replace itself.
    if (candidate.reg_canon === facts.broken_vehicle_reg) continue;

    // Identical derivations to the broken vehicle's, as of the ticket date.
    const ctx = {
      ...facts,
      ...vehicleFacts(candidate, candidate.maintenance, facts.created_at),
    };
    const verdict = evaluate('select_vehicle', ctx);

    // Two ways to be blocked, and the audit distinguishes them because the
    // remedies differ: a fired rule is a fact about the vehicle, an
    // unevaluated rule is a gap in our data about the vehicle.
    const firedExclusions = verdict.exclusion_reasons;
    const unevaluatedExclusions = verdict.unevaluated.filter((u) => isExclusionRule(u.rule_id));

    considered.push({
      reg: candidate.reg_canon,
      year: candidate.year,
      eligible: firedExclusions.length === 0 && unevaluatedExclusions.length === 0,
      excluded_by: firedExclusions.map((e) => ({ rule_id: e.rule_id, reason: e.reason, quote: e.quote })),
      blocked_by_missing_data: unevaluatedExclusions.map((u) => ({
        rule_id: u.rule_id,
        missing: u.missing_keys,
      })),
      citations: verdict.citations,
    });
  }

  const eligible = considered.filter((c) => c.eligible);

  // Ranking. The transcript encodes only one preference, and only for one
  // client: Orion's consignments get "the newest available vehicle". The
  // 2020 floor is already a hard exclusion in R-ORION-NEWEST; this is the
  // rest of that sentence. For every other client the transcript states no
  // preference, so the order is by registration - arbitrary, but stable,
  // which matters more here than clever. Inventing a ranking nobody asked
  // for would be a decision we could not defend with a quote.
  const ranked = facts.client_is === 'orion_pharma'
    ? eligible.slice().sort((a, b) => (b.year || 0) - (a.year || 0) || a.reg.localeCompare(b.reg))
    : eligible.slice().sort((a, b) => a.reg.localeCompare(b.reg));

  const chosen = ranked.length > 0 ? ranked[0] : null;
  const audit = [];

  if (chosen === null) {
    audit.push({
      step: 'select_vehicle',
      decision:
        `no eligible replacement among ${considered.length} candidates. ` +
        summariseBlocks(considered),
      data_used: 'vehicles, maintenance',
      rule_id: 'NO-ELIGIBLE-VEHICLE',
    });
  } else {
    const why = facts.client_is === 'orion_pharma'
      ? `newest eligible (${chosen.year}), per R-ORION-NEWEST`
      : 'first eligible by registration; transcript encodes no preference for this client';
    audit.push({
      step: 'select_vehicle',
      decision:
        `${chosen.reg} selected from ${considered.length} candidates ` +
        `(${eligible.length} eligible) - ${why}`,
      data_used: 'vehicles, maintenance',
      rule_id: facts.client_is === 'orion_pharma' ? 'R-ORION-NEWEST' : null,
    });
  }

  // One audit line per excluded vehicle would swamp the trail - nine
  // candidates a ticket, thirty tickets. The per-vehicle detail travels in
  // the work order's citations instead, and this line names the rules so
  // "why not that truck" is answerable from the audit alone.
  const blockedRules = new Set();
  for (const c of considered) {
    for (const e of c.excluded_by) blockedRules.add(e.rule_id);
    for (const b of c.blocked_by_missing_data) blockedRules.add(`${b.rule_id}(no data)`);
  }
  if (blockedRules.size > 0) {
    audit.push({
      step: 'select_vehicle_exclusions',
      decision:
        `${considered.length - eligible.length} of ${considered.length} candidates excluded by: ` +
        [...blockedRules].sort().join(', '),
      data_used: 'rules.yaml, vehicles, maintenance',
      rule_id: null,
    });
  }

  return {
    result: {
      replacement_reg: chosen ? chosen.reg : null,
      replacement_year: chosen ? chosen.year : null,
      considered: considered.length,
      eligible: eligible.length,
      excluded: considered.filter((c) => !c.eligible),
      citations: chosen ? chosen.citations : [],
    },
    audit,
  };
}

function summariseBlocks(considered) {
  const counts = new Map();
  for (const c of considered) {
    for (const e of c.excluded_by) counts.set(e.rule_id, (counts.get(e.rule_id) || 0) + 1);
    for (const b of c.blocked_by_missing_data) {
      const key = `${b.rule_id}(no data)`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  if (counts.size === 0) return 'no candidates were available at this hub.';
  return 'Blocked by: ' +
    [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, n]) => `${id} x${n}`).join(', ');
}
