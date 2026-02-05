#!/usr/bin/env node
/**
 * Follow-Up Checker - Periodically check for conversations needing attention
 * Sends notifications based on thresholds (immediate, 4h, daily, escalation)
 */

const https = require('https');
const followupsDb = require('./followups-db');

// Configuration
const CONFIG = {
  slackToken: 'REDACTED_SLACK_BOT_TOKEN',
  mySlackUserId: 'REDACTED_SLACK_USER_ID',
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
let lastDailyDigest = null;
let last4hCheck = null;

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
        'Content-Length': data.length
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
  console.log('  Checking for immediate items...');
}

/**
 * Check for 4-hour batch items
 */
async function check4Hour() {
  const now = Math.floor(Date.now() / 1000);

  // Get items older than 4 hours that haven't been notified recently
  const pending = followupsDb.getPendingResponses(db, {
    olderThan: CONFIG.thresholds.batch4h.slackDm
  }).filter(conv => {
    // Only notify if we haven't notified in the last 4 hours
    return !conv.notified_at || (now - conv.notified_at) > CONFIG.thresholds.batch4h.slackDm;
  });

  if (pending.length === 0) {
    console.log('  No 4-hour batch items');
    return;
  }

  const dms = pending.filter(c => c.type === 'slack-dm');
  const mentions = pending.filter(c => c.type === 'slack-mention');

  if (dms.length > 0 || mentions.length > 0) {
    let message = `💬 *Follow-ups needed:*\n\n`;

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

    await sendSlackDM(message);
    console.log(`  ✓ Sent 4-hour batch notification (${pending.length} items)`);

    // Mark as notified
    pending.forEach(conv => {
      followupsDb.markNotified(db, conv.id);
      followupsDb.logNotification(db, conv.id, '4h-batch');
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

  const pending = followupsDb.getPendingResponses(db);
  const awaiting = followupsDb.getAwaitingReplies(db, {
    olderThan: CONFIG.thresholds.daily.email
  });

  if (pending.length === 0 && awaiting.length === 0) {
    console.log('  No items for daily digest');
    return;
  }

  const message = buildDailyDigest(pending, awaiting);

  await sendSlackDM(message);
  console.log(`  ✓ Sent daily digest (${pending.length} pending, ${awaiting.length} awaiting)`);

  lastDailyDigest = today;

  // Mark as notified
  pending.forEach(conv => {
    followupsDb.logNotification(db, conv.id, 'daily-digest');
  });
}

/**
 * Check for escalations
 */
async function checkEscalations() {
  const now = Math.floor(Date.now() / 1000);

  const escalated = followupsDb.getPendingResponses(db).filter(conv => {
    const age = now - conv.last_activity;
    const threshold = CONFIG.thresholds.escalation[conv.type];

    // Escalate if older than threshold and we haven't escalated recently
    if (age > threshold) {
      const lastEscalation = conv.notified_at;
      return !lastEscalation || (now - lastEscalation) > 86400; // Re-escalate daily
    }
    return false;
  });

  if (escalated.length === 0) return;

  let message = `🚨 *ESCALATION: Old pending items*\n\n`;

  escalated.forEach(conv => {
    const age = formatDuration(now - conv.last_activity);
    const icon = conv.type === 'email' ? '📧' : conv.type === 'slack-dm' ? '💬' : '📢';
    message += `${icon} ${conv.from_name || conv.from_user} - waiting *${age}*\n`;
    if (conv.subject) message += `   "${conv.subject.substring(0, 60)}..."\n`;
  });

  await sendSlackDM(message);
  console.log(`  ✓ Sent escalation notification (${escalated.length} items)`);

  escalated.forEach(conv => {
    followupsDb.markNotified(db, conv.id);
    followupsDb.logNotification(db, conv.id, 'escalation');
  });
}

/**
 * Main check loop
 */
async function runChecks() {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] Running follow-up checks...`);

  try {
    await checkImmediate();
    await check4Hour();
    await checkDaily();
    await checkEscalations();
  } catch (error) {
    console.error('  ✗ Error in checks:', error.message);
  }
}

/**
 * Main
 */
async function main() {
  console.log('👀 Follow-Up Checker started');
  console.log(`   Check interval: ${CONFIG.checkInterval / 60000} minutes\n`);

  // Initialize database
  db = followupsDb.initDatabase();
  console.log('   ✓ Database initialized\n');

  // Initial check
  await runChecks();

  // Set up interval
  setInterval(runChecks, CONFIG.checkInterval);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
