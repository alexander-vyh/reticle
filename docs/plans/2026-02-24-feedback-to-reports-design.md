# Feedback-to-Reports Design

## Goal

Surface feedback-worthy moments involving direct reports and monitored individuals across Slack (and later Gmail, Jira), draft "When you [behavior], [impact]" feedback using common principles from SBI, Manager Tools, and Lara Hogan's equation, and present candidates in a native macOS app (Reticle) for review, editing, and manual delivery.

## Architecture

Three surfaces, all talking to a single local gateway API:

```
                         ┌─────────────────────────────────┐
                         │        Node.js Backend          │
                         │                                 │
Sources → lib/slack-reader.js                              │
              │                                            │
              └→ lib/feedback-collector.js                 │
                    │ AI assessment (Haiku)                 │
                    │ AI draft (Haiku)                      │
                    │                                       │
                    └→ claudia.db (action_log)              │
                              │                            │
                              └→ gateway (HTTP API) ←──────┤
                                        │                  │
              ┌─────────────────────────┼────────────────┐ │
              │                         │                │ │
       Swift app (Reticle)     Slack digest DM     Electron tray
       - People management     - "N candidates"    - counts
       - Review candidates       waiting           via gateway
       - Edit + Copy draft     - [Delivered]
       - History/stats           [Skip] buttons
```

All external surfaces (Swift app, tray) read/write through the gateway.
Internal Node.js services (digest, events monitor) use the DB directly.

---

## Identity Model

People are specified by **email address** as the canonical identifier. The gateway resolves email to platform identities on first lookup and caches the result.

| Platform | Resolution method |
|---|---|
| Slack | `users.lookupByEmail` |
| Jira | User search by email |
| Gmail | Email address (native) |

This enables:
- No manual `slackId` config in team.json
- Future sources (Jira, Gmail) work without re-configuring people
- A single "add person" flow in Reticle covers all sources

---

## Reticle — Swift macOS App

**Location:** `reticle/` at repo root (Xcode project, SwiftUI)
**Launch:** Standalone app, also openable from tray menu
**Framework:** SwiftUI
**Data:** URLSession → local gateway API

### Navigation structure

```
┌──────────┬──────────────────────────────────────────┐
│          │                                          │
│  People  │   [section content]                      │
│ Feedback │                                          │
│ Messages │                                          │
│  To-dos  │                                          │
│  Goals   │                                          │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

Feedback and People are built in V1. Messages, To-dos, Goals are future sections.

### People section

Add/remove monitored individuals by email. App shows identity resolution status per platform.

```
Alex Johnson    alex@company.com
  ✓ Slack: @alex.johnson
  ✓ Jira: ajohnson
  ○ Gmail: (matched by email)

[ + Add person by email ]
```

Includes both direct reports and any additional individuals to monitor.

### Feedback section

Two-panel layout: candidates list on left, detail on right.

```
┌─────────────────┬──────────────────────────────────┐
│ Candidates      │  Marcus Chen · affirming          │
│ ─────────────── │  #platform-eng · today 2:14pm    │
│ ● Marcus Chen   │                                  │
│   affirming     │  > Pushed the migration with     │
│   #platform-eng │    rollback support and tested   │
│                 │    against staging               │
│ ○ Priya Patel   │                                  │
│   adjusting     │  Draft:                          │
│   #incidents    │  When you added rollback support  │
│                 │  to the migration script, it     │
│                 │  reduced deployment risk for the  │
│                 │  team.                           │
│                 │  ┌────────────────────────────┐  │
│                 │  │ [editable text area]        │  │
│                 │  └────────────────────────────┘  │
│                 │                                  │
│                 │  [Copy to clipboard]  [Skip]     │
└─────────────────┴──────────────────────────────────┘
```

**History tab:** per-person weekly/monthly delivery counts, affirming:adjusting ratio.

---

## Feedback Pipeline

### Step 1: Slack scan (Node.js, scheduled)

`lib/slack-reader.js` scans all public channels for the past 24 hours. Filters out: bots, system messages, messages under 20 characters, link-only messages.

`lib/feedback-collector.js` filters to messages authored by or mentioning monitored people (matched by Slack ID resolved from email).

### Step 2: AI assessment (Haiku)

Batch assessment of candidate messages. Each classified as:
- **affirming** — person did something worth acknowledging
- **adjusting** — constructive feedback opportunity
- **skip** — routine, noise, not feedback-worthy

Only high/medium confidence results proceed.

### Step 3: AI draft (Haiku)

For each passing candidate, generate a "When you [behavior], [impact]" draft using common principles from SBI, Manager Tools, and Lara Hogan's Feedback Equation:

- Specific, observable behavior (not character judgment)
- Impact on team, project, or outcome
- Brief and factual
- Never evaluative labels ("great", "poor", "excellent")
- Forward-looking when appropriate

The draft is a starting point — the manager rewrites it before delivery.

### Step 4: Storage

Candidates stored (or held in memory) and exposed via gateway API.
When user acts (Delivered/Skip), logged to `action_log` table.

---

## Gateway API — New Endpoints

### People

| Method | Path | Description |
|---|---|---|
| GET | `/people` | List monitored people with resolution status |
| POST | `/people` | Add person by email (triggers resolution) |
| DELETE | `/people/:id` | Remove person from monitoring |

### Feedback

| Method | Path | Description |
|---|---|---|
| GET | `/feedback/candidates` | List pending candidates |
| POST | `/feedback/candidates/:id/delivered` | Mark delivered, log to action_log |
| POST | `/feedback/candidates/:id/skipped` | Mark skipped, log to action_log |
| GET | `/feedback/stats` | Per-person counts, ratio, weekly/monthly |

---

## Daily Digest Integration

Lightweight mention only — no Block Kit candidate cards in the digest:

```
3 feedback candidates waiting → open Reticle to review
```

Slack DM still includes [Delivered] [Skip] Block Kit buttons as a quick path
(for when the user is already in Slack and doesn't want to open the app).

---

## Tray App Integration

The existing Electron tray app shows a minimal feedback count, fetched from the gateway:

```
── Feedback ──
  3 candidates waiting
  This week: 4 delivered · 83% affirming
```

---

## Design Decisions

### Email as canonical identity

Instead of requiring manual Slack ID configuration, the user specifies people by email and the system resolves identities automatically. This enables multi-source without additional config.

### Three surfaces, one API

All client surfaces talk to the gateway. This keeps the data layer clean, makes the Swift app decoupled from the Node.js internals, and makes future surfaces easy to add.

### Swift for Reticle UI

Native macOS (SwiftUI) for the primary management interface. Smooth feel matters for a tool opened daily. The Node.js backend is preserved; Swift consumes it via gateway. Cross-platform deferred — Electron already exists as a fallback if needed later.

### Feedback as section one

Reticle is designed from the start as a multi-section management tool. Feedback is the first section. People management is shared infrastructure. Messages, To-dos, and Goals are future sections.

### Common principles, not model selection

The AI draft uses the shared core of SBI, Manager Tools, and Lara Hogan's equation — specific behavior, impact, forward-looking, non-evaluative. The manager does not select a model; the draft is a rewrite target regardless of framework.

### Affirming:adjusting ratio — observed, not enforced

Track the ratio per person as a reported metric. Expected ~80–90% affirming naturally. Never enforce this in code.

---

## PRD Compliance

| Axiom/Section | How addressed |
|---|---|
| Axiom 3: broad observation, narrow surfacing | AI filters to high/medium confidence only |
| Axiom 4: no private data of others | Public channels only; DMs never scanned |
| Section 4.2: not surveillance | Candidates surface to manager only; never shared |
| Section 10: feedback never auto-captured | Copy to clipboard — manager sends manually |
| Section 13: explainability | DigestItem requires observation, reason, authority, consequence |

---

## Cost Estimate

Per daily run (6 direct reports, ~50 channels):
- Assessment: ~100 messages × ~500 tokens = ~$0.01 (Haiku input)
- Drafting: ~10 candidates × ~200 tokens = ~$0.02 (Haiku output)
- **Total: ~$0.03/day, ~$0.75/month**
