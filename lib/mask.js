

import { createHash } from 'node:crypto';

const SALT = 'meridian-freight-pii-v1';
const TOKEN_CHARS = 6;


const PATTERNS = [
  
  { kind: 'DL', re: /\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{11}\b/gi },

  
  { kind: 'AADHAAR', re: /(?<![\w-])\d{4}\s\d{4}\s\d{4}(?![\w-])|(?<![\w-])\d{12}(?![\w-])/g },

  // '+91 93118 40522', '+91 8361473242', or a bare Indian mobile.
  {
    kind: 'PHONE',
    re: /\+91[-\s]?\d{5}[-\s]?\d{5}(?![\w-])|\+91[-\s]?\d{10}(?![\w-])|(?<![\w-])[6-9]\d{9}(?![\w-])/g,
  },
];


function canonicalFor(kind, value) {
  const digits = String(value).replace(/\D/g, '');
  if (kind === 'PHONE') return digits.slice(-10);
  if (kind === 'AADHAAR') return digits;
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function token(kind, value) {
  const canonical = canonicalFor(kind, value);
  const digest = createHash('sha256').update(`${SALT}|${kind}|${canonical}`).digest('hex');
  return `[${kind}:${digest.slice(0, TOKEN_CHARS)}]`;
}


function maskColumn(kind, value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  return token(kind, str);
}

export function maskPhone(value) {
  return maskColumn('PHONE', value);
}

export function maskAadhaar(value) {
  return maskColumn('AADHAAR', value);
}

export function maskDL(value) {
  return maskColumn('DL', value);
}


export function maskText(value) {
  if (value === null || value === undefined) return null;
  let out = String(value);
  for (const { kind, re } of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), (match) => token(kind, match));
  }
  return out;
}


export function findPII(value) {
  if (value === null || value === undefined) return [];
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const hits = [];
  for (const { kind, re } of PATTERNS) {
    const scan = new RegExp(re.source, re.flags);
    let m;
    while ((m = scan.exec(str)) !== null) {
      hits.push({ kind, index: m.index, length: m[0].length });
      if (m[0].length === 0) scan.lastIndex++;
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
}


export function assertClean(value, label = 'value') {
  const hits = findPII(value);
  if (hits.length > 0) {
    const summary = hits.map((h) => `${h.kind}@${h.index}`).join(', ');
    throw new Error(
      `PII_LEAK in ${label}: ${hits.length} match(es) [${summary}] - ` +
      `raw values withheld deliberately; mask at ingest, do not scrub here`
    );
  }
  return value;
}
