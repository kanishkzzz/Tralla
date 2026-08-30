
const FIELD_ALIASES = {
  ticket_id: ['ticketid', 'id', 'ticketno', 'ticketnumber', 'ref', 'reference', 'caseid'],
  created_at: ['createdat', 'opened', 'openedat', 'reportedat', 'reported', 'timestamp', 'datetime', 'date', 'raisedat'],
  vehicle: ['vehicle', 'vehiclereg', 'vehicleno', 'vehiclenumber', 'registration', 'registrationnumber', 'reg', 'truck', 'truckno', 'plate'],
  driver_id: ['driverid', 'driver', 'drivercode', 'driverno'],
  origin_hub: ['originhub', 'origin', 'fromhub', 'from', 'sourcehub', 'starthub', 'depot'],
  destination: ['destination', 'dest', 'desthub', 'destinationhub', 'tohub', 'to'],
  km_from_origin_hub: ['kmfromoriginhub', 'kmfromorigin', 'distancekm', 'km', 'distance', 'kms'],
  issue: ['issue', 'fault', 'problem', 'description', 'issuedescription', 'complaint', 'breakdowntype'],
  severity: ['severity', 'priority', 'sev', 'urgency'],
  client: ['client', 'customer', 'clientname', 'customername', 'account'],
  status: ['status', 'state'],
  resolution_note: ['resolutionnote', 'resolution', 'note', 'notes', 'remarks', 'comment'],
};

// Keys a wrapper object might hide the array under.
const ARRAY_WRAPPERS = ['tickets', 'records', 'data', 'items', 'rows', 'queue', 'results'];


const MIN_RECOGNISED_FIELDS = 3;

function canonicalKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-.]/g, '');
}

// Build lookup once: alias -> canonical field.
const ALIAS_TO_FIELD = new Map();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  ALIAS_TO_FIELD.set(canonicalKey(field), field);
  for (const alias of aliases) ALIAS_TO_FIELD.set(alias, field);
}

// Flattens one level of nesting so { vehicle: { registration: 'HR16...' } }
// still finds a registration. Deeper than one level is not a format change,
// it is a different system, and we would rather quarantine than guess.
function flattenOnce(record) {
  const flat = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        // Prefix-free: the inner key is what carries the meaning.
        if (!(inner in flat)) flat[inner] = innerValue;
      }
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

function adaptRecord(record) {
  const flat = flattenOnce(record);
  const out = {};
  const matched = new Set();

  for (const [key, value] of Object.entries(flat)) {
    const field = ALIAS_TO_FIELD.get(canonicalKey(key));
    if (field === undefined) continue;
    // First alias wins, so a record carrying both 'ticket_id' and 'id' keeps
    // the canonical one - FIELD_ALIASES lists the canonical spelling first.
    if (out[field] !== undefined) continue;
    out[field] = value;
    matched.add(field);
  }

  return { record: out, matched };
}

/**
 * Parse and normalise a ticket queue of unknown shape.
 *
 * Returns { records, shape, renamed, fatal }:
 *   records  canonical ticket objects, ready for validate.js
 *   shape    a human description of what was recognised, for the audit
 *   renamed  canonical fields that arrived under a different name
 *   fatal    a reason string when nothing usable could be read; records []
 */
export function adaptQueue(text, sourceLabel = 'queue') {
  if (typeof text !== 'string' || text.trim() === '') {
    return { records: [], shape: null, renamed: [], fatal: 'queue_file_empty' };
  }

  let raw = null;
  let shape = null;

  // 1. A JSON document: an array, or an object wrapping one.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      raw = parsed;
      shape = 'json_array';
    } else if (parsed !== null && typeof parsed === 'object') {
      for (const wrapper of ARRAY_WRAPPERS) {
        if (Array.isArray(parsed[wrapper])) {
          raw = parsed[wrapper];
          shape = `json_object.${wrapper}`;
          break;
        }
      }
      // A single ticket sent unwrapped.
      if (raw === null && Object.keys(parsed).length > 0) {
        raw = [parsed];
        shape = 'json_single_object';
      }
    }
  } catch {
    // Not one JSON document. Try NDJSON before giving up.
  }

  // 2. NDJSON - one JSON object per line.
  if (raw === null) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    const objects = [];
    let allParsed = true;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { allParsed = false; break; }
        objects.push(obj);
      } catch {
        allParsed = false;
        break;
      }
    }
    if (allParsed && objects.length > 0) {
      raw = objects;
      shape = 'ndjson';
    }
  }

  if (raw === null) {
    return {
      records: [],
      shape: null,
      renamed: [],
      fatal: `unrecognised_queue_format (${sourceLabel} is neither a JSON array, a wrapped array, nor NDJSON)`,
    };
  }

  // Records that are not objects at all - a list of bare ids, say - cannot
  // be adapted. They are counted, not silently dropped, so run.js can
  // quarantine them with a reason.
  const records = [];
  const unusable = [];
  const seenFields = new Set();

  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      unusable.push(item);
      continue;
    }
    const { record, matched } = adaptRecord(item);
    for (const f of matched) seenFields.add(f);
    records.push(record);
  }

  if (records.length > 0 && seenFields.size < MIN_RECOGNISED_FIELDS) {
    return {
      records: [],
      shape,
      renamed: [],
      fatal:
        `unrecognised_ticket_fields (${sourceLabel} parsed as ${shape} but only ` +
        `${seenFields.size} known field(s) found: ${[...seenFields].join(', ') || 'none'})`,
    };
  }

  // Which canonical fields arrived under a name we had to translate. This
  // is what the audit line reports, so the format change is visible rather
  // than absorbed silently.
  const renamed = [];
  const firstRaw = raw.find((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  if (firstRaw) {
    const originalKeys = new Set(Object.keys(flattenOnce(firstRaw)).map(canonicalKey));
    for (const field of seenFields) {
      if (!originalKeys.has(canonicalKey(field))) renamed.push(field);
    }
  }

  return {
    records,
    shape,
    renamed: renamed.sort(),
    unusable: unusable.length,
    fatal: null,
  };
}
