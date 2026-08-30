import {
  getVehicle, getAllVehicles, getDriver, getMaintenanceFor, getConflictsFor,
  getTripsFor, getAllFacts, searchFacts, getVehiclesByHub,
} from './db.js';
import { getAllRules, getRuleById } from './rules.js';
import { parseQuestion, buildAnswer } from './query.js';
import { assertClean } from './mask.js';

const CLIENT_RULE_HINTS = {
  shakti_cement: ['R-SHAKTI-36H'],
  orion_pharma: ['R-ORION-NEWEST', 'R-ORION-NO-OVERNIGHT'],
  vertex_retail: ['R-VERTEX-GATE-6PM', 'R-VERTEX-NOT-FAILED'],
  apex_chemicals: ['R-APEX-ROTATE'],
};

export function ask(question) {
  const parsed = parseQuestion(question);

  const vehicles = [];
  const conflicts = [];
  const maintenance = [];
  const trips = [];
  for (const reg of parsed.regs) {
    const v = getVehicle(reg);
    if (v) {
      vehicles.push(v);
      conflicts.push(...getConflictsFor(reg));
      if (parsed.intents.includes('maintenance')) maintenance.push(...getMaintenanceFor(reg));
      if (parsed.intents.includes('trip')) trips.push(...getTripsFor(reg));
    }
  }

  const drivers = [];
  for (const id of parsed.driverIds) {
    const d = getDriver(id);
    if (d) drivers.push(d);
  }

  if (vehicles.length === 0 && parsed.hubs.length > 0 && parsed.intents.includes('vehicle_spec')) {
    for (const hub of parsed.hubs) vehicles.push(...getVehiclesByHub(hub).slice(0, 12));
  }

  const rules = [];
  const seenRules = new Set();
  const addRule = (r) => { if (r && !seenRules.has(r.id)) { seenRules.add(r.id); rules.push(r); } };

  for (const id of parsed.ruleIds) addRule(getRuleById(id));
  for (const client of parsed.clients) {
    for (const id of CLIENT_RULE_HINTS[client] || []) addRule(getRuleById(id));
  }
  if (parsed.intents.includes('rule') || parsed.intents.includes('client_rule')) {
    for (const rule of getAllRules()) {
      const hay = `${rule.id} ${rule.name} ${rule.quote} ${rule.then?.reason || ''}`.toLowerCase();
      if (parsed.keywords.some((k) => hay.includes(k))) addRule(rule);
    }
  }

  const documents = [];
  const seenDocs = new Set();
  const wantDocs = rules.length === 0 && vehicles.length === 0 && drivers.length === 0;
  if (wantDocs || parsed.clients.length > 0) {
    const terms = parsed.clients.length > 0
      ? [...parsed.clients.map((c) => c.split('_')[0]), ...parsed.keywords]
      : parsed.keywords;
    for (const term of terms.slice(0, 6)) {
      for (const f of searchFacts(term)) {
        if (seenDocs.has(f.fact_id)) continue;
        seenDocs.add(f.fact_id);
        documents.push(f);
        if (documents.length >= 4) break;
      }
      if (documents.length >= 4) break;
    }
  }

  const result = buildAnswer(parsed, {
    vehicles, drivers, maintenance, conflicts, documents, rules: rules.slice(0, 6), trips,
  });

  assertClean(result.answer, 'query.answer');
  assertClean(JSON.stringify(result.citations), 'query.citations');

  return { ...result, parsed: { intents: parsed.intents, entities: {
    vehicles: parsed.regs, drivers: parsed.driverIds, clients: parsed.clients,
    hubs: parsed.hubs, rules: parsed.ruleIds,
  } } };
}

export function corpusSize() {
  return { vehicles: getAllVehicles().length, documents: getAllFacts().length, rules: getAllRules().length };
}
