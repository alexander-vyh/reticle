#!/usr/bin/env node
/**
 * Follow-Up Checker - Periodically check for conversations needing attention
 * Sends notifications based on thresholds (immediate, 4h, daily, escalation)
 */

const https = require('https');
const reticleDb = require('./reticle-db');
const log = require('./lib/logger')('followup-checker');

const config = require('./lib/config');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');

// Configuration
const CONFIG = {
  slackToken: config.slackBotToken,
  mySlackUserId: config.slackUserId,
  checkInterval: 15 * 60 * 1000, // Check every 15 minutes

  // Notification thresholds (in seconds)
  thresholds: {
    immediate: {
      // VIP or critical - notify right away
      slackDm: 0,
      slackMention: 0,
      email: 0
    },
    batch4h: {
      // Regular items - batch every 4 hours
      slackDm: 4 * 3600,
      slackMention: 4 * 3600,
      email: 4 * 3600
    },
    daily: {
      // Daily summary at 9am
      email: 24 * 3600,
      slackDm: 24 * 3600,
      slackMention: 24 * 3600
    },
    escalation: {
      // Escalate if very old
      email: 48 * 3600,       // 2 days
      slackDm: 3 * 24 * 3600, // 3 days
      slackMention: 7 * 24 * 3600 // 1 week
    }
  }
};

let db = null;
let accountId = null;
let lastDailyDigest = null;
let last4hCheck = null;
let lastEodDate = null;
let errorCount = 0;

// Check timer — stored so SIGHUP can reset it with updated interval
let checkTimer = null;

/**
 * Send Slack DM
 */
function sendSlackDM(message, blocks = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      channel: CONFIG.mySlackUserId,
      text: message,
      blocks: blocks || undefined,
      unfurl_links: false
    });

    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.slackToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.ok) {
            resolve(response);
          } else {
            reject(new Error(`Slack API error: ${response.error}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Format time duration
 */
function formatDuration(seconds) {
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} minutes`;
  } else if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} hours`;
  } else {
    const days = Math.floor(seconds / 86400);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
}

/**
 * Build daily digest message
 */
function buildDailyDigest(pending, awaiting) {
  const now = Math.floor(Date.now() / 1000);

  let message = `🌅 *Good morning! Follow-ups needed:*\n\n`;

  // Group by type
  const emails = pending.filter(c => c.type === 'email');
  const dms = pending.filter(c => c.type === 'slack-dm');
  const mentions = pending.filter(c => c.type === 'slack-mention');

  if (emails.length > 0) {
    message += `📧 *Email* (${emails.length}):\n`;
    emails.slice(0, 5).forEach(conv => {
      const age = formatDuration(now - conv.last_activity);
      message += `• ${conv.from_name || conv.from_user} - ${conv.subject} (waiting ${age})\n`;
    });
    if (emails.length > 5) {
      message += `  _...and ${emails.length - 5} more_\n`;
    }
    message += '\n';
  }

  if (dms.length > 0) {
    message += `💬 *Slack DMs* (${dms.length}):\n`;
    dms.slice(0, 5).forEach(conv => {
      const age = formatDuration(now - conv.last_activity);
      const preview = conv.subject ? `"${conv.subject.substring(0, 50)}..."` : '';
      message += `• ${conv.from_name || conv.from_user} - ${preview} (${age} ago)\n`;
    });
    if (dms.length > 5) {
      message += `  _...and ${dms.length - 5} more_\n`;
    }
    message += '\n';
  }

  if (mentions.length > 0) {
    message += `📢 *Mentions* (${mentions.length}):\n`;
    mentions.slice(0, 5).forEach(conv => {
      const age = formatDuration(now - conv.last_activity);
      message += `• #${conv.channel_name || conv.channel_id} - ${conv.from_name} mentioned you (${age} ago)\n`;
    });
    if (mentions.length > 5) {
      message += `  _...and ${mentions.length - 5} more_\n`;
    }
    message += '\n';
  }

  // Awaiting replies
  const awaitingEmails = awaiting.filter(c => c.type === 'email');
  if (awaitingEmails.length > 0) {
    message += `⏳ *Awaiting replies* (${awaitingEmails.length}):\n`;
    awaitingEmails.slice(0, 3).forEach(conv => {
      const age = formatDuration(now - conv.last_activity);
      message += `• ${conv.from_name || conv.from_user} - ${conv.subject} (${age} since you sent)\n`;
    });
    if (awaitingEmails.length > 3) {
      message += `  _...and ${awaitingEmails.length - 3} more_\n`;
    }
  }

  if (emails.length === 0 && dms.length === 0 && mentions.length === 0) {
    message = `✨ All caught up! No pending follow-ups.`;
  }

  return message;
}

/**
 * Check for items needing immediate attention
 */
async function checkImmediate() {
  // For now, VIP detection is handled by gmail-monitor
  // This is a placeholder for future immediate notifications
  log.debug('Checking for immediate items');
}

/**
 * Build EOD email section for the 4-hour batch notification
 * Returns null if nothing noteworthy to report (conditional suppression)
 */
function buildEODSection(db) {
  const now = Math.floor(Date.now() / 1000);
  const pendingEmails = reticleDb.getPendingResponses(db, accountId, { type: 'email' });
  const respondedTodayCount = reticleDb.getResolvedToday(db, accountId, 'email').length;

  // Split pending into urgent vs non-urgent by parsing metadata
  const urgent = [];
  const nonUrgent = [];
  for (const conv of pendingEmails) {
    let meta = null;
    try { if (conv.metadata) meta = JSON.parse(conv.metadata); } catch (e) {}
    if (meta?.urgency === 'urgent') {
      urgent.push({ ...conv, meta });
    } else {
      nonUrgent.push(conv);
    }
  }

  // Conditional suppression: skip if no urgent unreplied and <= 5 total unreplied
  if (urgent.length === 0 && pendingEmails.length <= 5 && respondedTodayCount === 0) {
    log.info({
      urgentCount: 0,
      pendingCount: pendingEmails.length,
      respondedToday: 0,
    }, 'EOD section suppressed — quiet email day');
    return null;
  }

  log.info({
    urgentCount: urgent.length,
    nonUrgentCount: nonUrgent.length,
    carryForwardCount: pendingEmails.length,
    respondedToday: respondedTodayCount,
  }, 'EOD section built');

  let section = `\n\n📊 *End of Day — Email*\n`;
  section += `Responded to ${respondedTodayCount} today.`;
  if (pendingEmails.length > 0) {
    section += ` Carrying ${pendingEmails.length} to tomorrow.`;
  }
  section += '\n';

  if (urgent.length > 0) {
    section += `\n🔴 *Urgent unreplied* (${urgent.length}):\n`;
    urgent.slice(0, 5).forEach(conv => {
      const age = formatDuration(now - conv.last_activity);
      const reason = conv.meta?.reason || '';
      section += `• ${conv.from_name || conv.from_user} — ${conv.subject || 'No subject'} (${age} ago)${reason ? ` — ${reason}` : ''}\n`;
    });
    if (urgent.length > 5) {
      section += `  _...and ${urgent.length - 5} more_\n`;
    }
  }

  if (nonUrgent.length > 0) {
    section += `\n📬 *Other unreplied* (${nonUrgent.length}):\n`;
    nonUrgent.slice(0, 3).forEach(conv => {
      const age = formatDuration(now - conv.last_activity);
      section += `• ${conv.from_name || conv.from_user} — ${conv.subject || 'No subject'} (${age} ago)\n`;
    });
    if (nonUrgent.length > 3) {
      section += `  _...and ${nonUrgent.length - 3} more_\n`;
    }
  }

  return section;
}

/**
 * Check for 4-hour batch items
 */
async function check4Hour() {
  const now = Math.floor(Date.now() / 1000);

  // Get items older than 4 hours that haven't been notified recently
  const pending = reticleDb.getPendingResponses(db, accountId, {
    olderThan: CONFIG.thresholds.batch4h.slackDm
  }).filter(conv => {
    // Only notify if we haven't notified in the last 4 hours
    return !conv.notified_at || (now - conv.notified_at) > CONFIG.thresholds.batch4h.slackDm;
  });

  const dms = pending.filter(c => c.type === 'slack-dm');
  const mentions = pending.filter(c => c.type === 'slack-mention');

  // Build the main message (DMs + mentions)
  let hasContent = dms.length > 0 || mentions.length > 0;
  let message = '';

  if (hasContent) {
    message = `💬 *Follow-ups needed:*\n\n`;

    if (dms.length > 0) {
      message += `*DMs* (${dms.length}):\n`;
      dms.slice(0, 3).forEach(conv => {
        const age = formatDuration(now - conv.last_activity);
        message += `• ${conv.from_name || conv.from_user} (${age} ago)\n`;
      });
      if (dms.length > 3) message += `  _...and ${dms.length - 3} more_\n`;
    }

    if (mentions.length > 0) {
      message += `\n*Mentions* (${mentions.length}):\n`;
      mentions.slice(0, 3).forEach(conv => {
        const age = formatDuration(now - conv.last_activity);
        message += `• #${conv.channel_name || conv.channel_id} (${age} ago)\n`;
      });
      if (mentions.length > 3) message += `  _...and ${mentions.length - 3} more_\n`;
    }
  }

  // Append EOD email section once per evening (after 5 PM, at most once per calendar day)
  const hour = new Date().getHours();
  const today = new Date().toDateString();
  if (hour >= 17 && lastEodDate !== today) {
    const eodSection = buildEODSection(db);
    if (eodSection) {
      if (!hasContent) message = '📊 *End-of-Day Summary*';
      message += eodSection;
      hasContent = true;
      lastEodDate = today;
    }
  }

  if (!hasContent) {
    log.info('No 4-hour batch items or EOD content — skipping notification');
    return;
  }

  await sendSlackDM(message);
  log.info({ count: pending.length, dms: dms.length, mentions: mentions.length, eod: hour >= 17 }, 'Sent 4-hour batch notification');

  // Mark individual conversations as notified (for dedup filtering)
  pending.forEach(conv => {
    reticleDb.markNotified(db, conv.id);
  });

  // Log one row per batch sent (not per conversation)
  if (pending.length > 0) {
    reticleDb.logNotification(db, accountId, pending[0].id, '4h-batch', 'slack', {
      batchSize: pending.length,
      dms: dms.length,
      mentions: mentions.length
    });
  }
}

/**
 * Send daily digest
 */
async function checkDaily() {
  const now = new Date();
  const hour = now.getHours();

  // Send at 9am
  if (hour !== 9) return;

  // Only send once per day
  const today = now.toISOString().split('T')[0];
  if (lastDailyDigest === today) return;

  const pending = reticleDb.getPendingResponses(db, accountId);
  const awaiting = reticleDb.getAwaitingReplies(db, accountId, {
    olderThan: CONFIG.thresholds.daily.email
  });

  if (pending.length === 0 && awaiting.length === 0) {
    log.debug('No items for daily digest');
    return;
  }

  const message = buildDailyDigest(pending, awaiting);

  await sendSlackDM(message);
  log.info({ pending: pending.length, awaiting: awaiting.length }, 'Sent daily digest');

  lastDailyDigest = today;

  // Mark individual conversations as notified (prevents immediate re-notification in 4h-batch)
  pending.forEach(conv => {
    reticleDb.markNotified(db, conv.id);
  });

  // Log one row per digest sent (not per conversation)
  if (pending.length > 0) {
    reticleDb.logNotification(db, accountId, pending[0].id, 'daily-digest', 'slack', {
      pendingCount: pending.length,
      awaitingCount: awaiting.length
    });
  }
}

/**
 * Check for escalations
 */
async function checkEscalations() {
  const now = Math.floor(Date.now() / 1000);

  const escalated = reticleDb.getPendingResponses(db, accountId).filter(conv => {
    const age = now - conv.last_activity;
    const threshold = CONFIG.thresholds.escalation[conv.type];

    // Escalate if older than threshold and we haven't escalated recently
    // Uses escalated_at (not notified_at) so 4h-batch notifications don't suppress escalations
    if (age > threshold) {
      const lastEscalation = conv.escalated_at;
      return !lastEscalation || (now - lastEscalation) > 86400; // Re-escalate daily
    }
    return false;
  });

  if (escalated.length === 0) {
    log.debug('No items eligible for escalation');
    return;
  }

  let message = `🚨 *ESCALATION: Old pending items*\n\n`;

  escalated.forEach(conv => {
    const age = formatDuration(now - conv.last_activity);
    const icon = conv.type === 'email' ? '📧' : conv.type === 'slack-dm' ? '💬' : '📢';
    message += `${icon} ${conv.from_name || conv.from_user} - waiting *${age}*\n`;
    if (conv.subject) message += `   "${conv.subject.substring(0, 60)}..."\n`;
  });

  await sendSlackDM(message);
  log.warn({ count: escalated.length, items: escalated.map(c => ({ id: c.id, type: c.type, from: c.from_name || c.from_user })) }, 'Sent escalation notification');

  escalated.forEach(conv => {
    reticleDb.markEscalated(db, conv.id);
    reticleDb.logNotification(db, accountId, conv.id, 'escalation');
  });
}

/**
 * Main check loop
 */
async function runChecks() {
  const pendingCount = reticleDb.getPendingResponses(db, accountId, {}).length;
  const awaitingCount = reticleDb.getAwaitingReplies(db, accountId, {}).length;
  log.info({ pendingCount, awaitingCount }, 'Running follow-up checks');

  try {
    await checkImmediate();
    await check4Hour();
    await checkDaily();
    await checkEscalations();

    heartbeat.write('followup-checker', {
      checkInterval: CONFIG.checkInterval,
      status: 'ok',
      metrics: { pendingCount, awaitingCount },
    });
  } catch (error) {
    log.error({ err: error }, 'Error in checks');
    heartbeat.write('followup-checker', {
      checkInterval: CONFIG.checkInterval,
      status: 'error',
      errors: { lastError: error.message, lastErrorAt: Date.now(), countSinceStart: ++errorCount }
    });
  }
}

/**
 * Main
 */
async function main() {
  log.info({ checkIntervalMin: CONFIG.checkInterval / 60000 }, 'Follow-Up Checker starting');

  const validation = validatePrerequisites('followup-checker', [
    { type: 'database', path: reticleDb.DB_PATH, description: 'Reticle database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  // Initialize database
  db = reticleDb.initDatabase();
  const primaryAccount = reticleDb.upsertAccount(db, {
    email: config.gmailAccount,
    provider: 'gmail',
    display_name: 'Primary',
    is_primary: 1
  });
  accountId = primaryAccount.id;
  log.info('Reticle DB initialized');

  // Initial check
  await runChecks();

  // Set up interval
  checkTimer = setInterval(runChecks, CONFIG.checkInterval);
}

function shutdown(signal) {
  log.info({ signal }, 'Shutting down gracefully');
  heartbeat.write('followup-checker', { checkInterval: CONFIG.checkInterval, status: 'shutting-down' });
  if (db) try { db.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('SIGHUP', () => {
  log.info('Received SIGHUP, reloading settings');
  try {
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(config.configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      CONFIG.checkInterval = (settings.polling?.followupCheckIntervalMinutes ?? 15) * 60 * 1000;
      // Update escalation thresholds if provided
      if (settings.thresholds) {
        if (settings.thresholds.escalation) {
          Object.assign(CONFIG.thresholds.escalation, settings.thresholds.escalation);
        }
      }
      log.info({ checkIntervalMs: CONFIG.checkInterval }, 'Settings reloaded');
    }
  } catch (e) {
    log.warn({ error: e.message }, 'Failed to reload settings, keeping current values');
  }

  // Reset the timer so the new interval takes effect immediately
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = setInterval(runChecks, CONFIG.checkInterval);
    log.info({ newInterval: CONFIG.checkInterval }, 'Poll timer reset');
  }
});

main().catch(error => {
  log.fatal({ err: error }, 'Fatal error');
  process.exit(1);
});
