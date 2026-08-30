// scripts/run.js
//
// The orchestrator. This file IS the workflow: everything the system does to
// a breakdown ticket happens here, in order, once.
//
//   node scripts/run.js                        # the main queue
//   node scripts/run.js data/surprise.json     # the hour-7 file
//
// Three properties this file exists to guarantee:
//
//   1. Exactly once.  A ticket id seen twice in the queue is processed once.
//      A whole second run of this script writes nothing new. Both are
//      enforced by the storage layer (INSERT OR IGNORE + unique ticket_id),
//      not by cleverness here - see lib/db.js.
//
//   2. Never crashes.  Every ticket runs inside its own try/catch. A record
//      that blows up is quarantined with the reason and the run continues.
//      One bad ticket cannot cost you the other 34.
//
//   3. No clock.  Every timestamp written comes from the ticket's own
//      created_at. Nothing here reads the system time, so two runs produce
//      identical bytes. See DECISIONS.md section 5.
//
// Division of labour: this file does ALL the database reads and writes. The
// pipeline steps in lib/pipeline/ are pure - they take what they need as
// arguments and return { result, audit }. That is why the context lookups
// below happen here and get passed down, rather than each step reaching for
// the database itself.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  getVehicle,
  getDriver,
  getMaintenanceFor,
  getVehiclesByHub,
  getVehicleCount,
  createWorkOrder,
  queueComms,
  quarantineRecord,
  writeAudit,
  withTransaction,
} from '../lib/db.js';

import { adaptQueue } from '../lib/adapt.js';
import { validateTicket } from '../lib/pipeline/validate.js';
import { enrich } from '../lib/pipeline/enrich.js';
import { classify } from '../lib/pipeline/classify.js';
import { chooseSourceHub, selectReplacement } from '../lib/pipeline/select.js';
import { buildWorkOrder } from '../lib/pipeline/workorder.js';
import { draftMessage } from '../lib/pipeline/comms.js';
import { renderAll } from '../lib/render.js';

const DEFAULT_QUEUE = 'data/tickets.json';

// ---------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------

// Content hashes of the ticket id, never counters. A counter would make the
// id depend on processing order, so re-running with the queue in a different
// order would produce different ids for the same work. See CLAUDE.md.
function idFor(prefix, ticketId) {
  const digest = createHash('sha256').update(String(ticketId)).digest('hex');
  return `${prefix}-${digest.slice(0, 12)}`;
}

// ---------------------------------------------------------------------
// Queue loading
// ---------------------------------------------------------------------

// Reading is ours; understanding the shape is adapt.js's. It recognises a
// JSON array, a wrapped array, NDJSON and renamed keys, and refuses cleanly
// on anything else rather than half-reading it into records that look valid
// and are not.
function loadQueue(queuePath) {
  let text;
  try {
    text = readFileSync(queuePath, 'utf8');
  } catch (err) {
    return { records: [], fatal: `unreadable_queue_file: ${err.code || 'ERROR'}` };
  }
  return adaptQueue(text, queuePath);
}

// ---------------------------------------------------------------------
// One ticket, start to finish
// ---------------------------------------------------------------------

function processTicket(raw, sourceFile) {
  // -- Step 1: validate -------------------------------------------------
  // Pure. Canonicalises the record and reports missing critical fields.
  // It does NOT look anything up; existence checks happen at enrich.
  const { ok, ticket, reasons } = validateTicket(raw);

  if (!ok) {
    // Broken records are quarantined with every reason they failed for, and
    // an alert - never dropped silently. One row per (ticket_key, reason),
    // so re-running adds nothing.
    const key = ticket.ticket_id || `MALFORMED:${idFor('Q', JSON.stringify(raw))}`;
    for (const reason of reasons) {
      quarantineRecord({
        ticket_key: key,
        reason,
        raw_json: JSON.stringify(raw),
        source_file: sourceFile,
        // No wall clock. A record whose own timestamp is unparseable gets
        // none rather than an invented one.
        detected_at: ticket.created_at,
      });
    }
    writeAudit({
      ticket_id: key,
      step: 'validate',
      decision: `quarantined: ${reasons.join(', ')}`,
      data_used: sourceFile,
      rule_id: 'VALIDATE-CRITICAL-FIELDS',
      actor: 'pipeline',
      at: ticket.created_at,
    });
    return { outcome: 'quarantined', ticket_id: key, reasons };
  }

  const ticketId = ticket.ticket_id;
  const at = ticket.created_at;

  // ── DECISION (yours) ─────────────────────────────────────────────────
  // 33 of the 35 tickets arrive with status CLOSED and a resolution note.
  // Right now we process them all, because the candidate README says
  // "exactly one per unique valid ticket" without qualifying on status,
  // and because a closed ticket still has to appear in the audit trail.
  //
  // The alternative is to skip anything not OPEN and record why. That is
  // defensible too - you would be arguing the queue is a historical log and
  // only open tickets are actionable. Pick one and be able to say why; an
  // evaluator will ask. If you switch, do it here, and write an audit line
  // rather than returning silently.
  // ─────────────────────────────────────────────────────────────────────

  const audit = [];

  // -- Context lookups (the only place the database is read) ------------
  const vehicle = getVehicle(ticket.vehicle_reg);
  const driver = getDriver(ticket.driver_id);
  const maintenance = getMaintenanceFor(ticket.vehicle_reg);

  // A registration that canonicalises cleanly but matches no fleet vehicle
  // is a broken record, not a dispatchable ticket. This is the existence
  // check validate.js deliberately does not do.
  if (vehicle === null) {
    quarantineRecord({
      ticket_key: ticketId,
      reason: 'vehicle_not_in_fleet',
      raw_json: JSON.stringify(raw),
      source_file: sourceFile,
      detected_at: at,
    });
    writeAudit({
      ticket_id: ticketId,
      step: 'enrich',
      decision: `quarantined: no fleet vehicle for ${ticket.vehicle_reg}`,
      data_used: 'vehicles',
      rule_id: 'ENRICH-VEHICLE-EXISTS',
      actor: 'pipeline',
      at,
    });
    return { outcome: 'quarantined', ticket_id: ticketId, reasons: ['vehicle_not_in_fleet'] };
  }

  // -- Step 2: enrich ---------------------------------------------------
  const enriched = enrich(ticket, { vehicle, driver, maintenance });
  audit.push(...enriched.audit);

  // -- Step 3: classify -------------------------------------------------
  const classified = classify(enriched.facts);
  audit.push(...classified.audit);

  // -- Step 4: select a replacement -------------------------------------
  // Two phases, because which hub may send is itself a rule decision
  // (R-ORIGIN-50KM: within 50km the ORIGIN hub sends, not the nearest one).
  // We ask the rules where to look, then fetch only those candidates.
  const source = chooseSourceHub(enriched.facts);
  audit.push(...source.audit);

  const candidates = source.hub === null
    ? []
    : getVehiclesByHub(source.hub).map((v) => ({
        ...v,
        // Eligibility needs each candidate's own history: brake work in the
        // last 30 days, an open jugaad, days past service.
        maintenance: getMaintenanceFor(v.reg_canon),
      }));

  const selected = selectReplacement(enriched.facts, candidates);
  audit.push(...selected.audit);

  // ── DECISION (yours) ─────────────────────────────────────────────────
  // What happens when no candidate is eligible? Today we still raise the
  // work order with replacement_reg = null and let the message say a
  // replacement is being arranged. The alternative is to quarantine, or to
  // create the work order and flag it for a human.
  //
  // Think about which one a dispatcher actually wants at 2am. Whatever you
  // choose, the reason each candidate was excluded is already in
  // selected.audit, so the answer to "why did nothing qualify" is on record
  // either way.
  // ─────────────────────────────────────────────────────────────────────

  // -- Steps 5 and 6: the two irreversible writes -----------------------
  // Wrapped together so a ticket can never end up with a work order and no
  // message, or the reverse. Both are INSERT OR IGNORE underneath, so the
  // transaction is about atomicity, not about preventing duplicates.
  const result = withTransaction(() => {
    const wo = buildWorkOrder({
      work_order_id: idFor('WO', ticketId),
      ticket,
      facts: enriched.facts,
      classification: classified.result,
      selection: selected.result,
      source_hub: source.hub,
      // The whole sourcing verdict, not just the chosen hub, so the work
      // order can cite R-ORIGIN-50KM and the dispatcher's words for it.
      sourcing: source,
    });
    const woWrite = createWorkOrder(wo);

    const msg = draftMessage({
      message_id: idFor('MSG', ticketId),
      ticket,
      facts: enriched.facts,
      classification: classified.result,
      selection: selected.result,
      work_order: wo,
    });
    const msgWrite = queueComms(msg);

    return { woWrite, msgWrite };
  });

  // created:false means the row was already there - a duplicate queue entry
  // or a second run. That is the exactly-once guarantee firing, and it is
  // worth an audit line rather than silence.
  audit.push({
    step: 'work_order',
    decision: result.woWrite.created
      ? `created ${idFor('WO', ticketId)}`
      : `already existed, no second write`,
    data_used: 'work_orders',
    rule_id: 'IDEMPOTENT-WORK-ORDER',
  });
  audit.push({
    step: 'comms',
    decision: result.msgWrite.created
      ? `queued ${idFor('MSG', ticketId)} for approval`
      : `already queued, no second draft`,
    data_used: 'comms',
    rule_id: 'IDEMPOTENT-COMMS',
  });

  // -- Step 7: audit ----------------------------------------------------
  // Steps return audit lines; only the orchestrator writes them. Keyed on
  // (ticket_id, step), so a re-run overwrites nothing and adds nothing.
  for (const line of audit) {
    writeAudit({
      ticket_id: ticketId,
      step: line.step,
      decision: line.decision,
      data_used: line.data_used,
      rule_id: line.rule_id,
      actor: 'pipeline',
      at,
    });
  }

  return {
    outcome: result.woWrite.created ? 'processed' : 'already_processed',
    ticket_id: ticketId,
  };
}

// ---------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------

function main() {
  // Refuse to run against an empty context store.
  //
  // Without this, running before scripts/ingest.js quarantines every ticket
  // as vehicle_not_in_fleet - and because quarantine is keyed
  // (ticket_key, reason) with INSERT OR IGNORE, those rows are PERMANENT.
  // A later correct run cannot overwrite them, resetContextTables() cannot
  // clear them, and the audit trail ends up holding both "quarantined: no
  // fleet vehicle" and "work_order: created" for the same ticket. A
  // contradictory trail is worse than no trail.
  //
  // So this is a hard stop rather than a warning: there is no legitimate
  // run against an empty fleet, and the only recovery from the poisoned
  // state is deleting the database.
  //
  // Note it only checks vehicles, because that is the only count db.js
  // exposes. An empty maintenance table would be worse in a quieter way -
  // every brake and service rule would silently pass - so if you want that
  // covered too, db.js needs a getMaintenanceCount() and this needs a
  // second clause.
  if (getVehicleCount() === 0) {
    process.stderr.write(
      'ALERT context_store_empty: no vehicles in the context store. ' +
      'Run `node scripts/ingest.js` first. Refusing to process the queue, ' +
      'because every ticket would quarantine and the quarantine rows would be permanent.\n'
    );
    process.exitCode = 1;
    return;
  }

  const queuePath = process.argv[2] || DEFAULT_QUEUE;
  const { records, fatal, shape, renamed, unusable } = loadQueue(queuePath);

  if (fatal) {
    // Degrade safely and loudly. An unreadable queue is not an empty queue,
    // so we must not fall through and render outputs as if the run
    // succeeded - that would silently erase nothing but would report
    // success on a run that did nothing.
    process.stderr.write(`ALERT queue_unusable ${queuePath}: ${fatal}\n`);
    process.exitCode = 1;
    return;
  }

  // A format change is news, not an implementation detail. It goes to
  // stderr as an alert so an unattended run surfaces it, and into the run
  // summary so the evaluator can see what we recognised.
  if (renamed && renamed.length > 0) {
    process.stderr.write(
      `ALERT queue_format_changed ${queuePath}: shape=${shape}, ` +
      `fields arrived under different names: ${renamed.join(', ')}
`
    );
  }
  if (unusable > 0) {
    process.stderr.write(`ALERT queue_unusable_records ${queuePath}: ${unusable} entries were not objects
`);
  }

  const seen = new Set();
  const summary = { total: records.length, processed: 0, duplicates: 0, quarantined: 0, replayed: 0 };

  for (const raw of records) {
    // ── DECISION (yours) ───────────────────────────────────────────────
    // Duplicate policy: first occurrence in the file wins. TKT-0020 appears
    // twice, the second carrying "(sync copy)" in its resolution note, so
    // the two copies are NOT byte-identical and the choice is real.
    //
    // First-wins is deterministic as long as the file order is stable, and
    // it is. The alternative is to prefer the record with the most non-null
    // fields, which survives a queue whose order changes between runs.
    // Decide which you would defend, and note it in DECISIONS.md.
    // ───────────────────────────────────────────────────────────────────
    const key = raw && raw.ticket_id ? String(raw.ticket_id).trim() : null;
    if (key && seen.has(key)) {
      summary.duplicates++;
      writeAudit({
        ticket_id: key,
        step: 'dedupe',
        decision: 'duplicate queue record, ignored; already processed this run',
        data_used: queuePath,
        rule_id: 'DEDUPE-FIRST-WINS',
        actor: 'pipeline',
        at: null,
      });
      continue;
    }
    if (key) seen.add(key);

    try {
      const r = processTicket(raw, queuePath);
      if (r.outcome === 'processed') summary.processed++;
      else if (r.outcome === 'already_processed') summary.replayed++;
      else summary.quarantined++;
    } catch (err) {
      // The catch-all that keeps rule 2 true. Anything unexpected becomes a
      // quarantined record with the reason, and the run carries on.
      summary.quarantined++;
      const fallbackKey = key || `MALFORMED:${idFor('Q', JSON.stringify(raw))}`;
      quarantineRecord({
        ticket_key: fallbackKey,
        reason: `unexpected_error: ${err && err.message ? err.message : 'unknown'}`,
        raw_json: JSON.stringify(raw),
        source_file: queuePath,
        detected_at: null,
      });
      process.stderr.write(`ALERT ticket_failed ${fallbackKey}: ${err && err.message}\n`);
    }
  }

  // Outputs are rendered fresh from database state every run, sorted by key,
  // never appended. Identical state therefore produces identical files.
  const written = renderAll();

  process.stdout.write(
    `queue=${queuePath} shape=${shape}${renamed && renamed.length ? ` renamed=[${renamed.join('|')}]` : ''} ` +
    `records=${summary.total} processed=${summary.processed} ` +
    `replayed=${summary.replayed} duplicates=${summary.duplicates} ` +
    `quarantined=${summary.quarantined}\n`
  );
  for (const [file, count] of Object.entries(written)) {
    process.stdout.write(`  ${file} ${count}\n`);
  }
}

main();
