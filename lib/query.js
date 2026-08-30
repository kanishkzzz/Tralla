// lib/query.js
//
// The grounded query interface. It answers from the resolved store or it
// says it cannot, and it never fills a gap with a guess. Confident
// unsupported answers are marked down harder than an honest refusal, so
// "insufficient data" is a first-class result here, not a fallback.
//
// Pure: parseQuestion works out what is being asked, the caller fetches
// exactly what that needs, buildAnswer turns it into an answer plus
// citations. No database access, no LLM. Every claim traces to a row.

import { normReg, normClient, normHub, normDriverId } from './normalize.js';

const INTENT_PATTERNS = [
  ['location', /\b(where|current location|right now|currently|position|gps|located|live location)\b/i],
  ['maintenance', /\b(maintenance|service|serviced|repair|repaired|brake|jugaad|odometer|workshop|mechanic|overdue|due)\b/i],
  ['vehicle_spec', /\b(year|model|bs4|bs6|bs stage|heater|capacity|tonnes|hub|home hub|registration|fleet|old|new)\b/i],
  ['client_rule', /\b(sla|delivery window|hours|deadline|gate|warehouse|closes|rotate|rotation|overnight|pharma|newest|penalty|failed delivery)\b/i],
  ['rule', /\b(rule|policy|allowed|permitted|must|never|always|restriction|grap|winter|monsoon|night)\b/i],
  ['driver', /\b(driver|tenure|joined|joining|roster|solo|night run)\b/i],
  ['trip', /\b(trip|trips|dispatch|route|history|delivered)\b/i],
];

const CLIENT_WORDS = ['shakti', 'vertex', 'apex', 'orion', 'internal', 'meridian'];
const HUB_WORDS = ['ambala', 'chandigarh', 'delhi', 'gurgaon', 'gurugram', 'jaipur',
  'kanpur', 'lucknow', 'ludhiana', 'rudrapur', 'faridabad', 'noida', 'nainital'];

export function parseQuestion(question) {
  const text = String(question || '').trim();
  const words = text.split(/[\s,?.;:()"']+/).filter(Boolean);

  const regs = [];
  for (const w of words) {
    if (!/^[A-Za-z]{2}[-\s]?\d{1,2}/.test(w)) continue;
    const canon = normReg(w);
    if (canon && canon.length >= 8 && canon.length <= 12 && /^[A-Z]{2}\d/.test(canon)) regs.push(canon);
  }

  const driverIds = [];
  for (const w of words) {
    const d = /drv/i.test(w) ? normDriverId(w) : null;
    if (d) driverIds.push(d);
  }

  const clients = [];
  for (const w of words) {
    if (CLIENT_WORDS.includes(w.toLowerCase())) {
      const c = normClient(w);
      if (c && !clients.includes(c)) clients.push(c);
    }
  }

  const hubs = [];
  for (const w of words) {
    if (HUB_WORDS.includes(w.toLowerCase())) {
      const h = normHub(w);
      if (h && !hubs.includes(h)) hubs.push(h);
    }
  }

  const ruleIds = (text.match(/R-[A-Z0-9-]+/gi) || []).map((r) => r.toUpperCase());

  const intents = INTENT_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);

  const stop = new Set(['what', 'which', 'when', 'where', 'who', 'why', 'how', 'is', 'are',
    'was', 'were', 'the', 'a', 'an', 'of', 'for', 'to', 'on', 'in', 'and', 'or', 'do', 'does',
    'did', 'can', 'should', 'has', 'have', 'had', 'me', 'tell', 'show', 'about', 'that', 'this']);
  const keywords = words
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !stop.has(w));

  return { text, regs, driverIds, clients, hubs, ruleIds, intents, keywords };
}

function snippet(text, keywords, width = 240) {
  const lower = String(text).toLowerCase();
  let best = -1;
  for (const k of keywords) {
    const i = lower.indexOf(k);
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  if (best === -1) return String(text).slice(0, width).trim();
  const start = Math.max(0, best - width / 3);
  return (start > 0 ? '…' : '') + String(text).slice(start, start + width).trim() + '…';
}

export function buildAnswer(parsed, data) {
  const lines = [];
  const citations = [];
  const {
    vehicles = [], drivers = [], maintenance = [], conflicts = [],
    documents = [], rules = [], trips = [],
  } = data || {};

  if (parsed.intents.includes('location')) {
    return {
      sufficient: false,
      answer:
        'Insufficient data. The system holds no live vehicle position. meridian_trips.csv ' +
        'covers September to October 2018 and southern India, so it cannot describe where any ' +
        'vehicle is now. Answering would require a telematics feed, which is not in scope.',
      citations: [{ source: 'DECISIONS.md#7', note: 'Live vehicle location — deliberate cut' }],
    };
  }

  for (const v of vehicles) {
    const parts = [];
    if (v.year !== null) parts.push(`${v.year}`);
    if (v.model) parts.push(v.model);
    if (v.bs_stage) parts.push(v.bs_stage);
    if (v.engine_heater !== null) parts.push(v.engine_heater === 1 ? 'engine heater' : 'no engine heater');
    if (v.capacity_tonnes !== null) parts.push(`${v.capacity_tonnes}t`);
    if (v.home_hub) parts.push(`home hub ${v.home_hub}`);
    lines.push(`${v.reg_canon}${v.vehicle_id ? ` (${v.vehicle_id})` : ''}: ${parts.join(', ')}.`);
    citations.push({
      source: `${v.source_file}:${v.source_row}`,
      entity: v.reg_canon,
      fields: ['year', 'model', 'bs_stage', 'engine_heater', 'home_hub', 'capacity_tonnes'],
    });
    const spellings = (() => { try { return JSON.parse(v.raw_regs) || []; } catch { return []; } })();
    if (spellings.length > 1) {
      lines.push(`  Same vehicle appears in the source as: ${spellings.join(', ')}.`);
    }
  }

  for (const c of conflicts) {
    lines.push(
      `Conflict on ${c.entity_key} ${c.field}: ${c.value_a} (${c.source_a}) was taken over ` +
      `${c.value_b} (${c.source_b}) under ${c.rule_id}.`
    );
    citations.push({ source: `rules#${c.rule_id}`, entity: c.entity_key, field: c.field });
  }

  for (const d of drivers) {
    lines.push(
      `${d.driver_id} ${d.name}, joined ${d.joining_date}, home hub ${d.home_hub}. ` +
      `Contact details are masked (${d.phone_masked}).`
    );
    citations.push({ source: `${d.source_file}:${d.source_row}`, entity: d.driver_id });
  }

  if (maintenance.length > 0) {
    lines.push(`${maintenance.length} maintenance entr${maintenance.length === 1 ? 'y' : 'ies'} on record, most recent first:`);
    for (const m of maintenance.slice(0, 8)) {
      lines.push(`  ${m.date}  ${m.odometer_km} km  ${m.mechanic}: ${m.notes}`);
      citations.push({ source: `${m.source_file}:${m.source_row}`, entity: m.vehicle_reg, date: m.date });
    }
  }

  for (const r of rules) {
    lines.push(`${r.id} — ${r.name}: ${r.then?.reason || r.then?.effect}. Rajender: "${r.quote}"` +
      (r.implemented === false ? ' [encoded but NOT enforced — see DECISIONS.md §7]' : ''));
    citations.push({ source: `rules.yaml#${r.id}`, quote: r.quote });
  }

  for (const doc of documents) {
    let payload;
    try { payload = JSON.parse(doc.value_json); } catch { payload = null; }
    if (!payload || !payload.text) continue;
    lines.push(`${doc.entity_key}: ${snippet(payload.text, parsed.keywords)}`);
    citations.push({ source: doc.entity_key, observed_at: doc.observed_at });
  }

  if (trips.length > 0) {
    lines.push(`${trips.length} historical trip(s) on record (Sept–Oct 2018 dataset, not current activity).`);
    citations.push({ source: 'meridian_trips.csv', note: 'historical only' });
  }

  if (lines.length === 0) {
    return {
      sufficient: false,
      answer:
        'Insufficient data. Nothing in the resolved store answers that. The store holds the ' +
        'fleet register, driver roster, maintenance log, trip history, 40 email threads, the ' +
        'dispatcher interview and the encoded rulebook. Try naming a vehicle registration, a ' +
        'driver id, a client, a hub, or a rule id.',
      citations: [],
    };
  }

  return { sufficient: true, answer: lines.join('\n'), citations };
}
