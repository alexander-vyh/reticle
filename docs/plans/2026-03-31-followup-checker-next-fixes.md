# Follow-up Checker: Next Fixes (Post-PR #32)

Date: 2026-03-31
Status: Pending — product decisions needed before implementation

## Background

PR #32 fixed the mechanical bugs (escalation suppression, log bloat, duplicate
queries). What remains are two architectural changes that affect what the tool
surfaces and how. These came out of a 5-expert audit (ops, lean, attention,
UX, behavioral psychology) — full analysis was done in the session that
produced PR #32.

---

## Fix #4: Relevance Gate (Awareness vs Obligation Classification)

### The Problem

Every Slack channel mention is treated as a "conversation needing follow-up."
In 48 hours: 2,944 unique conversations tracked, but only ~60 actual messages
directed at the user. The remaining ~2,880 are channel mentions where the user
happened to be @mentioned — many are `@here` or `@channel` broadcasts, FYI
threads, or resolved conversations.

The system cannot distinguish:
- "@alex please review this PR" (obligation — needs action)
- "@here the deploy is done" (awareness — no action needed)
- Thread continued after the user's last message (maybe needs re-engagement)

### What the Experts Said

**UX:** "The system outsourced filtering to the user. The PRD axiom 'silence
is success' requires filtering *inside* the tool."

**Attention:** "Not every conversation that hasn't been replied to is a
follow-up obligation. The classifier must distinguish commitments from noise."

**Behavioral:** "A Slack mention in a noisy channel carries the same weight
as a broken commitment to a direct report."

### Design Considerations

1. **Where to classify:** At ingestion (in `slack-events-monitor.js` when the
   mention arrives) or at notification time (in `followup-checker.js` when
   building the batch). Ingestion-time is better — avoids accumulating noise
   in the conversations table.

2. **Classification signals:**
   - Message content: direct question vs announcement vs FYI
   - Channel type: DM (high signal) vs group DM vs public channel
   - Sender relationship: direct report > peer > unknown
   - @mention type: personal `@alex` vs `@here`/`@channel`
   - Thread context: is the user already in this thread?

3. **Output categories:**
   - `obligation` — someone is waiting on the user specifically. Track + notify.
   - `awareness` — user was mentioned but no action required. Log but don't
     notify. Available on pull (daily digest ambient section, query).
   - `skip` — broadcast mentions, bot messages, etc. Don't track at all.

4. **Implementation options:**
   - Rule-based: `@here` → skip, DM → obligation, channel mention → awareness
     unless it contains a question directed at the user
   - AI-assisted: Use Claude to classify on ingestion (adds latency + cost)
   - Hybrid: Rule-based fast path, AI for ambiguous cases

5. **The `lib/reticle-agent.js` and obligation classifier** already exist as
   untracked files in the repo. Check if they have relevant classification
   logic that can be reused.

### Files to Modify

- `slack-events-monitor.js` — add classification at mention ingestion
- `reticle-db.js` — possibly add `obligation_type` column to conversations
- `followup-checker.js` — filter by obligation_type when building batches
- `lib/ai.js` — if using AI classification

### Estimated Effort

Rule-based: half a day. AI-hybrid: 1-2 days. Needs a product decision on
where to draw the line between obligation and awareness.

---

## Fix #5: Daily Digest Cap (5-15 Actionable Items)

### The Problem

The daily digest currently includes ALL pending conversations — 2,573 items
on March 30. The Slack message shows 5 items per category with "...and N more"
truncation. The digest is functionally unreadable and has a read rate of
effectively zero.

### What the Experts Said

**Attention:** "A daily digest should fit in a 2-minute read. 5-15 items, each
pre-filtered to the threshold of 'actionable, time-sensitive, and not already
known.' 2,573 items means the filtering logic is not filtering — it is logging."

**Behavioral:** "Duhigg's habit loop requires a satisfying reward at the close
of the routine. What reward does this user get after opening the daily digest?
More items. Without reward, the cue begins triggering avoidance."

**Lean:** "The tool is faithfully tracking an impossible load. A WIP limit of
20-30 actionable items is sustainable; 2,500 is a queue that will never drain."

### Design Considerations

1. **Hard cap vs smart ranking:** A hard cap of 15 items forces a ranking
   algorithm. The ranking should consider:
   - Relationship weight (direct report > peer > unknown)
   - Staleness (older = more urgent, up to a point)
   - Commitment signal (did the user promise something?)
   - Channel type (DM > group DM > channel mention)

2. **What happens to items below the cap?** They should NOT be lost. Options:
   - Available via pull ("show me everything") but not pushed
   - Ambient count: "...and 47 other items in your backlog"
   - Tiered: top 5 with details, next 10 as one-liners, rest as count

3. **Dependency on Fix #4:** If the relevance gate works well, the pending
   count drops dramatically and the cap may be less necessary. But the cap
   is a good safety net regardless — even with perfect classification, a
   leader with 20 real obligations should see the top 5-10, not all 20.

4. **The `buildDailyDigest()` function** (followup-checker.js line 123-188)
   already truncates display to 5 items per type with "...and N more." The
   change is to truncate the INPUT, not just the display — and rank before
   truncating.

5. **Interaction with `lib/digest-narration.js`:** The daily digest service
   (`digest-daily.js`) uses AI narration. If the follow-up checker's digest
   is capped, the daily digest narration should reference the same capped
   set for consistency.

### Files to Modify

- `followup-checker.js` — `buildDailyDigest()` and `check4Hour()` to rank
  and cap
- `reticle-db.js` — possibly add ranking query (or rank in-memory)
- `lib/people-store.js` — may need relationship weight for ranking

### Estimated Effort

Basic cap with simple ranking (staleness + type): 2-3 hours.
Relationship-weighted ranking: half a day (needs people-store integration).

---

## Recommended Sequence

1. **Fix #4 first** — the relevance gate at ingestion. This reduces the
   pending count from ~2,500 to maybe ~50-200. Most channel mentions become
   awareness-only and stop cluttering the notification pipeline.

2. **Fix #5 second** — the digest cap. With the relevance gate in place,
   the cap is a safety net on a much smaller set. The ranking algorithm
   becomes more meaningful when it's choosing between 50 real obligations
   rather than 2,500 noise items.

## Expert Reports (for reference)

The full expert analysis was conducted in-session on 2026-03-31. Key findings
by expert:

- **Ops Excellence (1/5):** System runs 96x/day, hasn't produced primary output
  (escalation) in 3 weeks. "A very busy do-nothing."
- **Lean Advisor:** Identified escalation suppression bug in code. 89/96 daily
  polls produce nothing visible. Growing volume is a resolution mechanics
  problem, not a notification problem.
- **Attention Coach (1.4/10):** Stage 3 alert fatigue. 2,573-item digest has
  zero read rate. "2,500 is not information. It is anxiety."
- **UX Researcher:** "The system outsourced filtering to the user." User asking
  "how many things mentioned me?" proves tool failed to transfer awareness.
- **Behavioral Psychologist:** Self-efficacy collapse. Tool generating opposite
  of intended effect. "Built as a logging system that learned to notify. Needs
  to be rebuilt as a prioritization engine that happens to log."
