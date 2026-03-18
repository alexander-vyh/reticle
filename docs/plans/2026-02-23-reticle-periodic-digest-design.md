# Reticle Periodic Digest — Design Document

**Date:** 2026-02-23
**Status:** Approved
**Goal:** Two-tier personal reflection digest (daily light + weekly deep) that surfaces follow-through signals, credibility gaps, and longitudinal patterns using structured collectors with AI narration.

**PRD Reference:** [Reticle PRD](2026-02-23-reticle-prd.md) — Section 8.1 (Periodic Digest)

## Context

Reticle is the product identity for Claudia. The Periodic Digest is the first Reticle surface to be built. It is separate from the team weekly report (weekly-summary-slack), which serves a different audience and purpose.

Claudia already has the data infrastructure: `claudia-db` tracks conversations, emails, O3 sessions, and actions. `gmail-monitor`, `slack-events-monitor`, and `meeting-alert-monitor` populate this data continuously. The digest connects this data to the user through structured reflection.

## Approach: Structured Core + AI Narration

Three layers:

1. **Collectors** (deterministic) — query existing DB and APIs, produce structured items with full explainability metadata
2. **Pattern Detection** (deterministic, weekly only) — compare this week's items against 4-week snapshot history, compute trends
3. **AI Narration** (presentation only) — arrange structured data into readable Slack prose. Cannot add facts or make claims not in the data.

```
LAYER 1: COLLECTORS
  follow-up ──┐
  email ──────┤
  O3/meeting ─┤──▶ DigestItem[]
  calendar ───┘
                      │
                      ▼
LAYER 2: PATTERN DETECTION (weekly only)
  reply latency trend ──┐
  close rate trend ─────┤
  O3 completion rate ───┤──▶ PatternInsight[]
  recurring counterparty┤
  topic deferral ───────┘
                      │
                      ▼
LAYER 3: AI NARRATION
  Daily: Haiku(DigestItem[]) ──▶ Slack DM
  Weekly: Sonnet(DigestItem[] + PatternInsight[]) ──▶ Slack DM
```

## DigestItem Format

Every collector produces items in this uniform shape. The four explainability fields (`observation`, `reason`, `authority`, `consequence`) are mandatory and map to PRD Section 13.

```js
{
  // Identity
  id: "digest-followup-abc123",
  collector: "followup",           // which collector produced this

  // Explainability (PRD Section 13 — all mandatory)
  observation: "Gandalf Grey sent you a DM 26 hours ago that you haven't replied to",
  reason: "Unreplied for >24h. You typically reply to Gandalf within 4 hours.",
  authority: "Auto-capture: hygiene obligation (unreplied DM)",
  consequence: "Will escalate to tomorrow's digest if still unreplied. No enforcement configured.",

  // Source
  sourceUrl: "https://app.slack.com/client/T.../D...",
  sourceType: "slack-dm",

  // Metadata for pattern detection
  category: "unreplied",           // unreplied | awaiting | o3 | meeting-prep | commitment
  priority: "normal",              // low | normal | high | critical
  ageSeconds: 93600,
  counterparty: "Gandalf Grey",

  // Timestamps
  observedAt: 1740300000,          // when the source event happened
  collectedAt: 1740386400          // when this item was generated
}
```

## Collectors

### Follow-up Collector

**Source:** `claudia-db` conversations table

| Category | Query | Priority |
|---|---|---|
| `unreplied` | `state='active', waiting_for='my-response'` | >24h normal, >48h high, >72h critical |
| `awaiting` | `state='active', waiting_for='their-response'` | >3d normal, >7d high |
| `stale` | `state='active', last_activity >7d` | normal |
| `resolved-today` | Resolved or flipped to awaiting today | low (positive signal for patterns) |

### Email Collector

**Source:** `claudia-db` emails + action_log tables

| Category | Query | Priority |
|---|---|---|
| `email-volume` | Count sent/received today | low (context) |
| `vip-unreplied` | VIP senders with unreplied emails | high |
| `commitment` | action_log where actor='user', action='commitment' | normal |

Overlapping unreplied items deduplicated with follow-up collector by `(sourceType, entity_id)` — higher priority wins.

### O3 / Meeting Collector

**Source:** `claudia-db` o3_sessions table + `meeting-cache.json`

| Category | Query | Priority |
|---|---|---|
| `o3-upcoming` | Scheduled for tomorrow (daily) or next week (weekly) | normal |
| `o3-incomplete` | This week's O3s where `lattice_logged = 0` | high |
| `o3-prep-gap` | O3s where `prep_sent_before = 0` and meeting passed | normal |
| `meeting-density` | Meeting count today/this week | low (context) |

### Calendar Collector

**Source:** Google Calendar API via `calendar-auth.js`

| Category | Query | Priority |
|---|---|---|
| `meeting-with-open-followups` | Tomorrow's meetings cross-referenced with open conversations involving same attendees | high |
| `meeting-heavy-day` | Days with >5h meetings | low (context) |
| `recurring-no-agenda` | Recurring meetings user owns without description | normal |

Cross-referencing matches calendar attendee emails against conversation `from_user` fields.

## Pattern Detection (Weekly Only)

### Snapshot Storage

New table in `claudia-db`:

```sql
CREATE TABLE IF NOT EXISTS digest_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  snapshot_date  TEXT NOT NULL,
  cadence        TEXT NOT NULL,        -- 'daily' | 'weekly'
  items          TEXT NOT NULL,        -- JSON array of DigestItem[]
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_digest_date ON digest_snapshots(account_id, snapshot_date);
```

Auto-prune snapshots older than 8 weeks.

### PatternInsight Format

```js
{
  id: "pattern-reply-latency-trending-up",
  type: "trend",               // trend | recurring | anomaly
  observation: "Your average reply time to emails increased from 8h to 14h over the last 3 weeks",
  evidence: {
    thisWeek: { avgReplyHours: 14, sampleSize: 23 },
    lastWeek: { avgReplyHours: 11, sampleSize: 19 },
    threeWeeksAgo: { avgReplyHours: 8, sampleSize: 21 }
  },
  significance: "moderate",    // minor | moderate | notable
  reason: "3-week upward trend in reply latency",
  authority: "Pattern detection: computed from digest snapshots",
  consequence: "Informational. No enforcement configured."
}
```

### Detectors

| Detector | Computation | Significance |
|---|---|---|
| Reply latency trend | Avg age of `unreplied` items at collection, week/week | >25% increase over 3w = moderate; >50% = notable |
| Follow-up close rate | Ratio resolved to total active, week/week | >15% decrease = moderate |
| O3 completion rate | % O3 sessions with `lattice_logged=1`, week/week | <80% for 2+ weeks = moderate |
| Recurring counterparties | People in `unreplied` 3+ times across 2+ weeks | 3 = minor; 5+ = moderate |
| Topic deferral | Conversations in snapshots 3+ consecutive days unresolved | 3d = minor; 5+ = moderate |

All detectors are pure arithmetic. No AI inference.

## AI Narration

### Hard Constraints

1. **Grounding:** Every statement traces to a `DigestItem` or `PatternInsight`. No inferred claims.
2. **Tone (Axiom 6):** Calm, factual, resolution-oriented. No praise, scolding, urgency theater.
3. **Completeness:** All `high`/`critical` items must appear. `low` items may be omitted with count noted.

### Must Never

- Invent connections not in the data
- Assign emotional states
- Use motivational language
- Create urgency beyond the priority field
- Suggest underperformance

### Daily Digest (Haiku)

Input: `DigestItem[]` (5-20 items typical)

Prompt instructs: group by urgency, preserve observation and consequence per item, target 1-2 sentences per item, Slack mrkdwn output. ~$0.02/run.

### Weekly Digest (Sonnet)

Input: `DigestItem[]` (30-80 items) + `PatternInsight[]` (0-5)

Prompt instructs four sections:
1. "This week" — resolved items, commitments kept, meetings completed
2. "Still open" — carried forward, grouped by counterparty
3. "Patterns" — only if insights exist, notable ones lead
4. "Next week" — calendar preview, upcoming O3s, open items with attendees

Sources cited naturally: "(email, Tuesday)" or "(Slack DM, 3 days ago)". ~$0.08/run.

### Fallback

If AI call fails: retry once after 30s. If still failing, send structured items as a plain Slack list (`observation` + `sourceUrl` per item). The data is always persisted to snapshots before narration runs.

## Schedules

| Service | Label | Schedule | Notes |
|---|---|---|---|
| Daily Digest | `ai.claudia.digest-daily` | Weekdays 6:00 PM | Skips Friday if weekly is configured |
| Weekly Digest | `ai.claudia.digest-weekly` | Friday 4:00 PM | Subsumes Friday's daily |

Both use `StartCalendarInterval` (run-once, not persistent). Both also work as standalone CLI.

## Error Handling

| Failure | Behavior |
|---|---|
| DB unavailable | Error DM, no digest |
| Calendar API failure | Calendar collector returns `[]`, others proceed, narration notes gap |
| Single collector throws | Remaining collectors run, narration notes missing source |
| Zero collectors succeed | Error DM, no digest |
| AI narration fails | Fallback to structured item list |
| Output exceeds Slack limit | Split into multiple messages, critical/high first |
| No items | "Nothing requiring attention today." / "Clean week." |
| First run (no history) | Pattern detection skipped: "Collecting baseline." |
| >30 unreplied items (vacation return) | Summarize by count, not individual listing |
| Friday daily/weekly overlap | Daily exits early, weekly covers Friday |

## Files

### New

| File | Purpose |
|---|---|
| `lib/digest-item.js` | DigestItem/PatternInsight constructors, validation, dedup |
| `lib/digest-collectors.js` | Four collector functions returning DigestItem[] |
| `lib/digest-patterns.js` | Five pattern detectors over snapshot history |
| `lib/digest-narration.js` | System prompts, AI calls, fallback formatting |
| `digest-daily.js` | Top-level service: Layer 1 + Layer 3 |
| `digest-weekly.js` | Top-level service: Layer 1 + Layer 2 + Layer 3 |

### Modified

| File | Change |
|---|---|
| `claudia-db.js` | Add `digest_snapshots` table, `saveSnapshot()`, `getSnapshotsForRange()`, `pruneOldSnapshots()` |
| `bin/deploy` | Add 2 plist templates |
| `tray/service-manager.js` | Add both services to SERVICES array |

### Dependencies

No new npm packages. Uses existing `better-sqlite3`, `googleapis`, `@anthropic-ai/sdk`, `pino`.

## Cost

~$0.50/month ($0.02/day weekday Haiku + $0.08/week Sonnet).

## Scope Boundaries

**Not covered by this design:**
- Team weekly report — separate surface, already designed
- Pre-Meeting Brief — future Reticle surface
- Hygiene Reminders retrofit — `followup-checker.js` continues as-is, future retrofit to DigestItem format
- Enforcing state — no items use enforcement
- Auto-capture confirmation UI — all digest items are auto-capture categories
- Slack conversation collector — data model not mature enough, add as fifth collector later
- Meeting transcription collector — recorder not merged yet, plugs into same pipeline when ready

**Reuse path:** The DigestItem format is designed as a system-wide contract. Future Reticle surfaces (Pre-Meeting Brief, Hygiene Reminders retrofit, Priority Interrupt logging) can adopt the same format, gaining explainability for free.
