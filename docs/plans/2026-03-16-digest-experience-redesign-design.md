# Digest Experience Redesign — Design Document

**Date:** 2026-03-16
**Status:** Draft (revised after spike + 7-agent review)
**Goal:** Wire new data sources and Monday Morning Meeting narration into the existing weekly digest pipeline so the Slack delivery becomes a usable weekly summary draft, replacing 30-60 minutes of manual assembly.

**PRD Reference:** [Reticle PRD](2026-02-23-reticle-prd.md) — Section 8.1 (Periodic Digest)
**Extends:** [Periodic Digest Design](2026-02-23-reticle-periodic-digest-design.md). Adds new collectors and a second narration path. Existing collection pipeline unchanged.

## 1. Problem Statement [PENDING SKELETON]

> **"What changes in the world?"**

The user produces a Engineering section for the Monday Morning Meeting notes every week by 7 AM Monday. Today this takes 30-60 minutes of manual archaeology: digging through Slack team channels, Jira resolved tickets, calendar, and memory to reconstruct what each of three sub-teams accomplished. By Friday the user is too drained to do this, so it defers to Sunday evening.

The weekly digest pipeline already collects 809 items from followups, email, O3s, and calendar. But this data is oriented around the user's personal follow-through — not team capability advancement. The digest delivers a raw Slack DM that cannot be used as source material for the Monday notes.

Observable change after this work: the user triggers the weekly digest (manually or scheduled). The Slack DM arrives as a structured Monday Morning Meeting notes draft in the correct format — Executive Summary, Infrastructure, Support, Platform sections with capability bullets and hiring status. The user reviews, makes minor edits, and pastes it into Confluence. Total active time: 10-15 minutes of genuine review (not 5 — the synthesis has cognitive value).

## 2. Non-Goals (minimum 3) [PENDING SKELETON]

### 2.1 — We are not replacing the existing collection pipeline

The four existing collectors (followup, email, O3, calendar) and five pattern detectors are unchanged. We add new data sources alongside them in `digest-weekly.js`, not instead of them. The daily digest is untouched.

**Why:** The existing pipeline provides "is anything broken?" signal. The new sources provide "what capability advanced?" signal. These are different questions for different sections of the output. **What this locks in:** Two narration paths coexist in `digest-weekly.js` — the existing `narrateWeekly()` for the reflection digest and the new `narrateWeeklySummary()` for the Monday notes. The weekly delivery includes both (or replaces the old one once validated).

### 2.2 — We are not auto-sending the summary

The digest produces a draft delivered to Slack. The user reviews, edits, and sends it themselves. Reticle does not post to Confluence or any other channel on the user's behalf.

**Why:** Axiom 5 (dismissal always possible) and the instrument philosophy. A weekly summary carries the user's voice and credibility. **What this locks in:** The output is always a draft, never a sent message.

### 2.3 — We are not building a SwiftUI Digest tab yet

The first iteration delivers the draft via Slack — the existing delivery channel. A Digest tab in the management window is a future increment, built only after the pipeline proves useful over 2+ weeks of real use.

**Why:** Every agent review converged on this: validate through the existing system before building new UI. The gateway endpoint (`GET /api/digest/latest`) already exists for when the UI is warranted. **What this locks in:** No Swift work in the skeleton. The Slack DM is the primary surface until trust is established.

### 2.4 — We are not building configurable cadence

The existing schedule (Friday 4 PM) plus the manual "Run Now" tray action covers the Sunday evening use case. No schedule configuration UI.

**Why:** The user's Sunday manual trigger already works. **What this locks in:** Cadence is a deploy config change (moving the launchd schedule to Sunday evening), not a feature.

## 3. Riskiest Assumption [PENDING SKELETON]

> **"I am betting that Slack team channel messages + Jira resolved tickets + Confluence pages + existing digest collectors, curated and narrated with the Monday Morning Meeting style guide, will produce a draft the user would send with 10-15 minutes of editing. I will know I'm wrong when the user consistently rewrites more than half the draft."**

### What the spike showed

The spike gathered live data from all sources for March 10-14 and ran it through AI narration. Results:

- **Structure:** Perfect — all 5 section headings matched the actual notes
- **Coverage:** ~75% — infrastructure automation work, drift detection, interviews all captured. Missed: vendor SSO integration (Jira ticket not in fixture), naming convention decision (only the problem was in Slack, not the resolution), Platform hiring update (previous notes only)
- **Verbosity:** 2x too long — AI included KTLO items (access provisioning, Slack channel management, storage metrics) that the style explicitly excludes
- **Root cause of verbosity:** Curation failure, not prompt failure. KTLO items were passed to the AI; the AI included them despite "exclude KTLO" instructions. The fix: strip KTLO categories before the AI call, not in the prompt.

### What this means for the assumption

The data is sufficient. The intelligence gap is editorial judgment — knowing what to omit. The curation engine must strip access provisioning, hardware tickets, Slack admin work, and routine onboarding/offboarding before the narration prompt ever sees them. With that stripping, the narration's job becomes: synthesize capability signals into the notes vocabulary. That's a tractable prompt problem.

**Embedded alternative (rejected):** Structured checklist — curated signals the user confirms/rejects, then AI assembles prose from approved items. Five of seven review agents suggested this as lower-risk. Rejected for the skeleton because: the pipeline already produces narrated output, the checklist requires a new interaction model and UI, and the riskiest assumption (data sufficiency) is testable without building the checklist. If the full draft fails validation, the checklist becomes Increment 1.

**Per-assumption probes:**

1. **What changes if false?** If the draft requires >50% rewriting, the narration approach is wrong. Fall back to delivering curated signals (team-attributed, KTLO-stripped) as a structured Slack message the user writes from. This still saves 15-20 minutes of archaeology.

2. **How quickly would we discover it's false?** First use — Sunday evening. The user either sends the draft with minor edits or doesn't.

3. **Can we test before writing code?** Already tested in the spike. The code changes are: add collectors, wire curation, swap narration prompt. Small delta from what exists.

### Liveness Test

> If the assumption is false and we don't discover it for two weeks?

Two weeks of drafts the user mostly rewrites. Cost: ~30 minutes of editing overhead each week (reading a bad draft + rewriting vs. starting from scratch). Moderate but not catastrophic — the Slack delivery is additive; the user can ignore it and do manual assembly.

## 4. Walking Skeleton [PENDING SKELETON]

> **What it is:** New data collectors (Slack team channels, Jira resolved, Confluence) wired into `digest-weekly.js`, feeding the curation engine and Monday Morning Meeting narration prompt. Output delivered via Slack DM in the notes format.

> **What it tests:** Whether the curated, narrated output is a draft the user would send.

> **What done looks like:** The user runs the weekly digest Sunday evening. A Slack DM arrives containing a structured Monday Morning Meeting notes draft. The user reads it, makes 3-5 edits, copies it to Confluence. Total: 10-15 minutes.

### Task 1: Slack team channel collector (~45 min)

Add `collectSlackTeamChannels(weekStart, weekEnd)` that:
- Reads messages from team channels (#eng-infra, #project-automation, #eng-general, #eng-platform) via `lib/slack-reader.js`
- Filters for messages from team members (using `monitored_people` team mapping from DB, not hardcoded)
- Strips trivial messages (emoji-only, "ok", "thanks")
- Returns `[{ author, authorTeam, channel, date, content }]`

### Task 2: Jira resolved collector (~45 min)

Add `collectJiraResolved(weekStart, weekEnd)` that:
- Queries `project in (ENG, ENGSUP) AND resolved >= weekStart AND resolved <= weekEnd` via Jira API
- Maps assignees to teams using `monitored_people`
- Classifies each ticket: capability-advancement vs KTLO (access provisioning, hardware, routine onboarding = KTLO)
- Returns `[{ key, summary, assignee, team, category }]` with KTLO tickets excluded

### Task 3: Wire curation + narration into digest-weekly.js (~60 min)

In `digest-weekly.js`, after the existing collector phase:
1. Call the new Slack and Jira collectors
2. Fetch previous week's notes from Confluence (canonical continuity reference) or fall back to `digest_snapshots.narration`
3. Pass all sources to `curateForWeeklySummary()` (already built — make `TEAMS` dynamic from `monitored_people` instead of hardcoded)
4. Pass curated data + previous notes to `narrateWeeklySummary()` (already built)
5. Deliver the summary draft as the weekly Slack DM (replacing or alongside the existing digest output)
6. Store curated items and narration text in `digest_snapshots`

Include a **source availability indicator** in the Slack output header: "Sources: Slack (4 channels), Jira (49 tickets), Confluence (3 pages)" or "Sources: Slack (4 channels), Jira unavailable, Confluence (0 pages)" — so the user knows what the draft is based on.

Include **gap markers** for thin sections: if a team has fewer than 2 capability signals, the draft should note "[Platform: thin signal this week — verify manually]" rather than generating confident prose from insufficient data.

### Continuation Gate

- **Assumption validated** (user sends the draft with minor edits for 2+ weeks) → proceed to Increment 1: Digest tab in SwiftUI
- **Assumption invalidated** (user rewrites >50% consistently) → pivot to curated-signal delivery (structured Slack message the user writes from, no AI prose)

**Post-skeleton questions:**
1. Was the riskiest assumption confirmed or invalidated?
2. What changed about the design as a result?

## 5. Proof of Delivery [PENDING SKELETON]

> "I will know this is worth continuing when the user produces their Monday weekly summary using the Reticle draft as the primary source, with 10-15 minutes of review and editing, for at least 2 consecutive weeks."

Not "when the narration runs." Not "when the Slack DM arrives." When the user's actual Sunday evening workflow drops from 30-60 minutes to 10-15 — and the output maintains their voice and credibility.

## 6. Anti-Metrics [PENDING SKELETON]

Even if this works perfectly, it has failed if:

- **The user spends more time editing the draft than writing from scratch.** A bad draft is worse than a blank page — higher cognitive load to read, evaluate, and selectively rewrite.
- **The summary reads like AI wrote it.** If the user's peers notice a tone shift, the summary has undermined credibility instead of supporting it (Axiom 2).
- **The user stops reviewing and just sends it unread.** Trust misplaced — one bad draft away from a credibility event. The 10-15 minute target (not 5) is deliberately set to ensure genuine engagement.
- **The draft contains a claim not traceable to collected data.** Every sentence must trace to a source signal.
- **The draft includes anything the style excludes.** Ticket counts, individual names, dollar amounts, KTLO laundry lists, sprint metrics, vendor details. The restraint is the style.
- **The 75% coverage creates false completeness.** The user assumes the draft is complete when it's not, sending notes that omit something important. Gap markers and source availability indicators are the structural safeguard.

## 7. Future Increments [PLACEHOLDER]

Each increment is addressed after learning from the skeleton. Not designed yet.

### Increment 1: Digest tab in SwiftUI management window
> Done when the user reads and copies the draft from the Reticle app instead of Slack, and says the experience is better — not when the view renders.

### Increment 2: Structured checklist alternative
> If the full-draft approach fails validation, build a curated-signal view where the user confirms/rejects items before AI assembly. Done when the user produces their summary with this workflow in less time than manual assembly — not when checkboxes render.

### Increment 3: Summary format learning
> Done when the narration prompt adapts to the user's actual summary style (learned from edits over time) — not when a preferences UI ships.

### Increment 4: Cadence optimization
> Done when the digest schedule matches the user's natural reflection moment (Sunday evening) without manual triggering — not when a scheduler UI ships.

---

## Target Output Format: Monday Morning Meeting Notes

The weekly digest must produce a draft matching the Engineering section of the leadership Monday Morning Meeting notes. The format is documented in full in the project memory (`monday-morning-notes-guide.md`); key constraints summarized here.

### Structure

```
## Engineering

### Executive Summary
(2-4 sentences. Opens with stability posture. Middle: optional initiative
highlight. Closes with risk posture.)

### Team Notes

#### Infrastructure
(Opening narrative sentence, capability bullets, hiring status closing line.)

#### Support
(Usually one sentence + default "normal operational activity" unless notable.)

#### Platform (Security & Reliability)
(Opening narrative sentence, capability bullets, hiring status closing line.)
```

### Content Rules

**Include:** Capability advancement, validation/correctness work, risk reduction, hiring status with pipeline details, hardware lifecycle data when notable.

**Exclude (strictly):** Ticket counts, individual employee names, dollar amounts, incident blow-by-blow, sprint/velocity metrics, meeting counts, vendor pricing, future commitments with dates, screenshots/links.

**Always KTLO (never surface):** User/application access provisioning/deprovisioning, password resets, MFA enrollment, hardware ordering/shipping/receiving, Slack channel management, routine onboarding/offboarding execution, Confluence updates to existing procedures, storage metrics. These are stripped by the curation engine before the AI call — the AI never sees them.

### Three Questions (for scanning executive)

1. Is anything broken or at risk? (Exec Summary — almost always "no")
2. What capability advanced this week? (Team Notes bullets — 2-5 per team)
3. Where are we on hiring? (Closing line of Infrastructure and Platform)

### Vocabulary

| Pattern | Use |
|---------|-----|
| "remained stable" | Exec summary opener |
| "no employee-impacting disruptions" | Exec summary opener |
| "risk posture remains unchanged" | Exec summary closer |
| "Normal operational activity" | Support default |
| "operational maturity" | Process/tooling advancement |
| "validated" | Correctness/verification work |
| "continued" | Multi-week WIP |
| "expanded" | Growing coverage/scope |

### Week-over-Week Continuity

First mention → progress → completion → disappear. No explicit closing statement. Previous week's notes fetched from Confluence (canonical record) for continuity reference, falling back to `digest_snapshots.narration` if Confluence is unavailable.

### Data Sources

1. **Slack team channels**: #eng-infra, #project-automation, #eng-general, #eng-platform — messages from team members filtered for substantive work updates. Accessible via `lib/slack-reader.js`.
2. **Jira (ENG + ENGSUP)**: Resolved tickets per team member per week, KTLO-classified tickets stripped before narration. Accessible via Jira API.
3. **Confluence (leadership + team spaces)**: Pages created or updated during the week. Design docs, runbooks, process documentation are high-signal for "capability advancement." Also the source for previous week's notes (continuity reference).
4. **Meeting metadata**: Calendar events provide interview counts (hiring signal), cross-team meeting attendance, and operational themes. Transcripts used when available (currently broken due to audio capture bug — degrade gracefully).
5. **Existing digest collectors**: Followups, email, O3, calendar — provide "is anything broken" and "open items" signal.

### Team Member → Team Mapping

Read from `monitored_people` table at runtime — not hardcoded. The curation engine's `TEAMS` constant must be replaced with a DB lookup before wiring into the pipeline. This prevents silent attribution drift when team membership changes.

---

## Key Decisions from Design Review (7-agent panel, 2026-03-16)

1. **Wire into existing pipeline, not standalone script.** The weekly digest is the right home for this. No throwaway code.
2. **10-15 minutes, not 5.** The manual process has cognitive value (sensemaking). The draft should support efficient review, not rubber-stamping.
3. **Strip KTLO in curation, not in prompt.** The AI can't reliably ignore data it's been shown. Access provisioning, hardware, Slack admin never reach the narration.
4. **Gap markers for thin sections.** Surface when a team has weak signal — don't generate confident prose from insufficient data.
5. **Source availability in output.** The Slack DM header shows which sources contributed — the user knows what the draft is based on.
6. **Confluence as continuity reference.** The canonical record is what was actually sent, not what the tool generated. Fetch last week's Confluence page, fall back to snapshot.
7. **Dynamic team mapping from DB.** The `TEAMS` constant in `digest-curation.js` becomes a runtime query against `monitored_people`.
8. **Checklist is the fallback, not the starting point.** If full-draft validation fails, structured checklist becomes Increment 2.

---

## Files

### New

| File | Purpose |
|------|---------|
| `lib/digest-curation.js` | Cross-reference engine — team attribution, KTLO stripping, gap detection (already built, needs dynamic TEAMS) |
| `test-digest-curation.js` | Unit tests for curation logic (already built) |
| `lib/slack-team-collector.js` | Reads team channels via slack-reader, filters for team member work signals |
| `lib/jira-collector.js` | Queries resolved Jira tickets, classifies KTLO vs capability |

### Modified

| File | Change |
|------|--------|
| `digest-weekly.js` | Wire new collectors + curation + summary narration into the weekly run |
| `reticle-db.js` | Add `curated_items` column to `digest_snapshots`; query `monitored_people` for team mapping |
| `gateway.js` | Include `curated_items` and `narration` in digest endpoint responses |
| `lib/digest-narration.js` | `narrateWeeklySummary()` already built; compression rules already added |
| `lib/digest-curation.js` | Replace hardcoded `TEAMS` with runtime DB lookup |

### Unchanged

Existing collector files, pattern detection, daily digest, heartbeat, service management, Swift app.
