// lib/pipeline/comms.js
//
// STUB - replace in step 4.
//
// Step 6. Drafts the client notification and hands it back for queueing
// behind the human approval gate. Nothing here sends anything: run.js
// queues it as status 'pending', and it only becomes 'sent' when a human
// approves through the CLI.
//
// THE HARD GATE LIVES HERE. No personal data in a message body, ever - not
// a driver phone, not a licence number, not an Aadhaar. Once lib/mask.js
// exists, assertClean() must run over `body` before this function returns,
// so a leak fails loudly at the point of drafting rather than quietly at
// the point of sending. Until then, this stub composes from fields that
// carry no personal data at all.
//
// Contract: ({ message_id, ticket, facts, classification, selection,
//              work_order }) -> row object matching the comms table

export function draftMessage(input) {
  const { message_id, ticket, classification, selection, work_order } = input;

  // Recipient is the CLIENT, addressed by slug. Resolving a slug to a real
  // contact address is a deployment concern, not a pipeline one.
  const recipient = ticket.client;

  // TODO(step 4): a real message honouring the client's actual rules -
  // Shakti's 36-hour window (R-SHAKTI-36H), Vertex's "scheduled morning
  // delivery, never failed delivery" wording (R-VERTEX-NOT-FAILED), the
  // monsoon padding on eastern routes (R-MONSOON-EAST-20).
  const body =
    `Breakdown reported on your consignment (ref ${ticket.ticket_id}). ` +
    `Severity assessed as ${classification.severity}. ` +
    (selection.replacement_reg
      ? `A replacement vehicle has been assigned and is being dispatched.`
      : `A replacement vehicle is being arranged and we will confirm shortly.`) +
    ` We will update you on revised timing.`;

  // The approver sees this. It is what makes the gate meaningful rather
  // than a rubber stamp - full context and citations, on one screen.
  const context = {
    ticket_id: ticket.ticket_id,
    issue: ticket.issue,
    severity: classification.severity,
    origin_hub: ticket.origin_hub,
    dest_hub: ticket.dest_hub,
    km_from_origin: ticket.km_from_origin,
    broken_vehicle: ticket.vehicle_reg,
    replacement_vehicle: selection.replacement_reg,
    candidates_considered: selection.considered,
  };

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
