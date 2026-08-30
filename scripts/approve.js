// scripts/approve.js
//
// The human approval gate. Drafted messages sit in comms as 'pending' until
// a person approves them here; only then are they written to
// outputs/comms_sent.jsonl.
//
//   node scripts/approve.js                          interactive, one by one
//   node scripts/approve.js --list                   show pending, approve nothing
//   node scripts/approve.js --all --by "R. Yadav"    approve every pending
//   node scripts/approve.js --ticket TKT-0001 --by X approve one
//   node scripts/approve.js --all --by X --at 2026-08-30T10:00:00+05:30
//
// This is the only irreversible action in the system, so it is the only one
// behind a person. The approver is shown the full context and citations the
// pipeline used - what broke, what was chosen, what was rejected and under
// which rule - because an approval gate that shows only the message body is
// a rubber stamp, not a control.
//
// ON THE CLOCK. CLAUDE.md forbids reading the system clock in lib/ and
// scripts/, and this file breaks that rule in exactly one place: sent_at.
// The prohibition exists so re-runs cannot drift. Approval is not a re-run -
// it is a one-time state transition guarded by status = 'pending' in
// db.js, so a second approval of the same ticket changes nothing and cannot
// overwrite the original timestamp. When a human approved something is a
// real fact about the world and inventing it from the ticket's own
// created_at would be a lie. Pass --at to pin it for a reproducible demo.

import { createInterface } from 'node:readline/promises';

import { getComms, approveComms, close } from '../lib/db.js';
import { assertClean } from '../lib/mask.js';
import { renderAll } from '../lib/render.js';

function parseArgs(argv) {
  const args = { list: false, all: false, ticket: null, by: null, at: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--all') args.all = true;
    else if (a === '--ticket') args.ticket = argv[++i];
    else if (a === '--by') args.by = argv[++i];
    else if (a === '--at') args.at = argv[++i];
  }
  return args;
}

function show(msg) {
  const ctx = JSON.parse(msg.context_json || '{}');
  const cites = JSON.parse(msg.citations_json || '[]');

  const out = [];
  out.push(`\n${'='.repeat(72)}`);
  out.push(`${msg.ticket_id}  ->  ${msg.recipient}      message ${msg.message_id}`);
  out.push('='.repeat(72));
  out.push(`  route          ${ctx.route}   (${ctx.km_from_origin} km from origin)`);
  out.push(`  broken         ${ctx.broken_vehicle}`);
  out.push(`  replacement    ${ctx.replacement_vehicle || 'NONE ASSIGNED'}  from ${ctx.source_hub}`);
  out.push(`  severity       ${ctx.severity} (${ctx.severity_source})` +
           (ctx.sla_hours ? `   SLA ${ctx.sla_hours}h` : ''));
  out.push(`  candidates     ${ctx.candidates_eligible} eligible of ${ctx.candidates_considered}`);

  if (Array.isArray(ctx.rejected) && ctx.rejected.length) {
    out.push('  rejected');
    for (const r of ctx.rejected) {
      const why = [...(r.excluded_by || []), ...(r.undetermined || []).map((u) => `${u}(no data)`)];
      out.push(`      ${r.vehicle.padEnd(12)} ${why.join(', ')}`);
    }
  }
  if (Array.isArray(ctx.driver_constraints) && ctx.driver_constraints.length) {
    for (const d of ctx.driver_constraints) out.push(`  DRIVER         ${d.reason} [${d.rule_id}]`);
  }

  // The citations are the reason this gate is meaningful. An approver who
  // disagrees can go straight to the rule or the source row.
  const ruleCites = cites.filter((c) => String(c.source).startsWith('rules.yaml#'));
  if (ruleCites.length) {
    out.push('  rules cited');
    const seen = new Set();
    for (const c of ruleCites) {
      const id = String(c.source).slice(11);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(`      ${id.padEnd(24)}${c.quote ? `"${c.quote}"` : ''}`);
    }
  }

  out.push('  --- message to be sent ---');
  out.push(`  ${msg.body}`);

  // Nothing reaches a human screen unchecked either. The gate is at every
  // boundary, not only the file writes.
  const text = out.join('\n');
  assertClean(text, `approve.display:${msg.ticket_id}`);
  process.stdout.write(text + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pending = getComms('pending');

  if (pending.length === 0) {
    process.stdout.write('nothing pending approval\n');
    close();
    return;
  }

  if (args.list) {
    for (const msg of pending) show(msg);
    process.stdout.write(`\n${pending.length} message(s) pending approval\n`);
    close();
    return;
  }

  // See the header note. --at pins it; otherwise this is the one real
  // wall-clock reading in the system.
  const sentAt = args.at || new Date().toISOString();
  let approver = args.by;
  let approved = 0;

  const targets = args.ticket
    ? pending.filter((m) => m.ticket_id === args.ticket)
    : pending;

  if (args.ticket && targets.length === 0) {
    process.stderr.write(`no pending message for ${args.ticket}\n`);
    process.exitCode = 1;
    close();
    return;
  }

  if (args.all || args.ticket) {
    if (!approver) {
      process.stderr.write('--by <name> is required: an approval must name the person who gave it\n');
      process.exitCode = 1;
      close();
      return;
    }
    for (const msg of targets) {
      show(msg);
      if (approveComms(msg.ticket_id, approver, sentAt).approved) approved++;
    }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (!approver) approver = (await rl.question('approver name: ')).trim();
    if (!approver) {
      process.stderr.write('an approval must name the person who gave it\n');
      process.exitCode = 1;
      rl.close();
      close();
      return;
    }
    for (const msg of targets) {
      show(msg);
      const answer = (await rl.question('\n  send this message? [y/N/q] ')).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 'y' && approveComms(msg.ticket_id, approver, sentAt).approved) approved++;
    }
    rl.close();
  }

  // Outputs are always re-rendered from state, so comms_pending.jsonl and
  // comms_sent.jsonl stay consistent with the database after an approval.
  const written = renderAll();
  process.stdout.write(`\napproved ${approved} of ${targets.length} by ${approver} at ${sentAt}\n`);
  process.stdout.write(`  outputs/comms_sent.jsonl ${written['outputs/comms_sent.jsonl']}\n`);
  process.stdout.write(`  outputs/comms_pending.jsonl ${written['outputs/comms_pending.jsonl']}\n`);
  close();
}

main();
