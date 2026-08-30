// lib/pipeline/validate.js
//
// Step 1. The only place in the system that decides whether a queue record
// is processable. normalize.js canonicalises without judging; this file
// judges without canonicalising.
//
// Pure: no database, no file I/O. It cannot tell you whether vehicle
// HRUNKNOWN exists in the fleet, only that the field was present and
// canonicalised to something. The existence check needs the context store
// and therefore happens in run.js after the lookup - see ENRICH-VEHICLE-EXISTS.
//
// Never throws. A record that is not even an object still comes back as a
// clean "not ok" with reasons, because the queue is allowed to contain
// anything and the run is not allowed to die.

import { normalizeTicket } from '../normalize.js';

// DECISIONS.md section 6. A ticket missing any of these cannot be processed:
// we would not know which ticket it is, which truck broke, where it broke,
// or when. Everything else can be absent and still yield a useful dispatch.
export const CRITICAL_FIELDS = ['ticket_id', 'vehicle_reg', 'origin_hub', 'created_at'];

// Reasons are stable strings, not sentences, because they are the primary
// key of the quarantine table alongside ticket_key. Rewording one silently
// creates a second quarantine row for the same fault on the next run.
const REASON = {
  not_an_object: 'record_not_an_object',
  ticket_id: 'missing_ticket_id',
  vehicle_reg: 'missing_vehicle',
  origin_hub: 'missing_origin_hub',
  created_at: 'unparseable_created_at',
};

export function validateTicket(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      ticket: normalizeTicket({}),
      reasons: [REASON.not_an_object],
    };
  }

  const ticket = normalizeTicket(raw);
  const reasons = [];

  // Checked in a fixed order so the quarantine rows for a given bad record
  // are the same set on every run, whatever the key order of the input.
  for (const field of CRITICAL_FIELDS) {
    if (ticket[field] === null || ticket[field] === undefined || ticket[field] === '') {
      reasons.push(REASON[field]);
    }
  }

  // Deliberately NOT critical: km_from_origin. It is null on TKT-9101 and it
  // is the input to R-ORIGIN-50KM, so a null there means we cannot tell
  // whether the origin hub or the nearest hub should send. That is a rule
  // that cannot be evaluated, which select.js handles by escalating rather
  // than guessing - a ticket we can still act on with a human in the loop
  // is more useful than one thrown in the bin. If you disagree, this is the
  // line to change, and DECISIONS.md section 6 is the place to say so.

  return { ok: reasons.length === 0, ticket, reasons };
}
