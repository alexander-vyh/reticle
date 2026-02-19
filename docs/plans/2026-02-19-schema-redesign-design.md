# Schema Redesign — Design Document

**Date:** 2026-02-19
**Status:** Approved

## Problem

Claudia's current database (`followups.db`) has 4 tables designed for conversation tracking and notification logging. As the system grows to support unsubscribe tracking, ML/agent training from historical actions, multi-account email, response tracking, and cross-entity linkages (email → todo, email → calendar event, etc.), the schema needs a clean-slate redesign.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Typed entities + generic edge table + action log | Best balance of query-ability, flexibility, and simplicity |
| Multi-account | `accounts` table, every entity references `account_id` | Personal accounts now, potentially others' mailboxes later |
| Entity linking | Generic edge table (`entity_links`) | No migrations for new link types; app-level validation via type registry |
| Action/event log | Single unified append-only table | All lifecycle events, all actors (`system`, `user`, `agent`); doubles as ML training corpus |
| Flexibility | JSON `metadata` column on all entity tables | New attributes don't need migrations; promote to typed columns later if needed |
| Migration | Clean break — new DB file (`claudia.db`) | Essentially no data to preserve; simplest path |
| Delete rules | None — never automated deletes | Archive, flag, demote only. Delete only on explicit per-message user request. |

## Schema

### 9 Tables

#### `accounts` — Multi-account anchor
```sql
CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  provider     TEXT NOT NULL DEFAULT 'gmail',
  display_name TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  metadata     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

#### `emails` — One row per email message
```sql
CREATE TABLE emails (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  gmail_id    TEXT,
  thread_id   TEXT,
  from_addr   TEXT NOT NULL,
  from_name   TEXT,
  to_addrs    TEXT,    -- JSON array
  cc_addrs    TEXT,    -- JSON array
  subject     TEXT,
  date        INTEGER NOT NULL,
  direction   TEXT NOT NULL,   -- 'inbound', 'outbound', 'internal'
  snippet     TEXT,
  metadata    TEXT,    -- JSON: labels, headers, List-Unsubscribe, etc.
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_emails_account  ON emails(account_id);
CREATE INDEX idx_emails_gmail_id ON emails(account_id, gmail_id);
CREATE INDEX idx_emails_thread   ON emails(account_id, thread_id);
CREATE INDEX idx_emails_from     ON emails(from_addr);
CREATE INDEX idx_emails_date     ON emails(date);
```

#### `conversations` — Thread-level tracking
```sql
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  type          TEXT NOT NULL,
  subject       TEXT,
  participants  TEXT,    -- JSON array of {addr, name, role}
  state         TEXT NOT NULL DEFAULT 'active',
  waiting_for   TEXT,
  urgency       TEXT DEFAULT 'normal',
  first_seen    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  resolved_at   INTEGER,
  snoozed_until INTEGER,
  metadata      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_conv_account  ON conversations(account_id);
CREATE INDEX idx_conv_state    ON conversations(state);
CREATE INDEX idx_conv_waiting  ON conversations(waiting_for) WHERE state = 'active';
CREATE INDEX idx_conv_activity ON conversations(last_activity);
```

#### `unsubscribes` — Unsub tracking with outcome monitoring
```sql
CREATE TABLE unsubscribes (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  sender_addr     TEXT,
  sender_domain   TEXT NOT NULL,
  method          TEXT NOT NULL,
  unsubscribe_url TEXT,
  requested_at    INTEGER NOT NULL,
  confirmed       INTEGER DEFAULT 0,
  confirmed_at    INTEGER,
  emails_since    INTEGER DEFAULT 0,
  metadata        TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_unsub_domain ON unsubscribes(sender_domain);
CREATE INDEX idx_unsub_addr   ON unsubscribes(sender_addr);
```

#### `email_rules` — Filter/triage rules (no delete rules)
```sql
CREATE TABLE email_rules (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id             TEXT NOT NULL REFERENCES accounts(id),
  rule_type              TEXT NOT NULL,
  match_from             TEXT,
  match_from_domain      TEXT,
  match_to               TEXT,
  match_subject_contains TEXT,
  source_email           TEXT,
  source_subject         TEXT,
  hit_count              INTEGER NOT NULL DEFAULT 0,
  last_hit_at            INTEGER,
  active                 INTEGER NOT NULL DEFAULT 1,
  metadata               TEXT,
  created_at             INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_rules_from   ON email_rules(match_from) WHERE active = 1;
CREATE INDEX idx_rules_domain ON email_rules(match_from_domain) WHERE active = 1;
CREATE UNIQUE INDEX idx_rules_unique ON email_rules(
  account_id, rule_type,
  COALESCE(match_from,''), COALESCE(match_from_domain,''),
  COALESCE(match_to,''), COALESCE(match_subject_contains,'')
);
```

#### `entity_links` — Generic edge table
```sql
CREATE TABLE entity_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  relationship TEXT NOT NULL,
  metadata     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_links_source ON entity_links(source_type, source_id);
CREATE INDEX idx_links_target ON entity_links(target_type, target_id);
CREATE INDEX idx_links_rel    ON entity_links(relationship);
CREATE UNIQUE INDEX idx_links_unique ON entity_links(
  source_type, source_id, target_type, target_id, relationship
);
```

**Relationship types** (extensible):
- `belongs_to` — email → conversation
- `triggered` — email → todo
- `replied_to` — email → email
- `follow_up_for` — conversation → calendar_event
- `unsubscribed_from` — unsubscribe → email
- `mentioned_in` — conversation → slack_message

#### `action_log` — Append-only lifecycle history & ML training corpus
```sql
CREATE TABLE action_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  account_id  TEXT REFERENCES accounts(id),
  actor       TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  context     TEXT,    -- JSON: decision context (features at decision time)
  outcome     TEXT,    -- JSON: what happened as a result
  metadata    TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_action_time    ON action_log(timestamp);
CREATE INDEX idx_action_entity  ON action_log(entity_type, entity_id);
CREATE INDEX idx_action_actor   ON action_log(actor);
CREATE INDEX idx_action_type    ON action_log(action);
CREATE INDEX idx_action_account ON action_log(account_id, timestamp);
```

#### `o3_sessions` — One-on-one meeting tracking (carried forward)
```sql
CREATE TABLE o3_sessions (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  report_name         TEXT NOT NULL,
  report_email        TEXT NOT NULL,
  scheduled_start     INTEGER NOT NULL,
  scheduled_end       INTEGER NOT NULL,
  verified            INTEGER,
  zoom_meeting_id     TEXT,
  zoom_summary        TEXT,
  prep_sent_afternoon INTEGER,
  prep_sent_before    INTEGER,
  post_nudge_sent     INTEGER,
  lattice_logged      INTEGER,
  metadata            TEXT,
  created_at          INTEGER NOT NULL
);

CREATE INDEX idx_o3_account ON o3_sessions(account_id);
CREATE INDEX idx_o3_report  ON o3_sessions(report_email);
CREATE INDEX idx_o3_start   ON o3_sessions(scheduled_start);
```

#### `notification_log` — Notification history (carried forward)
```sql
CREATE TABLE notification_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT REFERENCES accounts(id),
  conversation_id   TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  channel           TEXT DEFAULT 'slack',
  sent_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  metadata          TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX idx_notif_conv    ON notification_log(conversation_id);
CREATE INDEX idx_notif_account ON notification_log(account_id, sent_at);
```

## Application Layer

### New module: `claudia-db.js` (replaces `followups-db.js`)

**Entity Type Registry** — validates types in edge table operations:
```js
const ENTITY_TYPES = {
  email: 'email', conversation: 'conversation', unsubscribe: 'unsubscribe',
  email_rule: 'email_rule', o3_session: 'o3_session',
  todo: 'todo', calendar_event: 'calendar_event', slack_message: 'slack_message',
};

const RELATIONSHIPS = {
  belongs_to: 'belongs_to', triggered: 'triggered', replied_to: 'replied_to',
  follow_up_for: 'follow_up_for', unsubscribed_from: 'unsubscribed_from',
  mentioned_in: 'mentioned_in',
};
```

**Key API functions:**
- `initDatabase()` — creates all tables, returns db instance
- `link(db, { sourceType, sourceId, targetType, targetId, relationship })` — validates types, inserts edge, logs action
- `getLinked(db, entityType, entityId, opts)` — queries edges in both directions
- `logAction(db, { accountId, actor, entityType, entityId, action, context, outcome })` — append to action_log
- `checkUnsubscribed(db, accountId, senderDomain)` — returns `{ unsubscribed, emails_since }`
- All existing conversation/rule/O3/notification functions carried forward with `accountId` parameter added

### Migration Strategy

1. New DB file: `~/.openclaw/workspace/claudia.db`
2. `initDatabase()` creates all 9 tables from scratch
3. Update services in order: gmail-monitor → slack-events-monitor → meeting-alert-monitor → followup-checker
4. Old `followups.db` retained as backup
5. `followups-db.js` removed after all services migrated

## Future Extensions (no schema changes needed)

- **Vector search:** Add `sqlite-vec` extension, create virtual table over action_log context/embeddings
- **New entity types:** Add table + entry in `ENTITY_TYPES` registry. Edge table works immediately.
- **New relationships:** Add entry in `RELATIONSHIPS`. No schema change.
- **New attributes:** Add to `metadata` JSON column. Promote to typed column via migration only if query performance demands it.
