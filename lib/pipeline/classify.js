// lib/pipeline/classify.js
//
// Step 3. Severity, the client's real SLA, and the constraints that will
// shape the notification.
//
// It runs TWO rulebook steps, because two different questions are being
// asked of the same ticket:
//
//   'classify'      what does this client actually expect?
//                   R-SHAKTI-36H, R-ORION-NO-OVERNIGHT, R-MONSOON-EAST-20
//   'assign_driver' can the driver on this ticket run it?
//                   R-NEWDRIVER-NIGHT
//
// The driver check lives here rather than in a step of its own because
// there is no assign_driver.js in the layout and the answer is an input to
// the message, not to vehicle selection. It is a constraint on the
// dispatch, and constraints are what this step produces.
//
// ONE HONEST GAP, and it is worth reading before the walkthrough.
// The brief asks for severity decided by "the dispatcher's encoded rules,
// not vibes". The rulebook encodes no severity rule - the transcript never
// says what makes a breakdown HIGH rather than MEDIUM, and inventing a
// threshold here would be exactly the vibes the brief warns about, with
// the added sin of hiding it inside code where rules.yaml cannot see it.
// So severity is carried from the ticket, and the audit line says plainly
// that it was reported rather than derived. The fix is a rule in
// rules.yaml, not an if-statement here.

import { evaluate, firstEffect } from '../rules.js';

export function classify(facts) {
  const audit = [];

  const clientVerdict = evaluate('classify', facts);
  const driverVerdict = evaluate('assign_driver', facts);

  // Singleton effects: priority-sorted, so the first match wins by
  // construction. firstEffect returns the rule id and quote with the value,
  // which is what makes the SLA citable rather than merely correct.
  const sla = firstEffect(clientVerdict, 'set_sla_hours');
  const etaPad = firstEffect(clientVerdict, 'adjust_eta_pct');

  // Accumulating effect: every matching constraint applies, so they are all
  // collected rather than resolved to one.
  const constraints = clientVerdict.matched
    .filter((m) => m.effect === 'message_constraint')
    .map((m) => ({ rule_id: m.rule_id, text: String(m.value).trim(), quote: m.quote }));

  const severity = facts.severity_reported;

  audit.push({
    step: 'classify',
    decision:
      `severity ${severity === null ? 'UNSTATED' : severity} (reported on the ticket; ` +
      `the rulebook encodes no severity rule, so this is not a derived value)` +
      (sla ? ` | SLA ${sla.value}h` : '') +
      (etaPad ? ` | ETA padded ${etaPad.value}%` : '') +
      (constraints.length ? ` | ${constraints.length} message constraint(s)` : ''),
    data_used: 'tickets.json:severity, rules.yaml',
    rule_id: sla ? sla.rule_id : null,
  });

  if (sla) {
    audit.push({
      step: 'classify_sla',
      decision: `${facts.client_is} planned to ${sla.value}h - "${sla.quote}"`,
      data_used: 'rules.yaml',
      rule_id: sla.rule_id,
    });
  }

  // R-NEWDRIVER-NIGHT. An exclusion here does not stop the dispatch; it
  // says this driver cannot run it solo tonight. The remedy in the
  // transcript is to pair them or move the run to morning, so it becomes a
  // constraint the approver sees, not a quarantine.
  const driverBlocks = driverVerdict.exclusion_reasons;
  if (driverBlocks.length > 0) {
    for (const block of driverBlocks) {
      audit.push({
        step: 'assign_driver',
        decision:
          `driver ${facts.driver_id} (${facts.driver_months_tenure} months tenure) ` +
          `cannot run this solo: ${block.reason} - "${block.quote}"`,
        data_used: 'drivers.joining_date, tickets.json:created_at',
        rule_id: block.rule_id,
      });
    }
  }

  // Rules we could not evaluate at all. Reported so a gap in enrich.js
  // surfaces in the audit rather than looking like a rule that did not
  // apply. rules.js keeps these separate from "checked and passed" for
  // exactly this reason.
  const unevaluated = [...clientVerdict.unevaluated, ...driverVerdict.unevaluated];
  if (unevaluated.length > 0) {
    audit.push({
      step: 'classify_unevaluated',
      decision:
        `could not evaluate: ` +
        unevaluated.map((u) => `${u.rule_id} (missing ${u.missing_keys.join(', ')})`).join('; '),
      data_used: 'facts',
      rule_id: null,
    });
  }

  return {
    result: {
      severity,
      severity_source: 'reported',
      action: 'dispatch_replacement',
      sla_hours: sla ? sla.value : null,
      sla_rule: sla ? sla.rule_id : null,
      eta_pad_pct: etaPad ? etaPad.value : null,
      eta_rule: etaPad ? etaPad.rule_id : null,
      message_constraints: constraints,
      driver_constraints: driverBlocks.map((b) => ({
        rule_id: b.rule_id, reason: b.reason, quote: b.quote,
      })),
      citations: [...clientVerdict.citations, ...driverVerdict.citations],
    },
    audit,
  };
}
