import { ask, corpusSize } from '../../lib/resolve-query.js';

export const dynamic = 'force-dynamic';

const EXAMPLES = [
  'What year is RJ43DD3546?',
  'Maintenance history for PB31NP8886',
  'What is Shakti Cement delivery window?',
  'Where is HR16SP9238 right now?',
  'What rule covers BS4 in winter?',
  'Tell me about R-ORIGIN-50KM',
  'Vertex Retail warehouse gate',
  'Driver DRV-011 tenure',
];

export default async function Ask({ searchParams }) {
  const params = await searchParams;
  const q = typeof params?.q === 'string' ? params.q.trim() : '';
  const result = q ? ask(q) : null;
  const size = corpusSize();

  return (
    <>
      <div className="stats">
        <div className="stat"><b>{size.vehicles}</b><span>Vehicles</span></div>
        <div className="stat"><b>{size.documents}</b><span>Documents</span></div>
        <div className="stat"><b>{size.rules}</b><span>Encoded rules</span></div>
      </div>

      <form className="inline" method="get" style={{ marginBottom: 16 }}>
        <input type="text" name="q" placeholder="Ask about a vehicle, driver, client, hub or rule"
          defaultValue={q} style={{ minWidth: 420, flex: 1 }} />
        <button type="submit">Ask</button>
      </form>

      <div style={{ marginBottom: 24 }}>
        {EXAMPLES.map((e) => (
          <a key={e} href={`/ask?q=${encodeURIComponent(e)}`} className="tag"
            style={{ margin: 3, display: 'inline-block' }}>{e}</a>
        ))}
      </div>

      {result && (
        <>
          <div className="card">
            <h3>
              {result.sufficient
                ? <span style={{ color: 'var(--ok)' }}>Answered from the resolved store</span>
                : <span style={{ color: 'var(--warn)' }}>Insufficient data</span>}
            </h3>
            <div className="meta">
              intents: {result.parsed.intents.join(', ') || 'none detected'}
              {Object.entries(result.parsed.entities)
                .filter(([, v]) => v.length)
                .map(([k, v]) => ` · ${k}: ${v.join(', ')}`)}
            </div>
            <div className="body" style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</div>
          </div>

          <h2>Citations</h2>
          {result.citations.length === 0 ? (
            <div className="empty">No citations — the system declined to answer rather than guess.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead><tr><th>Source</th><th>Detail</th></tr></thead>
                <tbody>
                  {result.citations.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.source}</td>
                      <td style={{ color: 'var(--dim)' }}>
                        {c.quote ? <span className="quote">“{c.quote}”</span> : null}
                        {c.entity ? ` ${c.entity}` : ''}
                        {c.field ? ` · ${c.field}` : ''}
                        {c.fields ? ` · ${c.fields.join(', ')}` : ''}
                        {c.date ? ` · ${c.date}` : ''}
                        {c.note ? ` · ${c.note}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
