#!/usr/bin/env node
/**
 * Claudia Slack Events Monitor - Socket Mode event tracking
 * Monitors unanswered DMs and @mentions via Slack Socket Mode
 */

const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const { execSync } = require('child_process');
const emailCache = require('./email-cache');
const followupsDb = require('./followups-db');

// Configuration
const CONFIG = {
  appToken: 'REDACTED_SLACK_APP_TOKEN',
  botToken: 'REDACTED_SLACK_BOT_TOKEN',
  myUserId: null, // Will be determined on startup
  responseTimeout: 10 * 60 * 1000, // 10 minutes
  checkInterval: 60 * 1000, // Check for timeouts every minute
  stateFile: process.env.HOME + '/.openclaw/workspace/slack-events-state.json',
  reconnectDelay: 3000 // 3 seconds
};

// Tracked messages awaiting response
let pendingMessages = {};
let ws = null;
let reconnectTimeout = null;
let followupsDbConn = null;

/**
 * Make Slack API call
 */
function slackAPI(endpoint, params = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const query = method === 'GET' ? '?' + new URLSearchParams(params).toString() : '';
    const path = `/api/${endpoint}${query}`;

    const options = {
      hostname: 'slack.com',
      path: path,
      method: method,
      headers: { 'Authorization': `Bearer ${CONFIG.botToken}` }
    };

    if (method === 'POST') {
      const data = JSON.stringify(body || params);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);

      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => responseBody += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(responseBody);
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
    } else {
      https.get(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => responseBody += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(responseBody);
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
    }
  });
}

/**
 * Send macOS notification
 */
function sendMacOSNotification(title, message) {
  try {
    const escapedTitle = title.replace(/"/g, '\\"').substring(0, 100);
    const escapedMessage = message.replace(/"/g, '\\"').substring(0, 200);
    execSync(`osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"'`, { stdio: 'ignore' });
  } catch (error) {
    console.error('  ✗ macOS notification error:', error.message);
  }
}

/**
 * Get Socket Mode WebSocket URL
 */
async function getSocketModeUrl() {
  return new Promise((resolve, reject) => {
    const data = '';
    const options = {
      hostname: 'slack.com',
      path: '/api/apps.connections.open',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.appToken}`,
        'Content-Type': 'application/json',
        'Content-Length': 0
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.ok) {
            resolve(response.url);
          } else {
            reject(new Error(`Slack API error: ${response.error}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
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
 * Track Slack conversation in follow-ups database
 */
function trackSlackConversation(db, event, direction) {
  if (!db) return;

  try {
    const now = Math.floor(Date.now() / 1000);
    let conversationId, conversationType;

    if (event.channel_type === 'im') {
      // Direct message
      conversationId = `slack:dm:${event.user}`;
      conversationType = 'slack-dm';
    } else {
      // Channel mention - use message timestamp for uniqueness
      conversationId = `slack:mention:${event.channel}-${event.ts}`;
      conversationType = 'slack-mention';
    }

    const lastSender = direction === 'incoming' ? 'them' : 'me';
    const waitingFor = direction === 'incoming' ? 'my-response' : 'their-response';

    followupsDb.trackConversation(db, {
      id: conversationId,
      type: conversationType,
      subject: event.text ? event.text.substring(0, 100) : null,
      from_user: event.user,
      from_name: event.username || event.user,
      channel_id: event.channel_type === 'im' ? null : event.channel,
      channel_name: null, // Will be enriched later if needed
      last_activity: Math.floor(parseFloat(event.ts)),
      last_sender: lastSender,
      waiting_for: waitingFor,
      first_seen: now
    });
  } catch (error) {
    console.error('     ✗ Failed to track Slack conversation:', error.message);
  }
}

/**
 * Get user info
 */
async function getUserInfo(userId) {
  try {
    const data = await slackAPI('users.info', { user: userId });
    return data.user;
  } catch (error) {
    return null;
  }
}

/**
 * Get channel info
 */
async function getChannelInfo(channelId) {
  try {
    const data = await slackAPI('conversations.info', { channel: channelId });
    return data.channel;
  } catch (error) {
    return null;
  }
}

/**
 * Post Slack message
 */
async function postMessage(channel, text) {
  return slackAPI('chat.postMessage', {}, 'POST', { channel, text, unfurl_links: false });
}

/**
 * Load state
 */
function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const data = fs.readFileSync(CONFIG.stateFile, 'utf-8');
      pendingMessages = JSON.parse(data);
      console.log(`  Loaded ${Object.keys(pendingMessages).length} pending messages from state`);
    }
  } catch (error) {
    console.error('Error loading state:', error.message);
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
 * Track new message that needs response
 */
async function trackMessage(channel, ts, userId, text, type) {
  const msgKey = `${channel}_${ts}`;

  if (pendingMessages[msgKey]) {
    return; // Already tracking
  }

  const user = await getUserInfo(userId);
  const channelInfo = type === 'mention' ? await getChannelInfo(channel) : null;

  pendingMessages[msgKey] = {
    channel,
    channelName: channelInfo?.name || 'DM',
    user: user?.name || user?.real_name || userId,
    text: text.substring(0, 100),
    ts,
    time: parseFloat(ts) * 1000,
    type,
    reminded: false
  };

  console.log(`  📝 Tracking new ${type}: from ${pendingMessages[msgKey].user}`);
  saveState();
}

/**
 * Mark message as responded
 */
function markResponded(channel, ts) {
  // Find any pending messages in this channel that are older than this response
  let removed = 0;
  for (const [key, msg] of Object.entries(pendingMessages)) {
    if (msg.channel === channel && !msg.reminded) {
      const msgTime = parseFloat(msg.ts);
      const responseTime = parseFloat(ts);
      if (responseTime > msgTime) {
        delete pendingMessages[key];
        removed++;
      }
    }
  }
  if (removed > 0) {
    console.log(`  ✓ Removed ${removed} tracked message(s) (user responded)`);
    saveState();
  }
}

/**
 * Check for messages that need reminders
 */
async function checkTimeouts() {
  const now = Date.now();
  let reminders = 0;

  for (const [key, msg] of Object.entries(pendingMessages)) {
    if (msg.reminded) continue;

    const timeSince = now - msg.time;
    if (timeSince > CONFIG.responseTimeout) {
      const minutesAgo = Math.floor(timeSince / 60000);
      const type = msg.type === 'mention' ? '@mention' : 'DM';
      const location = msg.type === 'mention' ? `#${msg.channelName}` : 'DM';

      try {
        await postMessage(
          CONFIG.myUserId,
          `⏰ *Unanswered ${type} Reminder*\n` +
          `You haven't responded to a ${type} from *${msg.user}* in ${location}\n` +
          `*${minutesAgo} minutes ago*\n` +
          `_"${msg.text}${msg.text.length >= 100 ? '...' : ''}"_`
        );

        // Also send macOS notification
        sendMacOSNotification(
          `⏰ Unanswered ${type} (${minutesAgo}m)`,
          `From ${msg.user} in ${location}: ${msg.text.substring(0, 100)}`
        );

        pendingMessages[key].reminded = true;
        pendingMessages[key].remindedAt = now;
        reminders++;
        console.log(`  🔔 Sent reminder for ${type} from ${msg.user} (${minutesAgo}m old)`);
      } catch (error) {
        console.error(`  ✗ Failed to send reminder:`, error.message);
      }
    }
  }

  if (reminders > 0) {
    saveState();
  }

  // Clean up old entries (>24 hours)
  const dayAgo = now - (24 * 60 * 60 * 1000);
  let cleaned = 0;
  for (const [key, msg] of Object.entries(pendingMessages)) {
    if (msg.time < dayAgo) {
      delete pendingMessages[key];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`  🧹 Cleaned ${cleaned} old message(s)`);
    saveState();
  }
}

/**
 * Handle incoming Slack event
 */
async function handleEvent(event, db) {
  // Check if this is my message (responding to something)
  if (event.user === CONFIG.myUserId) {
    markResponded(event.channel, event.ts);

    // Mark conversation as resolved in follow-ups database
    if (db && event.type === 'message' && event.channel_type === 'im') {
      // For DMs, we need to find the other user in the conversation
      // The channel is a DM channel, so we need to look up who we're talking to
      // This is a simplified approach - in a real implementation we'd get the user from the channel
      // For now, we'll track outgoing messages
      trackSlackConversation(db, event, 'outgoing');
    }
    return;
  }

  // Ignore bot messages
  if (event.bot_id) {
    return;
  }

  const eventType = event.type === 'message' ? 'message' : event.type;
  console.log(`  📨 Event: ${eventType} in ${event.channel}`);

  // Track conversation in follow-ups database
  if (event.type === 'message' && !event.subtype && event.user !== CONFIG.myUserId) {
    trackSlackConversation(db, event, 'incoming');
  }

  switch (event.type) {
    case 'message':
      // Check if this is a DM (channel type 'im')
      if (event.channel_type === 'im') {
        await trackMessage(event.channel, event.ts, event.user, event.text, 'dm');
      }
      break;

    case 'app_mention':
      // Someone @mentioned me in a channel
      await trackMessage(event.channel, event.ts, event.user, event.text, 'mention');
      break;
  }
}

/**
 * Send email content as ephemeral message (only visible to requesting user)
 */
async function sendEmailContent(channel, userId, emailId) {
  try {
    let from, subject, date, body;

    // Check cache first (fast!)
    const cached = emailCache.getCachedEmail(emailId);
    if (cached) {
      console.log(`  ⚡ Using cached email content for ${emailId}`);
      from = cached.from;
      subject = cached.subject;
      date = cached.date;
      body = cached.body;
    } else {
      // Cache miss - fetch from Gmail API (slow)
      console.log(`  ⏳ Fetching email ${emailId} from Gmail API...`);

      const gmail = getGmailClient();

      // Fetch email
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: emailId,
        format: 'full'
      });

      const email = res.data;
      from = email.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
      subject = email.payload.headers.find(h => h.name === 'Subject')?.value || 'No subject';
      date = email.payload.headers.find(h => h.name === 'Date')?.value || 'Unknown date';

      // Get email body - try plain text first, then HTML
      body = '';
      const parts = email.payload.parts || [email.payload];

      // Try to find plain text part
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          body = Buffer.from(part.body.data, 'base64').toString();
          break;
        }
      }

      // If no plain text, try to get HTML and convert properly
      if (!body) {
        for (const part of parts) {
          if (part.mimeType === 'text/html' && part.body.data) {
            const { convert } = require('html-to-text');
            const html = Buffer.from(part.body.data, 'base64').toString();

            // Use proper HTML to text conversion
            body = convert(html, {
              wordwrap: 80,
              selectors: [
                { selector: 'a', options: { ignoreHref: true } },  // Don't show URLs inline
                { selector: 'img', format: 'skip' },               // Skip images
                { selector: 'table', options: { uppercaseHeaderCells: false } }
              ]
            });
            break;
          }
        }
      }

      if (!body && email.payload.body?.data) {
        body = Buffer.from(email.payload.body.data, 'base64').toString();
      }

      // Cache this email for next time
      emailCache.cacheEmail(emailId, { from, subject, date, body });
      console.log(`  💾 Cached email ${emailId}`);
    }

    // Limit length for display
    if (body && body.length > 3000) {
      body = body.substring(0, 3000) + '\n\n... (truncated)';
    }

    // Create ephemeral message (only visible to user who clicked)
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📧 *Email Content*\n\n*From:* ${from}\n*Subject:* ${subject}\n*Date:* ${date}`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '```\n' + (body || 'No content available').substring(0, 2800) + '\n```'
        }
      }
    ];

    // Send ephemeral message
    const data = JSON.stringify({
      channel: channel,
      user: userId,
      blocks: blocks,
      text: 'Email content'
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'slack.com',
        path: '/api/chat.postEphemeral',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.botToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => responseBody += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(responseBody);
            if (response.ok) {
              console.log('  ✓ Email content sent as ephemeral message');
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
  } catch (error) {
    console.error('  ✗ Error sending email content:', error.message);
    throw error;
  }
}

/**
 * Handle interactive button clicks
 */
async function handleInteractive(payload) {
  if (payload.type === 'block_actions') {
    const action = payload.actions[0];
    const username = payload.user.username;
    const userId = payload.user.id; // Actual user ID for ephemeral messages
    const channel = payload.channel.id;
    const emailId = action.value;
    const triggerId = payload.trigger_id; // Needed for opening modals

    console.log(`  🔘 Button clicked: ${action.action_id} by ${username} for email ${emailId}`);

    try {
      let responseText = '';

      switch (action.action_id) {
        case 'view_email_modal':
          // Send ephemeral message (only visible to user) instead of modal
          await sendEmailContent(channel, userId, emailId);
          return; // No text response needed

        case 'archive_email':
          responseText = await archiveEmailAction(emailId);
          break;

        case 'delete_email':
          responseText = await deleteEmailAction(emailId);
          break;

        case 'unsubscribe_email':
          responseText = await unsubscribeEmailAction(emailId);
          break;

        case 'open_in_gmail':
          // This is handled by Slack URL button, no server action needed
          responseText = '✓ Opening in Gmail...';
          break;

        default:
          responseText = '✗ Unknown action';
      }

      // Send response to user
      if (responseText) {
        await postMessage(channel, responseText);
      }

      // Mark conversation as resolved in follow-ups
      if (followupsDbConn) {
        const convId = `slack:dm:${userId}`;
        followupsDb.resolveConversation(followupsDbConn, convId);
      }
    } catch (error) {
      console.error(`  ✗ Error handling action:`, error.message);
      await postMessage(channel, `✗ Error: ${error.message}`);
    }
  }
}

/**
 * Get full email content via Gmail API
 */
async function getFullEmailContent(emailId) {
  try {
    const { google } = require('googleapis');
    const fs = require('fs');

    const credentials = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/gmail-credentials.json'));
    const token = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/gmail-token.json'));

    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2Client.setCredentials(token);

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: emailId,
      format: 'full'
    });

    const email = res.data;
    const from = email.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
    const subject = email.payload.headers.find(h => h.name === 'Subject')?.value || 'No subject';
    const date = email.payload.headers.find(h => h.name === 'Date')?.value || 'Unknown date';

    // Get email body
    let body = '';
    const parts = email.payload.parts || [email.payload];
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body.data) {
        body = Buffer.from(part.body.data, 'base64').toString().substring(0, 3000);
        break;
      }
    }

    if (!body && email.payload.body?.data) {
      body = Buffer.from(email.payload.body.data, 'base64').toString().substring(0, 3000);
    }

    return `📧 *Full Email*\n\n*From:* ${from}\n*Subject:* ${subject}\n*Date:* ${date}\n\n${body || '_No text content_'}`;
  } catch (error) {
    return `✗ Failed to get email: ${error.message}`;
  }
}

/**
 * Get Gmail API client (shared helper)
 */
function getGmailClient() {
  const { google } = require('googleapis');

  const credentials = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/gmail-credentials.json'));
  const token = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/gmail-token.json'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);

  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

/**
 * Archive email action (using Gmail API)
 */
async function archiveEmailAction(emailId) {
  try {
    const gmail = getGmailClient();

    // Remove INBOX label to archive
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: {
        removeLabelIds: ['INBOX']
      }
    });

    return '✓ Email archived';
  } catch (error) {
    console.error('  ✗ Archive error:', error.message);
    return `✗ Archive failed: ${error.message}`;
  }
}

/**
 * Delete email action (using Gmail API)
 */
async function deleteEmailAction(emailId) {
  try {
    const gmail = getGmailClient();

    // Move to trash (reversible - better than permanent delete)
    await gmail.users.messages.trash({
      userId: 'me',
      id: emailId
    });

    return '✓ Email moved to trash';
  } catch (error) {
    console.error('  ✗ Delete error:', error.message);
    return `✗ Delete failed: ${error.message}`;
  }
}

/**
 * Unsubscribe email action
 */
async function unsubscribeEmailAction(emailId) {
  try {
    // Create a temporary script to unsubscribe by email ID
    const scriptPath = '/tmp/unsub-by-id.sh';
    fs.writeFileSync(scriptPath, `#!/bin/bash
cd ~/.openclaw/workspace
./unsub "id:${emailId}"
`);
    execSync(`chmod +x ${scriptPath}`);
    execSync(scriptPath, { stdio: 'pipe', timeout: 30000 });
    return '✓ Unsubscribe automation started';
  } catch (error) {
    return `✗ Unsubscribe failed: ${error.message}`;
  }
}

/**
 * Connect to Socket Mode
 */
async function connectSocketMode(db) {
  try {
    console.log('  Connecting to Slack Socket Mode...');
    const url = await getSocketModeUrl();

    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('  ✓ Socket Mode connected\n');
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
    });

    ws.on('message', async (data) => {
      try {
        const envelope = JSON.parse(data);

        // Acknowledge envelope
        if (envelope.envelope_id) {
          ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }

        // Debug: Log all envelope types
        console.log(`  📦 Envelope type: ${envelope.type}`);

        // Handle different payload types
        if (envelope.type === 'hello') {
          console.log('  👋 Received hello from Slack');
        } else if (envelope.type === 'disconnect') {
          console.log('  ⚠️  Slack requested disconnect, reconnecting...');
          ws.close();
        } else if (envelope.type === 'events_api') {
          // This is an actual event
          console.log(`  📨 Event type: ${envelope.payload.event.type}`);
          await handleEvent(envelope.payload.event, db);
        } else if (envelope.type === 'interactive') {
          // Handle button clicks
          await handleInteractive(envelope.payload);
        } else {
          console.log(`  ⚠️  Unknown envelope type: ${envelope.type}`);
        }
      } catch (error) {
        console.error('  ✗ Error processing message:', error.message);
        console.error('  ✗ Stack:', error.stack);
      }
    });

    ws.on('error', (error) => {
      console.error('  ✗ WebSocket error:', error.message);
    });

    ws.on('close', () => {
      console.log('  ⚠️  Socket Mode disconnected, reconnecting in 3s...');
      ws = null;
      reconnectTimeout = setTimeout(() => connectSocketMode(db), CONFIG.reconnectDelay);
    });

  } catch (error) {
    console.error('  ✗ Failed to connect:', error.message);
    reconnectTimeout = setTimeout(() => connectSocketMode(db), CONFIG.reconnectDelay);
  }
}

/**
 * Main
 */
async function main() {
  console.log('👩‍💼 Claudia - Slack Events Monitor (Socket Mode)');
  console.log(`   Response timeout: ${CONFIG.responseTimeout / 60000} minutes\n`);

  // Clean old cache files
  emailCache.cleanOldCache();

  // Show cache stats
  const stats = emailCache.getCacheStats();
  console.log(`   Email cache: ${stats.count} emails, ${stats.totalSizeMB}MB`);
  console.log(`   Cache dir: ${emailCache.CACHE_DIR}\n`);

  // Get my user ID
  CONFIG.myUserId = await getMyUserId();
  console.log(`   My user ID: ${CONFIG.myUserId}`);

  // Initialize follow-ups database
  try {
    followupsDbConn = followupsDb.initDatabase();
    console.log('   ✓ Follow-ups tracking initialized\n');
  } catch (error) {
    console.error('   ✗ Failed to init follow-ups DB:', error.message);
  }

  // Load state
  loadState();

  // Connect to Socket Mode
  await connectSocketMode(followupsDbConn);

  // Start timeout checker
  setInterval(async () => {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timestamp}] Checking for message timeouts...`);
    await checkTimeouts();
  }, CONFIG.checkInterval);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  saveState();
  if (ws) ws.close();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  saveState();
  if (ws) ws.close();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
});

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
