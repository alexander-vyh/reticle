# Structured Logging for OpenClaw Workspace Scripts

**Date**: 2026-02-05
**Status**: Approved

## Problem

Workspace scripts use raw `console.log` for output. Long-running daemons survive because shell scripts redirect stdout to `.log` files. One-shot tools (like `unsub`) lose all output — when they fail, there's no trace of what happened.

Logs are also unstructured plain text, scattered alongside source code in the workspace directory, with no rotation, no levels, and no way to correlate events across processes.

## Design

### Shared Logger Module

A single file `lib/logger.js` wraps pino and is imported by every script:

```js
const log = require('./lib/logger')('unsub');
log.info({ emailId }, 'Starting unsubscribe');
log.error({ err }, 'Failed to visit URL');
```

The factory function takes a **name** and returns a pino logger that:
- Writes **JSON** to `~/.openclaw/logs/<name>.log` via pino-roll
- Writes **pretty-printed** output to stdout via pino-pretty
- Accepts optional **correlationId** for cross-process tracing
- Defaults to **INFO** level, overridable via `LOG_LEVEL` env var

### Dependencies

- `pino` — structured JSON logger
- `pino-pretty` — human-readable stdout transport
- `pino-roll` — file rotation transport

### Log Directory

All logs consolidate to `~/.openclaw/logs/`:

```
~/.openclaw/logs/
  gateway.log              # existing, unchanged
  gateway.err.log          # existing, unchanged
  unsub.log                # NEW
  gmail-monitor.log        # NEW (replaces workspace/gmail-monitor.log)
```

### Rotation

- Size-based: rotate at **10MB**
- Keep **7** rotated files per script (~70MB max each)
- No time-based rotation

### Log Levels

| Current code | Becomes |
|-------------|---------|
| `console.log('✓ ...')` | `log.info(...)` |
| `console.error('✗ ...')` | `log.error(...)` |
| API response details | `log.debug(...)` |

### Correlation

When gmail-monitor triggers unsub, it passes a correlation ID:

```
gmail-monitor:  log.info({ correlationId, emailId }, 'Triggering unsub')
unsub:          log.info({ correlationId }, 'Starting unsubscribe')
```

Query across processes: `cat ~/.openclaw/logs/*.log | jq 'select(.correlationId == "abc")'`

### Migration Strategy

Incremental. Two scripts first as proof of concept:
1. `unsub` (~15 console.log calls)
2. `gmail-monitor.js` (~49 console.log calls)

Remaining scripts migrate later. Old log files in workspace/ are cleaned up after migration.

### File Layout

```
~/.openclaw/workspace/
  lib/
    logger.js              # NEW — shared logger factory
  unsub                    # migrated
  gmail-monitor.js         # migrated
  docs/plans/
    2026-02-05-structured-logging-design.md  # this file
```
