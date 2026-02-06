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

    CREATE TABLE IF NOT EXISTS o3_sessions (
      id TEXT PRIMARY KEY,
      report_name TEXT NOT NULL,
      report_email TEXT NOT NULL,
      scheduled_start INTEGER NOT NULL,
      scheduled_end INTEGER NOT NULL,
      verified INTEGER,
      zoom_meeting_id TEXT,
      zoom_summary TEXT,
      prep_sent_afternoon INTEGER,
      prep_sent_before INTEGER,
      post_nudge_sent INTEGER,
      lattice_logged INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_o3_report ON o3_sessions(report_email);
    CREATE INDEX IF NOT EXISTS idx_o3_start ON o3_sessions(scheduled_start);
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

/**
 * Upsert an O3 session (idempotent — safe to call every poll cycle)
 */
function upsertO3Session(db, session) {
  const stmt = db.prepare(`
    INSERT INTO o3_sessions (id, report_name, report_email, scheduled_start, scheduled_end, created_at)
    VALUES (@id, @report_name, @report_email, @scheduled_start, @scheduled_end, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      scheduled_start = @scheduled_start,
      scheduled_end = @scheduled_end
  `);
  return stmt.run({
    id: session.id,
    report_name: session.report_name,
    report_email: session.report_email,
    scheduled_start: session.scheduled_start,
    scheduled_end: session.scheduled_end,
    created_at: Math.floor(Date.now() / 1000)
  });
}

/**
 * Mark a notification as sent for an O3 session
 * @param {string} field - 'prep_sent_afternoon', 'prep_sent_before', or 'post_nudge_sent'
 */
function markO3Notified(db, eventId, field) {
  const allowed = ['prep_sent_afternoon', 'prep_sent_before', 'post_nudge_sent'];
  if (!allowed.includes(field)) throw new Error(`Invalid O3 notification field: ${field}`);
  const stmt = db.prepare(`UPDATE o3_sessions SET ${field} = ? WHERE id = ?`);
  return stmt.run(Math.floor(Date.now() / 1000), eventId);
}

/**
 * Mark O3 as logged in Lattice
 */
function markO3LatticeLogged(db, eventId) {
  const stmt = db.prepare(`UPDATE o3_sessions SET lattice_logged = ? WHERE id = ?`);
  return stmt.run(Math.floor(Date.now() / 1000), eventId);
}

/**
 * Get O3 session by event ID
 */
function getO3Session(db, eventId) {
  return db.prepare('SELECT * FROM o3_sessions WHERE id = ?').get(eventId);
}

/**
 * Get all O3 sessions for a report in a date range
 */
function getO3SessionsForReport(db, reportEmail, startTs, endTs) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE report_email = ? AND scheduled_start >= ? AND scheduled_start <= ? ORDER BY scheduled_start DESC'
  ).all(reportEmail, startTs, endTs);
}

/**
 * Get the most recent O3 session for a report (before a given timestamp)
 */
function getLastO3ForReport(db, reportEmail, beforeTs) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE report_email = ? AND scheduled_start < ? ORDER BY scheduled_start DESC LIMIT 1'
  ).get(reportEmail, beforeTs || Math.floor(Date.now() / 1000));
}

/**
 * Get O3 sessions in a week range for weekly summary
 */
function getWeeklyO3Summary(db, weekStartTs, weekEndTs) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE scheduled_start >= ? AND scheduled_start <= ? ORDER BY report_name, scheduled_start'
  ).all(weekStartTs, weekEndTs);
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
  // O3 helpers
  upsertO3Session,
  markO3Notified,
  markO3LatticeLogged,
  getO3Session,
  getO3SessionsForReport,
  getLastO3ForReport,
  getWeeklyO3Summary,
  DB_PATH
};
