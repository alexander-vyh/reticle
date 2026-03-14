# Entity Identity Resolution — Deferred Attribution Model

> **Epic:** `reticle-el6`

## 1. Problem Statement `[PENDING SKELETON]`

> **"What changes in the world?"**

Today, the fact extractor creates person entities from name strings at extraction
time — `findOrCreateEntity(db, 'person', "Daniel 'D' Sherr\")`. These entities have
no identity anchor (no `identity_map` entry), no linked raw messages, and no way to
be auto-resolved to a real person later. They accumulate facts permanently attributed
to the wrong identity. The only escape valve is manual merge, which requires the user
to notice the duplicate, find the correct target, and trigger a UI action for each one.

Observed: 2 orphaned Daniel Sherr entities with 24 facts between them. 89 total person
entities, unknown fraction are floating. Every week of extraction adds more.

After this ships: the extractor stores facts with `entity_id = NULL` and a
`mentioned_name` string. A resolution sweep links them to known identities via exact
match on canonical name and display name — **but only to entities that have at least
one `identity_map` entry** (anchored entities). The graph accumulates only anchored
attributions. The floating entity problem stops growing.

## 2. Non-Goals (minimum 3) `[PENDING SKELETON]`

1. **Not building fuzzy or ML-based name matching.** The resolution sweep uses exact
   string matching against `canonical_name` and `identity_map.display_name` only.
   Fuzzy matching risks false attributions on a trust surface — a commitment wrongly
   assigned to the wrong person is worse than no assignment. This locks in: name
   variants that don't exactly match a known identity remain unattributed until manually
   resolved via merge.

2. **Not auto-merging existing duplicate entities.** The ~24 floating facts already in
   the DB are not automatically migrated. Manual merge via the UI is the cleanup path
   for existing orphans. Auto-merge violates the instrument axiom: Reticle shows
   deviation, it does not decide. This locks in: existing floating entities need one
   manual merge session; only new data benefits from deferred attribution.

3. **Not making unattributed facts visible in the UI in this increment.** Facts with
   `entity_id = NULL` will exist in the DB but won't surface in the People tab, digest,
   or Crack Finder until the resolution sweep attributes them. The gap window (capture →
   sweep) is the anti-metric to measure. UI for "needs review" unattributed facts is
   a future increment.

4. **Not ingesting meeting transcripts.** Transcripts have the same identity problem
   (speaker names from diarization) but are a separate pipeline. This design applies
   only to Slack and Jira-sourced facts. Transcript attribution is deferred.

## 3. Riskiest Assumption `[PENDING SKELETON]`

> **"I am betting that exact-match resolution (canonical name + display name) correctly
> attributes facts for the majority of known team members within one sweep cycle, AND
> that the pipeline gap between extraction and sweep is short enough that time-sensitive
> commitments are not missed. I will know I'm wrong when facts for known team members
> remain unattributed more than 24 hours after capture, or when manual review of one
> week of attributed facts shows >20% were linked to the wrong entity."**

**Rejected alternative:** Approach A — pre-check `identity_map.display_name` before
calling `findOrCreateEntity`. Rejected because: (1) entity creation still happens at
extraction time for unmatched names, preserving the structural problem; (2) exact match
still misses name variants like `"Daniel 'D' Sherr"` vs `"Daniel Sherr"`; (3) it cannot
prevent false merges when partial name overlaps exist. Approach B moves the decision
to a later, better-informed sweep with the same matching logic — but without permanently
committing a wrong entity_id at extraction time.

**Per-assumption probes:**

1. *What changes if false?* If exact match attribution rate is too low (facts stay
   unattributed for known people), the sweep needs to expand its matching: add
   `identity_map.display_name` aliases, or tokenized canonical name matching
   (last name alone, first + last without middle). Still no fuzzy — just wider exact
   matching against more known variants.

2. *How quickly would we discover it?* Within 24 hours of running the new extractor.
   The sweep exits non-zero if known display names appear in the unattributed queue
   after a run — this is an immediate, machine-detectable signal. Query:
   `SELECT mentioned_name, COUNT(*) FROM facts WHERE entity_id IS NULL GROUP BY
   mentioned_name` — if known team member names appear here after a sweep, attribution
   is failing.

3. *Can we test before writing code?* Yes — query the current `identity_map` and
   `entities` tables against the names in existing orphaned facts and see what percentage
   would match. Do this now before building. Takes 5 minutes.

## 4. Walking Skeleton `[PENDING SKELETON]`

**What it is:** Modify the extractor to stop creating person entities; add
`mentioned_name` to facts; build and run a resolution sweep with two attribution paths
against identity_map; schedule the sweep on launchd; verify attribution of known team
members on live data.

**What it tests:** Whether exact-match deferred attribution produces correct entity
links for known team members without creating new floating entities, and whether the
pipeline gap is tight enough that time-sensitive commitments are not missed.

**What done looks like:** Run the extractor on one day of new messages, then run the
sweep. Query `facts WHERE entity_id IS NULL` — any remaining unattributed facts show
only genuinely unknown people, not known team members. No new rows in `entities` with
`canonical_name` from AI-extracted text. Known people's facts appear in PersonDetailView.
Sweep exits non-zero if the opposite is true.

**Continuation gate:**
- **Validated** → known team member facts are attributed correctly, pipeline gap is
  acceptable. Proceed to: build anchor indicator in People UI, surface unattributed
  facts as "needs review."
- **Invalidated** → significant known-person facts remain unattributed after sweep.
  Revise matching: expand alias table coverage with additional display name variants,
  or add tokenized name matching as a second pass. Re-run skeleton task 3 before
  proceeding.

### Skeleton Task 1: Schema + extractor change + query audit (60 min)

Add `mentioned_name TEXT` column to `facts` table. Relax the `entity_id` constraint
from `NOT NULL` to nullable. Update the extractor's `storeFacts()` to store
`entity_id = NULL` and `mentioned_name = extractedName` instead of calling
`findOrCreateEntity`. No entity is created from extracted text.

**NFC normalization (two lines, required):** Apply `normalize('NFC')` to
`mentioned_name` before writing it in `storeFacts()`, and to `display_name` before
writing it in `addIdentity()`. Slack and Jira emit non-ASCII display names with
platform-dependent Unicode encoding — visually identical strings that are byte-different
will never match without normalization. This must happen at write time, not at query
time.

**Alias table (prerequisite for sweep, not future increment):** Create table
`entity_aliases (id TEXT PRIMARY KEY, entity_id TEXT REFERENCES entities(id),
alias TEXT NOT NULL, alias_source TEXT NOT NULL)` with a unique index on
`(entity_id, alias)`. Populate it immediately from `identity_map.display_name` for all
existing anchored entities. The sweep uses this table for Path B lookup — it is more
extensible than matching directly against two separate columns, and it becomes the
write target when the review queue's feedback loop ships in a future increment.

**Deduplication fix (critical correctness):** The current `_upsertEventFact` check
uses `WHERE entity_id = ?` to detect duplicates. When `entity_id IS NULL`, this
never matches — every extraction of the same commitment inserts a new row. After the
sweep runs, duplicate facts with the same entity_id will exist for the same commitment.
Fix: when storing with `entity_id = NULL`, check for existing rows on
`(mentioned_name, attribute, value, source_message_id)` before inserting. This ensures
idempotent extraction even before the sweep runs.

**Query audit (required before closing this task):** Enumerate every query in
`gateway.js` and `lib/org-memory-db.js` that touches `facts.entity_id`. Document
which queries assume non-null and update them to filter out null rows or handle null
explicitly. The `JOIN entities e ON f.entity_id = e.id` pattern in `gateway.js` will
silently drop deferred facts until this is done.

Deliverable: Facts table has `mentioned_name`, `entity_id` is nullable. `entity_aliases`
table created and seeded from existing `identity_map.display_name` entries. Extractor
no longer creates person entities. Dedup check fixed for null-entity rows. NFC
normalization applied at all write sites. All fact queries audited and updated. Test:
`test-knowledge-extractor.js` covers the null-entity path, NFC normalization, and
dedup under null entity_id.

### Skeleton Task 2: Resolution sweep embedded in extractor + heartbeat metrics (60 min)

**Embedding over separate process:** Call the resolution sweep logic directly at the
end of each extractor cycle — not as a separate `scripts/resolve-mentioned-names.js`
with its own launchd plist. launchd has no "run after job X" primitive; separate plists
rely on timing assumptions that break under load or clock drift. One process, one plist,
no coordination problem.

The sweep handles **two distinct attribution paths** — they must not be conflated:

**Path A — Author attribution** (facts where the author of the source message is the
subject of the fact): Use `raw_messages.author_ext_id → resolveIdentity()`. This is
an exact lookup by external ID and never produces false matches. Update
`facts.entity_id` directly from the resolved identity.

**Path B — Mention attribution** (facts extracted from text, where a person is named
in the message): For each fact with `entity_id IS NULL`:
1. Exact match on `entity_aliases.alias` (case-insensitive, NFC-normalized) — **only
   against aliases belonging to anchored entities** (entities with at least one
   `identity_map` entry)
2. If matched: `UPDATE facts SET entity_id = ? WHERE id = ?`
3. If unmatched: leave as-is, log the unresolved name

The anchor-only restriction is critical: a floating entity (no identity_map entry)
can share a canonical_name with a real person and produce a false attribution. Only
sweep to anchored entities. The alias table enforces this — aliases are only created
for anchored entities.

**Observable failure signal:** After every sweep run, execute:
```sql
SELECT f.mentioned_name FROM facts f
WHERE f.entity_id IS NULL
  AND EXISTS (
    SELECT 1 FROM entity_aliases ea
    WHERE LOWER(ea.alias) = LOWER(f.mentioned_name)
  )
```
If this returns any rows, the sweep exits non-zero. "Known people remain unattributed"
is a machine-detectable error, not just a log line.

**Vacuous success guard:** If the sweep runs but finds zero `entity_id IS NULL` rows
while the extractor heartbeat shows new messages were processed, emit a warning — this
may indicate an encoding mismatch or migration error that caused facts to be stored with
non-null entity_id (reverting to the old broken state), not genuine full attribution.

**Heartbeat metrics:** After each sweep run, write the following fields to the
extractor's heartbeat file (existing infrastructure, zero new plumbing):
```json
{
  "sweepAvailableNullFacts": 12,
  "sweepPathAMatched": 8,
  "sweepPathBMatched": 3,
  "sweepKnownNamesUnattributed": 0
}
```
`sweepKnownNamesUnattributed > 0` is the machine-readable alarm; the tray app already
reads heartbeats and can surface this directly.

**Idempotency:** The sweep processes `entity_id IS NULL` rows only. It is safe to
re-run on the same dataset. Note: if entities are merged between sweep runs, the
merged entity's facts retain their entity_id — no re-sweep is needed.

Deliverable: Sweep runs at the end of each extractor cycle (no separate plist). Exits
non-zero if known aliases remain unattributed. Heartbeat includes four sweep metrics.
Both attribution paths tested in `test-knowledge-extractor.js`.

### Skeleton Task 3: Run + verify (30 min)

Pre-check (before writing code): query current orphaned fact names against identity_map
to estimate match rate. Then run extractor + sweep on one day of data. Manually inspect
10 attributed facts — do they match the source messages? Check `mentioned_name` for
known team members in the unattributed set — should be empty. Confirm sweep exits 0
on clean run, non-zero on a seeded failure.

## 5. Proof of Delivery `[PENDING SKELETON]`

> "I will know this is worth continuing when **facts for the five most active known team
> members in this week's messages are attributed to the correct entities after one sweep
> cycle**, and **no new rows appear in `entities` with canonical names that look like
> AI-extracted person names** after I build the extractor change and resolution sweep
> and run them on one day of live data, AND **the sweep exits non-zero on a seeded
> known-person attribution failure in CI**."

Not "when tests pass." Not "when the schema migration runs." When real attributed
facts for real people appear in PersonDetailView with no new floating entities created,
and the failure signal works.

## 6. Anti-Metrics `[PENDING SKELETON]`

Even if the sweep runs correctly, it has **failed** if:

- **Known team member facts remain unattributed after the sweep runs.** If people the
  system already knows about (full `identity_map` entries, active Slack/Jira) have
  their commitments sitting in the null-entity queue, the sweep's matching is broken.

- **The pipeline gap exceeds 24 hours for a time-sensitive commitment.** If someone
  commits to something in a message, the extractor captures it, but the sweep doesn't
  run until the next morning — Crack Finder misses it overnight. Acceptable gap: same
  as the extractor's run frequency, not 10x it.

- **Any false attribution occurs.** Wrong entity gets a commitment. Even one case
  undermines the trust surface and is worse than leaving the fact unattributed.

- **The sweep exits 0 on a run where known people remain unattributed.** If the
  failure signal itself is broken, the worst failure mode (silent wrong operation)
  is undetectable from outside.

- **Duplicate facts appear for the same person after sweep runs.** If the same
  commitment appears twice in PersonDetailView after sweep, the null-entity dedup fix
  is missing or broken. Each unique `(source_message_id, attribute, value)` must
  produce exactly one fact row regardless of how many times the extractor and sweep run.

## 7. Future Increments `[PLACEHOLDER]`

Not designed yet. Addressed after learning from the skeleton.

1. **Anchor indicator in People UI** — entities without `identity_map` entries shown
   with a visual indicator (unanchored). Done when the user can distinguish floating
   from anchored entities at a glance without querying the DB.

2. **"Needs review" queue for unattributed facts** — surface facts with `entity_id IS
   NULL` in a dedicated UI section. Done when the user can attribute or dismiss an
   unresolved fact from the app, not when the query returns rows. **Feedback loop
   (required for durability):** When the user confirms an attribution, write the
   confirmed `mentioned_name` back to `entity_aliases` for that entity. When the user
   dismisses a fact, record a negative example to prevent re-surfacing. Without the
   feedback loop, the review queue accumulates the same unresolved names session after
   session and is abandoned after two weeks of use — it becomes a recurring cost with
   no compounding return.

3. **Merge UI: preferred name + identity review** — when merging two entities, show
   both canonical names and all identity badges from each side; let the user choose
   which name survives and which identities to carry forward. Done when merging
   `Daniel 'D' Sherr` into `Daniel Sherr` produces the correct canonical name without
   a follow-up rename step.

4. **Extended matching in resolution sweep** — tokenized last-name + first-name
   matching against known entities as a second pass after exact match fails. Only after
   exact match is validated and the false attribution rate from skeleton is known to be
   zero. Done when the unattributed rate for known people drops below 5%.

5. **Retroactive migration of existing floating entities** — script to migrate facts
   currently on floating entities (`entity_id` set to orphaned entity) to the
   `mentioned_name` model, then re-run the sweep to re-attribute correctly. Done when
   the orphaned Daniel Sherr entities have zero facts and can be deactivated.

---

## Liveness Test

> "Given your riskiest assumption, what happens if it's false and you don't discover
> it for two weeks?"

If exact-match attribution fails for known team members and goes unnoticed for two
weeks: facts accumulate in the null-entity queue undetected. The extractor appears to
run correctly (no errors), the sweep appears to run correctly (no errors), but the
digest and Crack Finder silently omit real commitments because their facts have no
entity_id. The user experiences Reticle as missing things — not broken, just quietly
wrong. This is the worst failure mode for a trust surface.

Mitigation already in the skeleton: the sweep exits non-zero if known display names
appear in the unattributed queue. The launchd plist can wire an alert to a log
aggregator or Slack notification on non-zero exit. "Unattributed facts for known
people: N" where N > 0 is an immediate, machine-detectable alarm — not a log line
the user has to remember to check.
