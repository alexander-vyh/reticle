# Feedback-to-Reports Design

## Goal

Surface feedback-worthy moments from Slack public channels involving direct reports, draft "When you [behavior], [impact]" feedback, deliver in the daily digest, and track delivery per report in the tray app.

## Architecture

New feedback collector in the existing three-layer digest pipeline. No new services.

```
All public channels (last 24h)
    |  lib/slack-reader.js
Filter: messages by/mentioning direct reports, >20 chars, non-bot
    |  lib/feedback-collector.js
AI Assessment (Haiku): affirming / adjusting / skip
    |  (drop low-confidence)
AI Draft (Haiku): "When you X, Y happens"
    |
DigestItem[] with feedbackDraft + rawArtifact
    |  digest-daily.js
Slack DM: raw artifact + draft + [Delivered] [Skip] buttons
    |  slack-events-monitor.js
action_log: feedback_delivered / feedback_skipped
    |  lib/feedback-tracker.js
Tray dashboard: per-report counts, weekly/monthly, ratio
```

---

## Design Decisions

### Data Source: Slack Only (V1)

Slack conversations are where most real-time feedback-worthy moments occur. Jira, Confluence, and call transcripts require new API credentials and clients; they can be added in later versions without architectural changes.

### Slack Scope: All Public Channels

Scan all public channels, not just channels the user belongs to. Public channels are by definition visible to everyone in the org, so no privacy concern. This gives the broadest view of how reports operate in collaborative spaces.

### Signal Types: Both Affirming and Adjusting

Surface both positive moments and constructive opportunities. Track the affirming:adjusting ratio per report as a reported metric, not a design target. The expectation is 80-90% affirming naturally, but this is not enforced in code.

### Draft Format: Raw Artifact + AI Draft Side-by-Side

Show the original Slack message(s), then an AI-generated "When you [behavior], [impact]" draft clearly presented as a starting point. The raw artifact keeps the manager honest about what actually happened; the draft reduces activation energy.

This balances the tension between the MT advisor's recommendation ("manager must own the feedback") and the practical need to reduce friction. The manager sees both evidence and a suggestion, and the draft is a rewrite target, not a send-ready message.

### Delivery: Daily Batch in Evening Digest

Add a "Feedback Opportunities" section to the existing 6 PM daily digest. Groups candidates by report. A moment from 9 AM is still within the 24-hour MT rule when surfaced at 6 PM.

### Delivery to Reports: Manual

The tool discovers and drafts; the user owns delivery. No automated sending. This preserves the manager's judgment muscle.

### Tracking: Manual Log Buttons

Each surfaced candidate has "Delivered" and "Skip" buttons. The user taps after giving feedback (or deciding not to). This enables per-report counts, weekly/monthly tracking, and dismissal pattern detection.

### Tracking Visibility: Tray App Dashboard

Persistent dashboard in the Electron tray app showing per-report delivered counts vs. weekly target, monthly totals, and affirming:adjusting ratio.

---

## Components

### 1. Slack Reader (`lib/slack-reader.js`) — Shared Infrastructure

Rate-limited Slack API helper, shared with the weekly-summary feature.

**Functions:**
- `listConversations({ types })` — Paginated listing (200/page)
- `getConversationHistory(channelId, oldest, latest)` — Paginated message history
- `getUserInfo(userId)` — Cached user lookup
- `getConversationInfo(channelId)` — Cached channel lookup

**Rate limiting:** Token bucket at 40 req/min (Slack Tier 3 limit is 50/min).

Design follows `docs/plans/2026-02-23-weekly-summary-slack-design.md` Section 4.1.

### 2. Feedback Collector (`lib/feedback-collector.js`) — Core Component

Runs as part of the daily digest at 6 PM. Three steps:

#### Step 1: Collect Messages Involving Direct Reports

Scan all public channel messages from the last 24 hours. For each message, check if the author is a direct report (by Slack user ID, mapped from `config.directReports`) or if any report is mentioned.

**Pre-AI filtering heuristics:**
- Skip messages < 20 characters
- Skip bot messages and app messages
- Skip messages that are only links/URLs with no commentary
- Skip thread replies that are just emoji reactions

**Candidate shape:**
```javascript
{
  reportName,       // From config.directReports
  reportSlackId,    // Slack user ID
  channelName,      // Channel name
  channelId,        // Channel ID
  messageText,      // Full message text
  timestamp,        // Slack message timestamp
  threadContext,     // If in a thread: parent message text
  messageType       // 'authored' | 'mentioned'
}
```

#### Step 2: AI Assessment (Batch)

Send candidates in batches to Claude Haiku for classification:

- `affirming` — Report did something well (shipped work, helped a teammate, handled a tough situation, good communication, initiative)
- `adjusting` — Constructive opportunity (missed context, unclear communication, could have been handled differently)
- `skip` — Not feedback-worthy (routine status update, factual question, noise)

**Assessment output per message:**
```javascript
{
  category: 'affirming' | 'adjusting' | 'skip',
  behavior: 'Factual description of what the person did',
  context: 'Why this matters or what it signals',
  confidence: 'high' | 'medium' | 'low'
}
```

Only `high` and `medium` confidence items proceed. Low confidence items are dropped.

**PRD constraint:** The assessment must not label behavior as "poor" or "excellent" (Section 4.2: not a performance evaluator). It identifies factual behaviors and their context.

#### Step 3: Draft Feedback (Per Candidate)

For each non-skipped candidate, generate a draft using Claude Haiku:

```
When you [specific observed behavior], [impact on team/project/outcome].
```

**DigestItem fields:**
- `collector`: `'feedback'`
- `observation`: The behavior (from assessment)
- `reason`: Why this surfaced now (recency + context)
- `authority`: "Public channel message in #channel-name at [time]"
- `consequence`: The impact statement
- `sourceType`: `'slack-public'`
- `category`: `'affirming'` or `'adjusting'`
- `priority`: `'normal'` (affirming) or `'high'` (adjusting)
- `counterparty`: Report's name
- `entityId`: `channelId:timestamp` (Slack message permalink)

**Additional metadata (feedback-specific):**
- `feedbackDraft`: Full "When you X, Y happens" text
- `rawArtifact`: Original Slack message + channel + thread context
- `feedbackType`: `'affirming'` or `'adjusting'`

### 3. Feedback Tracker (`lib/feedback-tracker.js`)

DB helper functions for feedback metrics. All queries read from the existing `action_log` table.

**Functions:**
- `logFeedbackAction(reportName, feedbackType, action, entityId)` — Write `feedback_delivered` or `feedback_skipped` to `action_log`
- `getWeeklyCountsByReport(weekStart)` — Per-report delivered/skipped counts for a given week
- `getMonthlyCountsByReport(monthStart)` — Same, monthly
- `getRatioByReport(since)` — Affirming:adjusting ratio per report over a time period
- `getSkipPatterns(since)` — Reports with highest skip rates (dismissal pattern signal)

### 4. Daily Digest Enhancement (`digest-daily.js` — modify)

Add the feedback collector to the existing collector chain. Feedback items appear in a dedicated "Feedback Opportunities" section of the digest.

### 5. Narration Enhancement (`lib/digest-narration.js` — modify)

Enhance the daily narration prompt to handle feedback items. Feedback items render differently from other digest items: they include the raw artifact blockquote and the draft, not just a narrated summary.

### 6. Button Handler (`slack-events-monitor.js` — modify)

Handle `feedback_delivered` and `feedback_skipped` button actions. Update the Slack message to show the confirmed state (disabled buttons with status text).

### 7. Tray Dashboard (`tray/` — modify)

New "Feedback" section in the Electron menu bar app:

```
-- Feedback -----------------
Marcus Chen    ██████ 4/3
Priya Patel    ████── 2/3
Jordan Kim     ██──── 1/3  !
Sofia Rivera   ████── 2/3
...
This month: 47 delivered, 12 skipped
Ratio: 82% affirming, 18% adjusting
```

- Per-report bar showing delivered this week vs. configurable target
- Warning indicator if any report is significantly below target
- Monthly totals and affirming:adjusting ratio
- Refreshes when tray menu opens (queries DB via `feedback-tracker.js`)

---

## Configuration

Add to `~/.config/claudia/team.json`:

```json
{
  "directReports": [
    { "email": "...", "name": "...", "slackId": "U..." }
  ],
  "feedback": {
    "weeklyTarget": 3,
    "scanScope": "public_channels",
    "scanWindowHours": 24
  }
}
```

The `slackId` field on direct reports is new. It's needed to map Slack messages to reports. If not provided, the collector can look up by display name/email, but explicit IDs are more reliable.

---

## PRD Compliance

| PRD Requirement | How Satisfied |
|----------------|---------------|
| Axiom 3: See more, speak less | Scans all public channels, surfaces only feedback-worthy moments |
| Axiom 4: No private data of others | Public channels only |
| Axiom 6: Calm, factual | AI draft uses factual behavior + impact, no judgment |
| Axiom 7: Longitudinal | Per-report weekly/monthly tracking, dismissal patterns |
| Axiom 8: Evidence-based | Every item has observation/reason/authority/consequence |
| Section 10: Never auto-capture feedback | Items surfaced for user review, never auto-created as tasks |
| Section 4.2: Not surveillance/evaluator | Tracks user's feedback habits, not report performance |
| Section 7.2: No performance labeling | Assessment identifies behaviors, not quality labels |
| Section 13: Explainability | DigestItem format with mandatory fields |

---

## Cost Estimate

| Component | Per Day | Per Month |
|-----------|---------|-----------|
| Slack API calls | ~200 (within rate limit) | ~4,400 |
| AI Assessment (Haiku) | ~$0.01 (50-100 messages) | ~$0.25 |
| AI Drafting (Haiku) | ~$0.02 (5-15 drafts) | ~$0.50 |
| **Total** | **~$0.03/day** | **~$0.75/month** |

---

## Not In V1

- Jira/Confluence scanning (needs API credentials)
- Call transcript scanning (needs transcription service)
- Real-time feedback alerts (daily batch only)
- Automated delivery to reports
- Pattern detection on feedback data (trends over time)
- Feedback quality assessment (was the delivered feedback good?)
