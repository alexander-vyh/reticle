#!/usr/bin/env node
/**
 * OpenClaw Slack Monitor - Tracks unanswered DMs and @mentions
 * Reminds you if you haven't responded within 10 minutes
 */

const https = require('https');
const fs = require('fs');

// Configuration
const CONFIG = {
  slackToken: 'REDACTED_SLACK_BOT_TOKEN',
  myUsername: 'redacted.username', // Your Slack username
  checkInterval: 2 * 60 * 1000, // Check every 2 minutes
  responseTimeout: 10 * 60 * 1000, // 10 minutes in milliseconds
  stateFile: process.env.HOME + '/.openclaw/workspace/slack-monitor-state.json'
};

// Tracked messages awaiting response
let pendingMessages = {};

/**
 * Make Slack API call
 */
function slackAPI(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const path = `/api/${endpoint}${query ? '?' + query : ''}`;

    const options = {
      hostname: 'slack.com',
      path: path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${CONFIG.slackToken}` }
    };

    https.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.ok) {
            resolve(data);
          } else {
            reject(new Error(`Slack API error: ${data.error}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Post Slack message
 */
function postMessage(channel, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ channel, text, unfurl_links: false });

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
            reject(new Error(`Slack error: ${response.error}`));
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
 * Get my user ID
 */
async function getMyUserId() {
  const data = await slackAPI('auth.test');
  return data.user_id;
}

/**
 * Get recent DMs
 */
async function getRecentDMs(myUserId) {
  try {
    // Get list of DM conversations
    const conversations = await slackAPI('conversations.list', {
      types: 'im',
      limit: 100
    });

    const dms = [];

    for (const channel of conversations.channels || []) {
      try {
        // Get recent messages from this DM
        const history = await slackAPI('conversations.history', {
          channel: channel.id,
          limit: 20
        });

        for (const message of history.messages || []) {
          // Skip my own messages and bot messages
          if (message.user === myUserId || message.bot_id) continue;

          // Check if this is a recent message (last hour)
          const messageTime = parseFloat(message.ts) * 1000;
          if (Date.now() - messageTime < 60 * 60 * 1000) {
            dms.push({
              channel: channel.id,
              user: message.user,
              text: message.text,
              ts: message.ts,
              time: messageTime
            });
          }
        }
      } catch (error) {
        // Skip inaccessible channels
        continue;
      }
    }

    return dms;
  } catch (error) {
    console.error('Error fetching DMs:', error.message);
    return [];
  }
}

/**
 * Get recent @mentions in channels
 */
async function getRecentMentions(myUserId) {
  try {
    // Search for recent mentions
    const results = await slackAPI('search.messages', {
      query: `<@${myUserId}>`,
      count: 20,
      sort: 'timestamp',
      sort_dir: 'desc'
    });

    const mentions = [];

    for (const match of results.messages?.matches || []) {
      const messageTime = parseFloat(match.ts) * 1000;

      // Only recent mentions (last hour)
      if (Date.now() - messageTime < 60 * 60 * 1000) {
        // Skip if it's my own message
        if (match.user === myUserId) continue;

        mentions.push({
          channel: match.channel?.id,
          channelName: match.channel?.name,
          user: match.user,
          username: match.username,
          text: match.text,
          ts: match.ts,
          time: messageTime,
          permalink: match.permalink
        });
      }
    }

    return mentions;
  } catch (error) {
    console.error('Error fetching mentions:', error.message);
    return [];
  }
}

/**
 * Check if I replied to a message
 */
async function hasReplied(channel, originalTs, myUserId) {
  try {
    const history = await slackAPI('conversations.history', {
      channel: channel,
      oldest: originalTs,
      limit: 50
    });

    // Check if any message after the original is from me
    for (const message of history.messages || []) {
      if (message.ts > originalTs && message.user === myUserId) {
        return true;
      }
    }

    return false;
  } catch (error) {
    return false; // Assume not replied if we can't check
  }
}

/**
 * Load state
 */
function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const data = fs.readFileSync(CONFIG.stateFile, 'utf-8');
      pendingMessages = JSON.parse(data);
    }
  } catch (error) {
    pendingMessages = {};
  }
}

/**
 * Save state
 */
function saveState() {
  try {
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(pendingMessages, null, 2));
  } catch (error) {
    console.error('Error saving state:', error.message);
  }
}

/**
 * Main check function
 */
async function checkSlack() {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] Checking Slack for unanswered messages...`);

  try {
    const myUserId = await getMyUserId();

    // Get recent DMs and mentions
    const [dms, mentions] = await Promise.all([
      getRecentDMs(myUserId),
      getRecentMentions(myUserId)
    ]);

    console.log(`  Found ${dms.length} recent DM(s), ${mentions.length} mention(s)`);

    const now = Date.now();
    const allMessages = [...dms, ...mentions];

    // Check each message
    for (const msg of allMessages) {
      const msgKey = `${msg.channel}_${msg.ts}`;

      // Skip if already processed
      if (pendingMessages[msgKey]?.reminded) continue;

      // Check if I've replied
      const replied = await hasReplied(msg.channel, msg.ts, myUserId);

      if (replied) {
        // Mark as resolved
        if (pendingMessages[msgKey]) {
          delete pendingMessages[msgKey];
        }
        continue;
      }

      // Track new message
      if (!pendingMessages[msgKey]) {
        pendingMessages[msgKey] = {
          channel: msg.channel,
          channelName: msg.channelName || 'DM',
          user: msg.user || msg.username,
          text: msg.text.substring(0, 100),
          ts: msg.ts,
          time: msg.time,
          type: msg.channelName ? 'mention' : 'dm'
        };
        console.log(`  📝 Tracking new ${pendingMessages[msgKey].type}: ${pendingMessages[msgKey].channelName}`);
      }

      // Check if timeout exceeded
      const timeSince = now - msg.time;
      if (timeSince > CONFIG.responseTimeout && !pendingMessages[msgKey].reminded) {
        const minutesAgo = Math.floor(timeSince / 60000);
        const type = msg.channelName ? '@mention' : 'DM';
        const location = msg.channelName ? `#${msg.channelName}` : 'DM';
        const from = msg.username || msg.user;

        try {
          await postMessage(
            '@' + CONFIG.myUsername,
            `⏰ *Unanswered ${type} Reminder*\n` +
            `You haven't responded to a ${type} from *${from}* in ${location}\n` +
            `*${minutesAgo} minutes ago*\n` +
            `_"${msg.text.substring(0, 150)}${msg.text.length > 150 ? '...' : ''}"_`
          );

          pendingMessages[msgKey].reminded = true;
          pendingMessages[msgKey].remindedAt = now;
          console.log(`  🔔 Sent reminder for ${type} from ${from} (${minutesAgo}m old)`);
        } catch (error) {
          console.error(`  ✗ Failed to send reminder:`, error.message);
        }
      }
    }

    // Clean up old entries (>24 hours)
    const dayAgo = now - (24 * 60 * 60 * 1000);
    for (const [key, msg] of Object.entries(pendingMessages)) {
      if (msg.time < dayAgo) {
        delete pendingMessages[key];
      }
    }

    saveState();

  } catch (error) {
    console.error('Check error:', error);
  }
}

/**
 * Main
 */
async function main() {
  console.log('🦞 OpenClaw Slack Monitor');
  console.log(`   Response timeout: ${CONFIG.responseTimeout / 60000} minutes`);
  console.log(`   Check interval: ${CONFIG.checkInterval / 1000}s\n`);

  loadState();

  // Initial check
  await checkSlack();
  console.log('');

  // Loop
  setInterval(async () => {
    try {
      await checkSlack();
      console.log('');
    } catch (error) {
      console.error('Fatal error:', error);
    }
  }, CONFIG.checkInterval);
}

main().catch(error => {
  console.error('Startup error:', error);
  process.exit(1);
});
