// lib/render.js
//
// Renders the graded output files from database state.
//
// The rule that makes re-runnability work: these files are written FRESH
// every run and never appended to. Two runs over the same state therefore
// produce byte-identical files, and a re-run cannot double a line even if
// something upstream went wrong. All the ordering comes from db.js, whose
// every list query carries an explicit ORDER BY.
//
// This is the one file in lib/ besides db.js that touches the disk. It is
// the write boundary, which is where assertClean() will hook in once
// lib/mask.js exists - a leak anywhere upstream should fail here, loudly,
// before it reaches a file an evaluator reads.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  getAllWorkOrders,
  getComms,
  getAllQuarantine,
  getAllAudit,
} from './db.js';

// One JSON object per line, trailing newline, no pretty-printing. Key order
// is fixed by the object literals below rather than by whatever order the
// database happened to return columns in - another thing that would
// otherwise vary between runs.
function writeJsonl(filePath, rows) {
  mkdirSync(dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(filePath, rows.length > 0 ? body + '\n' : '', 'utf8');
  return rows.length;
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    // A malformed citations blob must not take down the render. Better a
    // visible marker in the output than a crashed run.
    return fallback;
  }
}

export function renderAll(outDir = 'outputs', auditDir = 'audit') {
  const workOrders = getAllWorkOrders().map((r) => ({
    work_order_id: r.work_order_id,
    ticket_id: r.ticket_id,
    vehicle_reg: r.vehicle_reg,
    created_at: r.created_at,
    citations: parseJsonColumn(r.citations_json, []),
  }));

  // Pending messages exist to be approved, so the approver's context and
  // citations travel with them. Sent messages match the exact shape the
  // candidate README specifies, and nothing more.
  const pending = getComms('pending').map((r) => ({
    message_id: r.message_id,
    ticket_id: r.ticket_id,
    recipient: r.recipient,
    body: r.body,
    context: parseJsonColumn(r.context_json, {}),
    citations: parseJsonColumn(r.citations_json, []),
  }));

  const sent = getComms('sent').map((r) => ({
    message_id: r.message_id,
    ticket_id: r.ticket_id,
    recipient: r.recipient,
    body: r.body,
    approved_by: r.approved_by,
    sent_at: r.sent_at,
  }));

  const quarantine = getAllQuarantine().map((r) => ({
    ticket_key: r.ticket_key,
    reason: r.reason,
    source_file: r.source_file,
    detected_at: r.detected_at,
    raw: parseJsonColumn(r.raw_json, null),
  }));

  const audit = getAllAudit().map((r) => ({
    ticket_id: r.ticket_id,
    step: r.step,
    decision: r.decision,
    data_used: r.data_used,
    rule_id: r.rule_id,
    actor: r.actor,
    at: r.at,
  }));

  return {
    [`${outDir}/work_orders.jsonl`]: writeJsonl(`${outDir}/work_orders.jsonl`, workOrders),
    [`${outDir}/comms_pending.jsonl`]: writeJsonl(`${outDir}/comms_pending.jsonl`, pending),
    [`${outDir}/comms_sent.jsonl`]: writeJsonl(`${outDir}/comms_sent.jsonl`, sent),
    [`${outDir}/quarantine.jsonl`]: writeJsonl(`${outDir}/quarantine.jsonl`, quarantine),
    [`${auditDir}/audit.jsonl`]: writeJsonl(`${auditDir}/audit.jsonl`, audit),
  };
}
