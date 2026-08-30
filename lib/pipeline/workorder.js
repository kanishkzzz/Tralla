// lib/pipeline/workorder.js
//
// STUB - replace in step 4.
//
// Step 5. Shapes the work order row. It does NOT write it; run.js does,
// inside a transaction, through db.js.
//
// The citations array is the point of this file. Every claim the work order
// makes should name where it came from - a source file and row, or a rule
// id from rules.yaml. "Because the system said so" scores nothing.
//
// Contract: ({ work_order_id, ticket, facts, classification, selection,
//              source_hub }) -> row object matching the work_orders table

export function buildWorkOrder(input) {
  const { work_order_id, ticket, classification, selection, source_hub } = input;

  // TODO(step 4): build real citations. Shape to aim for:
  //   { source: 'rules.yaml#R-ORIGIN-50KM', quote: 'within 50 of origin, origin sends' }
  //   { source: 'fleet_master.csv:33', field: 'bs_stage', value: 'BS6' }
  //   { source: 'maintenance_log.xlsx:112', field: 'brake_work_date' }
  const citations = [
    { source: 'tickets.json', field: 'ticket_id', value: ticket.ticket_id },
  ];

  return {
    work_order_id,
    ticket_id: ticket.ticket_id,
    vehicle_reg: ticket.vehicle_reg,
    replacement_reg: selection.replacement_reg,
    origin_hub: source_hub,
    severity: classification.severity,
    // The ticket's own timestamp, never the clock. Two runs, same bytes.
    created_at: ticket.created_at,
    citations_json: JSON.stringify(citations),
  };
}
