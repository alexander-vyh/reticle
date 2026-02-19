'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_DIR = path.join(process.env.HOME, '.openclaw', 'workspace');
const DB_PATH = process.env.CLAUDIA_DB_PATH || path.join(DB_DIR, 'claudia.db');

// --- Entity Type + Relationship Registries ---

const ENTITY_TYPES = {
  email: 'email',
  conversation: 'conversation',
  unsubscribe: 'unsubscribe',
  email_rule: 'email_rule',
  o3_session: 'o3_session',
  todo: 'todo',
  calendar_event: 'calendar_event',
  slack_message: 'slack_message',
};

const RELATIONSHIPS = {
  belongs_to: 'belongs_to',
  triggered: 'triggered',
  replied_to: 'replied_to',
  follow_up_for: 'follow_up_for',
  unsubscribed_from: 'unsubscribed_from',
  mentioned_in: 'mentioned_in',
};

function generateId() {
  return crypto.randomUUID();
}

function initDatabase() {
  if (!process.env.CLAUDIA_DB_PATH) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      provider     TEXT NOT NULL DEFAULT 'gmail',
      display_name TEXT,
      is_primary   INTEGER NOT NULL DEFAULT 0,
      metadata     TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS emails (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      gmail_id    TEXT,
      thread_id   TEXT,
      from_addr   TEXT NOT NULL,
      from_name   TEXT,
      to_addrs    TEXT,
      cc_addrs    TEXT,
      subject     TEXT,
      date        INTEGER NOT NULL,
      direction   TEXT NOT NULL,
      snippet     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_emails_account  ON emails(account_id);
    CREATE INDEX IF NOT EXISTS idx_emails_gmail_id ON emails(account_id, gmail_id);
    CREATE INDEX IF NOT EXISTS idx_emails_thread   ON emails(account_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_emails_from     ON emails(from_addr);
    CREATE INDEX IF NOT EXISTS idx_emails_date     ON emails(date);

    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL REFERENCES accounts(id),
      type          TEXT NOT NULL,
      subject       TEXT,
      participants  TEXT,
      state         TEXT NOT NULL DEFAULT 'active',
      waiting_for   TEXT,
      urgency       TEXT DEFAULT 'normal',
      first_seen    INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      resolved_at   INTEGER,
      snoozed_until INTEGER,
      notified_at   INTEGER,
      metadata      TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conv_account  ON conversations(account_id);
    CREATE INDEX IF NOT EXISTS idx_conv_state    ON conversations(state);
    CREATE INDEX IF NOT EXISTS idx_conv_waiting  ON conversations(waiting_for) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_conv_activity ON conversations(last_activity);

    CREATE TABLE IF NOT EXISTS unsubscribes (
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
    CREATE INDEX IF NOT EXISTS idx_unsub_domain ON unsubscribes(sender_domain);
    CREATE INDEX IF NOT EXISTS idx_unsub_addr   ON unsubscribes(sender_addr);

    CREATE TABLE IF NOT EXISTS email_rules (
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
    CREATE INDEX IF NOT EXISTS idx_rules_from   ON email_rules(match_from) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_rules_domain ON email_rules(match_from_domain) WHERE active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique ON email_rules(
      account_id, rule_type,
      COALESCE(match_from,''), COALESCE(match_from_domain,''),
      COALESCE(match_to,''), COALESCE(match_subject_contains,'')
    );

    CREATE TABLE IF NOT EXISTS entity_links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type  TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      target_type  TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      relationship TEXT NOT NULL,
      metadata     TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_links_source ON entity_links(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON entity_links(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_links_rel    ON entity_links(relationship);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique ON entity_links(
      source_type, source_id, target_type, target_id, relationship
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      account_id  TEXT REFERENCES accounts(id),
      actor       TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      action      TEXT NOT NULL,
      context     TEXT,
      outcome     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_action_time    ON action_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_action_entity  ON action_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_action_actor   ON action_log(actor);
    CREATE INDEX IF NOT EXISTS idx_action_type    ON action_log(action);
    CREATE INDEX IF NOT EXISTS idx_action_account ON action_log(account_id, timestamp);

    CREATE TABLE IF NOT EXISTS o3_sessions (
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
    CREATE INDEX IF NOT EXISTS idx_o3_account ON o3_sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_o3_report  ON o3_sessions(report_email);
    CREATE INDEX IF NOT EXISTS idx_o3_start   ON o3_sessions(scheduled_start);

    CREATE TABLE IF NOT EXISTS notification_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id        TEXT REFERENCES accounts(id),
      conversation_id   TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      channel           TEXT DEFAULT 'slack',
      sent_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      metadata          TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_notif_conv    ON notification_log(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_notif_account ON notification_log(account_id, sent_at);
  `);

  return db;
}

// --- Accounts ---

function upsertAccount(db, { email, provider = 'gmail', display_name = null, is_primary = 0, metadata = null }) {
  const existing = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`UPDATE accounts SET
      provider = COALESCE(?, provider),
      display_name = COALESCE(?, display_name),
      is_primary = ?,
      metadata = COALESCE(?, metadata),
      updated_at = strftime('%s','now')
      WHERE email = ?`
    ).run(provider, display_name, is_primary, metadata ? JSON.stringify(metadata) : null, email);
    return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  }
  const id = generateId();
  db.prepare(`INSERT INTO accounts (id, email, provider, display_name, is_primary, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email, provider, display_name, is_primary, metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function getAccount(db, email) {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
}

function getPrimaryAccount(db) {
  return db.prepare('SELECT * FROM accounts WHERE is_primary = 1 LIMIT 1').get();
}

// --- Entity Links ---

function validateEntityType(type) {
  if (!Object.values(ENTITY_TYPES).includes(type)) {
    throw new Error(`Unknown entity type: "${type}". Valid types: ${Object.keys(ENTITY_TYPES).join(', ')}`);
  }
}

function link(db, { sourceType, sourceId, targetType, targetId, relationship, metadata = null }) {
  validateEntityType(sourceType);
  validateEntityType(targetType);
  db.prepare(`INSERT INTO entity_links (source_type, source_id, target_type, target_id, relationship, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_type, source_id, target_type, target_id, relationship) DO UPDATE SET
      metadata = COALESCE(excluded.metadata, entity_links.metadata)`
  ).run(sourceType, sourceId, targetType, targetId, relationship, metadata ? JSON.stringify(metadata) : null);
}

function getLinked(db, entityType, entityId, { direction, relationship, targetType, sourceType } = {}) {
  const results = [];
  // Forward: this entity is the source
  if (direction !== 'reverse') {
    let sql = 'SELECT * FROM entity_links WHERE source_type = ? AND source_id = ?';
    const params = [entityType, entityId];
    if (targetType) { sql += ' AND target_type = ?'; params.push(targetType); }
    if (relationship) { sql += ' AND relationship = ?'; params.push(relationship); }
    results.push(...db.prepare(sql).all(...params));
  }
  // Reverse: this entity is the target
  if (direction !== 'forward') {
    let sql = 'SELECT * FROM entity_links WHERE target_type = ? AND target_id = ?';
    const params = [entityType, entityId];
    if (sourceType) { sql += ' AND source_type = ?'; params.push(sourceType); }
    if (relationship) { sql += ' AND relationship = ?'; params.push(relationship); }
    results.push(...db.prepare(sql).all(...params));
  }
  return results;
}

function unlink(db, sourceType, sourceId, targetType, targetId, relationship) {
  db.prepare(`DELETE FROM entity_links
    WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relationship = ?`
  ).run(sourceType, sourceId, targetType, targetId, relationship);
}

// --- Action Log ---

function logAction(db, { accountId = null, actor, entityType = null, entityId = null, action, context = null, outcome = null, metadata = null }) {
  db.prepare(`INSERT INTO action_log (account_id, actor, entity_type, entity_id, action, context, outcome, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId, actor, entityType, entityId, action,
    context ? JSON.stringify(context) : null,
    outcome ? JSON.stringify(outcome) : null,
    metadata ? JSON.stringify(metadata) : null
  );
}

function getEntityHistory(db, entityType, entityId) {
  return db.prepare(
    'SELECT * FROM action_log WHERE entity_type = ? AND entity_id = ? ORDER BY timestamp ASC'
  ).all(entityType, entityId);
}

function getRecentActions(db, { accountId, actor, action, since, limit = 100 } = {}) {
  let sql = 'SELECT * FROM action_log WHERE 1=1';
  const params = [];
  if (accountId) { sql += ' AND account_id = ?'; params.push(accountId); }
  if (actor) { sql += ' AND actor = ?'; params.push(actor); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (since) { sql += ' AND timestamp >= ?'; params.push(since); }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// --- Emails ---

function upsertEmail(db, accountId, { gmail_id, thread_id = null, from_addr, from_name = null,
    to_addrs = null, cc_addrs = null, subject = null, date, direction, snippet = null, metadata = null }) {
  if (gmail_id) {
    const existing = db.prepare('SELECT * FROM emails WHERE account_id = ? AND gmail_id = ?').get(accountId, gmail_id);
    if (existing) {
      db.prepare(`UPDATE emails SET
        thread_id = COALESCE(?, thread_id), from_addr = ?, from_name = COALESCE(?, from_name),
        to_addrs = COALESCE(?, to_addrs), cc_addrs = COALESCE(?, cc_addrs),
        subject = COALESCE(?, subject), date = ?, direction = ?,
        snippet = COALESCE(?, snippet), metadata = COALESCE(?, metadata)
        WHERE id = ?`
      ).run(
        thread_id, from_addr, from_name,
        to_addrs ? JSON.stringify(to_addrs) : null, cc_addrs ? JSON.stringify(cc_addrs) : null,
        subject, date, direction, snippet,
        metadata ? JSON.stringify(metadata) : null, existing.id
      );
      return db.prepare('SELECT * FROM emails WHERE id = ?').get(existing.id);
    }
  }
  const id = generateId();
  db.prepare(`INSERT INTO emails (id, account_id, gmail_id, thread_id, from_addr, from_name,
    to_addrs, cc_addrs, subject, date, direction, snippet, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, accountId, gmail_id, thread_id, from_addr, from_name,
    to_addrs ? JSON.stringify(to_addrs) : null, cc_addrs ? JSON.stringify(cc_addrs) : null,
    subject, date, direction, snippet, metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
}

function getEmailByGmailId(db, accountId, gmailId) {
  return db.prepare('SELECT * FROM emails WHERE account_id = ? AND gmail_id = ?').get(accountId, gmailId);
}

function getEmailsByThread(db, accountId, threadId) {
  return db.prepare('SELECT * FROM emails WHERE account_id = ? AND thread_id = ? ORDER BY date ASC')
    .all(accountId, threadId);
}

// --- Conversations ---

function trackConversation(db, accountId, conversation) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO conversations (
      id, account_id, type, subject, participants, state, waiting_for,
      urgency, first_seen, last_activity, metadata
    ) VALUES (
      @id, @account_id, @type, @subject, @participants, 'active', @waiting_for,
      @urgency, @first_seen, @last_activity, @metadata
    )
    ON CONFLICT(id) DO UPDATE SET
      subject = COALESCE(@subject, conversations.subject),
      last_activity = @last_activity,
      waiting_for = @waiting_for,
      updated_at = strftime('%s', 'now')
  `);

  return stmt.run({
    id: conversation.id,
    account_id: accountId,
    type: conversation.type,
    subject: conversation.subject || null,
    participants: conversation.from_user || null,
    waiting_for: conversation.waiting_for,
    urgency: (conversation.metadata && conversation.metadata.urgency) || 'normal',
    first_seen: conversation.first_seen || now,
    last_activity: conversation.last_activity || now,
    metadata: conversation.metadata ? JSON.stringify(conversation.metadata) : null
  });
}

function updateConversationState(db, id, lastSender, waitingFor) {
  return db.prepare(`
    UPDATE conversations
    SET waiting_for = ?, last_activity = strftime('%s','now'), updated_at = strftime('%s','now')
    WHERE id = ? AND state = 'active'
  `).run(waitingFor, id);
}

function resolveConversation(db, id) {
  return db.prepare(`
    UPDATE conversations
    SET state = 'resolved', resolved_at = strftime('%s', 'now'), updated_at = strftime('%s', 'now')
    WHERE id = ? AND resolved_at IS NULL
  `).run(id);
}

function getPendingResponses(db, accountId, options = {}) {
  const { type = null, olderThan = null, limit = null } = options;

  let query = `
    SELECT * FROM conversations
    WHERE account_id = ? AND waiting_for = 'my-response' AND state = 'active'
  `;
  const params = [accountId];

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }
  if (olderThan) {
    const threshold = Math.floor(Date.now() / 1000) - olderThan;
    query += ` AND last_activity < ?`;
    params.push(threshold);
  }
  query += ` ORDER BY last_activity ASC`;
  if (limit) {
    query += ` LIMIT ?`;
    params.push(limit);
  }

  return db.prepare(query).all(...params);
}

function getAwaitingReplies(db, accountId, options = {}) {
  const { type = null, olderThan = null, limit = null } = options;

  let query = `
    SELECT * FROM conversations
    WHERE account_id = ? AND waiting_for = 'their-response' AND state = 'active'
  `;
  const params = [accountId];

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }
  if (olderThan) {
    const threshold = Math.floor(Date.now() / 1000) - olderThan;
    query += ` AND last_activity < ?`;
    params.push(threshold);
  }
  query += ` ORDER BY last_activity ASC`;
  if (limit) {
    query += ` LIMIT ?`;
    params.push(limit);
  }

  return db.prepare(query).all(...params);
}

function getResolvedToday(db, accountId, type) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const epoch = Math.floor(startOfDay.getTime() / 1000);
  let sql = `SELECT * FROM conversations
    WHERE account_id = ? AND (resolved_at >= ? OR (waiting_for = 'their-response' AND updated_at >= ?))`;
  const params = [accountId, epoch, epoch];
  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }
  return db.prepare(sql).all(...params);
}

function getStats(db, accountId) {
  const rows = db.prepare(`
    SELECT
      type,
      waiting_for,
      COUNT(*) as count,
      AVG(strftime('%s', 'now') - last_activity) as avg_age_seconds
    FROM conversations
    WHERE account_id = ? AND state = 'active'
    GROUP BY type, waiting_for
  `).all(accountId);

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return { total, breakdown: rows };
}

// --- Unsubscribes ---

function recordUnsubscribe(db, accountId, { sender_addr = null, sender_domain, method,
    unsubscribe_url = null, metadata = null }) {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO unsubscribes (id, account_id, sender_addr, sender_domain, method,
    unsubscribe_url, requested_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, accountId, sender_addr, sender_domain, method, unsubscribe_url, now,
    metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM unsubscribes WHERE id = ?').get(id);
}

function checkUnsubscribed(db, accountId, senderDomain) {
  const row = db.prepare(
    'SELECT * FROM unsubscribes WHERE account_id = ? AND sender_domain = ? ORDER BY requested_at DESC LIMIT 1'
  ).get(accountId, senderDomain);
  if (!row) return { unsubscribed: false, emails_since: 0, confirmed: false };
  return {
    unsubscribed: true,
    emails_since: row.emails_since,
    confirmed: !!row.confirmed,
    requested_at: row.requested_at,
    method: row.method,
    id: row.id
  };
}

function incrementEmailsSince(db, accountId, senderDomain) {
  db.prepare(
    `UPDATE unsubscribes SET emails_since = emails_since + 1
     WHERE account_id = ? AND sender_domain = ? AND id = (
       SELECT id FROM unsubscribes WHERE account_id = ? AND sender_domain = ?
       ORDER BY requested_at DESC LIMIT 1
     )`
  ).run(accountId, senderDomain, accountId, senderDomain);
}

function confirmUnsubscribe(db, unsubscribeId) {
  db.prepare(
    "UPDATE unsubscribes SET confirmed = 1, confirmed_at = strftime('%s','now') WHERE id = ?"
  ).run(unsubscribeId);
}

// --- Email Rules ---

const ALLOWED_RULE_TYPES = ['archive', 'alert', 'demote', 'flag'];

function createRule(db, accountId, { rule_type, match_from = null, match_from_domain = null,
    match_to = null, match_subject_contains = null, source_email = null, source_subject = null, metadata = null }) {
  if (rule_type === 'delete') {
    throw new Error('Delete rules are not allowed. Use archive, alert, demote, or flag.');
  }
  const mf = match_from ? match_from.toLowerCase() : null;
  const mfd = match_from_domain ? match_from_domain.toLowerCase() : null;
  const mt = match_to ? match_to.toLowerCase() : null;
  const msc = match_subject_contains ? match_subject_contains.toLowerCase() : null;

  const result = db.prepare(`INSERT INTO email_rules
    (account_id, rule_type, match_from, match_from_domain, match_to, match_subject_contains, source_email, source_subject, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, rule_type, COALESCE(match_from,''), COALESCE(match_from_domain,''),
                 COALESCE(match_to,''), COALESCE(match_subject_contains,''))
    DO UPDATE SET active = 1, source_email = COALESCE(excluded.source_email, email_rules.source_email),
                  source_subject = COALESCE(excluded.source_subject, email_rules.source_subject)`
  ).run(accountId, rule_type, mf, mfd, mt, msc, source_email, source_subject,
    metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM email_rules WHERE id = ?').get(result.lastInsertRowid);
}

function getActiveRules(db, accountId) {
  return db.prepare('SELECT * FROM email_rules WHERE account_id = ? AND active = 1').all(accountId);
}

function recordRuleHit(db, ruleId) {
  db.prepare(
    "UPDATE email_rules SET hit_count = hit_count + 1, last_hit_at = strftime('%s','now') WHERE id = ?"
  ).run(ruleId);
}

function deactivateRule(db, ruleId) {
  db.prepare('UPDATE email_rules SET active = 0 WHERE id = ?').run(ruleId);
}

function getRuleById(db, ruleId) {
  return db.prepare('SELECT * FROM email_rules WHERE id = ?').get(ruleId);
}

function getRulesSummary(db, accountId) {
  const total = db.prepare('SELECT COUNT(*) as c FROM email_rules WHERE account_id = ? AND active = 1').get(accountId).c;
  const top = db.prepare(
    'SELECT * FROM email_rules WHERE account_id = ? AND active = 1 ORDER BY hit_count DESC LIMIT 10'
  ).all(accountId);
  return { total, top };
}

module.exports = {
  DB_PATH,
  ENTITY_TYPES,
  RELATIONSHIPS,
  ALLOWED_RULE_TYPES,
  initDatabase,
  upsertAccount,
  getAccount,
  getPrimaryAccount,
  link,
  getLinked,
  unlink,
  logAction,
  getEntityHistory,
  getRecentActions,
  upsertEmail,
  getEmailByGmailId,
  getEmailsByThread,
  trackConversation,
  updateConversationState,
  resolveConversation,
  getPendingResponses,
  getAwaitingReplies,
  getResolvedToday,
  getStats,
  recordUnsubscribe,
  checkUnsubscribed,
  incrementEmailsSince,
  confirmUnsubscribe,
  createRule,
  getActiveRules,
  recordRuleHit,
  deactivateRule,
  getRuleById,
  getRulesSummary,
};
