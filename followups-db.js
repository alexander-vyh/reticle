#!/usr/bin/env node
/**
 * Follow-ups Database - Track conversations needing responses across email and Slack
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.HOME, '.openclaw/workspace/followups.db');

/**
 * Initialize database with schema
 */
function initDatabase() {
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,           -- 'email', 'slack-dm', 'slack-mention'
      subject TEXT,                  -- Email subject or Slack message preview
      from_user TEXT NOT NULL,       -- Email address or Slack user ID
      from_name TEXT,                -- Display name
      channel_id TEXT,               -- For Slack mentions, the channel ID
      channel_name TEXT,             -- For Slack mentions, the channel name
      last_activity INTEGER NOT NULL, -- Unix timestamp
      last_sender TEXT NOT NULL,     -- 'me' or 'them'
      waiting_for TEXT NOT NULL,     -- 'my-response' or 'their-response'
      first_seen INTEGER NOT NULL,   -- When we first tracked this
      notified_at INTEGER,           -- When we last sent a notification
      resolved_at INTEGER,           -- When conversation was resolved (null if active)
      metadata TEXT,                 -- JSON for additional context
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_type ON conversations(type);
    CREATE INDEX IF NOT EXISTS idx_waiting_for ON conversations(waiting_for);
    CREATE INDEX IF NOT EXISTS idx_resolved_at ON conversations(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_last_activity ON conversations(last_activity);

    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      notification_type TEXT NOT NULL, -- 'immediate', '4h', 'daily', 'escalation'
      sent_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_notif_conversation ON notification_log(conversation_id);
  `);

  return db;
}

/**
 * Track or update a conversation
 */
function trackConversation(db, conversation) {
  const stmt = db.prepare(`
    INSERT INTO conversations (
      id, type, subject, from_user, from_name, channel_id, channel_name,
      last_activity, last_sender, waiting_for, first_seen, metadata
    ) VALUES (
      @id, @type, @subject, @from_user, @from_name, @channel_id, @channel_name,
      @last_activity, @last_sender, @waiting_for, @first_seen, @metadata
    )
    ON CONFLICT(id) DO UPDATE SET
      subject = @subject,
      last_activity = @last_activity,
      last_sender = @last_sender,
      waiting_for = @waiting_for,
      updated_at = strftime('%s', 'now')
  `);

  return stmt.run({
    id: conversation.id,
    type: conversation.type,
    subject: conversation.subject || null,
    from_user: conversation.from_user,
    from_name: conversation.from_name || null,
    channel_id: conversation.channel_id || null,
    channel_name: conversation.channel_name || null,
    last_activity: conversation.last_activity,
    last_sender: conversation.last_sender,
    waiting_for: conversation.waiting_for,
    first_seen: conversation.first_seen || conversation.last_activity,
    metadata: conversation.metadata ? JSON.stringify(conversation.metadata) : null
  });
}

/**
 * Mark conversation as resolved
 */
function resolveConversation(db, id) {
  const stmt = db.prepare(`
    UPDATE conversations
    SET resolved_at = strftime('%s', 'now'),
        updated_at = strftime('%s', 'now')
    WHERE id = ? AND resolved_at IS NULL
  `);
  return stmt.run(id);
}

/**
 * Get conversations needing my response
 */
function getPendingResponses(db, options = {}) {
  const {
    type = null,
    olderThan = null, // seconds
    limit = null
  } = options;

  let query = `
    SELECT * FROM conversations
    WHERE waiting_for = 'my-response'
      AND resolved_at IS NULL
  `;

  const params = {};

  if (type) {
    query += ` AND type = @type`;
    params.type = type;
  }

  if (olderThan) {
    const threshold = Math.floor(Date.now() / 1000) - olderThan;
    query += ` AND last_activity < @threshold`;
    params.threshold = threshold;
  }

  query += ` ORDER BY last_activity ASC`;

  if (limit) {
    query += ` LIMIT @limit`;
    params.limit = limit;
  }

  const stmt = db.prepare(query);
  return stmt.all(params);
}

/**
 * Get conversations where I'm waiting for their response
 */
function getAwaitingReplies(db, options = {}) {
  const {
    type = null,
    olderThan = null,
    limit = null
  } = options;

  let query = `
    SELECT * FROM conversations
    WHERE waiting_for = 'their-response'
      AND resolved_at IS NULL
  `;

  const params = {};

  if (type) {
    query += ` AND type = @type`;
    params.type = type;
  }

  if (olderThan) {
    const threshold = Math.floor(Date.now() / 1000) - olderThan;
    query += ` AND last_activity < @threshold`;
    params.threshold = threshold;
  }

  query += ` ORDER BY last_activity ASC`;

  if (limit) {
    query += ` LIMIT @limit`;
    params.limit = limit;
  }

  const stmt = db.prepare(query);
  return stmt.all(params);
}

/**
 * Log notification sent
 */
function logNotification(db, conversationId, notificationType) {
  const stmt = db.prepare(`
    INSERT INTO notification_log (conversation_id, notification_type)
    VALUES (?, ?)
  `);
  return stmt.run(conversationId, notificationType);
}

/**
 * Update notification timestamp on conversation
 */
function markNotified(db, id) {
  const stmt = db.prepare(`
    UPDATE conversations
    SET notified_at = strftime('%s', 'now')
    WHERE id = ?
  `);
  return stmt.run(id);
}

/**
 * Get summary statistics
 */
function getStats(db) {
  const stats = db.prepare(`
    SELECT
      type,
      waiting_for,
      COUNT(*) as count,
      AVG(strftime('%s', 'now') - last_activity) as avg_age_seconds
    FROM conversations
    WHERE resolved_at IS NULL
    GROUP BY type, waiting_for
  `).all();

  return stats;
}

module.exports = {
  initDatabase,
  trackConversation,
  resolveConversation,
  getPendingResponses,
  getAwaitingReplies,
  logNotification,
  markNotified,
  getStats,
  DB_PATH
};
