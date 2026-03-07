# Reticle

Reticle is a personal work-alignment system. It helps a capable individual maintain
intent, follow through on commitments, and act earlier — not by automating decisions,
but by extending awareness and preserving continuity where human attention doesn't
scale with complexity.

Reticle is an instrument, not an agent. It shows deviation. It preserves reference.
It does not decide or command. Silence is the default success state.

**Read the full PRD:** `docs/plans/2026-02-23-reticle-prd.md`

### Binding Axioms (from PRD — not optional)

1. Helps the primary user first — no persona abstractions
2. Credibility and follow-through, not productivity theater
3. Observe broadly, surface narrowly — silence is success
4. Never rely on others' private information
5. Dismissal always possible unless explicitly revoked
6. Calm, factual, resolution-oriented tone
7. Longitudinal — patterns over events, future outcomes over immediate efficiency
8. Accountability is evidence-based and research-grounded

## Outcomes, Not Code

The goal of every change is a **real-world outcome** — not a passing test, not a
clean diff, not a completed ticket. Before declaring anything done, verify the actual
result the user needs is happening. "Tests pass" is not an outcome. "Follow-ups
surface before credibility erodes" is.

If your change reveals a bug elsewhere, fix it. If something adjacent blocks the
outcome, own it. If you can't verify the outcome end-to-end, say so honestly —
don't paper over it.

## Quick Start

```bash
npm install                # Root dependencies
npm test                   # Run all tests
cd reticle && swift build  # Build SwiftUI apps
cd reticle && swift test   # Run Swift tests
```

Node >=22 required. Swift >=5.9 required for the SwiftUI apps and meeting recorder.

## Architecture

6 Node.js services + 2 Swift apps + 1 Swift daemon:

| Service | File | Purpose |
|---------|------|---------|
| Gmail Monitor | `gmail-monitor.js` | Polls Gmail, filters/batches emails, sends to Slack |
| Slack Monitor | `slack-events-monitor.js` | Real-time Slack DM/mention tracking via Socket Mode |
| Meeting Alerts | `meeting-alert-monitor.js` | Calendar notifications, O3 prep/nudges, popup UI |
| Follow-up Checker | `followup-checker.js` | Multi-tier notifications for stale conversations |
| Daily Digest | `digest-daily.js` | Collects signals, AI-narrates a morning briefing to Slack |
| Weekly Digest | `digest-weekly.js` | Pattern detection + longitudinal summary to Slack |

| Component | Path | Purpose |
|-----------|------|---------|
| Reticle App | `reticle/Sources/Reticle/` | SwiftUI menu bar tray + management window (People, Feedback) |
| Meeting Popup | `reticle/Sources/MeetingPopup/` | SwiftUI floating panel for meeting countdown + join |
| Gateway API | `gateway.js` | Express REST API — people, feedback, Slack reader endpoints |
| Meeting Recorder | `recorder/` | Swift macOS daemon — CoreAudio capture + live transcription |

**Database** (`reticle-db.js`): Typed entities + generic edge table (`entity_links`) +
append-only `action_log` (ML training corpus). SQLite via better-sqlite3.
Schema docs: `docs/plans/2026-02-19-schema-redesign-design.md`.

## Key Files

- `reticle-db.js` — Database layer: schema, queries, entity type registry
- `lib/ai.js` — Anthropic SDK wrapper for AI-powered filtering/triage
- `lib/config.js` — Config loader (reads `~/.reticle/config/`)
- `lib/heartbeat.js` — Health check module (all services write heartbeat JSON)
- `lib/startup-validation.js` — Pre-flight checks before service main loop
- `lib/logger.js` — Structured logging via pino with rotation
- `lib/slack.js` — Slack Web API helpers (DMs, messages)
- `lib/slack-reader.js` — Slack conversation history reader
- `lib/people-store.js` — Monitored people CRUD (DB-backed)
- `lib/digest-collectors.js` — Data collectors for digest items (followups, email, calendar, O3)
- `lib/digest-item.js` — Digest item model + deduplication
- `lib/digest-narration.js` — AI narration of daily/weekly digests
- `lib/digest-patterns.js` — Pattern detection across digest snapshots
- `lib/feedback-collector.js` — Extracts feedback items from Slack history
- `lib/feedback-blocks.js` — Slack Block Kit formatting for feedback sections
- `lib/feedback-tracker.js` — Feedback delivery tracking via action_log
- `bin/deploy` — Production deployment (rsync + launchd plist generation)

## Configuration

Runtime config in `~/.reticle/` (never committed):
- `config/secrets.json` — Slack tokens, Gmail account (template: `config/secrets.example.json`)
- `config/team.json` — VIP contacts, direct reports (template: `config/team.example.json`)
- `data/reticle.db` — SQLite database (created on first run)
- `logs/` — Structured logs via pino with rotation

## Testing — Strict TDD Required

Follow RED-GREEN-REFACTOR for every change. No exceptions without explicit permission.

1. **RED:** Write a failing test. Run it. **Show the failure output.**
2. **GREEN:** Write minimal code to make the test pass. Run it. **Show it passes.**
3. **REFACTOR:** Clean up while keeping tests green.

If you wrote production code before a failing test exists, delete it and start over.
"I'll add tests after" is not TDD. Tests that pass immediately prove nothing.

**Unit tests** for pure logic — parsing, filtering, scoring, data transformation,
decision logic.

**Integration tests** for I/O boundaries — database operations (temp file DBs,
not `:memory:`), file system interactions, service startup/shutdown.

Both layers required for new features.

```bash
npm test                        # All tests (root + tray)
node test-reticle-db.js         # Database layer
node test-heartbeat.js          # Heartbeat module
node test-startup-validation.js # Startup validation
node test-people-store.js       # People store
node test-digest-item.js        # Digest item model
node test-digest-collectors.js  # Digest data collectors
node test-digest-patterns.js    # Pattern detection
node test-digest-narration.js   # AI narration
node test-slack-reader.js       # Slack reader
node test-feedback-collector.js # Feedback extraction
node test-feedback-tracker.js   # Feedback tracking
node test-feedback-blocks.js    # Feedback Slack blocks
node test-gateway.js            # Gateway API
cd reticle && swift test        # Swift tests (ServiceManager parsing, heartbeat)
```

Tests use plain Node.js `assert` — no test framework. Each test file is a standalone
script at the project root that exits 0 on success, non-zero on failure. Swift tests
use XCTest in `reticle/Tests/`.

## Code Style

- Plain Node.js — no TypeScript, no bundler, no transpilation
- No package-lock.json at root
- Structured logging via pino (`lib/logger.js`) — never `console.log` in services
- Services are standalone scripts managed by launchd
- JSON `metadata` columns for flexible attributes — promote to typed columns only
  when query performance demands it
- Test files live at the project root alongside source (e.g., `test-reticle-db.js`)

## Agent Framework Files (Product Feature — Not Dev Instructions)

`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `USER.md`
define the **Reticle agent persona** for conversational contexts (Discord, Slack).
They are part of the product, not instructions for Claude Code.

## Work Tracking (Beads)

This project uses [beads](https://beads.dev) (`bd` command) for task tracking with
dependency chains. The database lives in `.beads/` (Dolt-backed, auto-managed).

**Two layers, no duplication:**
- **Design** (`docs/plans/*.md`) — approved specs, schema, rationale. Read before
  implementing. Rarely changes.
- **Execution** (`bd`) — task status, dependencies, blocking chains. Check and
  update during implementation.

### When starting implementation work

```bash
bd ready                        # What's unblocked and ready?
bd ready --parent <epic-id>     # Filter to a specific workstream
bd show <issue-id>              # Read details before starting
bd update <id> -s in_progress   # Claim the task
```

### When finishing a task

```bash
bd close <id>                   # Marks done, unblocks dependents
bd ready                        # See what opened up
```

### When you discover new work mid-session

```bash
bd q "Short description"                    # Quick capture, returns ID
bd create "Title" --parent <epic> -p 2      # Structured, under an epic
bd dep <blocker-id> --blocks <blocked-id>   # Wire into dependency chain
```

### Key commands

```bash
bd list                  # All open issues
bd blocked               # What's waiting on what
bd graph --all           # Visual dependency map
bd children <epic-id>    # What's under an epic
bd stale                 # Forgotten work
```

Do NOT use beads for quick questions, code review, or exploratory work. Use it when
the session involves implementing, completing, or planning tracked work.

## Design Documents

All approved designs live in `docs/plans/` with date prefixes. Read the relevant
design doc before working on a feature — they contain approved schema, API contracts,
and architectural decisions. Task breakdowns and status live in beads, not in plan docs.

## Meeting Recorder (Swift)

```bash
cd recorder
make build          # Debug build
make release        # Release build
make list-devices   # Show available audio devices
make run            # Build + run debug
```

Managed by launchd via `recorder/ai.reticle.meeting-recorder.plist`.
Uses CoreAudio for capture and a Python venv for live transcription.

## Gotchas

- Legacy "OpenClaw" naming persists in some recorder paths and launchd labels
- Gmail OAuth callback uses a high port to match the registered redirect URI
- Database uses epoch seconds (not milliseconds) for all timestamps
- `entity_links` edge table uses app-level type validation (ENTITY_TYPES registry),
  not database constraints
- No automated deletes — archive/flag only; delete only on explicit user request
- Deploy target is macOS launchd (not systemd, not Docker)
- Pre-commit hook runs `gitleaks` — commits will be rejected if secrets are staged
- Config templates are in `config/` — actual secrets live in `~/.reticle/config/`

## Deploy

```bash
bin/deploy  # Syncs to ~/.reticle/app/, generates plists, restarts services
```
