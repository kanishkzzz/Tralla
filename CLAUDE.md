@AGENTS.md
Meridian Freight pipeline — structure

Next.js, plain JavaScript, ES modules ("type": "module"). better-sqlite3 (synchronous — never add async/await to db code), yaml, zod. No TypeScript, no ORM. Windows dev machine.

Layout
data/            raw client files, read-only, never written to
rules/rules.yaml the dispatcher's operating rules
lib/             db.js, normalize.js, mask.js, rules.js, adapt.js, render.js
lib/pipeline/    validate.js, enrich.js, classify.js, select.js,
                 workorder.js, comms.js
scripts/         ingest.js (run once), run.js (run many times)
app/             Next.js dashboard: queue, approvals, audit, ask
outputs/         generated jsonl, gitignored
audit/           generated jsonl, gitignored
DECISIONS.md     assumptions and precedence rules
What lives where
scripts/ingest.js loads the corpus into context tables. scripts/run.js processes the ticket queue into state tables. They share lib/, never each other.
Everything in lib/ except db.js is pure: takes arguments, returns values. No file I/O, no DB access, no console.log.
All SQL lives in lib/db.js behind named functions. Nothing else writes SQL — not the pipeline, not the Next.js pages.
Business rules live in rules/rules.yaml, never as if statements in code.
normalize.js only canonicalises values. It never decides validity — that is validate.js alone.
Pipeline steps return { result, audit[] }. The orchestrator in run.js writes the audit lines; steps don't write to the DB themselves.
Geography constants (hub lists, NCR, hill routes) live in normalize.js and are imported, never redefined.
Conventions
Reads return null for a missing single, [] for an empty list. Never undefined, never throw.
Parsers return null on bad input rather than throwing.
Ids: work orders WO-<first 12 of sha256(ticket_id)>, messages MSG-<same>.
Every list query carries an explicit ORDER BY.
No Date.now(), new Date(), uuid, or counters anywhere in lib/ or scripts/.
When writing code here

Comment non-obvious choices — this code gets defended line by line in a live walkthrough. Boring and readable over clever. No new dependencies without saying why. Touch only the files the task names.