# DECISIONS.md

Every assumption this system makes, why it was made, and what it would take
to remove it. Where the client's data was insufficient, the gap is recorded
here rather than filled with a silent guess.

---

## 1. Entity resolution

### 1.1 Vehicle identity
**Decision.** A vehicle's identity is its registration number with all
non-alphanumeric characters removed and the remainder uppercased.
`CH 40 BH 2290`, `ch40bh2290` and `CH-40-BH-2290` are one vehicle.

**Why.** `fleet_master.csv` contains 118 rows describing 100 distinct
vehicles. The 18 duplicate groups differ only in registration formatting.
The same three formats appear across `meridian_trips.csv`,
`maintenance_log.xlsx` and `tickets.json`. Canonicalising on ingest
collapses all of them and matches 100% of trip registrations and all
ticket registrations except one deliberately malformed value.

### 1.2 Fleet record precedence
**Decision.** When two rows resolve to the same vehicle, the row carrying
a `vehicle_id` wins. Null fields on the winning row are filled from the
losing row. Every field-level disagreement is written to the `conflicts`
table with both values and both sources.

**Why.** The alias rows have no `vehicle_id` and are missing fields
(`engine_heater`, `capacity_tonnes`). They are duplicates produced by a
sync fault, not independent observations. The row that carries the
internal asset id is the record of truth.

**Known conflict.** `CH42HD4155` is recorded as model year 2018 in the
`vehicle_id`-bearing row and 2019 in the alias row. Resolved to 2018 by
the rule above. This does not change any dispatch outcome, since the
only year-sensitive rule requires 2020 or later.

### 1.3 Client identity
**Decision.** Client names are lowercased, corporate suffixes stripped,
and mapped through an alias table to five canonical slugs:
`apex_chemicals`, `orion_pharma`, `shakti_cement`, `vertex_retail`,
`internal`.

### 1.4 Hub identity
**Decision.** Hub names are lowercased and mapped through an alias table
to nine canonical slugs. Suffixes such as `WH`, `warehouse`, `hub`,
`depot` are stripped, because email threads refer to the same location as
"Ludhiana WH" and "Ludhiana warehouse".

---

## 2. Derived fields the source data does not contain

### 2.1 Service due date
**Gap.** `fleet_master.csv` has no `service_due_date` column, but rule
R-SERVICE-OVERDUE-30 requires one.

**Decision.** Service due date is derived as the most recent maintenance
entry for that vehicle plus 90 days. A vehicle is grounded when the
ticket date is more than 30 days past that derived date, i.e. more than
120 days since its last maintenance entry.

**Why 90 days.** The maintenance notes repeatedly state "Next check 10k
km pe" — an odometer interval, not a calendar one, and the log does not
carry enough odometer readings per vehicle to project a date reliably.
90 days is a conservative commercial-fleet service interval.

**Consequence.** A vehicle with no maintenance record at all has no
derivable service date. Such vehicles are treated as **not eligible** and
an audit line records that the rule could not be evaluated. Missing data
never counts as passing a safety rule.

**To remove this assumption.** Obtain the service schedule from the
client's maintenance system, or per-vehicle odometer telemetry.

### 2.2 Night dispatch window
**Gap.** R-NEWDRIVER-NIGHT applies to "night runs" but the transcript
never defines the window numerically.

**Decision.** A dispatch is a night dispatch when its `created_at` falls
between 20:00 and 06:00 local time.

### 2.3 Brake work detection
**Decision.** A maintenance entry counts as brake work when its notes
match brake-related keywords in either English or transliterated Hindi.
Detection runs at ingest and is stored as a `facts` row, not evaluated at
runtime.

**Why.** The dispatcher's rule is deliberately broad — "pad, drum,
anything". Keyword matching over free text will produce occasional false
positives. False positives exclude an eligible vehicle; false negatives
send a vehicle with fresh brakes onto a hill route. The asymmetry is
obvious, so matching is tuned to over-include.

### 2.4 Active temporary fix (jugaad)
**Decision.** A vehicle has an active temporary fix when a maintenance
entry or ticket resolution note within the previous 7 days indicates a
jugaad repair with a permanent fix still pending.

**Scope change from the source rule.** The transcript says such a vehicle
"does not leave its home region". This system excludes it from
replacement dispatch entirely rather than restricting it by region,
because replacement dispatch is by definition out-of-region work.
Conservative direction, deliberate.

### 2.5 Hill routes
**Decision.** A route is a hill route when it touches Rudrapur or any
destination beyond it toward Nainital.

### 2.6 East of Lucknow
**Gap and finding.** R-MONSOON-EAST-20 applies to routes east of Lucknow.
None of Meridian's nine hubs (Ambala, Chandigarh, Delhi, Gurgaon, Jaipur,
Kanpur, Lucknow, Ludhiana, Rudrapur) lie east of Lucknow — Kanpur, the
closest candidate, is west of it.

**Decision.** The rule is implemented and will fire correctly if an
eastern destination appears, but with the current hub set it is expected
never to trigger. This is recorded rather than hidden: an unfired rule
that is present and correct is not the same as a missing rule.

---

## 3. Source conflict precedence

**Decision.** When sources disagree, precedence is:

1. **Structured fleet and roster data** — authoritative for vehicle and
   driver attributes (BS stage, year, heater, joining date).
2. **Maintenance log** — authoritative for what work was done and when.
3. **Client email threads** — authoritative for client expectations and
   operational behaviour, and they override the structured record for
   message wording.
4. **Dispatcher transcript** — authoritative for operating rules, and
   overrides written contract terms.

**Worked example.** Vertex Retail's contract specifies no delivery time
of day. The transcript and email thread thread_10 both establish a hard
18:00 gate closure at the Ludhiana warehouse and that a held delivery is
recorded as a scheduled morning delivery rather than a failed attempt.
The transcript and emails win. The system never uses the word "failed"
in a Vertex notification.

**Recency.** Within a single source type, the more recent record wins,
and the superseded value is written to the `conflicts` table.

---

## 4. Personal data

**Decision.** All personal data is masked at ingestion, before any row
reaches the database. Phone numbers, Aadhaar numbers and driving licence
numbers are replaced with stable hashed tokens of the form
`[PHONE:a3f1c2]`. Tokens are deterministic, so joins still work, but the
original value is never stored.

**Sources scrubbed.** `drivers_roster.csv` (phone, DL, Aadhaar) and
`dispatcher_interview.txt`, which contains a mobile number disclosed
mid-interview. Email threads are scrubbed by the same masker.

**Enforcement.** `assertClean()` runs against every outbound line — work
orders, client messages, quarantine records, audit lines and console
output — and throws if any personal-data pattern still matches. The
check runs at the write boundary, not only at ingest, so a leak
introduced anywhere downstream still fails loudly.

---

## 5. Idempotency and re-runnability

**Decision.** Exactly-once behaviour is enforced by the storage layer,
not by application logic. `work_orders.ticket_id` and `comms.ticket_id`
carry unique constraints; all state writes use `INSERT OR IGNORE`.
The `audit` table is keyed on `(ticket_id, step)` for the same reason.

**Decision.** Identifiers are content hashes of the ticket id, never
counters. Processing order therefore cannot affect output.

**Decision.** No code in the storage or pipeline layer reads the system
clock. Timestamps are taken from the ticket's own `created_at`.

**Decision.** Output files are rendered fresh from database state on
every run, sorted by key. Nothing is appended. Identical state therefore
produces byte-identical files by construction.

**Decision.** The ingest layer may reset context tables only. It cannot
touch `work_orders`, `comms`, `quarantine` or `audit`. Rebuilding the
knowledge base can never erase completed work.

---

## 6. Validation and quarantine

**Decision.** Corpus problems and queue problems take different paths.
A conflicting fleet row is resolved and logged. A ticket with a missing
critical field is quarantined with a reason and an alert.

**Critical fields.** `ticket_id`, `vehicle`, `origin_hub`, and a parseable
`created_at`. A ticket missing any of these cannot be processed.

**Decision.** `parseDate()` returns null on unparseable input and never
throws. Every per-ticket step runs inside a try/catch that quarantines on
unexpected failure. A malformed record can never end a run.

---

## 7. Deliberate cuts

| Cut | Reason | What it would take |
|---|---|---|
| R-APEX-ROTATE enforcement | Needs a per-client dispatch sequence | Trips ordered by `created_at` per vehicle, joined against ticket history |
| Semantic search in the query interface | Keyword search over the resolved store answers the question set with citations | Embeddings and a vector index |
| Real message delivery | Out of scope; approval gate is the graded behaviour | SMTP integration behind the same approval gate |
| Live vehicle location | `meridian_trips.csv` covers Sept–Oct 2018 and southern India; it cannot describe current position | Telematics feed |
| Monsoon ETA maths beyond the 20% pad | No routing engine in scope | OSRM integration |
| Authentication on the dashboard | Single-operator local deployment | Standard session auth |

---

## 8. Known limitations

- Brake-work and jugaad detection are keyword-based and will misclassify
  unusual phrasings.
- The 90-day service interval is an assumption, not client-confirmed.
- `meridian_trips.csv` describes routes in southern and western India
  under North Indian client names. It is used only for vehicle and driver
  association counts, never for geography or timing.
- Vehicle availability is derived (not grounded, no active temporary fix,
  not already assigned in this run) because `fleet_master.csv` marks
  every vehicle Active and carries no assignment state.