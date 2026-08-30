# Meridian Freight — breakdown-to-resolution

Unattended pipeline: a breakdown ticket queue in, work orders and
approval-gated client messages out, with an audit trail for every decision
and no personal data anywhere in the output.

## One command

```bash
npm install && npm run setup
```

`setup` ingests the corpus and processes the queue. Node 22+, no database
server, no accounts, no network. `better-sqlite3` ships a prebuilt binary
for Windows, macOS and Linux, so there is no compiler step.

Then, to see it prove itself:

```bash
npm run verify          # 14 checks, including running the whole pipeline twice
```

## Commands

| Command | What it does |
|---|---|
| `npm run ingest` | Corpus → context tables. Masks personal data on the way in. Re-runnable. |
| `npm run run` | Ticket queue → work orders, drafted messages, quarantine, audit. Re-runnable. |
| `npm run run -- path/to/queue.json` | Same, against a different queue file. |
| `npm run approve` | The human gate. Interactive; `-- --all --by "Name"` for batch. |
| `npm run verify` | Proves idempotency, exactly-once, reconciliation and the PII gate. |
| `npm run verify -- --fresh` | Same, from a deleted database — the clean-machine path. |

## Outputs

| File | Contents |
|---|---|
| `outputs/work_orders.jsonl` | One per unique valid ticket, with citations to rules and source rows |
| `outputs/comms_pending.jsonl` | Drafted messages awaiting approval, with full approver context |
| `outputs/comms_sent.jsonl` | Written only after a human approves |
| `outputs/quarantine.jsonl` | Broken records, one row per reason |
| `audit/audit.jsonl` | One line per step per ticket: what was decided, on what data, under which rule |

All five are rendered fresh from database state on every run and sorted by
key, so identical state produces byte-identical files.

## How it is put together

```
data/              client files, read-only
rules/rules.yaml   the dispatcher's operating rules, each with his own words
lib/               db.js normalize.js mask.js rules.js adapt.js render.js xlsx.js
lib/pipeline/      validate enrich classify select workorder comms
scripts/           ingest.js run.js approve.js verify.js init-db.js
DECISIONS.md       every assumption, precedence rule and deliberate cut
```

`scripts/` does all file and database I/O. Everything in `lib/` except
`db.js` is pure — arguments in, values out. All SQL lives behind named
functions in `db.js`. Business rules live in `rules.yaml`, never as
`if` statements in code.

## The four properties it is built to hold

**Exactly once.** `work_orders.ticket_id` and `comms.ticket_id` carry unique
constraints and every state write is `INSERT OR IGNORE`. Duplicate queue
records and whole re-runs both become no-ops in the storage layer rather
than in application logic.

**Byte-identical re-runs.** No code reads the system clock — every timestamp
comes from the ticket's own `created_at`, ids are content hashes rather than
counters, every query carries an explicit `ORDER BY`, and timestamps without
a timezone are pinned to IST rather than to the host. The one deliberate
exception is the approval timestamp, which is a real fact about a human
action and cannot drift because approval is guarded on `status = 'pending'`.

**Nothing dropped, nothing crashed.** Every ticket runs in its own
try/catch. Broken records are quarantined with one row per reason and an
alert on stderr. An unreadable queue file refuses to run rather than
rendering empty outputs over good ones.

**No personal data, anywhere.** Masked at ingestion into stable tokens
(`[PHONE:a3f1c2]`) so joins still work; `assertClean()` runs at every write
boundary and throws rather than scrubbing, so an upstream gap fails loudly
instead of leaking quietly.

## Format changes

`lib/adapt.js` reads a JSON array, an object wrapping one, or NDJSON, and
translates renamed fields (`id`, `truck`, `distance_km`, `customer`…) onto
the canonical shape. A recognised change raises
`ALERT queue_format_changed` naming the translated fields. A shape it does
not recognise is refused outright — a half-read file that looks valid is
worse than one that stops.

## Known gaps

Recorded in full in `DECISIONS.md` §7. The three worth stating up front:
nearest-hub selection beyond 50 km is not implemented because the corpus
contains no inter-hub distances (the pipeline falls back to the origin hub
and flags for review); `R-APEX-ROTATE` is encoded but not enforced; and
severity is carried from the ticket rather than derived, because the
transcript encodes no severity rule and inventing one in code is exactly
the guesswork the rulebook exists to prevent.
