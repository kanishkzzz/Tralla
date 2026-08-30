// lib/pipeline/enrich.js
//
// STUB - replace in step 4.
//
// Step 2. Turns a validated ticket plus its context into the flat "facts"
// object that rules.js evaluates. The fact names are fixed by the glossary
// at the bottom of rules/rules.yaml - route_is_hill, vehicle_bs_stage,
// vehicle_days_past_service, driver_months_tenure and the rest. If a fact
// name here does not match the glossary, the rule silently never fires.
//
// Pure. run.js does the lookups and passes them in.
//
// Contract: ({ ticket }, { vehicle, driver, maintenance }) -> { facts, audit }

export function enrich(ticket, context) {
  const { vehicle, driver, maintenance } = context;

  const facts = {
    ticket_id: ticket.ticket_id,
    created_at: ticket.created_at,
    client: ticket.client,
    issue: ticket.issue,
    severity_reported: ticket.severity_reported,
    origin_hub: ticket.origin_hub,
    dest_hub: ticket.dest_hub,
    km_from_origin: ticket.km_from_origin,
    route_touches: [ticket.origin_hub, ticket.dest_hub].filter(Boolean),

    broken_vehicle_reg: vehicle ? vehicle.reg_canon : null,
    broken_vehicle_year: vehicle ? vehicle.year : null,

    // TODO(step 4): the derived facts. Each has a documented derivation in
    // DECISIONS.md section 2 - service due date, brake work detection,
    // active jugaad, night dispatch window, hill routes. Use daysBetween()
    // and localHour() from normalize.js so none of it reads the host clock.
    driver_months_tenure: null,
    is_night_dispatch: null,
    route_is_hill: null,
    route_east_of_lucknow: null,
    maintenance_count: Array.isArray(maintenance) ? maintenance.length : 0,
    driver_known: driver !== null,
  };

  return {
    facts,
    audit: [{
      step: 'enrich',
      decision: `context assembled for ${facts.broken_vehicle_reg} (STUB: derived facts pending)`,
      data_used: 'vehicles, drivers, maintenance',
      rule_id: null,
    }],
  };
}
