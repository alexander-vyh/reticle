#!/usr/bin/env node
/**
 * Claudia Slack Events Monitor - Socket Mode event tracking
 * Monitors unanswered DMs and @mentions via Slack Socket Mode
 */

const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const { execSync } = require('child_process');
const crypto = require('crypto');
const emailCache = require('./email-cache');
const claudiaDb = require('./claudia-db');
const { parseSenderEmail, formatRuleDescription } = require('./lib/email-utils');
const { parseRuleRefinement } = require('./lib/ai');
const log = require('./lib/logger')('slack-events');

const os = require('os');
const path = require('path');
const config = require('./lib/config');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');

// Configuration
const CONFIG = {
  appToken: config.slackAppToken,
  botToken: config.slackBotToken,
  myUserId: null, // Will be determined on startup
  responseTimeout: 10 * 60 * 1000, // 10 minutes
  checkInterval: 60 * 1000, // Check for timeouts every minute
  stateFile: path.join(__dirname, 'slack-events-state.json'),
  reconnectDelay: 3000 // 3 seconds
};

// Tracked messages awaiting response
let pendingMessages = {};
let ws = null;
let reconnectTimeout = null;
let followupsDbConn = null;
let accountId = null;
let errorCount = 0;

// Active "Match differently" thread conversations: threadTs → { emailMeta, ruleType, currentConditions, ruleId, channel }
const ruleRefinementThreads = new Map();

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
    log.error({ err: error }, 'macOS notification error');
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

    claudiaDb.trackConversation(db, accountId, {
      id: conversationId,
      type: conversationType,
      subject: event.text ? event.text.substring(0, 100) : null,
      from_user: event.user,
      from_name: event.username || event.user,
      last_activity: Math.floor(parseFloat(event.ts)),
      last_sender: lastSender,
      waiting_for: waitingFor,
      first_seen: now
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to track Slack conversation');
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
      log.info({ count: Object.keys(pendingMessages).length }, 'State loaded');
    }
  } catch (error) {
    log.error({ err: error }, 'Error loading state');
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
    log.error({ err: error }, 'Error saving state');
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

  log.info({ type, user: pendingMessages[msgKey].user, channel }, 'Tracking new message');
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
    log.info({ count: removed, channel }, 'Cleared tracked messages (user responded)');
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
        log.info({ type, user: msg.user, minutesAgo }, 'Sent reminder');
      } catch (error) {
        log.error({ err: error, type, user: msg.user }, 'Failed to send reminder');
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
    log.debug({ count: cleaned }, 'Cleaned old messages');
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

  // Intercept thread replies for "Match differently" rule refinement conversations
  if (event.type === 'message' && event.thread_ts && ruleRefinementThreads.has(event.thread_ts)) {
    const handled = await handleRuleRefinementReply(event);
    if (handled) return;
  }

  const eventType = event.type === 'message' ? 'message' : event.type;
  log.info({ eventType, channel: event.channel }, 'Event received');

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
      log.debug({ emailId }, 'Using cached email content');
      from = cached.from;
      subject = cached.subject;
      date = cached.date;
      body = cached.body;
    } else {
      // Cache miss - fetch from Gmail API (slow)
      log.info({ emailId }, 'Fetching email from Gmail API');

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
      log.debug({ emailId }, 'Cached email');
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
              log.info({ emailId }, 'Email content sent as ephemeral message');
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
    log.error({ err: error, emailId }, 'Error sending email content');
    throw error;
  }
}

// ── Email Classification Helpers ──────────────────────────────────────

/**
 * Get email metadata from cache or fetch from Gmail API on cache miss.
 */
async function getEmailMeta(emailId) {
  const cached = emailCache.getCachedEmail(emailId);
  if (cached) return cached;

  // Cache miss — fetch from Gmail API
  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] });
    const headers = res.data.payload.headers;
    const meta = {
      id: emailId,
      from: headers.find(h => h.name === 'From')?.value || '',
      to: headers.find(h => h.name === 'To')?.value || '',
      cc: headers.find(h => h.name === 'Cc')?.value || '',
      subject: headers.find(h => h.name === 'Subject')?.value || '',
      date: headers.find(h => h.name === 'Date')?.value || ''
    };
    emailCache.cacheEmail(emailId, meta);
    return meta;
  } catch (error) {
    log.error({ err: error, emailId }, 'Failed to fetch email metadata');
    return null;
  }
}

/**
 * Post an ephemeral message (only visible to user).
 */
async function postEphemeral(channel, userId, text, blocks) {
  const body = { channel, user: userId, text };
  if (blocks) body.blocks = blocks;
  return slackAPI('chat.postEphemeral', {}, 'POST', body);
}

/**
 * Post a message (optionally in a thread).
 */
async function postThreadMessage(channel, text, threadTs, blocks) {
  const body = { channel, text, unfurl_links: false };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks) body.blocks = blocks;
  return slackAPI('chat.postMessage', {}, 'POST', body);
}

/**
 * Decode overflow menu short code → { actionType, emailId }
 * Codes: as=archive sender, ds=delete sender, ls=alert sender, dm=demote sender, ad=archive domain
 */
function decodeClassifyAction(value) {
  const [code, emailId] = value.split('|');
  const actionMap = { as: 'archive', ds: 'delete', ls: 'alert', dm: 'demote', ad: 'archive' };
  return { actionType: actionMap[code], isDomain: code === 'ad', emailId };
}

/**
 * Map overflow action type to the immediate action on the current email.
 * 'archive'/'demote' → archive the email, 'delete' → trash it, 'alert' → no immediate action needed
 */
function immediateActionForType(actionType) {
  if (actionType === 'archive' || actionType === 'demote') return 'archive';
  if (actionType === 'delete') return 'delete';
  return null; // 'alert' has no immediate destructive action
}

/**
 * Build the rule confirmation blocks with action buttons.
 */
function buildRuleConfirmationBlocks(ruleType, description, ruleId, extra) {
  const label = ruleType.charAt(0).toUpperCase() + ruleType.slice(1);
  const elements = [];

  if (extra?.suggested) {
    // Suggested compound rule — needs explicit acceptance
    elements.push(
      { type: 'button', text: { type: 'plain_text', text: 'Yes, apply this rule' }, action_id: 'accept_suggested_rule', value: String(ruleId), style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: 'No, just match sender' }, action_id: 'accept_default_rule', value: `${ruleId}|${extra.defaultRuleArgs}` },
      { type: 'button', text: { type: 'plain_text', text: 'Match differently...' }, action_id: 'match_differently', value: String(ruleId) }
    );
  } else {
    // Default rule — already applied
    elements.push(
      { type: 'button', text: { type: 'plain_text', text: 'Undo rule' }, action_id: 'undo_rule', value: String(ruleId) },
      { type: 'button', text: { type: 'plain_text', text: 'Match differently...' }, action_id: 'match_differently', value: String(ruleId) }
    );
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: extra?.suggested
        ? `📋 Suggested rule: ${label} when ${description}\n${extra.reason}`
        : `✓ Rule created: ${label} when ${description}` } },
    { type: 'actions', elements }
  ];
}

/**
 * Handle the classify_email overflow menu selection.
 */
async function handleClassifyAction(action, channel, userId, messageTs) {
  const selectedValue = action.selected_option?.value;
  if (!selectedValue) return;

  const { actionType, isDomain, emailId } = decodeClassifyAction(selectedValue);
  const cid = `cls_${crypto.randomBytes(4).toString('hex')}`;
  log.info({ cid, actionType, isDomain, emailId }, 'Classify action');

  // Get email metadata
  const meta = await getEmailMeta(emailId);
  if (!meta) {
    await postMessage(channel, '✗ Could not load email metadata');
    return;
  }

  const { email: senderEmail, domain: senderDomain } = parseSenderEmail(meta.from);

  // Self-domain protection
  if (isDomain && config.filterPatterns?.companyDomain && senderDomain === config.filterPatterns.companyDomain) {
    await postMessage(channel, `⚠️ Cannot ${actionType} emails from your own domain (@${senderDomain})`);
    return;
  }

  // 1. Immediate action on current email (independent of rule creation)
  const immediateAction = immediateActionForType(actionType);
  if (immediateAction === 'archive') {
    try { await archiveEmailAction(emailId); } catch (e) { log.warn({ err: e, emailId }, 'Immediate archive failed'); }
  } else if (immediateAction === 'delete') {
    try { await deleteEmailAction(emailId); } catch (e) { log.warn({ err: e, emailId }, 'Immediate delete failed'); }
  }

  // 2. Domain actions require confirmation
  if (isDomain) {
    const confirmBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `⚠️ This will ${actionType} *ALL* emails from @${senderDomain}` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Confirm' }, action_id: 'confirm_domain_rule', value: `${actionType}|${senderDomain}|${meta.from}|${meta.subject}`, style: 'danger' },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'cancel_domain_rule', value: 'cancel' }
      ]}
    ];
    const actionLabel = immediateAction === 'archive' ? '✓ Archived this email\n' : immediateAction === 'delete' ? '✓ Trashed this email\n' : '';
    await postMessage(channel, `${actionLabel}⚠️ Confirm domain rule for @${senderDomain}`);
    await postThreadMessage(channel, `Confirm domain rule`, null, confirmBlocks);
    return;
  }

  // 3. Sender-level actions — check if smart inference applies
  const myEmail = config.gmailAccount?.toLowerCase() || '';
  const allRecipients = `${meta.to || ''} ${meta.cc || ''}`.toLowerCase();
  const sentToDL = allRecipients && !allRecipients.includes(myEmail) && allRecipients.includes('@');

  if (sentToDL) {
    // Smart inference: suggest compound rule with TO condition
    const toMatch = extractDistributionList(allRecipients, myEmail);
    // Don't create the rule yet — propose it
    const suggestedConditions = { ruleType: actionType, matchFrom: senderEmail, matchTo: toMatch };
    const description = `FROM ${senderEmail} AND TO ${toMatch}`;
    // Create the rule provisionally to get an ID, but we could also just pass args
    const ruleRow = claudiaDb.createRule(followupsDbConn, accountId, {
      rule_type: actionType, match_from: senderEmail, match_to: toMatch,
      source_email: meta.from, source_subject: meta.subject
    });
    const ruleId = ruleRow.id;
    // Immediately deactivate — it's a proposal, not yet accepted
    claudiaDb.deactivateRule(followupsDbConn, ruleId);

    const defaultRuleArgs = JSON.stringify({ rule_type: actionType, match_from: senderEmail, source_email: meta.from, source_subject: meta.subject });
    const actionLabel = immediateAction === 'archive' ? '✓ Archived this email\n' : immediateAction === 'delete' ? '✓ Trashed this email\n' : '';
    const blocks = buildRuleConfirmationBlocks(actionType, description, ruleId, {
      suggested: true,
      reason: '_(More targeted — this was sent to a distribution list, not directly to you)_',
      defaultRuleArgs: Buffer.from(defaultRuleArgs).toString('base64').substring(0, 60)
    });
    // Prepend immediate action confirmation
    if (actionLabel) {
      blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: actionLabel.trim() } });
    }
    const resp = await postThreadMessage(channel, `Suggested rule: ${description}`, null, blocks);
    // Store context for potential "Match differently" thread
    if (resp?.ts) {
      storeRefinementContext(resp.ts, channel, meta, actionType, { matchFrom: senderEmail, matchTo: toMatch }, ruleId);
    }
  } else {
    // Default: simple sender rule — create immediately
    const ruleRow2 = claudiaDb.createRule(followupsDbConn, accountId, {
      rule_type: actionType, match_from: senderEmail,
      source_email: meta.from, source_subject: meta.subject
    });
    const ruleId = ruleRow2.id;
    const description = formatRuleDescription(claudiaDb.getRuleById(followupsDbConn, ruleId));
    const actionLabel = immediateAction === 'archive' ? '✓ Archived this email\n' : immediateAction === 'delete' ? '✓ Trashed this email\n' : '';
    const blocks = buildRuleConfirmationBlocks(actionType, description, ruleId);
    if (actionLabel) {
      blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: actionLabel.trim() } });
    }
    const resp = await postThreadMessage(channel, `Rule created: ${actionType} when ${description}`, null, blocks);
    if (resp?.ts) {
      storeRefinementContext(resp.ts, channel, meta, actionType, { matchFrom: senderEmail }, ruleId);
    }
    log.info({ cid, ruleId, description }, 'Default rule created');
  }
}

/**
 * Extract the most likely distribution list address from recipients.
 */
function extractDistributionList(recipients, myEmail) {
  // Split on commas, find addresses that aren't the user's
  const addresses = recipients.match(/[\w.+-]+@[\w.-]+/g) || [];
  const dlCandidates = addresses.filter(a => a.toLowerCase() !== myEmail);
  return dlCandidates[0] || '';
}

/**
 * Store context for a "Match differently" thread conversation.
 */
function storeRefinementContext(threadTs, channel, emailMeta, ruleType, currentConditions, ruleId) {
  ruleRefinementThreads.set(threadTs, { emailMeta, ruleType, currentConditions, ruleId, channel });
  // Auto-expire after 1 hour
  setTimeout(() => ruleRefinementThreads.delete(threadTs), 60 * 60 * 1000);
}

/**
 * Handle thread replies in rule refinement conversations.
 */
async function handleRuleRefinementReply(event) {
  const threadTs = event.thread_ts;
  const ctx = ruleRefinementThreads.get(threadTs);
  if (!ctx) return false; // Not a refinement thread

  const userText = event.text;
  log.info({ threadTs, userText }, 'Rule refinement reply');

  const result = await parseRuleRefinement({
    emailMeta: { from: ctx.emailMeta.from, to: ctx.emailMeta.to, cc: ctx.emailMeta.cc, subject: ctx.emailMeta.subject },
    currentRule: ctx.currentConditions,
    userInstruction: userText
  });

  if (!result) {
    await postThreadMessage(ctx.channel, "I couldn't parse that — try being more specific, e.g., \"only when subject mentions role audit\" or \"remove the To condition\"", threadTs);
    return true;
  }

  // Build description and propose
  const description = formatRuleDescription({
    match_from: result.matchFrom, match_from_domain: result.matchFromDomain,
    match_to: result.matchTo, match_subject_contains: result.matchSubjectContains
  });

  // Create the proposed rule (deactivated until confirmed)
  const newRuleRow = claudiaDb.createRule(followupsDbConn, accountId, {
    rule_type: ctx.ruleType, match_from: result.matchFrom, match_from_domain: result.matchFromDomain,
    match_to: result.matchTo, match_subject_contains: result.matchSubjectContains,
    source_email: ctx.emailMeta.from, source_subject: ctx.emailMeta.subject
  });
  const newRuleId = newRuleRow.id;
  claudiaDb.deactivateRule(followupsDbConn, newRuleId);

  // Update context with new proposal
  ctx.currentConditions = result;
  ctx.ruleId = newRuleId;

  const label = ctx.ruleType.charAt(0).toUpperCase() + ctx.ruleType.slice(1);
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `Updated rule: ${label} when ${description}` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Apply this rule' }, action_id: 'apply_refined_rule', value: String(newRuleId), style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: 'Try again' }, action_id: 'try_again_refine', value: threadTs }
    ]}
  ];
  await postThreadMessage(ctx.channel, `Updated rule: ${description}`, threadTs, blocks);
  return true;
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
    const actionId = action.action_id;
    const cid = `act_${crypto.randomBytes(6).toString('hex')}`;
    const startTime = Date.now();

    // Parse compound value: emailId|threadId (backward compatible with plain emailId)
    const valueParts = action.value ? action.value.split('|') : [];
    const emailId = valueParts[0];
    const threadId = valueParts[1] || null;

    // Try to get email context from cache (no extra API call)
    const cached = emailId ? emailCache.getCachedEmail(emailId) : null;
    const subject = cached?.subject || undefined;
    const from = cached?.from || undefined;

    log.info({ cid, actionId, username, emailId, threadId, subject, from }, 'Slack action started');

    try {
      let result = null;

      switch (actionId) {
        case 'view_email_modal':
          // Send ephemeral message (only visible to user) instead of modal
          await sendEmailContent(channel, userId, emailId);
          log.info({ cid, actionId, emailId, success: true, durationMs: Date.now() - startTime }, 'Slack action completed');
          return; // No text response needed

        case 'archive_email':
          result = await archiveEmailAction(emailId);
          break;

        case 'delete_email':
          result = await deleteEmailAction(emailId);
          break;

        case 'unsubscribe_email':
          result = await unsubscribeEmailAction(emailId);
          break;

        case 'mark_replied':
          // Flip conversation state — still waiting for their reply back
          if (threadId && followupsDbConn) {
            claudiaDb.updateConversationState(followupsDbConn, `email:${threadId}`, 'me', 'their-response');
          }
          result = { success: true, message: '✓ Marked as replied' };
          break;

        case 'mark_no_response_needed':
          // Resolve outright — this email doesn't need a reply
          if (threadId && followupsDbConn) {
            claudiaDb.resolveConversation(followupsDbConn, `email:${threadId}`);
          }
          result = { success: true, message: '✓ Marked as no reply needed' };
          break;

        case 'open_in_gmail':
          // This is handled by Slack URL button, no server action needed
          result = { success: true, message: '✓ Opening in Gmail...' };
          break;

        // ── Email Classification Actions ──────────────────────────

        case 'classify_email':
          await handleClassifyAction(action, channel, userId, payload.message?.ts);
          log.info({ cid, actionId, success: true, durationMs: Date.now() - startTime }, 'Classify action completed');
          return;

        case 'accept_suggested_rule': {
          // User accepted the compound rule proposal — reactivate it
          const ruleId = parseInt(action.value);
          if (followupsDbConn) {
            // Reactivate the previously deactivated proposed rule
            claudiaDb.createRule(followupsDbConn, accountId, (() => {
              const r = claudiaDb.getRuleById(followupsDbConn, ruleId);
              if (!r) return { rule_type: 'archive' }; // fallback
              return { rule_type: r.rule_type, match_from: r.match_from, match_from_domain: r.match_from_domain, match_to: r.match_to, match_subject_contains: r.match_subject_contains, source_email: r.source_email, source_subject: r.source_subject };
            })());
            const rule = claudiaDb.getRuleById(followupsDbConn, ruleId);
            const desc = rule ? formatRuleDescription(rule) : 'unknown';
            result = { success: true, message: `✓ Rule created: ${rule?.rule_type || 'archive'} when ${desc}` };
          }
          break;
        }

        case 'accept_default_rule': {
          // User rejected compound suggestion, wants simple sender-only rule
          const parts = action.value.split('|');
          const proposedRuleId = parseInt(parts[0]);
          try {
            const argsJson = Buffer.from(parts[1] || '', 'base64').toString();
            const args = JSON.parse(argsJson);
            if (followupsDbConn) {
              // Deactivate the compound proposal
              claudiaDb.deactivateRule(followupsDbConn, proposedRuleId);
              // Create the simple sender rule
              const rule = claudiaDb.createRule(followupsDbConn, accountId, args);
              const desc = rule ? formatRuleDescription(rule) : 'unknown';
              result = { success: true, message: `✓ Rule created: ${rule?.rule_type || 'archive'} when ${desc}` };
            }
          } catch (e) {
            log.warn({ err: e }, 'Failed to parse default rule args');
            result = { success: false, message: '✗ Failed to create rule' };
          }
          break;
        }

        case 'undo_rule': {
          const ruleId = parseInt(action.value);
          if (followupsDbConn) {
            const rule = claudiaDb.getRuleById(followupsDbConn, ruleId);
            claudiaDb.deactivateRule(followupsDbConn, ruleId);
            result = { success: true, message: `✓ Rule removed. Emails${rule?.match_from ? ` from ${rule.match_from}` : ''} will appear normally.` };
          }
          break;
        }

        case 'match_differently': {
          // Start a "Match differently" thread conversation
          const ruleId = parseInt(action.value);
          const ctx = [...ruleRefinementThreads.values()].find(c => c.ruleId === ruleId);
          if (ctx) {
            const meta = ctx.emailMeta;
            const currentDesc = formatRuleDescription({
              match_from: ctx.currentConditions.matchFrom, match_from_domain: ctx.currentConditions.matchFromDomain,
              match_to: ctx.currentConditions.matchTo, match_subject_contains: ctx.currentConditions.matchSubjectContains
            });
            const prompt = [
              'How should I match future emails like this?',
              '',
              'This email:',
              `  From: ${meta.from}`,
              meta.to ? `  To: ${meta.to}` : null,
              `  Subject: ${meta.subject}`,
              '',
              `Current rule: ${ctx.ruleType.charAt(0).toUpperCase() + ctx.ruleType.slice(1)} when ${currentDesc}`,
              '',
              'Tell me what to change — e.g., "only when subject mentions role audit", "from any sender to this DL", "remove the To condition"'
            ].filter(x => x !== null).join('\n');

            // Find the thread this confirmation was posted in
            const msgTs = payload.message?.ts || payload.container?.message_ts;
            await postThreadMessage(channel, prompt, msgTs);
            // Update the refinement thread context to use this message's thread
            if (msgTs) {
              ruleRefinementThreads.set(msgTs, ctx);
            }
          } else {
            await postMessage(channel, 'Session expired — click the overflow menu again to start over.');
          }
          log.info({ cid, actionId, ruleId, success: true, durationMs: Date.now() - startTime }, 'Match differently started');
          return;
        }

        case 'apply_refined_rule': {
          // User accepted an AI-refined rule
          const ruleId = parseInt(action.value);
          if (followupsDbConn) {
            // Reactivate it
            const rule = claudiaDb.getRuleById(followupsDbConn, ruleId);
            if (rule) {
              claudiaDb.createRule(followupsDbConn, accountId, {
                rule_type: rule.rule_type, match_from: rule.match_from, match_from_domain: rule.match_from_domain,
                match_to: rule.match_to, match_subject_contains: rule.match_subject_contains,
                source_email: rule.source_email, source_subject: rule.source_subject
              });
              const desc = formatRuleDescription(rule);
              result = { success: true, message: `✓ Rule created: ${rule.rule_type} when ${desc}` };
              // Deactivate any older rule for the same refinement thread
              const threadTs = payload.message?.thread_ts || payload.container?.thread_ts;
              if (threadTs) {
                const ctx = ruleRefinementThreads.get(threadTs);
                if (ctx && ctx.ruleId !== ruleId) {
                  claudiaDb.deactivateRule(followupsDbConn, ctx.ruleId);
                }
                ruleRefinementThreads.delete(threadTs);
              }
            } else {
              result = { success: false, message: '✗ Rule not found' };
            }
          }
          break;
        }

        case 'try_again_refine':
          // User wants to try another refinement — just prompt them
          await postThreadMessage(channel, 'Tell me how you\'d like to adjust the rule:', action.value);
          log.info({ cid, actionId, success: true, durationMs: Date.now() - startTime }, 'Try again prompt sent');
          return;

        case 'confirm_domain_rule': {
          // User confirmed a domain-level rule
          const [ruleType, domain, sourceEmail, sourceSubject] = (action.value || '').split('|');
          if (followupsDbConn && ruleType && domain) {
            claudiaDb.createRule(followupsDbConn, accountId, {
              rule_type: ruleType, match_from_domain: domain,
              source_email: sourceEmail || null, source_subject: sourceSubject || null
            });
            result = { success: true, message: `✓ Rule created: ${ruleType} when FROM DOMAIN @${domain}` };
          }
          break;
        }

        case 'cancel_domain_rule':
          result = { success: true, message: '✓ Domain rule cancelled.' };
          break;

        default:
          result = { success: false, message: '✗ Unknown action' };
      }

      const durationMs = Date.now() - startTime;

      // Send response to user
      if (result && result.message) {
        await postMessage(channel, result.message);
      }

      if (result?.success) {
        log.info({ cid, actionId, emailId, success: true, durationMs }, 'Slack action completed');
      } else {
        log.warn({ cid, actionId, emailId, success: false, durationMs, message: result?.message }, 'Slack action completed with failure');
      }

      // Resolve email conversation in follow-ups when archived/deleted/unsubscribed
      if (followupsDbConn && threadId && ['archive_email', 'delete_email', 'unsubscribe_email'].includes(actionId)) {
        claudiaDb.resolveConversation(followupsDbConn, `email:${threadId}`);
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error({ cid, err: error, actionId, emailId, durationMs }, 'Slack action failed');
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

    const credentials = JSON.parse(fs.readFileSync(config.gmailCredentialsPath));
    const token = JSON.parse(fs.readFileSync(config.gmailTokenPath));

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

  const credentials = JSON.parse(fs.readFileSync(config.gmailCredentialsPath));
  const token = JSON.parse(fs.readFileSync(config.gmailTokenPath));
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

    log.info({ emailId }, 'Email archived via Gmail API');
    return { success: true, message: '✓ Email archived' };
  } catch (error) {
    log.error({ err: error, emailId }, 'Archive failed');
    return { success: false, message: `✗ Archive failed: ${error.message}` };
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

    log.info({ emailId }, 'Email trashed via Gmail API');
    return { success: true, message: '✓ Email moved to trash' };
  } catch (error) {
    log.error({ err: error, emailId }, 'Delete failed');
    return { success: false, message: `✗ Delete failed: ${error.message}` };
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
cd ${__dirname}
./unsub "id:${emailId}"
`);
    execSync(`chmod +x ${scriptPath}`);
    execSync(scriptPath, { stdio: 'pipe', timeout: 30000 });
    log.info({ emailId }, 'Unsubscribe automation completed');
    return { success: true, message: '✓ Unsubscribe automation started' };
  } catch (error) {
    log.error({ err: error, emailId }, 'Unsubscribe failed');
    return { success: false, message: `✗ Unsubscribe failed: ${error.message}` };
  }
}

/**
 * Connect to Socket Mode
 */
async function connectSocketMode(db) {
  try {
    log.info('Connecting to Slack Socket Mode');
    const url = await getSocketModeUrl();

    ws = new WebSocket(url);

    ws.on('open', () => {
      log.info('Socket Mode connected');
      heartbeat.write('slack-events', { checkInterval: 30000, status: 'ok' });
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
        log.debug({ envelopeType: envelope.type }, 'Envelope received');

        // Handle different payload types
        if (envelope.type === 'hello') {
          log.info('Received hello from Slack');
        } else if (envelope.type === 'disconnect') {
          log.warn('Slack requested disconnect, reconnecting');
          ws.close();
        } else if (envelope.type === 'events_api') {
          // This is an actual event
          log.debug({ eventType: envelope.payload.event.type }, 'Events API payload');
          await handleEvent(envelope.payload.event, db);
        } else if (envelope.type === 'interactive') {
          // Handle button clicks
          await handleInteractive(envelope.payload);
        } else {
          log.warn({ envelopeType: envelope.type }, 'Unknown envelope type');
        }
        heartbeat.write('slack-events', { checkInterval: 30000, status: 'ok' });
      } catch (error) {
        log.error({ err: error }, 'Error processing WebSocket message');
      }
    });

    ws.on('error', (error) => {
      log.error({ err: error }, 'WebSocket error');
      heartbeat.write('slack-events', {
        checkInterval: 30000,
        status: 'degraded',
        errors: { lastError: 'WebSocket disconnected, reconnecting', lastErrorAt: Date.now(), countSinceStart: ++errorCount }
      });
    });

    ws.on('close', () => {
      log.warn({ reconnectDelayMs: CONFIG.reconnectDelay }, 'Socket Mode disconnected, reconnecting');
      heartbeat.write('slack-events', {
        checkInterval: 30000,
        status: 'degraded',
        errors: { lastError: 'WebSocket disconnected, reconnecting', lastErrorAt: Date.now(), countSinceStart: ++errorCount }
      });
      ws = null;
      reconnectTimeout = setTimeout(() => connectSocketMode(db), CONFIG.reconnectDelay);
    });

  } catch (error) {
    log.error({ err: error }, 'Failed to connect to Socket Mode');
    reconnectTimeout = setTimeout(() => connectSocketMode(db), CONFIG.reconnectDelay);
  }
}

/**
 * Main
 */
async function main() {
  log.info({ responseTimeoutMin: CONFIG.responseTimeout / 60000 }, 'Slack Events Monitor starting');

  // Clean old cache files
  emailCache.cleanOldCache();

  // Show cache stats
  const stats = emailCache.getCacheStats();
  log.info({ cacheCount: stats.count, cacheSizeMB: stats.totalSizeMB }, 'Email cache stats');

  // Get my user ID
  CONFIG.myUserId = await getMyUserId();
  log.info({ myUserId: CONFIG.myUserId }, 'Authenticated with Slack');

  // Validate prerequisites before proceeding
  const validation = validatePrerequisites('slack-events', [
    { type: 'file', path: path.join(config.configDir, 'secrets.json'), description: 'Claudia secrets (Slack tokens)' },
    { type: 'database', path: claudiaDb.DB_PATH, description: 'Claudia database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  // Initialize follow-ups database
  try {
    followupsDbConn = claudiaDb.initDatabase();
    const primaryAccount = claudiaDb.upsertAccount(followupsDbConn, {
      email: CONFIG.gmailAccount,
      provider: 'gmail',
      display_name: 'Primary',
      is_primary: 1
    });
    accountId = primaryAccount.id;
    log.info('Claudia DB initialized');
  } catch (error) {
    log.error({ err: error }, 'Failed to init follow-ups DB');
  }

  // Load state
  loadState();

  // Connect to Socket Mode
  await connectSocketMode(followupsDbConn);

  // Start timeout checker
  setInterval(async () => {
    log.debug('Checking for message timeouts');
    await checkTimeouts();
  }, CONFIG.checkInterval);
}

// Handle graceful shutdown
function shutdown(signal) {
  heartbeat.write('slack-events', { checkInterval: 30000, status: 'shutting-down' });
  log.info({ signal }, 'Received signal, shutting down');
  saveState();
  if (ws) ws.close();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(error => {
  log.fatal({ err: error }, 'Fatal error');
  process.exit(1);
});
