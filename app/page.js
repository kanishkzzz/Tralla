import {
  getAllWorkOrders, getComms, getAllQuarantine, getAllAudit,
  getVehicleCount, getAllConflicts,
} from '../lib/db.js';
import { assertClean } from '../lib/mask.js';

export const dynamic = 'force-dynamic';

function parse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

export default function Overview() {
  const workOrders = getAllWorkOrders();
  const pending = getComms('pending');
  const sent = getComms('sent');
  const quarantine = getAllQuarantine();
  const audit = getAllAudit();
  const conflicts = getAllConflicts();

  assertClean(JSON.stringify([workOrders, quarantine, conflicts]), 'dashboard:/');

  const ruleCounts = new Map();
  for (const wo of workOrders) {
    for (const c of parse(wo.citations_json, [])) {
      if (String(c.source).startsWith('rules.yaml#')) {
        const id = String(c.source).slice(11);
        ruleCounts.set(id, (ruleCounts.get(id) || 0) + 1);
      }
    }
  }
  const rules = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="stats">
        <div className="stat"><b>{workOrders.length}</b><span>Work orders</span></div>
        <div className="stat warn"><b>{pending.length}</b><span>Awaiting approval</span></div>
        <div className="stat good"><b>{sent.length}</b><span>Approved &amp; sent</span></div>
        <div className="stat"><b>{quarantine.length}</b><span>Quarantined</span></div>
        <div className="stat"><b>{audit.length}</b><span>Audit lines</span></div>
        <div className="stat"><b>{getVehicleCount()}</b><span>Vehicles resolved</span></div>
      </div>

      <h2>Quarantine — broken records, never dropped</h2>
      {quarantine.length === 0 ? <div className="empty">Nothing quarantined.</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Ticket</th><th>Reason</th><th>Source</th><th>Detected</th></tr></thead>
            <tbody>
              {quarantine.map((q) => (
                <tr key={q.ticket_key + q.reason}>
                  <td className="mono">{q.ticket_key}</td>
                  <td><span className="tag bad">{q.reason}</span></td>
                  <td className="mono">{q.source_file}</td>
                  <td className="mono">{q.detected_at || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Entity resolution conflicts — resolved by documented precedence</h2>
      {conflicts.length === 0 ? <div className="empty">No conflicts recorded.</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Entity</th><th>Field</th><th>Winner</th><th>Rejected</th><th>Rule</th></tr></thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.entity_key}</td>
                  <td>{c.field}</td>
                  <td className="mono">{c.value_a} <span className="tag">{c.source_a}</span></td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{c.value_b} <span className="tag">{c.source_b}</span></td>
                  <td><span className="tag rule">{c.rule_id}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Rules cited across work orders</h2>
      {rules.length === 0 ? <div className="empty">No rules cited yet.</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Rule</th><th>Citations</th></tr></thead>
            <tbody>
              {rules.map(([id, n]) => (
                <tr key={id}><td><span className="tag rule">{id}</span></td><td>{n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Work orders</h2>
      {workOrders.length === 0 ? <div className="empty">No work orders. Run <code>npm run setup</code>.</div> : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Work order</th><th>Ticket</th><th>Broken</th><th>Replacement</th><th>Hub</th><th>Severity</th><th>Cites</th></tr>
            </thead>
            <tbody>
              {workOrders.map((w) => (
                <tr key={w.work_order_id}>
                  <td className="mono">{w.work_order_id}</td>
                  <td className="mono"><a href={`/audit?ticket=${w.ticket_id}`}>{w.ticket_id}</a></td>
                  <td className="mono">{w.vehicle_reg}</td>
                  <td className="mono">{w.replacement_reg || <span className="tag bad">none eligible</span>}</td>
                  <td>{w.origin_hub}</td>
                  <td><span className={`tag ${w.severity}`}>{w.severity}</span></td>
                  <td>{parse(w.citations_json, []).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
