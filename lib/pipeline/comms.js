// lib/pipeline/comms.js
//
// Step 6. Drafts the client notification and hands it back for queueing
// behind the human approval gate. Nothing here sends anything: run.js
// queues it as 'pending', and it becomes 'sent' only when a human approves.
//
// It runs the 'draft_message' rulebook step, which is where the client
// rules that are about WORDING live - R-VERTEX-NOT-FAILED in particular.
// That rule exists because the word "failed" auto-generates a penalty note
// in Vertex's system and then two finance teams argue for a month over
// 4,000 rupees. A rule about vocabulary is still a rule, and it is cited
// like any other.
//
// THE HARD GATE. assertClean() runs over the finished body and over the
// approver context before either leaves this function. It throws rather
// than scrubbing: silently cleaning here would hide a masking failure
// upstream and let it rot. A thrown error names the ticket and stops the
// run; a quietly published phone number caps the whole score at 50.

import { evaluate } from '../rules.js';
import { assertClean } from '../mask.js';

export function draftMessage(input) {
  const { message_id, ticket, facts, classification, selection, work_order } = input;

  const verdict = evaluate('draft_message', facts);

  // Wording constraints from both steps: 'classify' produced the ones that
  // are about the dispatch (Orion's no-overnight-hold), 'draft_message' the
  // ones about how to describe it (Vertex's vocabulary and gate window).
  const constraints = [
    ...classification.message_constraints,
    ...verdict.matched
      .filter((m) => m.effect === 'message_constraint')
      .map((m) => ({ rule_id: m.rule_id, text: String(m.value).trim(), quote: m.quote })),
  ];

  const recipient = ticket.client;

  const lines = [];
  lines.push(`Breakdown reported on your consignment (our reference ${ticket.ticket_id}).`);

  if (facts.issue) {
    lines.push(`Reported fault: ${facts.issue}. Severity ${classification.severity || 'under assessment'}.`);
  }

  if (selection.replacement_reg) {
    lines.push(
      `A replacement vehicle (${selection.replacement_reg}) has been assigned from our ` +
      `${work_order.origin_hub} hub and is being dispatched.`
    );
  } else {
    // Never claim a replacement we do not have. The approver sees why in
    // the context block, and the audit carries the excluding rules.
    lines.push(
      `A replacement vehicle is being arranged. We will confirm the vehicle and ` +
      `revised timing shortly.`
    );
  }

  if (classification.sla_hours !== null) {
    lines.push(
      `We are working to your ${classification.sla_hours}-hour delivery window.`
    );
  }

  if (classification.eta_pad_pct !== null) {
    lines.push(
      `Monsoon conditions on this route: our revised estimate already includes a ` +
      `${classification.eta_pad_pct}% allowance, and that is the figure we are quoting you.`
    );
  }

  // Constraint text is instruction to us, not prose for the client, so it
  // is appended as explicit handling notes rather than dropped into the
  // body as if the client wrote it.
  for (const c of constraints) {
    lines.push(`Handling note: ${c.text.replace(/\s+/g, ' ')}`);
  }

  const body = lines.join(' ');

  // The approver sees this. It is what makes the gate a decision rather
  // than a rubber stamp: what broke, what was chosen, what was rejected and
  // under which rule, and what could not be determined.
  const context = {
    ticket_id: ticket.ticket_id,
    client: facts.client_is,
    issue: facts.issue,
    severity: classification.severity,
    severity_source: classification.severity_source,
    sla_hours: classification.sla_hours,
    route: `${facts.origin_hub} -> ${facts.dest_hub}`,
    km_from_origin: facts.km_from_origin,
    broken_vehicle: ticket.vehicle_reg,
    replacement_vehicle: selection.replacement_reg,
    source_hub: work_order.origin_hub,
    candidates_considered: selection.considered,
    candidates_eligible: selection.eligible,
    rejected: selection.excluded.slice(0, 8).map((e) => ({
      vehicle: e.reg,
      excluded_by: e.excluded_by.map((r) => r.rule_id),
      undetermined: e.blocked_by_missing_data.map((r) => r.rule_id),
    })),
    driver_constraints: classification.driver_constraints,
    constraints: constraints.map((c) => ({ rule_id: c.rule_id, text: c.text.replace(/\s+/g, ' ') })),
  };

  // The gate, on both halves. context is serialised because findPII walks
  // strings, and an object reaching the approver's screen is as outbound as
  // the body is.
  assertClean(body, `comms.body:${ticket.ticket_id}`);
  assertClean(JSON.stringify(context), `comms.context:${ticket.ticket_id}`);

  return {
    message_id,
    ticket_id: ticket.ticket_id,
    recipient,
    body,
    context_json: JSON.stringify(context),
    citations_json: work_order.citations_json,
    status: 'pending',
    approved_by: null,
    sent_at: null,
    created_at: ticket.created_at,
  };
}
