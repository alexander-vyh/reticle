# Digest Experience Redesign — Design Document

**Date:** 2026-03-16 (revised 2026-03-19 with live session findings)
**Status:** Draft (revised after spike + 7-agent review + live March 18 session)
**Goal:** Wire new data sources and Monday Morning Meeting narration into the existing weekly digest pipeline so the Slack delivery becomes a usable weekly summary draft, replacing 30-60 minutes of manual assembly.

**PRD Reference:** [Reticle PRD](2026-02-23-reticle-prd.md) — Section 8.1 (Periodic Digest)
**Extends:** [Periodic Digest Design](2026-02-23-reticle-periodic-digest-design.md). Adds new collectors and a second narration path. Existing collection pipeline unchanged.

## 1. Problem Statement [VALIDATED]

> **"What changes in the world?"**

The user produces a Digital Workplace section for the Monday Morning Meeting notes every week by 7 AM Monday. Today this takes 30-60 minutes of manual archaeology: digging through Slack team channels, Jira resolved tickets, calendar, and memory to reconstruct what each of three sub-teams accomplished. By Friday the user is too drained to do this, so it defers to Sunday evening.

The weekly digest pipeline already collects 809 items from followups, email, O3s, and calendar. But this data is oriented around the user's personal follow-through — not team capability advancement. The digest delivers a raw Slack DM that cannot be used as source material for the Monday notes.

Observable change after this work: the user triggers the weekly digest (manually or scheduled). The Slack DM arrives as a structured Monday Morning Meeting notes draft in the correct format — Executive Summary, Infrastructure, Support, Platform sections with capability bullets and hiring status. The user reviews, makes minor edits, and pastes it into Confluence. Total active time: 10-15 minutes of genuine review (not 5 — the synthesis has cognitive value).

## 2. Non-Goals (minimum 3) [VALIDATED]

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

### 2.5 — We are not building a Claude Code interactive skill (yet)

The March 18 session demonstrated an interactive workflow: the user triggered data pulls conversationally via Claude Code, reviewed incrementally, and iterated on the draft in real-time using MCP tools (Atlassian, Slack, Google Calendar). This is a separate artifact (a `/weekly-summary` Claude Code command) — not the automated pipeline. The pipeline produces a first draft; the interactive skill enables on-demand generation with editorial iteration. We build the pipeline first.

**Why:** The pipeline validates the data sufficiency and curation assumptions without requiring the user to be in a Claude Code session. The interactive skill is a complementary delivery surface, not a replacement. **What this locks in:** No `.claude/commands/` work in the skeleton. The interactive skill becomes a future increment once the pipeline proves the curation works.

## 3. Riskiest Assumption [VALIDATED]

> **"I am betting that Slack team channel messages + Jira resolved tickets + Confluence pages + existing digest collectors, curated and narrated with the Monday Morning Meeting style guide, will produce a draft the user would send with 10-15 minutes of editing. I will know I'm wrong when the user consistently rewrites more than half the draft."**

### What the spike showed (March 10-14 synthetic)

The spike gathered live data from all sources for March 10-14 and ran it through AI narration. Results:

- **Structure:** Perfect — all 5 section headings matched the actual notes
- **Coverage:** ~75% — infrastructure automation work, drift detection, interviews all captured. Missed: vendor SSO integration (Jira ticket not in fixture), naming convention decision (only the problem was in Slack, not the resolution), Platform hiring update (previous notes only)
- **Verbosity:** 2x too long — AI included KTLO items (access provisioning, Slack channel management, storage metrics) that the style explicitly excludes
- **Root cause of verbosity:** Curation failure, not prompt failure. KTLO items were passed to the AI; the AI included them despite "exclude KTLO" instructions. The fix: strip KTLO categories before the AI call, not in the prompt.

### What the live session showed (March 9-16, 2026-03-18)

A full end-to-end run using real Jira + Slack + Google Calendar data, with the user editing in real time. This produced the actual March 16th Confluence entry.

- **Coverage improved to ~90%** with both Jira and Slack sources combined. Slack provided narrative context Jira lacked (e.g., the drift detection pivot from custom script to GitHub Actions, the ZTD enrollment testing discussions).
- **KTLO stripping worked at the primary level** — access provisioning, hardware, password tickets were correctly excluded. But **secondary KTLO leaked through**: Trelica reconnection (fixing broken integration), Vanta compliance remediations (catch-up), Incident #72 response details. These required manual removal.
- **Overclaiming is the critical failure mode.** The draft claimed drift detection was "running on schedule" when the Jira ticket (DWDEV-9155) was still In Progress. This would have damaged the user's credibility if published. Status verification is now a mandatory quality gate.
- **On-call calendar context was essential.** Understanding who was on-call explained DWS ticket distribution and team capacity allocation. Without this, the draft would have no way to distinguish "quiet week" from "capacity absorbed by queue."
- **Previous week's Confluence page was the canonical continuity reference.** Without it, the draft used "Implemented" for items that should have been "Continued." The Confluence fetch is not optional — it's critical infrastructure.
- **Total iteration:** 4 rounds of user correction before the draft was publishable. Corrections documented in the Editorial Correction Patterns section.

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
- Reads messages from team channels (#iops-dw, #iops-dw-cse, #project-terraform, #digital-workplace, #learning-terraform) via `lib/slack-reader.js`
- Filters for messages from team members (using `monitored_people` team mapping from DB, not hardcoded)
- Strips trivial messages (emoji-only, "ok", "thanks")
- Returns `[{ author, authorTeam, channel, date, content }]`

### Task 2: Jira resolved collector (~45 min)

Add `collectJiraResolved(weekStart, weekEnd)` that:
- Queries `project in (DWDEV, DWS) AND resolved >= weekStart AND resolved <= weekEnd` via Jira API
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

### Quality Gates (added 2026-03-19 from live session)

The March 18 session exposed specific failure modes in AI-generated summaries. These gates prevent overclaiming, false completeness, and style violations.

**Gate 1: Status Verification (the "drift detection" problem)**
For every Jira ticket cited as a capability accomplishment, verify its actual status. On March 18, the draft claimed drift detection was "running on schedule" — but DWDEV-9155 was still In Progress in Jellyfish. The curation engine must check: `if status !== 'Done' || resolutionDate outside window → in-progress language, not accomplishment language`.

**Gate 2: KTLO Re-check After Curation**
After stripping, scan the remaining items for false positives that survived classification:
- Fixing a broken integration is maintenance, not new capability (March 18: Trelica reconnection removed)
- Compliance catch-up is maintenance (March 18: Vanta remediations removed from Security header)
- Restoring functionality ≠ building functionality

**Gate 3: Source Traceability**
Every bullet must trace to a specific Jira ticket or Slack message. Include internal annotations `[source: DWDEV-1234]` in the curated data structure. Strip before delivery.

**Gate 4: Gap Markers**
If a team has fewer than 2 capability signals after KTLO stripping, emit `[Team: thin signal — verify manually]` rather than generating confident prose from insufficient data.

**Gate 5: Name Scrub**
Post-narration: scan output for any team member names. The style guide explicitly forbids individual names. Replace with team references.

**Gate 6: Continuity Cross-Reference**
Compare against previous week's section:
- Items appearing in both weeks with identical language → stale copy, flag
- Items from last week that vanished without completion language → dropped silently, flag
- Hiring status that contradicts prior week without explanation → flag

### Continuation Gate

- **Assumption validated** (user sends the draft with minor edits for 2+ weeks) → proceed to Increment 1: Digest tab in SwiftUI
- **Assumption invalidated** (user rewrites >50% consistently) → pivot to curated-signal delivery (structured Slack message the user writes from, no AI prose)

**Post-skeleton questions:**
1. Was the riskiest assumption confirmed or invalidated?
2. What changed about the design as a result?

## 5. Proof of Delivery [PENDING SKELETON]

> "I will know this is worth continuing when the user produces their Monday weekly summary using the Reticle draft as the primary source, with 10-15 minutes of review and editing, for at least 2 consecutive weeks."

Not "when the narration runs." Not "when the Slack DM arrives." When the user's actual Sunday evening workflow drops from 30-60 minutes to 10-15 — and the output maintains their voice and credibility.

## 6. Anti-Metrics [VALIDATED]

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

### Increment 5: Claude Code `/weekly-summary` interactive skill (added 2026-03-19)
> Done when the user can type `/weekly-summary` in Claude Code and receive an interactive draft they can iterate on conversationally — not when the command file exists. The March 18 session demonstrated this workflow manually; this increment codifies it as a reusable skill. Depends on the pipeline curation engine working (Increment 0/skeleton) since the skill reuses the same include/exclude logic and quality gates. Design blueprint: `docs/plans/2026-03-18-tooling-architecture-blueprint.md`.

### Increment 6: 1:1 prep skill (added 2026-03-19)
> Done when the user can type `/one-on-one-prep <name>` and receive evidence-based feedback prep with on-call cross-referencing — not when the data queries run. Reuses the same Jira/Slack/Calendar data sources as the weekly summary but with a per-person analysis lens. Design template: `docs/plans/2026-03-18-one-on-one-prep-template.md`.

---

## Target Output Format: Monday Morning Meeting Notes

The weekly digest must produce a draft matching the Digital Workplace section of the leadership Monday Morning Meeting notes. The format is documented in full in the project memory (`monday-morning-notes-guide.md`); key constraints summarized here.

### Structure

```
## Digital Workplace

### Executive Summary
(2-4 sentences. Opens with stability posture. Middle: optional initiative
highlight. Closes with risk posture.)

### Team Notes

#### Corporate Systems Engineering
(Opening narrative sentence, capability bullets, hiring status closing line.)

#### Desktop Support
(Usually one sentence + default "normal operational activity" unless notable.)

#### Security (Platform & Endpoint)
(Opening narrative sentence, capability bullets, hiring status closing line.)
```

### Content Rules

**Include:** Capability advancement, validation/correctness work, risk reduction, hiring status with pipeline details, hardware lifecycle data when notable.

**Exclude (strictly):** Ticket counts, individual employee names, dollar amounts, incident blow-by-blow, sprint/velocity metrics, meeting counts, vendor pricing, future commitments with dates, screenshots/links.

**Always KTLO (never surface):** User/application access provisioning/deprovisioning, password resets, MFA enrollment, hardware ordering/shipping/receiving, Slack channel management, routine onboarding/offboarding execution, Confluence updates to existing procedures, storage metrics. These are stripped by the curation engine before the AI call — the AI never sees them.

### Three Questions (for scanning executive)

1. Is anything broken or at risk? (Exec Summary — almost always "no")
2. What capability advanced this week? (Team Notes bullets — 2-5 per team)
3. Where are we on hiring? (Closing line of CSE and Security sections)

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

1. **Slack team channels**: #iops-dw, #iops-dw-cse, #project-terraform, #digital-workplace, #learning-terraform — messages from team members filtered for substantive work updates. Accessible via `lib/slack-reader.js`.
2. **Jira (DWDEV + DWS)**: Resolved tickets per team member per week, KTLO-classified tickets stripped before narration. DWDEV tickets are almost always capability; DWS tickets are almost always KTLO. Accessible via Jira API (cloud ID: `1ddedfba-913e-4ed3-97db-fa299ced0673`).
3. **Confluence (EMGT space)**: Previous week's Monday Morning Meeting page for continuity reference. Page title format: "March 16th, 2026" (ordinal date). Also DW space for new process docs created during the week.
4. **On-call calendar** (added 2026-03-19): Google Calendar group calendar (`c_c3daf94bf19d2969cb3ffd0637496bbc2c5644d8b4a68dd1df4cadb051bda283@group.calendar.google.com`). Events named "[Person] - On Call" show daily rotation. Used to contextualize DWS ticket volume (on-call days explain operational load) and detect off-rotation ticket work.
5. **Meeting metadata**: Calendar events provide interview counts (hiring signal), cross-team meeting attendance, and operational themes. Transcripts used when available (currently broken due to audio capture bug — degrade gracefully).
6. **Existing digest collectors**: Followups, email, O3, calendar — provide "is anything broken" and "open items" signal.

### Team Member → Team Mapping

Read from `monitored_people` table at runtime — not hardcoded. The curation engine's `TEAMS` constant must be replaced with a DB lookup before wiring into the pipeline. This prevents silent attribution drift when team membership changes.

---

## Editorial Correction Patterns (added 2026-03-19 from live session)

The March 18 live session produced a real draft from real data. The user's editorial corrections provide ground truth for the curation engine and narration prompt.

### Corrections Applied

| Draft Said | User Corrected To | Classification Rule |
|-----------|-------------------|---------------------|
| "Reconnected NetSuite to Trelica, restored integrations for Bitwarden, Datadog, and Make" | REMOVED | Fixing broken integrations is maintenance, not new capability |
| "Closed Vanta compliance remediations for departed-employee account deprovisioning in GitHub and Auth0" | REMOVED | Compliance catch-up is maintenance, not capability advancement |
| "alongside compliance remediation" (Security section header) | "alongside endpoint platform improvements" | Don't highlight compliance as a theme — it's operational |
| "Contributed to Incident #72 response (Meta Business Manager compromise)" | REMOVED | Incident response details are excluded per style guide |
| "Created Terraform user objects for termed-user attribute" | "Implemented Terraform management for the termed-user attribute" | Prefer outcome language ("implemented management") over implementation details ("created objects") |
| "surfaced its first automated drift alert on March 12 and is now running on schedule" | "an initial GitHub Actions–based implementation generated its first drift detection alert on March 12. Finalizing scheduled automation." | DWDEV-9155 was still In Progress — overclaiming. Must verify Jira status before using completion language |
| "Identity lifecycle operations continued at pace" (exec summary) | Folded into surrounding sentences | Prefer tighter exec summaries — every sentence must earn its place |

### Implications for Curation Engine

1. **KTLO re-check needed after primary classification.** The Trelica and Vanta items passed KTLO classification (they weren't access provisioning or hardware) but were still maintenance. Add a secondary filter: "Does this restore something that was working before?" → maintenance.
2. **Verb choice in narration prompt.** The style guide vocabulary table needs "implemented" as the preferred verb for new IaC coverage (not "created" or "added").
3. **Status verification is mandatory.** The curation engine must check Jira ticket status before passing to narration. In-progress tickets get "continued" / "progressed" / "finalizing" language, never "completed" / "validated" / "running."
4. **Incident response is always excluded** — even when it involves noteworthy security events. The style guide says "incident response" (2 words) if anything, not the details.

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
