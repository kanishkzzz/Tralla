import { getAllAudit, getAuditFor } from '../../lib/db.js';
import { assertClean } from '../../lib/mask.js';

export const dynamic = 'force-dynamic';

export default async function Audit({ searchParams }) {
  const params = await searchParams;
  const ticket = typeof params?.ticket === 'string' ? params.ticket.trim() : '';

  const lines = ticket ? getAuditFor(ticket) : getAllAudit();
  assertClean(JSON.stringify(lines), 'dashboard:/audit');

  const tickets = [...new Set(getAllAudit().map((l) => l.ticket_id))].sort();

  return (
    <>
      <div className="stats">
        <div className="stat"><b>{lines.length}</b><span>{ticket ? 'Lines for ticket' : 'Audit lines'}</span></div>
        <div className="stat"><b>{tickets.length}</b><span>Tickets with a trail</span></div>
      </div>

      <form className="inline" method="get" style={{ marginBottom: 18 }}>
        <input type="text" name="ticket" placeholder="Ticket id, e.g. TKT-0020" defaultValue={ticket} />
        <button type="submit">Trace</button>
        {ticket && <a href="/audit" style={{ fontSize: 13 }}>clear</a>}
      </form>

      {ticket && lines.length === 0 && (
        <div className="empty">No audit trail for <code>{ticket}</code>.</div>
      )}

      {lines.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Ticket</th><th>Step</th><th>Decision</th><th>Data used</th><th>Rule</th><th>Actor</th><th>At</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.ticket_id + l.step}>
                  <td className="mono"><a href={`/audit?ticket=${l.ticket_id}`}>{l.ticket_id}</a></td>
                  <td className="mono">{l.step}</td>
                  <td style={{ maxWidth: 520 }}>{l.decision}</td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{l.data_used}</td>
                  <td>{l.rule_id ? <span className="tag rule">{l.rule_id}</span> : <span style={{ color: 'var(--dim)' }}>—</span>}</td>
                  <td style={{ color: 'var(--dim)' }}>{l.actor}</td>
                  <td className="mono" style={{ color: 'var(--dim)' }}>{l.at || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!ticket && (
        <>
          <h2>Tickets</h2>
          <div className="scroll" style={{ padding: 12 }}>
            {tickets.map((t) => (
              <a key={t} href={`/audit?ticket=${t}`} className="tag" style={{ margin: 3, display: 'inline-block' }}>{t}</a>
            ))}
          </div>
        </>
      )}
    </>
  );
}
