import { getComms } from '../../lib/db.js';
import { assertClean } from '../../lib/mask.js';
import { approveMessage } from '../actions.js';

export const dynamic = 'force-dynamic';

function parse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

export default function Approvals() {
  const pending = getComms('pending');
  const sent = getComms('sent');

  assertClean(JSON.stringify([pending, sent]), 'dashboard:/approvals');

  return (
    <>
      <div className="stats">
        <div className="stat warn"><b>{pending.length}</b><span>Awaiting approval</span></div>
        <div className="stat good"><b>{sent.length}</b><span>Approved &amp; sent</span></div>
      </div>

      <h2>Pending — nothing is sent without a human</h2>
      {pending.length === 0 && <div className="empty">Nothing pending approval.</div>}

      {pending.map((m) => {
        const ctx = parse(m.context_json, {});
        const cites = parse(m.citations_json, []);
        const rules = [];
        const seen = new Set();
        for (const c of cites) {
          const s = String(c.source);
          if (!s.startsWith('rules.yaml#')) continue;
          const id = s.slice(11);
          if (seen.has(id)) continue;
          seen.add(id);
          rules.push({ id, quote: c.quote });
        }

        return (
          <div className="card" key={m.message_id}>
            <h3>{m.ticket_id} → {m.recipient}</h3>
            <div className="meta mono">{m.message_id}</div>

            <div className="grid2">
              <div className="kv"><span>Route</span>{ctx.route} · {ctx.km_from_origin} km</div>
              <div className="kv"><span>Broken</span><code>{ctx.broken_vehicle}</code></div>
              <div className="kv"><span>Replacement</span><code>{ctx.replacement_vehicle || '— none eligible —'}</code> from {ctx.source_hub}</div>
              <div className="kv"><span>Severity</span><span className={`tag ${ctx.severity}`}>{ctx.severity}</span> ({ctx.severity_source})</div>
              <div className="kv"><span>SLA</span>{ctx.sla_hours ? `${ctx.sla_hours} h` : 'standard'}</div>
              <div className="kv"><span>Candidates</span>{ctx.candidates_eligible} eligible of {ctx.candidates_considered}</div>
            </div>

            {Array.isArray(ctx.rejected) && ctx.rejected.length > 0 && (
              <>
                <div className="meta">Rejected candidates</div>
                <div className="scroll" style={{ marginBottom: 12 }}>
                  <table>
                    <thead><tr><th>Vehicle</th><th>Excluded by</th><th>Could not evaluate</th></tr></thead>
                    <tbody>
                      {ctx.rejected.map((r) => (
                        <tr key={r.vehicle}>
                          <td className="mono">{r.vehicle}</td>
                          <td>{(r.excluded_by || []).map((x) => <span className="tag rule" key={x}>{x}</span>)}</td>
                          <td>{(r.undetermined || []).map((x) => <span className="tag" key={x}>{x}</span>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {Array.isArray(ctx.driver_constraints) && ctx.driver_constraints.map((d) => (
              <div className="kv" key={d.rule_id} style={{ marginBottom: 8 }}>
                <span>Driver</span><span className="tag bad">{d.rule_id}</span>&nbsp;{d.reason}
              </div>
            ))}

            {rules.length > 0 && (
              <>
                <div className="meta">Rules cited</div>
                {rules.map((r) => (
                  <div key={r.id} style={{ marginBottom: 4 }}>
                    <span className="tag rule">{r.id}</span>{' '}
                    {r.quote && <span className="quote">“{r.quote}”</span>}
                  </div>
                ))}
              </>
            )}

            <div className="body">{m.body}</div>

            <form action={approveMessage} className="inline">
              <input type="hidden" name="ticket_id" value={m.ticket_id} />
              <input type="text" name="approved_by" placeholder="Approver name" required />
              <button type="submit">Approve &amp; send</button>
            </form>
          </div>
        );
      })}

      <h2>Sent</h2>
      {sent.length === 0 ? <div className="empty">Nothing sent yet.</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Message</th><th>Ticket</th><th>Recipient</th><th>Approved by</th><th>Sent at</th></tr></thead>
            <tbody>
              {sent.map((m) => (
                <tr key={m.message_id}>
                  <td className="mono">{m.message_id}</td>
                  <td className="mono">{m.ticket_id}</td>
                  <td>{m.recipient}</td>
                  <td>{m.approved_by}</td>
                  <td className="mono">{m.sent_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
