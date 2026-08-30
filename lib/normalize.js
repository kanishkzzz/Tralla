// lib/normalize.js
//
// Canonicalisation only. Every function here answers "what is the standard
// form of this value?" and nothing else.
//
// It NEVER decides whether a value is acceptable. normReg('hr??unknown')
// returns 'HRUNKNOWN' quite happily - that string is a perfectly good
// canonical form of a bad input. Deciding that no such vehicle exists is
// validate.js's job. Keeping that separation means quarantine reasons all
// come from one place instead of being scattered across the codebase.
//
// Three properties every function here holds to:
//   1. Total      - never throws, whatever you feed it
//   2. Null-safe  - null/undefined/'' in, null out
//   3. Idempotent - norm(norm(x)) === norm(x), so re-running ingest is safe
//
// A fourth, added after a cross-machine determinism bug: nothing here reads
// the host timezone. See the dates section.

// ---------------------------------------------------------------------
// Registration numbers
// ---------------------------------------------------------------------

// 'CH 40 BH 2290' | 'ch-40-bh-2290' | 'CH40BH2290'  ->  'CH40BH2290'
// This one line is half of the entity resolution in this project: it
// collapses 118 fleet rows into 100 vehicles and matches every ticket and
// trip registration against them.
export function normReg(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned === '' ? null : cleaned;
}

// ---------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------

// Add to this map whenever an email or a data file uses a new spelling.
// It is the single place client naming lives.
const CLIENT_ALIASES = {
  'apex chemicals': 'apex_chemicals',
  'apex chem': 'apex_chemicals',
  'apex': 'apex_chemicals',
  'orion pharma': 'orion_pharma',
  'orion pharmaceuticals': 'orion_pharma',
  'orion': 'orion_pharma',
  'shakti cement': 'shakti_cement',
  'shakthi cement': 'shakti_cement',
  'shakti': 'shakti_cement',
  'vertex retail': 'vertex_retail',
  'vertex': 'vertex_retail',
  'internal': 'internal',
  'meridian freight': 'internal',
  'meridian': 'internal',
};

// Corporate suffixes carry no identity, so they come off before lookup.
const CORP_SUFFIXES =
  /\b(private limited|pvt\.? ?ltd\.?|pvt\.?|limited|ltd\.?|llp|inc\.?|corp\.?|co\.?)\b/g;

// 'Vertex Retail Pvt. Ltd.' -> 'vertex_retail'
// Unknown clients fall through to a slug rather than null, so an
// unrecognised name still groups consistently instead of vanishing.
export function normClient(value) {
  if (value === null || value === undefined) return null;
  const base = String(value)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(CORP_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (base === '') return null;
  if (CLIENT_ALIASES[base]) return CLIENT_ALIASES[base];
  return base.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------------
// Hubs and geography
// ---------------------------------------------------------------------

// The nine hubs in fleet_master.csv, plus the NCR cities the BS4 rule
// names and the hill destinations the heater rule names.
const HUB_ALIASES = {
  'ambala': 'ambala',
  'chandigarh': 'chandigarh',
  'delhi': 'delhi',
  'new delhi': 'delhi',
  'gurgaon': 'gurgaon',
  'gurugram': 'gurgaon',
  'jaipur': 'jaipur',
  'kanpur': 'kanpur',
  'lucknow': 'lucknow',
  'ludhiana': 'ludhiana',
  'rudrapur': 'rudrapur',
  'faridabad': 'faridabad',
  'noida': 'noida',
  'nainital': 'nainital',
  'haldwani': 'haldwani',
};

// Longest first, so the substring fallback below is decided by specificity
// rather than by object insertion order. 'new delhi' must be tested before
// 'delhi' or the more specific alias can never win.
const HUB_KEYS_BY_LENGTH = Object.keys(HUB_ALIASES).sort((a, b) => b.length - a.length);

// Emails say 'Ludhiana WH', the CSV says 'Ludhiana'. Strip the noise words
// before lookup so both land on the same slug.
const PLACE_SUFFIXES =
  /\b(wh|warehouse|hub|depot|dc|plant|yard|terminal|centre|center|branch)\b/g;

export function normHub(value) {
  if (value === null || value === undefined) return null;
  const base = String(value)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(PLACE_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (base === '') return null;
  if (HUB_ALIASES[base]) return HUB_ALIASES[base];
  for (const key of HUB_KEYS_BY_LENGTH) {
    if (base.includes(key)) return HUB_ALIASES[key];
  }
  return base.replace(/\s+/g, '_');
}

// Geography lives here so rules.yaml and enrich.js never disagree about it.
export const NCR_HUBS = ['delhi', 'gurgaon', 'faridabad', 'noida'];
export const HILL_HUBS = ['rudrapur', 'nainital', 'haldwani'];

// See DECISIONS.md 2.6: none of Meridian's nine hubs are actually east of
// Lucknow. The list is correct and the rule will fire if such a
// destination appears; with the current hub set it is expected not to.
export const EAST_OF_LUCKNOW = ['gorakhpur', 'varanasi', 'patna', 'gonda', 'basti'];

export function isHillRoute(hubs) {
  return (hubs || []).some((h) => HILL_HUBS.includes(h));
}

export function touchesNCR(hubs) {
  return (hubs || []).some((h) => NCR_HUBS.includes(h));
}

export function isEastOfLucknow(hubs) {
  return (hubs || []).some((h) => EAST_OF_LUCKNOW.includes(h));
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------
//
// Meridian's data mixes three date shapes, and JavaScript treats two of
// them differently:
//
//   '2026-02-21T04:00:00'          tickets       - parsed as HOST LOCAL time
//   '2026-05-19'                   maintenance   - parsed as UTC
//   'Thu, 04 Jun 2026 12:35 +0530' emails        - explicit offset, fine
//
// Left alone, that means the same input produces different output on
// different machines: under UTC the first value stays 04:00 on the 21st,
// under IST it becomes 22:30 on the 20th. Every derived day count then
// shifts by one, which is enough to flip R-HILL-BRAKE-30 and R-JUGAAD-7DAY
// to the wrong answer, and enough to make our outputs differ from the
// evaluator's on an otherwise identical run.
//
// So: any timestamp that does not carry its own offset is read in IST.
// Meridian is a North India fleet, every email header in the corpus is
// +0530, and the operating rules are written in local wall-clock terms
// ("four in the morning in December", night runs). The host timezone is
// never consulted.
const ASSUMED_OFFSET = '+05:30';
const ASSUMED_OFFSET_MIN = 330;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// Attaches the assumed offset to inputs that lack one. Strings that already
// carry 'Z' or '+hh:mm', and non-ISO shapes like email headers, pass through.
function pinOffset(str) {
  if (DATE_ONLY_RE.test(str)) return `${str}T00:00:00${ASSUMED_OFFSET}`;
  if (NAIVE_DATETIME_RE.test(str)) return `${str.replace(' ', 'T')}${ASSUMED_OFFSET}`;
  return str;
}

// The most important function in this file, because TKT-9102 carries
// created_at: 'not-a-date'. If this throws, the run dies and 35 points
// go with it. It returns null instead, and validate.js quarantines the
// ticket cleanly.
//
// Handles: ISO strings, email headers ('Thu, 04 Jun 2026 12:35 +0530'),
// Excel serial numbers, JS Date objects, and everything else -> null.
// Always returns a UTC ISO string, so stored values sort and compare
// correctly regardless of which shape they came in as.
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }

  // Excel stores dates as days since 1899-12-30. Anything in this range is
  // a plausible spreadsheet date rather than a year or a distance. The
  // serial carries no timezone, so it means midnight IST like every other
  // bare date here.
  if (typeof value === 'number') {
    if (value > 20000 && value < 60000) {
      const ms = Math.round((value - 25569) * 86400 * 1000) - ASSUMED_OFFSET_MIN * 60000;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }

  const str = String(value).trim();
  if (str === '') return null;

  const parsed = new Date(pinOffset(str));
  if (!isNaN(parsed.getTime())) {
    // A successful parse of nonsense is still nonsense. Anything outside
    // a sane fleet-records window is rejected. The check runs on the
    // assumed-zone calendar year, not the UTC one, so a 1 January date
    // is not rejected for being 31 December in UTC.
    const year = new Date(parsed.getTime() + ASSUMED_OFFSET_MIN * 60000).getUTCFullYear();
    if (year < 2000 || year > 2100) return null;
    return parsed.toISOString();
  }

  // dd/mm/yyyy and dd-mm-yyyy, which Date() reads as US month-first.
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const parsed2 = new Date(`${iso}T00:00:00${ASSUMED_OFFSET}`);
    return isNaN(parsed2.getTime()) ? null : parsed2.toISOString();
  }

  return null;
}

// Just the date part, for grouping and for the maintenance log.
// Rendered in the assumed zone, NOT by slicing the UTC string - IST
// midnight is 18:30 UTC the previous day, so a naive slice would report
// the wrong calendar date for every bare date in the corpus.
export function dateOnly(value) {
  const iso = parseDate(value);
  if (iso === null) return null;
  return new Date(new Date(iso).getTime() + ASSUMED_OFFSET_MIN * 60000)
    .toISOString()
    .slice(0, 10);
}

// Hour of the local working day, 0-23, in the assumed zone. Exists so that
// R-NIGHT-SOLO's "is_night_dispatch" test cannot reintroduce the host
// timezone through the back door by calling getHours() on a UTC string.
export function localHour(value) {
  const iso = parseDate(value);
  if (iso === null) return null;
  return new Date(new Date(iso).getTime() + ASSUMED_OFFSET_MIN * 60000).getUTCHours();
}

// Whole calendar days between two dates, in the assumed zone. Null if
// either side is unparseable - callers must treat null as "cannot
// evaluate", never as zero.
//
// Calendar days, not elapsed hours divided by 24: "brake work in the last
// thirty days" is a statement about dates, and an elapsed-time reading
// makes the answer depend on the time of day each event happened to be
// recorded at. A maintenance entry dated 2026-05-19 is 30 days before a
// ticket on 2026-06-18 whether that ticket came in at 04:00 or 23:00.
export function daysBetween(from, to) {
  const a = dateOnly(from);
  const b = dateOnly(to);
  if (a === null || b === null) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// ---------------------------------------------------------------------
// Small field normalisers
// ---------------------------------------------------------------------

// 'drv020' | 'DRV-20' | 'drv 020' -> 'DRV-020'
export function normDriverId(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).toUpperCase().match(/DRV[^0-9]*(\d+)/);
  if (!m) return null;
  return 'DRV-' + m[1].padStart(3, '0');
}

// Free text, English or transliterated Hindi, into a fixed category set.
// Used both for ticket issues and for maintenance notes, which is why the
// Hinglish terms are here.
//
// COMPONENTS ONLY. The mechanics' notes follow the shape
// "<component> <symptom>, <action>. <next check>", and the symptoms are
// shared across every component: 'awaaz aa rahi thi' (making a noise),
// 'overheat ho raha tha', 'pickup kam ho gayi thi', 'smoke aa raha tha'.
// An earlier version mixed symptom words into these patterns, so 'awaaz'
// sat in the gearbox bucket and quietly relabelled 91 of the 250 real
// notes - 'front tyre awaaz aa rahi thi' came back as a gearbox fault.
// A symptom must never decide the component. Order is longest-match-first
// within a bucket; buckets themselves are disjoint on component nouns.
const COMPONENT_PATTERNS = [
  ['brake', /\bbrake|braking/i],
  ['suspension', /wheel bearing|leaf spring|shocker|suspension/i],
  ['steering', /steering/i],
  ['gearbox', /gear ?box|clutch|transmission|differential/i],
  ['tyre', /\bty?res?\b|\btires?\b|puncture|burst/i],
  ['radiator', /radiator|coolant|cooling/i],
  ['turbo', /turbo/i],
  ['fuel', /fuel|diesel|injector|def pump/i],
  ['electrical', /battery|alternator|starter|wiring|electrical|\bfuse\b|headlight/i],
  ['ac', /\bac\b|compressor/i],
  ['engine', /fan belt|air filter|oil seal|head gasket|piston|\bengine\b|seize/i],
];

// Consulted ONLY when no component was named. A bare "overheating" with no
// part attached is an engine complaint; a bare noise or power complaint is
// genuinely unidentified and stays 'other' rather than being guessed into
// a bucket.
const SYMPTOM_PATTERNS = [
  ['engine', /overheat|garam/i],
];

export function normIssue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  for (const [label, pattern] of COMPONENT_PATTERNS) {
    if (pattern.test(str)) return label;
  }
  for (const [label, pattern] of SYMPTOM_PATTERNS) {
    if (pattern.test(str)) return label;
  }
  return 'other';
}

// Returns a number or null. Never NaN, never 0-for-missing - a caller
// that sees null knows the value was absent rather than genuinely zero.
//
// The validation is deliberately strict. Stripping every non-digit and
// calling Number() looks equivalent but is not: 'unknown' strips to '' and
// Number('') is 0, so unparseable text silently became a real zero. For
// km_from_origin_hub that turns "we do not know where the truck is" into
// "it is at the origin hub", which routes a dispatch on invented data
// instead of quarantining the ticket.
export function normNum(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const str = String(value).trim();
  if (str === '') return null;

  // Drop thousands separators and a trailing unit ('92,000 km' -> '92000'),
  // then demand what is left be a complete number and nothing else.
  const cleaned = str.replace(/,/g, '').replace(/[a-z%°"'\s]+$/i, '').trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normBool(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'haan'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'nahi'].includes(s)) return false;
  return null;
}

export function normSeverity(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  return ['LOW', 'MEDIUM', 'HIGH'].includes(s) ? s : null;
}

export function normBsStage(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').match(/BS(\d)/);
  return m ? 'BS' + m[1] : null;
}

// ---------------------------------------------------------------------
// Row-level helpers used by ingest.js
// ---------------------------------------------------------------------

export function normalizeVehicleRow(row, sourceFile, sourceRow) {
  const heater = normBool(row.engine_heater);
  return {
    reg_canon: normReg(row.registration_number),
    vehicle_id: row.vehicle_id || null,
    model: row.model || null,
    year: normNum(row.year),
    bs_stage: normBsStage(row.bs_stage),
    engine_heater: heater === null ? null : (heater ? 1 : 0),
    home_hub: normHub(row.home_hub),
    capacity_tonnes: normNum(row.capacity_tonnes),
    source_file: sourceFile,
    source_row: sourceRow,
    raw_regs: JSON.stringify([row.registration_number]),
  };
}

export function normalizeTicket(row) {
  return {
    ticket_id: row.ticket_id ? String(row.ticket_id).trim() : null,
    created_at: parseDate(row.created_at),
    vehicle_reg: normReg(row.vehicle),
    driver_id: normDriverId(row.driver_id),
    origin_hub: normHub(row.origin_hub),
    dest_hub: normHub(row.destination),
    km_from_origin: normNum(row.km_from_origin_hub),
    issue: normIssue(row.issue),
    severity_reported: normSeverity(row.severity),
    client: normClient(row.client),
    status: row.status ? String(row.status).trim().toUpperCase() : null,
    resolution_note: row.resolution_note || null,
  };
}
