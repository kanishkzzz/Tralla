/**
 * scripts/test-rules.js — assertions for lib/rules.js.
 *
 * Plain Node, no test framework: one dependency-free file that prints ok/FAIL
 * per assertion and exits non-zero if any fail. Run with `node scripts/test-rules.js`.
 *
 * Note on context keys: evaluate() looks a rule's `when` key up directly in the
 * context object, so the context key IS the condition key. A rule written
 * `month_in: [10,11,12,1,2]` reads ctx.month_in, holding the integer month.
 * The name reads oddly for a scalar; it is deliberate, and enrich.js must emit
 * it under exactly this name.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRules, matchCondition, evaluate, firstEffect } from '../lib/rules.js';

let failures = 0;

function check(label, actual, expected) {
  const pass = Object.is(actual, expected);
  if (!pass) failures += 1;
  const detail = pass ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail}`);
}

/* ------------------------------------------------------------------ *
 * matchCondition
 * ------------------------------------------------------------------ */

console.log('\n-- matchCondition --');

check('{lte:50} vs 47 matches', matchCondition({ lte: 50 }, 47), true);
check('{lte:50} vs 586 does not match', matchCondition({ lte: 50 }, 586), false);

check('month list vs 5 does not match', matchCondition([11, 12, 1, 2], 5), false);
check('month list vs 12 matches', matchCondition([11, 12, 1, 2], 12), true);

check(
  'hub list vs disjoint route does not match',
  matchCondition(['delhi', 'gurgaon'], ['lucknow', 'ludhiana']),
  false,
);
check(
  'hub list vs overlapping route matches',
  matchCondition(['delhi', 'gurgaon'], ['delhi', 'jaipur']),
  true,
);

// The two that matter most: missing context is never a pass.
check('string spec vs null does not match', matchCondition('BS4', null), false);
check('false spec vs undefined does not match', matchCondition(false, undefined), false);

/* ------------------------------------------------------------------ *
 * evaluate
 * ------------------------------------------------------------------ */

console.log('\n-- evaluate(select_vehicle) --');

// A complete select_vehicle context: every condition key the implemented rules
// for this step can test is present, so nothing lands in `unevaluated`.
const januaryNcrBs4 = {
  month_in: 1,
  client_is: 'vertex_retail',
  km_from_origin: 47,
  route_touches: ['delhi', 'jaipur'],
  route_is_hill: false,
  route_east_of_lucknow: false,
  dest_hub: 'jaipur',
  is_night_dispatch: false,
  driver_months_tenure: 24,
  vehicle_bs_stage: 'BS4',
  vehicle_year: 2021,
  vehicle_has_heater: true,
  vehicle_days_past_service: 4,
  vehicle_brake_work_days: 120,
  vehicle_has_active_jugaad: false,
};

const winter = evaluate('select_vehicle', januaryNcrBs4);
check('January NCR route with a BS4 vehicle is excluded', winter.excluded, true);
check(
  'the exclusion cites R-BS4-NCR-WINTER',
  winter.citations.some((c) => c.rule_id === 'R-BS4-NCR-WINTER'),
  true,
);
check('a fully-populated context leaves nothing unevaluated', winter.unevaluated.length, 0);

// Same vehicle, same route, out of the October-February window.
const may = { ...januaryNcrBs4, month_in: 5 };
const summer = evaluate('select_vehicle', may);
check('the same BS4 vehicle in May is not excluded', summer.excluded, false);
check(
  'R-BS4-NCR-WINTER is not cited in May',
  summer.citations.some((c) => c.rule_id === 'R-BS4-NCR-WINTER'),
  false,
);

/* ------------------------------------------------------------------ *
 * firstEffect — the 50km sourcing rule
 * ------------------------------------------------------------------ */

console.log('\n-- firstEffect(set_source_hub) --');

const near = evaluate('select_vehicle', { ...may, km_from_origin: 47 });
check(
  'within 50km the origin hub sends',
  firstEffect(near, 'set_source_hub').value,
  'origin',
);
check(
  'and the decision is attributable to R-ORIGIN-50KM',
  firstEffect(near, 'set_source_hub').rule_id,
  'R-ORIGIN-50KM',
);

const far = evaluate('select_vehicle', { ...may, km_from_origin: 586 });
check(
  'beyond 50km the nearest hub sends',
  firstEffect(far, 'set_source_hub').value,
  'nearest',
);

check(
  'an effect no rule matched returns null',
  firstEffect(far, 'set_sla_hours'),
  null,
);

/* ------------------------------------------------------------------ *
 * unevaluated — "we could not check" is not "we checked and it is fine"
 * ------------------------------------------------------------------ */

console.log('\n-- unevaluated --');

// A hill route where the vehicle's brake history could not be read. The brake
// rule must not quietly pass; it must be reported as unevaluated.
const hillMissingBrakes = {
  ...may,
  route_touches: ['rudrapur', 'nainital'],
  route_is_hill: true,
  dest_hub: 'nainital',
};
delete hillMissingBrakes.vehicle_brake_work_days;

const hill = evaluate('select_vehicle', hillMissingBrakes);
const brakeEntry = hill.unevaluated.find((u) => u.rule_id === 'R-HILL-BRAKE-30');

check('R-HILL-BRAKE-30 is reported unevaluated', brakeEntry !== undefined, true);
check(
  'and it names the key that was missing',
  brakeEntry === undefined ? null : brakeEntry.missing_keys.join(','),
  'vehicle_brake_work_days',
);
check(
  'R-HILL-BRAKE-30 is not in matched',
  hill.matched.some((m) => m.rule_id === 'R-HILL-BRAKE-30'),
  false,
);
check('an unevaluated safety rule does not exclude on its own', hill.excluded, false);

/* ------------------------------------------------------------------ *
 * Load-time validation
 * ------------------------------------------------------------------ */

console.log('\n-- loadRules validation --');

// Written to the OS temp directory rather than committed, so a deliberately
// broken rulebook never sits next to the real one. Fixed filename, no clock.
const fixturePath = join(tmpdir(), 'meridian-rules-badkey-fixture.yaml');
const fixture = [
  'version: 1',
  'rules:',
  '  - id: R-TYPO-FIXTURE',
  '    name: Rule with a misspelled condition key',
  '    step: select_vehicle',
  '    priority: 100',
  '    when:',
  '      vehicle_bs_stagee: BS4',
  '    then:',
  '      effect: exclude_vehicle',
  '      reason: this rule would never fire',
  '    quote: "fixture"',
  '    implemented: true',
  '',
].join('\n');

writeFileSync(fixturePath, fixture, 'utf8');

let thrownMessage = null;
try {
  loadRules(fixturePath);
} catch (err) {
  thrownMessage = err.message;
}

check('an unknown condition key throws at load time', thrownMessage !== null, true);
check(
  'and the error names the offending rule',
  thrownMessage !== null && thrownMessage.includes('R-TYPO-FIXTURE'),
  true,
);

unlinkSync(fixturePath);

/* ------------------------------------------------------------------ */

console.log(`\n${failures === 0 ? 'all assertions passed' : `${failures} assertion(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
