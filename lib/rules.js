/**
 * lib/rules.js — the dispatcher's rulebook, as a judge.
 *
 * This module answers one question: "which rules match this context, and what
 * do they say?" It returns a verdict. It never filters a vehicle list, never
 * picks a hub, never mutates anything. The pipeline steps act on the verdict.
 * Keeping the judging separate from the acting is what lets a work order cite
 * the exact rule and quote behind every decision.
 *
 * PURITY
 * No database access, no file writes, no console.log, no Date.now(), no
 * new Date(). The one deliberate exception to lib/'s "no file I/O" rule is
 * loadRules(), which reads the YAML rulebook — that read is the module's
 * entire reason to exist, and it is cached so it happens once per path.
 *
 * DETERMINISM
 * Rules are sorted at load time and every verdict array preserves that order,
 * so two runs over the same context emit citations in the same sequence.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/* ------------------------------------------------------------------ *
 * Vocabulary
 *
 * These three lists are the closed vocabulary of the rulebook. Anything in
 * rules.yaml outside them is a typo, and a typo'd condition key is the worst
 * kind of bug here: the rule loads fine and then silently never fires. Every
 * one of these is checked at load time so that failure becomes an error.
 * ------------------------------------------------------------------ */

// Context keys a rule's `when` block may test. enrich.js must produce these.
export const KNOWN_CONDITION_KEYS = [
  'month_in', 'client_is', 'km_from_origin', 'route_touches',
  'route_is_hill', 'route_east_of_lucknow', 'dest_hub', 'is_night_dispatch',
  'driver_months_tenure', 'vehicle_bs_stage', 'vehicle_year', 'vehicle_has_heater',
  'vehicle_days_past_service', 'vehicle_brake_work_days', 'vehicle_has_active_jugaad',
  'vehicle_last_client_incident',
];

// Effects a rule's `then` block may declare.
export const KNOWN_EFFECTS = [
  'exclude_vehicle', 'exclude_driver', 'set_source_hub',
  'set_sla_hours', 'adjust_eta_pct', 'message_constraint',
];

// Pipeline steps a rule may attach to.
export const KNOWN_STEPS = ['classify', 'select_vehicle', 'draft_message', 'assign_driver'];

// Fields every rule must carry. `quote` is required because a decision without
// a transcript citation is not defensible in the walkthrough.
const REQUIRED_FIELDS = ['id', 'step', 'priority', 'when', 'then', 'quote'];

// Numeric comparison operators usable inside a `when` value object.
const OPERATORS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
};

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

// Resolved from this file rather than from process.cwd(), so `node scripts/run.js`
// and the Next.js server both find the same rulebook whatever directory they
// were started in. fileURLToPath keeps this correct on Windows drive paths.
const DEFAULT_RULES_PATH = fileURLToPath(new URL('../rules/rules.yaml', import.meta.url));

// Resolved path -> validated, sorted, frozen rule array. Keyed by path so a
// test fixture cannot evict or masquerade as the real rulebook. A load that
// throws is never cached, so a bad file fails loudly every time it is asked for.
const cache = new Map();

// The rulebook getRules/evaluate consult when no path is given. Set by the last
// successful loadRules(), so loading a fixture switches the module over to it.
let activePath = null;

/**
 * Parse, validate, sort and cache the rulebook. Returns the rule array.
 * Repeat calls with the same path return the cached array without re-reading.
 */
export function loadRules(rulesPath = DEFAULT_RULES_PATH) {
  const resolved = resolvePath(rulesPath);

  const cached = cache.get(resolved);
  if (cached) {
    activePath = resolved;
    return cached;
  }

  const doc = parseYaml(readFileSync(resolved, 'utf8'));
  const rules = Object.freeze(validateAndSort(doc, resolved));

  cache.set(resolved, rules);
  activePath = resolved;
  return rules;
}

function validateAndSort(doc, sourcePath) {
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
    throw new Error(`rules.js: ${sourcePath} has no top-level "rules" array`);
  }

  const seenIds = new Set();

  doc.rules.forEach((rule, index) => {
    // A rule missing its id cannot be named by id, so fall back to its position.
    const label = rule && rule.id ? `rule ${rule.id}` : `rule at rules[${index}] (no id)`;

    if (!isPlainObject(rule)) {
      throw new Error(`rules.js: ${label} in ${sourcePath} is not a mapping`);
    }

    for (const field of REQUIRED_FIELDS) {
      // `when: {}` is legal and means "always matches", so test for absence,
      // not for falsiness — priority 0 and an empty when must both survive.
      if (rule[field] === undefined || rule[field] === null) {
        throw new Error(`rules.js: ${label} is missing required field "${field}"`);
      }
    }

    if (seenIds.has(rule.id)) {
      throw new Error(`rules.js: duplicate rule id ${rule.id} in ${sourcePath}`);
    }
    seenIds.add(rule.id);

    if (!KNOWN_STEPS.includes(rule.step)) {
      throw new Error(
        `rules.js: rule ${rule.id} has unknown step "${rule.step}" ` +
        `(known: ${KNOWN_STEPS.join(', ')})`,
      );
    }

    if (!isPlainObject(rule.when)) {
      throw new Error(`rules.js: rule ${rule.id} has a "when" that is not a mapping`);
    }

    for (const key of Object.keys(rule.when)) {
      if (!KNOWN_CONDITION_KEYS.includes(key)) {
        throw new Error(
          `rules.js: rule ${rule.id} tests unknown condition key "${key}". ` +
          `A key enrich.js never produces would make this rule silently never fire.`,
        );
      }
      // Same reasoning one level down: `{ lte: 50 }` is a comparison, but a
      // typo'd `{ lte_: 50 }` would evaluate to nothing at all. Catch it here.
      const spec = rule.when[key];
      if (isPlainObject(spec)) {
        for (const op of Object.keys(spec)) {
          if (!Object.hasOwn(OPERATORS, op)) {
            throw new Error(
              `rules.js: rule ${rule.id} uses unknown operator "${op}" on "${key}" ` +
              `(known: ${Object.keys(OPERATORS).join(', ')})`,
            );
          }
        }
      }
    }

    if (!isPlainObject(rule.then)) {
      throw new Error(`rules.js: rule ${rule.id} has a "then" that is not a mapping`);
    }

    if (!KNOWN_EFFECTS.includes(rule.then.effect)) {
      throw new Error(
        `rules.js: rule ${rule.id} declares unknown effect "${rule.then.effect}" ` +
        `(known: ${KNOWN_EFFECTS.join(', ')})`,
      );
    }
  });

  // Priority descending, then id ascending. The id tiebreaker is not cosmetic:
  // without it equal-priority rules come back in YAML file order, so moving a
  // rule up the file would reorder the citations printed on a work order and
  // break byte-identical re-runs. Sort on a copy — doc.rules is the parse result.
  return doc.rules
    .slice()
    .sort((a, b) => b.priority - a.priority || compareIds(a.id, b.id));
}

function compareIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// The rulebook currently in force. Loads the default on first use.
function activeRules() {
  return loadRules(activePath === null ? DEFAULT_RULES_PATH : activePath);
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

/**
 * Rules attached to one pipeline step, in sorted order, with unimplemented
 * rules dropped. A rule with no `implemented` key counts as implemented;
 * only an explicit `implemented: false` excludes it.
 */
export function getRules(step) {
  assertKnownStep(step);
  return activeRules().filter((rule) => rule.step === step && rule.implemented !== false);
}

/** One rule by id, including unimplemented ones. null when there is no such rule. */
export function getRuleById(id) {
  const found = activeRules().find((rule) => rule.id === id);
  return found === undefined ? null : found;
}

/** Every rule, sorted, including unimplemented ones — the dashboard shows those too. */
export function getAllRules() {
  // Copy so a caller cannot splice the module-level cache out from under the pipeline.
  return activeRules().slice();
}

// The step vocabulary is closed and checked at load time, so a step that reaches
// here from calling code is a typo. Returning [] would hide it as "no rules matched".
function assertKnownStep(step) {
  if (!KNOWN_STEPS.includes(step)) {
    throw new Error(`rules.js: unknown step "${step}" (known: ${KNOWN_STEPS.join(', ')})`);
  }
}

/* ------------------------------------------------------------------ *
 * Condition matching
 * ------------------------------------------------------------------ */

/**
 * Does one context value satisfy one condition spec?
 * Exported on its own so the matching semantics can be tested without a rulebook.
 */
export function matchCondition(spec, actual) {
  // Missing context never matches. A vehicle whose maintenance history could not
  // be read must not clear a safety check by default — absence of evidence is not
  // evidence of compliance. This single line is also what makes a `false` spec
  // fail against an undefined context rather than quietly comparing false to nothing.
  if (actual === undefined || actual === null) return false;

  if (Array.isArray(spec)) {
    // Set against set: any overlap counts. `route_touches: [delhi, gurgaon...]`
    // against a route of ['delhi','jaipur'] is a hit. Both sides are canonical
    // slugs from normalize.js, so membership is compared exactly.
    if (Array.isArray(actual)) return spec.some((candidate) => actual.includes(candidate));
    // Set against scalar: membership. `month_in: [10,11,12,1,2]` against month 1.
    return spec.includes(actual);
  }

  if (isPlainObject(spec)) {
    // Numeric comparison. Every operator in the object must hold, so
    // `{ gte: 10, lt: 30 }` is a range.
    const actualNum = Number(actual);
    return Object.entries(spec).every(([op, bound]) => {
      const compare = OPERATORS[op];
      if (compare === undefined) return false; // load-time validation should have caught this
      const boundNum = Number(bound);
      // Non-numeric on either side is not a comparison we can make. Refusing it
      // keeps a stray string out of a safety threshold via JS coercion.
      if (Number.isNaN(actualNum) || Number.isNaN(boundNum)) return false;
      return compare(actualNum, boundNum);
    });
  }

  if (typeof spec === 'boolean') {
    // Strict, so `vehicle_has_heater: false` matches only a context that actually
    // says false — never one that merely failed to mention it.
    return spec === actual;
  }

  // Plain equality, case-insensitive between two strings so a rulebook written
  // as `BS4` still matches a context carrying 'bs4'.
  if (typeof spec === 'string' && typeof actual === 'string') {
    return spec.toLowerCase() === actual.toLowerCase();
  }
  return spec === actual;
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/**
 * Judge one context against the rules for one step.
 *
 * Returns:
 *   matched            [{ rule_id, name, effect, value, reason, quote, priority }]
 *   excluded           true if any matched effect is an exclusion
 *   exclusion_reasons  [{ rule_id, reason, quote }]
 *   citations          [{ rule_id, quote }]
 *   unevaluated        [{ rule_id, missing_keys: [] }]
 *
 * Every array is in sorted rule order (priority descending, id ascending).
 */
export function evaluate(step, ctx) {
  const context = isPlainObject(ctx) ? ctx : {};

  const matched = [];
  const exclusion_reasons = [];
  const citations = [];
  const unevaluated = [];

  for (const rule of getRules(step)) {
    const keys = Object.keys(rule.when);

    // "We checked and it's fine" and "we couldn't check" are different outcomes,
    // and the verdict has to tell them apart — a rule that could not be evaluated
    // gets an audit line saying so, a rule that simply did not apply gets nothing.
    //
    // Any absent or null key puts the rule in `unevaluated`, even when another
    // key would have ruled it out anyway. That over-reports slightly and is the
    // deliberate direction: an enrich.js gap should surface in the audit rather
    // than be masked by an unrelated condition that happened to fail first.
    const missing_keys = keys.filter(
      (key) => context[key] === undefined || context[key] === null,
    );
    if (missing_keys.length > 0) {
      unevaluated.push({ rule_id: rule.id, missing_keys });
      continue;
    }

    // An empty `when` has no keys, so `every` is vacuously true — it always matches.
    const fires = keys.every((key) => matchCondition(rule.when[key], context[key]));
    if (!fires) continue;

    const effect = rule.then.effect;
    matched.push({
      rule_id: rule.id,
      name: rule.name === undefined ? null : rule.name,
      effect,
      value: rule.then.value === undefined ? null : rule.then.value,
      reason: rule.then.reason === undefined ? null : rule.then.reason,
      quote: rule.quote,
      priority: rule.priority,
    });

    citations.push({ rule_id: rule.id, quote: rule.quote });

    if (effect.startsWith('exclude_')) {
      exclusion_reasons.push({
        rule_id: rule.id,
        reason: rule.then.reason === undefined ? null : rule.then.reason,
        quote: rule.quote,
      });
    }
  }

  return {
    matched,
    excluded: exclusion_reasons.length > 0,
    exclusion_reasons,
    citations,
    unevaluated,
  };
}

/**
 * The winning value for a singleton effect, or null.
 *
 * set_source_hub, set_sla_hours and adjust_eta_pct can only have one answer, and
 * `matched` is priority-sorted, so the first match is the winner by construction.
 * exclude_vehicle, exclude_driver and message_constraint accumulate instead —
 * callers read verdict.matched for those and take all of them.
 */
export function firstEffect(verdict, effectName) {
  const matches = verdict && Array.isArray(verdict.matched) ? verdict.matched : [];
  const winner = matches.find((entry) => entry.effect === effectName);
  if (winner === undefined) return null;
  return { value: winner.value, rule_id: winner.rule_id, quote: winner.quote };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// A mapping, not an array and not null — YAML gives us all three as 'object'.
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
