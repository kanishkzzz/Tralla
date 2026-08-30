// scripts/ingest.js
//
// Loads the static corpus into the context tables. Run once, re-runnable.
//
//   node scripts/ingest.js
//
// Three things this file is responsible for, in order of how badly they
// hurt when wrong:
//
//   1. Personal data is masked HERE, on the way in. Nothing downstream ever
//      sees a raw phone number, licence or Aadhaar, because nothing
//      downstream is ever given one. assertClean() runs over every row that
//      could carry one, so a gap in the masker fails this script instead of
//      leaking quietly into an output file three steps later.
//
//   2. Entity resolution. fleet_master.csv describes 100 vehicles in 118
//      rows. The duplicates are merged here, before the database, and every
//      field-level disagreement is written to the conflicts table with the
//      precedence rule that settled it - never a silent pick.
//
//   3. Re-runnability. resetContextTables() rebuilds the six context tables
//      from scratch, so ingesting twice leaves the same rows. It cannot
//      touch work_orders, comms, quarantine or audit - rebuilding the
//      knowledge base must never erase completed work.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  resetContextTables,
  withTransaction,
  upsertVehicle,
  upsertDriver,
  insertTrip,
  insertMaintenance,
  upsertFact,
  recordConflict,
  getVehicleCount,
  getAllConflicts,
  close,
} from '../lib/db.js';

import {
  normReg, normClient, normHub, normBsStage, normNum, normBool,
  normDriverId, parseDate, dateOnly, normalizeVehicleRow,
} from '../lib/normalize.js';

import { maskPhone, maskAadhaar, maskDL, maskText, assertClean } from '../lib/mask.js';
import { readSheetRows } from '../lib/xlsx.js';

const DATA = 'data';

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

// Minimal RFC4180 splitter: handles quoted fields and doubled quotes inside
// them. The client's three CSVs do not currently use quoting, but a file
// that starts doing so must not silently shift every column by one.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(path) {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
    const row = { __row: i + 2 };
    header.forEach((h, j) => { row[h] = cells[j] === undefined ? '' : cells[j]; });
    return row;
  });
}

// ---------------------------------------------------------------------
// Vehicles - the entity resolution that the hour-3 checkpoint is about
// ---------------------------------------------------------------------

// DECISIONS.md 1.2. Two rows describing one vehicle disagree in two ways:
// one of them has no vehicle_id, and some fields are blank. The row that
// carries a vehicle_id is the master record and wins any field-level
// conflict; blanks on the winner are filled from the loser rather than
// left null. Merging happens in memory and the vehicle is written ONCE,
// because upsertVehicle overwrites every column - writing both rows in
// sequence would let the shadow row's blank capacity and heater erase the
// master's real values.
const MERGE_FIELDS = ['vehicle_id', 'model', 'year', 'bs_stage', 'engine_heater',
  'home_hub', 'capacity_tonnes'];

function ingestFleet() {
  const rows = readCsv(join(DATA, 'fleet_master.csv'));
  const merged = new Map();

  for (const row of rows) {
    const v = normalizeVehicleRow(row, 'fleet_master.csv', row.__row);
    if (!v.reg_canon) continue;

    const prior = merged.get(v.reg_canon);
    if (!prior) {
      merged.set(v.reg_canon, { ...v, raw_regs: [row.registration_number] });
      continue;
    }

    // The row with a vehicle_id is canonical. If both or neither have one,
    // the earlier row wins, which is deterministic because file order is.
    const canonical = (v.vehicle_id && !prior.vehicle_id) ? v : prior;
    const other = canonical === v ? prior : v;

    for (const field of MERGE_FIELDS) {
      const a = canonical[field];
      const b = other[field];
      if (a !== null && b !== null && a !== b) {
        recordConflict({
          entity_type: 'vehicle',
          entity_key: v.reg_canon,
          field,
          value_a: String(a),
          source_a: `fleet_master.csv:${canonical.source_row}`,
          value_b: String(b),
          source_b: `fleet_master.csv:${other.source_row}`,
          winner: String(a),
          rule_id: 'PREC-FLEET-CANONICAL-ROW',
        });
      }
    }

    const out = { ...canonical, raw_regs: [...prior.raw_regs, row.registration_number] };
    for (const field of MERGE_FIELDS) {
      if (out[field] === null && other[field] !== null) out[field] = other[field];
    }
    merged.set(v.reg_canon, out);
  }

  for (const v of merged.values()) {
    // raw_regs keeps every spelling we saw for this plate. It is the
    // evidence for the entity-resolution report: 'CH 40 BH 2290' and
    // 'CH40BH2290' were the same truck, and here is where we said so.
    upsertVehicle({ ...v, raw_regs: JSON.stringify(v.raw_regs.filter(Boolean).sort()) });
  }

  return { rows: rows.length, entities: merged.size };
}

// ---------------------------------------------------------------------
// Drivers - the hard gate
// ---------------------------------------------------------------------

function ingestDrivers() {
  const rows = readCsv(join(DATA, 'drivers_roster.csv'));
  let n = 0;

  for (const row of rows) {
    const driver = {
      driver_id: normDriverId(row.driver_id),
      // Names are not masked: dispatch is unusable without them and the
      // brief enumerates phone, ID and licence numbers. The protection for
      // names is that no outbound message ever contains one.
      name: row.name || null,
      phone_masked: maskPhone(row.phone),
      dl_masked: maskDL(row.dl_number),
      aadhaar_masked: maskAadhaar(row.aadhaar),
      joining_date: dateOnly(row.joining_date),
      home_hub: normHub(row.home_hub),
      source_file: 'drivers_roster.csv',
      source_row: row.__row,
    };
    if (!driver.driver_id) continue;

    // Belt and braces. If the masker ever misses a format, this throws here
    // rather than letting the raw value reach the database.
    assertClean(driver, `drivers_roster.csv:${row.__row}`);
    upsertDriver(driver);
    n++;
  }

  return { rows: rows.length, entities: n };
}

// ---------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------

function ingestTrips() {
  const rows = readCsv(join(DATA, 'meridian_trips.csv'));
  let n = 0;

  for (const row of rows) {
    const trip = {
      trip_id: row.trip_id || null,
      created_at: parseDate(row.created_at),
      vehicle_reg: normReg(row.vehicle_reg),
      driver_id: normDriverId(row.driver_id),
      client: normClient(row.client),
      origin_hub: normHub(row.origin_name),
      dest_hub: normHub(row.dest_name),
      status: row.status ? String(row.status).trim().toUpperCase() : null,
      osrm_time_min: normNum(row.osrm_time_min),
      actual_time_min: normNum(row.actual_time_min),
      source_file: 'meridian_trips.csv',
    };
    if (!trip.trip_id) continue;
    insertTrip(trip);
    n++;
  }

  return { rows: rows.length, entities: n };
}

// ---------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------

const MAINTENANCE_HEADER = ['date', 'vehicle', 'odometer_km', 'mechanic', 'notes'];

function ingestMaintenance() {
  const buf = readFileSync(join(DATA, 'maintenance_log.xlsx'));
  const rows = readSheetRows(buf);

  // Shape check. lib/xlsx.js handles one narrow spreadsheet dialect on
  // purpose; if the client sends something it cannot read, we want to know
  // immediately rather than ingest an empty maintenance history and then
  // silently pass every brake and service rule.
  if (rows.length === 0) {
    throw new Error('maintenance_log.xlsx: no rows readable - unsupported workbook shape');
  }
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  for (const expected of MAINTENANCE_HEADER) {
    if (!header.includes(expected)) {
      throw new Error(`maintenance_log.xlsx: missing expected column '${expected}'`);
    }
  }

  const col = Object.fromEntries(MAINTENANCE_HEADER.map((h) => [h, header.indexOf(h)]));
  let n = 0;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const entry = {
      date: dateOnly(cells[col.date]),
      vehicle_reg: normReg(cells[col.vehicle]),
      odometer_km: normNum(cells[col.odometer_km]),
      mechanic: cells[col.mechanic] || null,
      // Free text written by mechanics. Nothing stops one of them from
      // typing a phone number into it, so it goes through the scrubber.
      notes: maskText(cells[col.notes]),
      source_file: 'maintenance_log.xlsx',
      source_row: i + 1,
    };
    if (!entry.vehicle_reg) continue;
    assertClean(entry.notes, `maintenance_log.xlsx:${i + 1}`);
    insertMaintenance(entry);
    n++;
  }

  return { rows: rows.length - 1, entities: n };
}

// ---------------------------------------------------------------------
// Documents - emails and the interview
// ---------------------------------------------------------------------

// Stored as facts so the query interface has something citable. The whole
// masked body is kept rather than an extracted summary, because a citation
// that cannot be checked against the source is not a citation.
function ingestDocuments() {
  const docs = [];

  const emailDir = join(DATA, 'emails');
  for (const name of readdirSync(emailDir).sort()) {
    if (!name.endsWith('.txt')) continue;
    docs.push({ path: `emails/${name}`, text: readFileSync(join(emailDir, name), 'utf8') });
  }
  docs.push({
    path: 'dispatcher_interview.txt',
    text: readFileSync(join(DATA, 'dispatcher_interview.txt'), 'utf8'),
  });

  for (const doc of docs) {
    const masked = maskText(doc.text);
    assertClean(masked, doc.path);

    // The first Date: header in the thread, so facts extracted later can be
    // ordered in time against the structured data.
    const dateLine = doc.text.match(/^Date:\s*(.+)$/m);

    upsertFact({
      // Deterministic id: the path identifies the document, so re-ingesting
      // updates in place instead of accumulating copies.
      fact_id: `doc:${doc.path}`,
      entity_type: 'document',
      entity_key: doc.path,
      fact_type: doc.path.startsWith('emails/') ? 'email_thread' : 'interview',
      value_json: JSON.stringify({ path: doc.path, text: masked }),
      observed_at: dateLine ? parseDate(dateLine[1].trim()) : null,
      expires_at: null,
      source: doc.path,
      confidence: 'high',
    });
  }

  return { rows: docs.length, entities: docs.length };
}

// ---------------------------------------------------------------------

function main() {
  // Context only. The outbox is never touched - see lib/db.js.
  resetContextTables();

  const stats = withTransaction(() => ({
    fleet: ingestFleet(),
    drivers: ingestDrivers(),
    trips: ingestTrips(),
    maintenance: ingestMaintenance(),
    documents: ingestDocuments(),
  }));

  const conflicts = getAllConflicts();

  const line = (label, s) =>
    process.stdout.write(`  ${label.padEnd(14)} ${String(s.rows).padStart(6)} rows -> ${String(s.entities).padStart(5)} records\n`);

  process.stdout.write('ingest complete\n');
  line('fleet', stats.fleet);
  line('drivers', stats.drivers);
  line('trips', stats.trips);
  line('maintenance', stats.maintenance);
  line('documents', stats.documents);

  process.stdout.write(`\nentity resolution\n`);
  process.stdout.write(`  ${stats.fleet.rows} fleet rows resolved to ${getVehicleCount()} vehicles\n`);
  process.stdout.write(`  ${conflicts.length} field conflicts recorded, all resolved by documented precedence\n`);
  for (const c of conflicts) {
    process.stdout.write(
      `    ${c.entity_key} ${c.field}: ${c.value_a} (${c.source_a}) beats ${c.value_b} (${c.source_b}) [${c.rule_id}]\n`
    );
  }

  close();
}

main();
