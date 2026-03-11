# Fact Extraction Pipeline

## 1. Problem Statement `[PENDING SKELETON]`

> **"What changes in the world?"**

Today, 3,000+ messages sit in `raw_messages` with `extracted = 0`. They contain
commitments, action items, decisions, status changes, and risks — all invisible to
Reticle. The user discovers missed obligations only when someone follows up or
credibility has already eroded.

After this ships: Reticle reads captured messages, extracts structured facts into
the knowledge graph, and surfaces open commitments and action items before they go
stale. The user sees a daily "open items" section in the digest and gets Crack Finder
alerts for aging commitments — without ever having to manually track what was said.

This is Phase 2 of the org-memory plan (Tasks 6-8) plus the first consumer
(Crack Finder, Task 9). The capture layer (Phase 1) is complete and producing data.

## 2. Non-Goals (minimum 3) `[PENDING SKELETON]`

1. **Not building entity hierarchy or parent relationships.** Initiatives, epics,
   and org-chart structure are deferred. Extraction produces flat entity→fact pairs.
   Why: hierarchy requires a separate design pass and adds complexity without
   unlocking the core value (surfacing stale commitments). This locks in: no
   "roll up action items by initiative" queries until a future increment.

2. **Not building a Slack command interface or interactive to-do management.**
   This is read-only extraction + passive surfacing. No `/reticle todos` command,
   no "mark as done" buttons, no write-back to Slack. Why: the walking skeleton
   needs to prove extraction quality first. Adding interaction before quality is
   validated invests in the wrong layer. This locks in: resolution is manual
   (update the fact in the DB or let Crack Finder nag).

3. **Not extracting from email or meetings.** Only `raw_messages` (Slack + Jira)
   are in scope. Gmail and meeting transcripts are future data sources. Why:
   Slack is where most team coordination happens; email capture doesn't exist yet;
   meeting transcripts are a separate pipeline. This locks in: action items from
   email-only conversations won't surface.

4. **Not building the Weekly Report consumer (Phase 3 Task 11).** The existing
   `dw-weekly-report.js` serves the weekly narrative role for now. The AI-narrated
   replacement depends on validated extraction quality. Deferred to a future increment.

## 3. Riskiest Assumption `[PENDING SKELETON]`

> **"I am betting that Claude Sonnet can reliably extract actionable facts from
> noisy Slack channel messages at a quality level where false positives don't
> erode trust in the system. I will know I'm wrong when manual review of the
> first 7 days of extractions shows >30% of surfaced items are noise (bot chatter
> misidentified as commitments, general discussion classified as action items,
> or duplicate facts from rephrased messages)."**

**Rejected alternative:** Rule-based extraction (keyword matching for "can you",
"TODO", "please", "action item", pattern matching for @-mentions + imperative
verbs). This is buildable in an afternoon — scan messages for patterns, store
matches as facts. Rejected because: indirect asks ("the Okta sync needs attention"),
contextual commitments ("I'll handle that"), and implicit delegation ("your team
should look at this") are the highest-value extraction targets and cannot be captured
by patterns. If Sonnet extraction fails, this is the fallback — but it would miss
the most important signals.

**Per-assumption probes:**

1. *What changes if false?* Switch to a two-stage pipeline: Haiku for noise
   filtering (is this message actionable at all?), then Sonnet only on the
   filtered set. Or fall back to keyword extraction with manual triage. The
   prompt design changes entirely.

2. *How quickly would we discover it?* Within 1-2 days of running extraction.
   The first batch produces facts that can be manually compared against the
   source messages. Fast feedback loop.

3. *Can we test before writing code?* Yes — and we should. Take 20 real messages
   from `raw_messages`, paste them into a Claude conversation with the extraction
   prompt, and evaluate the output. This is the walking skeleton's first task.

## 4. Walking Skeleton `[PENDING SKELETON]`

**What it is:** A script that reads unextracted messages, sends them to Sonnet
in batches, writes extracted facts to the `facts` table, marks messages extracted,
and prints a summary of what it found.

**What it tests:** Whether Sonnet extraction produces useful, accurate facts from
real captured Slack/Jira messages — the riskiest assumption.

**What done looks like:** Run the extractor on 7 days of captured messages. Manually
review 50 extracted facts. At least 70% are genuine commitments, action items,
decisions, or status observations that match what actually happened in the source
messages. Open event facts for the user's own commitments appear and are queryable.

### Skeleton Task 1: Prompt spike (30 min)

Pull 20 representative messages from `raw_messages` (mix of team channel chatter,
DMs, Jira activity, bot messages). Test the extraction prompt manually against
Claude Sonnet. Evaluate: does it correctly identify action items, commitments,
and status changes? Does it ignore noise? Does it return structured output that
maps to the `facts` schema?

Deliverable: A validated prompt and example output. Decision on fact taxonomy
(which attributes to extract).

### Skeleton Task 2: Build the extractor (45 min)

Create `knowledge-extractor.js`:
- Query `raw_messages WHERE extracted = 0` in batches (20-50 messages per API call)
- Send each batch to Sonnet with the validated prompt
- Parse structured output into `upsertFact()` calls
- Mark messages `extracted = 1` via `markExtracted()`
- Pre-extraction backup via `VACUUM INTO`
- Log extraction stats (messages processed, facts created, tokens used)

Test file: `test-knowledge-extractor.js` — unit test the parsing/mapping logic
with canned AI responses (no live API calls in tests).

### Skeleton Task 3: Run, review, surface (30 min)

- Run the extractor on real data
- Query open event facts: `SELECT * FROM facts WHERE fact_type = 'event' AND resolution = 'open'`
- Manually compare against source messages (are these real commitments?)
- Add a "commitments" section to the daily digest collector
- Evaluate: does this actually surface things you would have missed?

**Continuation gate:**
- **Validated** → proceed to Crack Finder (first future increment), deploy
  extractor on launchd schedule
- **Invalidated** → revise the prompt, adjust fact taxonomy, or fall back to
  two-stage Haiku→Sonnet pipeline. Re-run skeleton task 1.

## 5. Proof of Delivery `[PENDING SKELETON]`

> "I will know this is worth continuing when **open event facts extracted from
> this week's messages include at least 3 real commitments I made or received
> that I would not have tracked otherwise** after I build the extractor and run
> it on 7 days of captured messages."

Not "when the extractor runs without errors." Not "when facts appear in the DB."
When real commitments surface that would have otherwise been forgotten.

## 6. Anti-Metrics `[PENDING SKELETON]`

Even if extraction works perfectly, it has **failed** if:

- **More than 5 spurious notifications per week.** If the user dismisses most
  surfaced items as noise, the system erodes trust instead of building it.
  (Axiom 3: speak less than it could.)

- **Extraction cost exceeds $5/day.** At 3,000 messages/week with Sonnet, token
  costs must stay reasonable for a personal tool. If batching doesn't control
  costs, the architecture needs to change.

- **The user stops reading the digest because it's too long.** Extraction should
  surface 3-10 items per day, not 50. If the fact volume overwhelms the signal,
  the extraction threshold is too low.

## 7. Future Increments `[PLACEHOLDER]`

Each increment is addressed after learning from the skeleton. Not designed yet.

1. **Crack Finder** — Pure graph queries for stale commitments (open events older
   than N days), unacted decisions, unmitigated risks. Daily Slack DM. Done when
   it surfaces a real stale commitment before the user remembers it, not when the
   query returns rows.

2. **Fact resolution automation** — Auto-resolve event facts when a follow-up
   message indicates completion ("done", "shipped", "resolved"). Done when manual
   resolution drops by 50%, not when the pattern matcher runs.

3. **Email capture** — Extend `gmail-monitor.js` to write to `raw_messages`.
   Done when email-sourced commitments surface alongside Slack ones, not when
   emails land in the DB.

4. **Meeting transcript extraction** — Feed post-meeting transcripts through
   the same extraction pipeline. Done when meeting action items surface in the
   digest, not when the transcript is parsed.

5. **Interactive resolution** — Slack buttons to mark items done/dismissed.
   Done when the user resolves items from Slack without touching the DB.

---

## Fact Taxonomy (working draft — validated in skeleton task 1)

Based on the existing schema and the org-memory plan:

| Attribute | Fact Type | Example Value | Resolution? |
|-----------|-----------|---------------|-------------|
| `committed_to` | event | "Send UKG report by Friday" | open → completed/abandoned |
| `asked_to` | event | "Review Okta sync config" | open → completed/abandoned |
| `decided` | event | "Use Terraform for IaC" | open → completed/superseded |
| `raised_risk` | event | "SSO migration may break integrations" | open → completed/abandoned |
| `status_update` | state | "Working on Jamf IAM integration" | re-confirmed via last_confirmed_at |
| `role` | state | "Engineering Manager" | re-confirmed via last_confirmed_at |
| `team` | state | "Corporate Systems Engineering" | re-confirmed via last_confirmed_at |

Event facts use the resolution lifecycle. State facts use re-confirmation.
The extractor returns `fact_type` for each extracted fact per the original plan.

## Message Selection Strategy

Not all messages are worth extracting. The extractor filters to:

1. **Messages from humans** — skip bot/service messages (Slackbot, Assist, Okta
   Service, Jellyfish, etc.) based on `author_name` or `author_ext_id` patterns
2. **Messages with substance** — skip short reactions, emoji-only, link-only
   (already filtered at capture time to >=5 chars, but extraction can skip
   further noise)
3. **Batch by thread/channel** — send related messages together so the AI has
   context for who is asking whom to do what

Bot detection heuristic: maintain a `BOT_EXT_IDS` set (populated from the first
extraction review) or check if `author_ext_id` matches known bot patterns.

## Extraction Prompt Architecture

Single-pass Sonnet. Each API call receives a batch of messages from the same
channel or thread, with context:

```
System: You are extracting structured facts from workplace messages for a
knowledge graph. For each message, identify:
- Commitments (someone promises to do something)
- Action items (someone is asked to do something)
- Decisions (a choice is made)
- Risks (a concern is raised about something that could go wrong)
- Status updates (someone reports what they're working on or their role)

For each fact, return:
- entity: the person's name (who the fact is about)
- attribute: one of committed_to, asked_to, decided, raised_risk, status_update, role, team
- value: what specifically (one sentence)
- fact_type: "event" or "state"
- confidence: 0.0-1.0

Skip: greetings, small talk, emoji reactions, bot notifications, messages
that don't contain extractable facts.

Return JSON array. Empty array if no facts found.
```

Batching: 20-50 messages per call, grouped by channel. Thread messages sent
together for context. Estimated cost: ~$0.50-2.00/day at current message volume.
