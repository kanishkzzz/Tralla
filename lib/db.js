/**
 * lib/db.js — Meridian Freight context + state store.
 *
 * better-sqlite3 is synchronous: every call here returns a value, never a Promise.
 * Do not add async/await to this file.
 *
 * DETERMINISM CONTRACT
 * This module never calls Date.now(), never constructs a Date, and never generates
 * a UUID. Every id and every timestamp is supplied by the caller. The database
 * contributes no ambient state of its own, which is what lets the pipeline run
 * twice back to back and emit byte-identical outputs. If you ever feel the urge to
 * default a timestamp in here, that urge is the bug.
 *
 * All list reads carry an explicit ORDER BY for the same reason: SQLite's natural
 * row order is not a guarantee, and the JSONL writers depend on stable ordering.
 */

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './meridian.db';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

// Context tables: rebuilt from source files on every ingest. Disposable.
const CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS vehicles (
  reg_canon       TEXT PRIMARY KEY,
  vehicle_id      TEXT,
  model           TEXT,
  year            INTEGER,
  bs_stage        TEXT,
  engine_heater   INTEGER,
  home_hub        TEXT,
  capacity_tonnes REAL,
  source_file     TEXT,
  source_row      INTEGER,
  raw_regs        TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicles_home_hub ON vehicles(home_hub);

CREATE TABLE IF NOT EXISTS drivers (
  driver_id      TEXT PRIMARY KEY,
  name           TEXT,
  phone_masked   TEXT,
  dl_masked      TEXT,
  aadhaar_masked TEXT,
  joining_date   TEXT,
  home_hub       TEXT,
  source_file    TEXT,
  source_row     INTEGER
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id         TEXT PRIMARY KEY,
  created_at      TEXT,
  vehicle_reg     TEXT,
  driver_id       TEXT,
  client          TEXT,
  origin_hub      TEXT,
  dest_hub        TEXT,
  status          TEXT,
  osrm_time_min   REAL,
  actual_time_min REAL,
  source_file     TEXT
);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_reg ON trips(vehicle_reg);

CREATE TABLE IF NOT EXISTS maintenance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT,
  vehicle_reg TEXT,
  odometer_km INTEGER,
  mechanic    TEXT,
  notes       TEXT,
  source_file TEXT,
  source_row  INTEGER,
  UNIQUE(vehicle_reg, date, odometer_km)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle_reg ON maintenance(vehicle_reg);

CREATE TABLE IF NOT EXISTS facts (
  fact_id     TEXT PRIMARY KEY,
  entity_type TEXT,
  entity_key  TEXT,
  fact_type   TEXT,
  value_json  TEXT,
  observed_at TEXT,
  expires_at  TEXT,
  source      TEXT,
  confidence  TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_entity_fact ON facts(entity_key, fact_type);

CREATE TABLE IF NOT EXISTS conflicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT,
  entity_key  TEXT,
  field       TEXT,
  value_a     TEXT,
  source_a    TEXT,
  value_b     TEXT,
  source_b    TEXT,
  winner      TEXT,
  rule_id     TEXT,
  UNIQUE(entity_type, entity_key, field)
);
`;

// State tables: the outbox. Every row is evidence that an action was taken.
// These are append-only in practice and are NEVER dropped by this module.
const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_orders (
  work_order_id   TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL UNIQUE,
  vehicle_reg     TEXT,
  replacement_reg TEXT,
  origin_hub      TEXT,
  severity        TEXT,
  created_at      TEXT,
  citations_json  TEXT
);

CREATE TABLE IF NOT EXISTS comms (
  message_id     TEXT PRIMARY KEY,
  ticket_id      TEXT NOT NULL UNIQUE,
  recipient      TEXT,
  body           TEXT,
  context_json   TEXT,
  citations_json TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  approved_by    TEXT,
  sent_at        TEXT,
  created_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_comms_status ON comms(status);

CREATE TABLE IF NOT EXISTS quarantine (
  ticket_key  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  raw_json    TEXT,
  source_file TEXT,
  detected_at TEXT,
  PRIMARY KEY (ticket_key, reason)
);

CREATE TABLE IF NOT EXISTS audit (
  ticket_id TEXT NOT NULL,
  step      TEXT NOT NULL,
  decision  TEXT,
  data_used TEXT,
  rule_id   TEXT,
  actor     TEXT,
  at        TEXT,
  PRIMARY KEY (ticket_id, step)
);
`;

export function initSchema() {
  db.exec(CONTEXT_SCHEMA);
  db.exec(STATE_SCHEMA);
}

initSchema();

/**
 * Drops and recreates the six CONTEXT tables only.
 *
 * work_orders, comms, quarantine and audit are deliberately untouched. Those four
 * are the outbox: they record actions that were actually taken and messages a human
 * actually approved. Wiping them would let a re-ingest resurrect a ticket that has
 * already produced a work order, which is precisely the duplicate-action failure
 * this system exists to prevent. Re-deriving context from the source files is free;
 * re-sending a client message is not. If you genuinely need a clean slate for the
 * outbox, delete the database file.
 */
export function resetContextTables() {
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS conflicts;
      DROP TABLE IF EXISTS facts;
      DROP TABLE IF EXISTS maintenance;
      DROP TABLE IF EXISTS trips;
      DROP TABLE IF EXISTS drivers;
      DROP TABLE IF EXISTS vehicles;
    `);
    db.exec(CONTEXT_SCHEMA);
  })();
}

/* ------------------------------------------------------------------ *
 * Binding helper
 * ------------------------------------------------------------------ */

// better-sqlite3 refuses to bind undefined and refuses to bind booleans.
// Source rows routinely carry both, so normalise at the boundary rather than
// making every caller remember.
function val(x) {
  if (x === undefined || x === null) return null;
  if (typeof x === 'boolean') return x ? 1 : 0;
  return x;
}

/* ------------------------------------------------------------------ *
 * Prepared statements — compiled once, at module load, never per call.
 * ------------------------------------------------------------------ */

const stmtUpsertVehicle = db.prepare(`
  INSERT INTO vehicles
    (reg_canon, vehicle_id, model, year, bs_stage, engine_heater, home_hub,
     capacity_tonnes, source_file, source_row, raw_regs)
  VALUES
    (@reg_canon, @vehicle_id, @model, @year, @bs_stage, @engine_heater, @home_hub,
     @capacity_tonnes, @source_file, @source_row, @raw_regs)
  ON CONFLICT(reg_canon) DO UPDATE SET
    vehicle_id      = excluded.vehicle_id,
    model           = excluded.model,
    year            = excluded.year,
    bs_stage        = excluded.bs_stage,
    engine_heater   = excluded.engine_heater,
    home_hub        = excluded.home_hub,
    capacity_tonnes = excluded.capacity_tonnes,
    source_file     = excluded.source_file,
    source_row      = excluded.source_row,
    raw_regs        = excluded.raw_regs
`);

const stmtUpsertDriver = db.prepare(`
  INSERT INTO drivers
    (driver_id, name, phone_masked, dl_masked, aadhaar_masked, joining_date,
     home_hub, source_file, source_row)
  VALUES
    (@driver_id, @name, @phone_masked, @dl_masked, @aadhaar_masked, @joining_date,
     @home_hub, @source_file, @source_row)
  ON CONFLICT(driver_id) DO UPDATE SET
    name           = excluded.name,
    phone_masked   = excluded.phone_masked,
    dl_masked      = excluded.dl_masked,
    aadhaar_masked = excluded.aadhaar_masked,
    joining_date   = excluded.joining_date,
    home_hub       = excluded.home_hub,
    source_file    = excluded.source_file,
    source_row     = excluded.source_row
`);

// OR IGNORE so re-ingesting the same source file is a no-op rather than a crash.
const stmtInsertTrip = db.prepare(`
  INSERT OR IGNORE INTO trips
    (trip_id, created_at, vehicle_reg, driver_id, client, origin_hub, dest_hub,
     status, osrm_time_min, actual_time_min, source_file)
  VALUES
    (@trip_id, @created_at, @vehicle_reg, @driver_id, @client, @origin_hub, @dest_hub,
     @status, @osrm_time_min, @actual_time_min, @source_file)
`);

const stmtInsertMaintenance = db.prepare(`
  INSERT OR IGNORE INTO maintenance
    (date, vehicle_reg, odometer_km, mechanic, notes, source_file, source_row)
  VALUES
    (@date, @vehicle_reg, @odometer_km, @mechanic, @notes, @source_file, @source_row)
`);

const stmtUpsertFact = db.prepare(`
  INSERT INTO facts
    (fact_id, entity_type, entity_key, fact_type, value_json, observed_at,
     expires_at, source, confidence)
  VALUES
    (@fact_id, @entity_type, @entity_key, @fact_type, @value_json, @observed_at,
     @expires_at, @source, @confidence)
  ON CONFLICT(fact_id) DO UPDATE SET
    entity_type = excluded.entity_type,
    entity_key  = excluded.entity_key,
    fact_type   = excluded.fact_type,
    value_json  = excluded.value_json,
    observed_at = excluded.observed_at,
    expires_at  = excluded.expires_at,
    source      = excluded.source,
    confidence  = excluded.confidence
`);

const stmtRecordConflict = db.prepare(`
  INSERT INTO conflicts
    (entity_type, entity_key, field, value_a, source_a, value_b, source_b, winner, rule_id)
  VALUES
    (@entity_type, @entity_key, @field, @value_a, @source_a, @value_b, @source_b, @winner, @rule_id)
  ON CONFLICT(entity_type, entity_key, field) DO UPDATE SET
    value_a  = excluded.value_a,
    source_a = excluded.source_a,
    value_b  = excluded.value_b,
    source_b = excluded.source_b,
    winner   = excluded.winner,
    rule_id  = excluded.rule_id
`);

const stmtGetVehicle       = db.prepare(`SELECT * FROM vehicles WHERE reg_canon = ?`);
const stmtGetDriver        = db.prepare(`SELECT * FROM drivers WHERE driver_id = ?`);
const stmtGetMaintenance   = db.prepare(`SELECT * FROM maintenance WHERE vehicle_reg = ? ORDER BY date DESC, odometer_km DESC, id ASC`);
const stmtGetFactsAll      = db.prepare(`SELECT * FROM facts WHERE entity_key = ? ORDER BY observed_at DESC, fact_id ASC`);
const stmtGetFactsByType   = db.prepare(`SELECT * FROM facts WHERE entity_key = ? AND fact_type = ? ORDER BY observed_at DESC, fact_id ASC`);
const stmtGetVehiclesByHub = db.prepare(`SELECT * FROM vehicles WHERE home_hub = ? ORDER BY reg_canon ASC`);
const stmtGetAllConflicts  = db.prepare(`SELECT * FROM conflicts ORDER BY entity_type ASC, entity_key ASC, field ASC`);
const stmtGetVehicleCount  = db.prepare(`SELECT COUNT(*) AS n FROM vehicles`);

// INSERT OR IGNORE is the exactly-once guarantee. The unique keys are
// work_orders.ticket_id, comms.ticket_id, quarantine(ticket_key, reason) and
// audit(ticket_id, step). A second call with the same key changes nothing and
// throws nothing; .changes tells the caller which of the two happened.
const stmtCreateWorkOrder = db.prepare(`
  INSERT OR IGNORE INTO work_orders
    (work_order_id, ticket_id, vehicle_reg, replacement_reg, origin_hub, severity,
     created_at, citations_json)
  VALUES
    (@work_order_id, @ticket_id, @vehicle_reg, @replacement_reg, @origin_hub, @severity,
     @created_at, @citations_json)
`);

const stmtQueueComms = db.prepare(`
  INSERT OR IGNORE INTO comms
    (message_id, ticket_id, recipient, body, context_json, citations_json,
     status, approved_by, sent_at, created_at)
  VALUES
    (@message_id, @ticket_id, @recipient, @body, @context_json, @citations_json,
     @status, @approved_by, @sent_at, @created_at)
`);

// Guarded on status = 'pending' so a second approval of the same ticket is a no-op
// and can never overwrite the original sent_at. comms_sent.jsonl must contain
// exactly one line per approved ticket, on every re-run.
const stmtApproveComms = db.prepare(`
  UPDATE comms
     SET status = 'sent', approved_by = @approved_by, sent_at = @sent_at
   WHERE ticket_id = @ticket_id AND status = 'pending'
`);

const stmtQuarantine = db.prepare(`
  INSERT OR IGNORE INTO quarantine
    (ticket_key, reason, raw_json, source_file, detected_at)
  VALUES
    (@ticket_key, @reason, @raw_json, @source_file, @detected_at)
`);

const stmtWriteAudit = db.prepare(`
  INSERT OR IGNORE INTO audit
    (ticket_id, step, decision, data_used, rule_id, actor, at)
  VALUES
    (@ticket_id, @step, @decision, @data_used, @rule_id, @actor, @at)
`);

const stmtHasWorkOrder     = db.prepare(`SELECT 1 AS hit FROM work_orders WHERE ticket_id = ?`);
const stmtGetAllWorkOrders = db.prepare(`SELECT * FROM work_orders ORDER BY ticket_id ASC`);
const stmtGetCommsAll      = db.prepare(`SELECT * FROM comms ORDER BY ticket_id ASC`);
const stmtGetCommsByStatus = db.prepare(`SELECT * FROM comms WHERE status = ? ORDER BY ticket_id ASC`);
const stmtGetAllQuarantine = db.prepare(`SELECT * FROM quarantine ORDER BY ticket_key ASC, reason ASC`);
const stmtGetAuditFor      = db.prepare(`SELECT * FROM audit WHERE ticket_id = ? ORDER BY at ASC, step ASC`);
const stmtGetAllAudit      = db.prepare(`SELECT * FROM audit ORDER BY ticket_id ASC, at ASC, step ASC`);

/* ------------------------------------------------------------------ *
 * Context writers — ingest only
 * ------------------------------------------------------------------ */

export function upsertVehicle(obj) {
  stmtUpsertVehicle.run({
    reg_canon:       val(obj.reg_canon),
    vehicle_id:      val(obj.vehicle_id),
    model:           val(obj.model),
    year:            val(obj.year),
    bs_stage:        val(obj.bs_stage),
    engine_heater:   val(obj.engine_heater),
    home_hub:        val(obj.home_hub),
    capacity_tonnes: val(obj.capacity_tonnes),
    source_file:     val(obj.source_file),
    source_row:      val(obj.source_row),
    raw_regs:        val(obj.raw_regs)
  });
}

export function upsertDriver(obj) {
  stmtUpsertDriver.run({
    driver_id:      val(obj.driver_id),
    name:           val(obj.name),
    phone_masked:   val(obj.phone_masked),
    dl_masked:      val(obj.dl_masked),
    aadhaar_masked: val(obj.aadhaar_masked),
    joining_date:   val(obj.joining_date),
    home_hub:       val(obj.home_hub),
    source_file:    val(obj.source_file),
    source_row:     val(obj.source_row)
  });
}

export function insertTrip(obj) {
  stmtInsertTrip.run({
    trip_id:         val(obj.trip_id),
    created_at:      val(obj.created_at),
    vehicle_reg:     val(obj.vehicle_reg),
    driver_id:       val(obj.driver_id),
    client:          val(obj.client),
    origin_hub:      val(obj.origin_hub),
    dest_hub:        val(obj.dest_hub),
    status:          val(obj.status),
    osrm_time_min:   val(obj.osrm_time_min),
    actual_time_min: val(obj.actual_time_min),
    source_file:     val(obj.source_file)
  });
}

export function insertMaintenance(obj) {
  stmtInsertMaintenance.run({
    date:        val(obj.date),
    vehicle_reg: val(obj.vehicle_reg),
    odometer_km: val(obj.odometer_km),
    mechanic:    val(obj.mechanic),
    notes:       val(obj.notes),
    source_file: val(obj.source_file),
    source_row:  val(obj.source_row)
  });
}

export function upsertFact(obj) {
  stmtUpsertFact.run({
    fact_id:     val(obj.fact_id),
    entity_type: val(obj.entity_type),
    entity_key:  val(obj.entity_key),
    fact_type:   val(obj.fact_type),
    value_json:  val(obj.value_json),
    observed_at: val(obj.observed_at),
    expires_at:  val(obj.expires_at),
    source:      val(obj.source),
    confidence:  val(obj.confidence)
  });
}

export function recordConflict(obj) {
  stmtRecordConflict.run({
    entity_type: val(obj.entity_type),
    entity_key:  val(obj.entity_key),
    field:       val(obj.field),
    value_a:     val(obj.value_a),
    source_a:    val(obj.source_a),
    value_b:     val(obj.value_b),
    source_b:    val(obj.source_b),
    winner:      val(obj.winner),
    rule_id:     val(obj.rule_id)
  });
}

/* ------------------------------------------------------------------ *
 * Context readers — null for a missing single, [] for an empty list.
 * ------------------------------------------------------------------ */

export function getVehicle(regCanon) {
  const row = stmtGetVehicle.get(val(regCanon));
  return row === undefined ? null : row;
}

export function getDriver(driverId) {
  const row = stmtGetDriver.get(val(driverId));
  return row === undefined ? null : row;
}

export function getMaintenanceFor(regCanon) {
  return stmtGetMaintenance.all(val(regCanon));
}

export function getFactsFor(entityKey, factType) {
  if (factType === undefined || factType === null) {
    return stmtGetFactsAll.all(val(entityKey));
  }
  return stmtGetFactsByType.all(val(entityKey), val(factType));
}

export function getVehiclesByHub(hub) {
  return stmtGetVehiclesByHub.all(val(hub));
}

export function getAllConflicts() {
  return stmtGetAllConflicts.all();
}

export function getVehicleCount() {
  const row = stmtGetVehicleCount.get();
  return row === undefined ? 0 : row.n;
}

/* ------------------------------------------------------------------ *
 * State writers — the outbox. Exactly-once, or it did not happen.
 * ------------------------------------------------------------------ */

export function createWorkOrder(obj) {
  const info = stmtCreateWorkOrder.run({
    work_order_id:   val(obj.work_order_id),
    ticket_id:       val(obj.ticket_id),
    vehicle_reg:     val(obj.vehicle_reg),
    replacement_reg: val(obj.replacement_reg),
    origin_hub:      val(obj.origin_hub),
    severity:        val(obj.severity),
    created_at:      val(obj.created_at),
    citations_json:  val(obj.citations_json)
  });
  return { created: info.changes === 1 };
}

export function queueComms(obj) {
  const info = stmtQueueComms.run({
    message_id:     val(obj.message_id),
    ticket_id:      val(obj.ticket_id),
    recipient:      val(obj.recipient),
    body:           val(obj.body),
    context_json:   val(obj.context_json),
    citations_json: val(obj.citations_json),
    status:         obj.status === undefined || obj.status === null ? 'pending' : obj.status,
    approved_by:    val(obj.approved_by),
    sent_at:        val(obj.sent_at),
    created_at:     val(obj.created_at)
  });
  return { created: info.changes === 1 };
}

export function approveComms(ticketId, approvedBy, sentAt) {
  const info = stmtApproveComms.run({
    ticket_id:   val(ticketId),
    approved_by: val(approvedBy),
    sent_at:     val(sentAt)
  });
  return { approved: info.changes === 1 };
}

export function quarantineRecord(obj) {
  const info = stmtQuarantine.run({
    ticket_key:  val(obj.ticket_key),
    reason:      val(obj.reason),
    raw_json:    val(obj.raw_json),
    source_file: val(obj.source_file),
    detected_at: val(obj.detected_at)
  });
  return { created: info.changes === 1 };
}

export function writeAudit(obj) {
  const info = stmtWriteAudit.run({
    ticket_id: val(obj.ticket_id),
    step:      val(obj.step),
    decision:  val(obj.decision),
    data_used: val(obj.data_used),
    rule_id:   val(obj.rule_id),
    actor:     val(obj.actor),
    at:        val(obj.at)
  });
  return { created: info.changes === 1 };
}

/* ------------------------------------------------------------------ *
 * State readers
 * ------------------------------------------------------------------ */

export function hasWorkOrder(ticketId) {
  return stmtHasWorkOrder.get(val(ticketId)) !== undefined;
}

export function getAllWorkOrders() {
  return stmtGetAllWorkOrders.all();
}

export function getComms(status) {
  if (status === undefined || status === null) {
    return stmtGetCommsAll.all();
  }
  return stmtGetCommsByStatus.all(val(status));
}

export function getAllQuarantine() {
  return stmtGetAllQuarantine.all();
}

export function getAuditFor(ticketId) {
  return stmtGetAuditFor.all(val(ticketId));
}

export function getAllAudit() {
  return stmtGetAllAudit.all();
}

/* ------------------------------------------------------------------ *
 * Utility
 * ------------------------------------------------------------------ */

// Runs fn inside a single SQLite transaction and returns whatever fn returns.
// Ingest wraps its bulk loops in this: thousands of inserts become one fsync,
// and a mid-file parse failure rolls the whole load back instead of leaving the
// context store half-populated.
export function withTransaction(fn) {
  return db.transaction(fn)();
}

export function close() {
  db.close();
}
