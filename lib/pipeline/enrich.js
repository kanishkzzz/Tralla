// lib/pipeline/enrich.js
//
// Step 2. Turns a validated ticket plus its context into the flat facts
// object rules.js judges. Every key here is named in the CONTEXT KEY
// CONTRACT at the foot of rules/rules.yaml. A name that does not match
// does not error - the rule lands in verdict.unevaluated and never fires,
// which is why rules.js validates the vocabulary at load time and why this
// file lists the keys explicitly rather than spreading an object in.
//
// Pure. run.js does the lookups and passes them in.
//
// The derivations here are the ones the source data does not contain, each
// documented in DECISIONS.md section 2. Three of them decide safety rules,
// so the null-versus-sentinel distinction below is load-bearing:
//
//   null      "we could not determine this"   -> rule is unevaluated
//                                             -> select.js blocks the vehicle
//   sentinel  "we determined there is none"   -> rule evaluates and passes
//
// Getting that backwards in either direction is a real dispatch error. A
// vehicle with no brake work in its history must not be blocked from hill
// routes; a vehicle whose history we could not read must not be cleared.

import {
  daysBetween, dateOnly, localHour, isHillRoute, isEastOfLucknow,
} from '../normalize.js';

// A vehicle that has never had brake work still has to satisfy
// "vehicle_brake_work_days lt 30". null would make the rule unevaluated and
// block a perfectly good truck, so "no brake work on record" is expressed
// as a number far outside any rule's window.
const NO_SUCH_EVENT_DAYS = 99999;

// DECISIONS.md 2.1. fleet_master.csv has no service_due_date column, so due
// date is last maintenance + 90 days, and R-SERVICE-OVERDUE-30 grounds the
// vehicle when the ticket is more than 30 days past that - 120 days since
// the last entry.
const SERVICE_INTERVAL_DAYS = 90;

// DECISIONS.md 2.4.
const JUGAAD_WINDOW_DAYS = 7;

// DECISIONS.md 2.2. The transcript never gives a numeric night window.
const NIGHT_FROM_HOUR = 20;
const NIGHT_TO_HOUR = 6;

// DECISIONS.md 2.3, deliberately over-inclusive. Note this is NOT normIssue:
// normIssue assigns each note exactly one component, so a note about a
// clutch job that also mentions brake work would be filed as 'gearbox' and
// the brake work would vanish. A false positive costs us one eligible
// vehicle; a false negative puts fresh, untested brakes on a ghat road.
const BRAKE_NOTE = /brake|braking/i;

// A jugaad with the permanent repair still outstanding. Both the English
// and the transliterated Hindi forms appear in the log.
const JUGAAD_NOTE = /jugaad/i;
const PENDING_FIX_NOTE = /permanent fix baaki|permanent repair pending|needs permanent repair|permanent fix pending/i;

// Average days per month, so "less than six months with us" is a tenure in
// months rather than a raw day count.
const DAYS_PER_MONTH = 30.4375;

// Most recent entry matching a predicate, AS OF a date. db.js returns
// maintenance ordered date DESC, id ASC, so the first hit at or before the
// cutoff is the newest one and the scan is deterministic.
//
// The cutoff is not decoration. The maintenance log runs to August 2026 and
// the queue starts in February, so without it a February breakdown gets
// judged against an August service record - the vehicle looks freshly
// serviced because of work that had not happened yet, and a brake job still
// six weeks in the future bars it from a hill route today. Every fact here
// must be what was knowable when the ticket was raised.
function mostRecent(maintenance, asOf, predicate) {
  if (!Array.isArray(maintenance)) return null;
  for (const entry of maintenance) {
    if (!entry || !entry.date) continue;
    const age = daysBetween(entry.date, asOf);
    if (age === null || age < 0) continue; // dated after the ticket: not yet knowable
    if (predicate(entry)) return entry;
  }
  return null;
}

/**
 * The vehicle half of the context, derived as of a given date.
 *
 * Exported because select.js needs exactly this for every candidate it
 * considers, not just for the broken vehicle. Sharing it is what keeps the
 * eligibility rules honest: the truck that broke down and the truck being
 * considered to replace it are judged by identical derivations.
 */
export function vehicleFacts(vehicle, maintenance, asOf) {
  if (!vehicle) {
    return {
      vehicle_bs_stage: null,
      vehicle_year: null,
      vehicle_has_heater: null,
      vehicle_days_past_service: null,
      vehicle_brake_work_days: null,
      vehicle_has_active_jugaad: null,
      vehicle_last_client_incident: null,
    };
  }

  const latest = mostRecent(maintenance, asOf, () => true);
  const daysSinceService = latest === null ? null : daysBetween(latest.date, asOf);

  const lastBrake = mostRecent(maintenance, asOf, (e) => BRAKE_NOTE.test(e.notes || ''));
  const brakeDays = lastBrake === null ? NO_SUCH_EVENT_DAYS : daysBetween(lastBrake.date, asOf);

  const lastJugaad = mostRecent(
    maintenance,
    asOf,
    (e) => JUGAAD_NOTE.test(e.notes || '') && PENDING_FIX_NOTE.test(e.notes || ''),
  );
  const jugaadDays = lastJugaad === null ? null : daysBetween(lastJugaad.date, asOf);

  return {
    vehicle_bs_stage: vehicle.bs_stage,
    vehicle_year: vehicle.year,

    // engine_heater is stored 0/1, and null when the fleet rows disagreed or
    // both were blank. Null must stay null: on a winter hill route that
    // blocks the vehicle, which is the correct direction.
    vehicle_has_heater:
      vehicle.engine_heater === null || vehicle.engine_heater === undefined
        ? null
        : vehicle.engine_heater === 1,

    // null when the vehicle has no maintenance record at all - no derivable
    // due date, so R-SERVICE-OVERDUE-30 cannot be evaluated and select.js
    // treats the vehicle as ineligible. DECISIONS.md 2.1.
    vehicle_days_past_service:
      daysSinceService === null ? null : daysSinceService - SERVICE_INTERVAL_DAYS,

    vehicle_brake_work_days: brakeDays,

    // A determinable false, not a null: "we looked and there is no open
    // jugaad" must pass the rule rather than block on missing data.
    vehicle_has_active_jugaad:
      jugaadDays === null ? false : jugaadDays <= JUGAAD_WINDOW_DAYS,

    // R-APEX-ROTATE is implemented: false in the rulebook and getRules drops
    // it, so nothing reads this. Kept as an explicit null so the gap is
    // visible in the facts rather than merely absent. DECISIONS.md 7.
    vehicle_last_client_incident: null,
  };
}

export function enrich(ticket, context) {
  const { vehicle, driver, maintenance } = context;
  const asOf = ticket.created_at;

  const day = dateOnly(asOf);
  const hour = localHour(asOf);
  const routeTouches = [ticket.origin_hub, ticket.dest_hub].filter(Boolean);

  const tenureDays = driver && driver.joining_date
    ? daysBetween(driver.joining_date, asOf)
    : null;

  const facts = {
    // -- identity, not tested by any rule but carried for citations --
    ticket_id: ticket.ticket_id,
    created_at: asOf,
    issue: ticket.issue,
    severity_reported: ticket.severity_reported,
    origin_hub: ticket.origin_hub,
    broken_vehicle_reg: vehicle ? vehicle.reg_canon : null,
    driver_id: driver ? driver.driver_id : null,

    // -- condition keys the rulebook tests --
    // 'month_in' reads oddly as a fact name, but it is the key the rulebook
    // uses and rules.js looks up context[key] verbatim.
    month_in: day === null ? null : Number(day.slice(5, 7)),
    client_is: ticket.client,
    km_from_origin: ticket.km_from_origin,
    dest_hub: ticket.dest_hub,
    route_touches: routeTouches,
    route_is_hill: isHillRoute(routeTouches),
    route_east_of_lucknow: isEastOfLucknow(routeTouches),

    // DECISIONS.md 2.2. localHour, not getHours, so the window is IST on
    // every machine - see the dates section of normalize.js.
    is_night_dispatch: hour === null ? null : (hour >= NIGHT_FROM_HOUR || hour < NIGHT_TO_HOUR),

    driver_months_tenure: tenureDays === null ? null : Math.floor(tenureDays / DAYS_PER_MONTH),

    // The broken vehicle's own condition. Not used for eligibility - it is
    // already broken - but it is what the work order cites when describing
    // what failed, and it makes the jugaad history of the failed truck
    // visible to the approver.
    ...vehicleFacts(vehicle, maintenance, asOf),
  };

  // Which derivations could not be made. Reported rather than silently
  // passed along, because a null here becomes an unevaluated rule later and
  // the audit should say where the gap started.
  const gaps = Object.entries(facts)
    .filter(([, v]) => v === null)
    .map(([k]) => k);

  return {
    facts,
    audit: [{
      step: 'enrich',
      decision:
        `context assembled for ${facts.broken_vehicle_reg}: ` +
        `${facts.client_is}, ${facts.km_from_origin}km from ${facts.origin_hub}, ` +
        `month ${facts.month_in}, hill=${facts.route_is_hill}, night=${facts.is_night_dispatch}` +
        (gaps.length ? ` | undetermined: ${gaps.join(', ')}` : ''),
      data_used: 'vehicles, drivers, maintenance, tickets.json',
      rule_id: null,
    }],
  };
}
