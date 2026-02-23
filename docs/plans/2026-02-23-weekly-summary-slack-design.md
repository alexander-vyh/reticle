# Weekly Summary — Slack Collection & Synthesis Design

**Date:** 2026-02-23
**Status:** Approved
**Goal:** Automatically collect Slack messages across all channels/DMs weekly, summarize them with AI, and deliver a draft Digital Workplace weekly report to the user's Slack DMs every Friday.

## Problem

Writing the weekly Digital Workplace summary currently requires manually reviewing Slack conversations, Jira tickets, and other sources. The Slack review is the most time-consuming part — the user is a member of many channels and has DMs with multiple direct reports. Context is spread across dozens of conversations with no automated way to extract the signal.

Claudia already has Slack send and event-listening capabilities but cannot read message history.

## Design

### Architecture: Two-Phase Pipeline

Separate collection from summarization to stay within AI context limits and allow independent retry/inspection.

```
Phase 1: Collect              Phase 2: Summarize
┌──────────────────┐          ┌──────────────────────┐
│ slack-reader.js  │          │ Per-channel Haiku     │
│ (new lib module) │──JSON──> │ summarization         │
│                  │  files   │         │             │
│ conversations.   │          │         v             │
│ list + history   │          │ Final Sonnet          │
│ for all channels │          │ synthesis             │
│ in last 7 days   │          │         │             │
└──────────────────┘          │         v             │
                              │ Draft → Slack DM      │
                              └──────────────────────┘
```

### New Slack Scopes Required

Already present: `channels:history`, `channels:read`, `groups:history`, `im:history`, `mpim:history`, `users:read`.

Added: `groups:read`, `im:read`, `mpim:read` (needed for `conversations.list` to return private channels, DMs, and group DMs).

### Component 1: `lib/slack-reader.js`

New module alongside `lib/slack.js`. Same raw `https` + bearer token pattern.

**Functions:**
- `listConversations()` — `conversations.list` with `types=public_channel,private_channel,mpim,im`. Handles pagination (max 200/page).
- `getConversationHistory(channelId, oldest, latest)` — `conversations.history` for a channel within a time range. Handles pagination for 1000+ message channels.
- `getUserInfo(userId)` — `users.info` with in-memory cache. Resolves user IDs to display names.
- `getConversationInfo(channelId)` — `conversations.info` with in-memory cache. Gets channel names.

**Rate limiting:** Token bucket at 40 req/min (headroom under Slack Tier 3 limit of 50).

### Component 2: `weekly-summary-collector.js`

Top-level service. Runs Fridays at 3:00 PM via launchd.

**Process:**
1. Enumerate all conversations via `listConversations()`
2. Filter to channels with activity in last 7 days (using `last_message_ts`)
3. Fetch history for each active channel
4. Clean: strip bot messages, join/leave events, reaction-only messages, sub-5-char messages
5. Resolve: replace `<@U1234>` user mentions with display names
6. Store: one JSON file per channel under `~/.claudia/data/weekly-summary/YYYY-MM-DD/channels/`

**Output structure:**
```
~/.claudia/data/weekly-summary/2026-02-23/
  channels/
    C01ABC-general.json
    C02DEF-dw-engineering.json
    D03GHI-dm-kinski-wu.json
    ...
  metadata.json
```

Each channel file:
```json
{
  "channelId": "C01ABC",
  "channelName": "general",
  "channelType": "public_channel",
  "messageCount": 142,
  "messages": [
    { "ts": "1740000000.000", "user": "Gandalf Grey", "text": "..." }
  ]
}
```

**Idempotency:** Skips if output directory already exists. Override with `FORCE_RECOLLECT=1`.

**Data retention:** Auto-deletes collection directories older than 4 weeks.

**Expected runtime:** 3-5 minutes for ~50-100 active channels at 40 req/min.

### Component 3: `weekly-summary-synthesizer.js`

Top-level service. Runs Fridays at 3:30 PM via launchd.

**Tier 1 — Per-channel summarization (Haiku):**
- Reads each channel JSON from today's collection
- Channels with <5 messages auto-tagged "No notable activity" (no AI call)
- Sends remaining to `claude-haiku-4-5-20251001` with prompt:

> Extract: decisions made, action items, notable updates, blockers, cross-team coordination.
> Ignore: casual chat, greetings, emoji reactions, off-topic conversation.
> Output: 3-5 bullet points max. If nothing notable, respond "No notable activity."

- Writes per-channel summaries to `~/.claudia/data/weekly-summary/YYYY-MM-DD/summaries/`

**Tier 2 — Final synthesis (Sonnet):**
- Reads all per-channel summaries
- Reads `team.json` for team structure
- Sends to Sonnet with:
  - Team structure context (CSE, Desktop Support, Security members)
  - Output format template matching the existing weekly report style
  - Instruction: passive/impersonal voice, business outcomes, no ticket numbers
- Writes final draft to `~/.claudia/data/weekly-summary/YYYY-MM-DD/draft.md`
- Sends draft to user's Slack DM via `sendSlackDM()`

**Dependency on collector:** Checks that collection directory exists and has channel files. If not, retries after 5 minutes up to 3 times, then sends an error DM.

**Cost per run:** ~50 Haiku calls (~$0.15) + 1 Sonnet call (~$0.05) = ~$0.20/week.

### Launchd Integration

Two new plists via `bin/deploy`:

| Service | Label | Schedule |
|---|---|---|
| Weekly Collector | `ai.claudia.weekly-collector` | Fridays 3:00 PM |
| Weekly Synthesizer | `ai.claudia.weekly-synthesizer` | Fridays 3:30 PM |

Both use `StartCalendarInterval` (run-once, not persistent). Both also work as standalone CLI: `node weekly-summary-collector.js`.

### Tray App

Add both services to `tray/service-manager.js` SERVICES array for visibility.

### Error Handling

- Individual channel Slack API failure → log, skip, continue
- Individual channel AI summary failure → log, mark "Summary unavailable"
- Complete failure (no token, no credentials) → error DM via `sendSlackDM()`

### Files

| Action | File |
|---|---|
| New | `lib/slack-reader.js` |
| New | `weekly-summary-collector.js` |
| New | `weekly-summary-synthesizer.js` |
| Modify | `bin/deploy` (add 2 plist templates) |
| Modify | `tray/service-manager.js` (add to SERVICES) |

### What This Does NOT Cover

- Jira ticket collection (separate command, same pattern, future feature)
- Zoom transcript ingestion (future feature)
- Combined Jira + Slack synthesis into one report (future feature, takes both drafts as input)
- Confluence page publishing (manual copy-paste from draft for now)
