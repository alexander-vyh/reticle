#!/usr/bin/env node
/**
 * Claudia Gmail Monitor - Simple polling-based email assistant
 * Monitors Gmail and sends notifications to Slack
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const emailCache = require('./email-cache');
const followupsDb = require('./followups-db');

// Configuration
const CONFIG = {
  gmailAccount: 'user@example.com',
  slackToken: 'REDACTED_SLACK_BOT_TOKEN',
  mySlackUserId: 'REDACTED_SLACK_USER_ID', // the primary user's user ID
  checkInterval: 5 * 60 * 1000, // 5 minutes
  batchTimes: [9, 12, 15, 18], // Hours to send batched summaries (9am, 12pm, 3pm, 6pm)
  historyFile: process.env.HOME + '/.openclaw/workspace/gmail-last-check.txt',
  batchQueueFile: process.env.HOME + '/.openclaw/workspace/gmail-batch-queue.json'
};

// Batch queue for non-urgent emails
let batchQueue = [];
let lastBatchHour = -1;

// Filtering stats
let filteringStats = {
  archived: 0,
  deleted: 0,
  unsubscribed: 0
};

// Follow-ups database connection
let followupsDbConn = null;

// VIP senders - C-levels and VPs at example.com (from executives.csv)
const VIPS = [
  // Test
  'personal@example.com', // Personal email for testing

  // C-Level
  'ceo@example.com', // CEO
  'cfo@example.com', // CFO
  'cmo@example.com', // CMO
  'cco@example.com', // Chief Customer Officer
  'cpto@example.com', // Chief Product & Technology Officer
  'cro@example.com', // Chief Revenue Officer

  // Senior VPs & VPs
  'vp1@example.com', // SVP New Acquisition Sales
  'vp2@example.com', // VP Campaign Implementation
  'vp3@example.com', // RVP Growth & Strategy
  'vp4@example.com', // VP Product Management
  'vp5@example.com', // VP People Operations
  'vp6@example.com', // VP Revenue Operations
  'vp7@example.com', // VP Inventory
  'vp8@example.com', // VP Supply Ops
  'vp9@example.com', // RVP Growth & Strategy
  'vp10@example.com', // SVP Engineering
  'vp11@example.com', // RVP Growth & Strategy
  'vp12@example.com', // VP Brand & Agency Partnerships
  'vp13@example.com', // VP AdOps Omni
  'vp14@example.com', // VP Client Success - Software
  'vp15@example.com', // VP Programmatic Traders
  'vp16@example.com', // SVP Strategic Partnerships
  'vp17@example.com', // VP Brand & Communications
  'vp18@example.com', // VP Financial Planning & Analysis
  'vp19@example.com', // RVP Growth & Strategy
  'vp20@example.com', // SVP Growth & Strategy
  'vp21@example.com', // SVP General Manager
  'vp22@example.com', // VP Client Success
  'vp23@example.com', // VP Client Success
  'vp24@example.com', // VP Head of Legal
  'vp25@example.com', // SVP Ad Operations
  'vp26@example.com', // VP Infrastructure Operations
  'vp27@example.com', // VP Finance
  'vp28@example.com', // VP AI Implementation
  'vp29@example.com', // VP Growth Marketing
  'vp30@example.com', // VP CS Operations
  'vp31@example.com', // RVP Growth & Strategy

  // C-Level Direct Reports
  'dir1@example.com', // Division Sales Manager
  'dir2@example.com', // Design Manager
  'dir3@example.com', // Regional Sales Manager
  'dir4@example.com', // General Sales Manager
  'dir5@example.com', // Director of Facilities
  'dir6@example.com', // Executive Creative Director
  'dir7@example.com', // Executive Project Manager
  'dir8@example.com', // Specialist, Social Media and Events
  'dir9@example.com', // Sales Development Director
  'dir10@example.com', // Product Specialist
  'dir11@example.com', // Head of Political Sales
  'dir12@example.com', // Regional Sales Manager
  'dir13@example.com', // Regional Sales Manager
  'dir14@example.com', // Regional Manager
  'dir15@example.com' // Director of Client Success - Political
];

// VIP title patterns (case-insensitive)
const VIP_TITLES = ['ceo', 'cto', 'cfo', 'coo', 'cmo', 'ciso', 'cpo', 'vp', 'vice president', 'president'];

// Urgent keywords (case-insensitive)
const URGENT_KEYWORDS = [
  'urgent', 'asap', 'emergency', 'critical', 'immediate',
  'production', 'down', 'outage', 'p0', 'p1',
  'security incident', 'breach', 'help needed'
];

/**
 * Create Block Kit blocks for urgent email with action buttons
 */
function createUrgentEmailBlocks(from, subject, reason, date, emailId) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔴 *URGENT EMAIL*\n*From:* ${from}\n*Subject:* ${subject}\n*Reason:* ${reason}\n*Time:* ${date}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📧 View" },
          action_id: "view_email_modal",
          value: emailId,
          style: "primary"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🌐 Gmail" },
          action_id: "open_in_gmail",
          value: emailId,
          url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✓ Archive" },
          action_id: "archive_email",
          value: emailId
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🗑️ Trash" },
          action_id: "delete_email",
          value: emailId,
          style: "danger"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Unsubscribe" },
          action_id: "unsubscribe_email",
          value: emailId
        }
      ]
    }
  ];
}

/**
 * Send macOS notification using terminal-notifier (appears as "Claudia")
 */
function sendMacOSNotification(title, message) {
  try {
    const escapedTitle = title.replace(/"/g, '\\"').substring(0, 100);
    const escapedMessage = message.replace(/"/g, '\\"').substring(0, 200);
    execSync(
      `terminal-notifier -title "${escapedTitle}" -message "${escapedMessage}" -sound default -sender ai.openclaw.notifications`,
      { stdio: 'pipe' }
    );
  } catch (error) {
    console.error('  ✗ macOS notification error:', error.message);
    if (error.stderr) {
      console.error('  ✗ terminal-notifier stderr:', error.stderr.toString());
    }
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
 * Fetch and cache email content for fast "View" button response
 */
async function fetchAndCacheEmail(emailId) {
  try {
    const gmail = getGmailClient();

    // Fetch full email
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: emailId,
      format: 'full'
    });

    const email = res.data;
    const from = email.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
    const subject = email.payload.headers.find(h => h.name === 'Subject')?.value || 'No subject';
    const date = email.payload.headers.find(h => h.name === 'Date')?.value || 'Unknown date';

    // Get email body - try plain text first, then HTML
    let body = '';
    const parts = email.payload.parts || [email.payload];

    // Try to find plain text part
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body.data) {
        body = Buffer.from(part.body.data, 'base64').toString();
        break;
      }
    }

    // If no plain text, try to get HTML and convert
    if (!body) {
      for (const part of parts) {
        if (part.mimeType === 'text/html' && part.body.data) {
          const { convert } = require('html-to-text');
          const html = Buffer.from(part.body.data, 'base64').toString();
          body = convert(html, {
            wordwrap: 80,
            selectors: [
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' },
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

    // Cache it
    emailCache.cacheEmail(emailId, { from, subject, date, body });
    console.log(`     💾 Pre-cached email ${emailId}`);
    return true;
  } catch (error) {
    console.error(`     ✗ Failed to pre-cache email ${emailId}:`, error.message);
    return false;
  }
}

/**
 * Get my Slack user ID
 */
async function getMySlackUserId() {
  if (CONFIG.mySlackUserId) return CONFIG.mySlackUserId;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'slack.com',
      path: '/api/auth.test',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${CONFIG.slackToken}` }
    };

    https.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          // For bot tokens, we need to find the actual user
          // Let's use the team to send to ourselves
          CONFIG.mySlackUserId = data.user_id || '@redacted.username';
          resolve(CONFIG.mySlackUserId);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Send Slack DM
 */
async function sendSlackDM(message, blocks = null) {
  // Send DM - no fallback
  await sendSlackMessage(CONFIG.mySlackUserId, message, blocks);
  return CONFIG.mySlackUserId;
}

/**
 * Send Slack message (supports Block Kit for interactive buttons)
 */
function sendSlackMessage(channel, message, blocks = null) {
  return new Promise((resolve, reject) => {
    const payload = {
      channel: channel,
      text: message,
      unfurl_links: false,
      as_user: true
    };

    // Add blocks if provided (for interactive messages)
    if (blocks) {
      payload.blocks = blocks;
    }

    const data = JSON.stringify(payload);

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
 * Apply rule-based filtering
 * Returns: { action: 'keep'|'archive'|'delete', reason: string }
 */
function applyRuleBasedFilter(email) {
  const from = email.from.toLowerCase();
  const subject = email.subject.toLowerCase();

  // Auto-archive rules (noise, but keep in archive)
  if (from.includes("' via it") && !from.includes('@example.com">')) {
    return { action: 'archive', reason: 'Kantata via IT notification' };
  }

  if (from.includes('no-reply@zoom.us') && subject.includes('has joined')) {
    return { action: 'archive', reason: 'Zoom join notification' };
  }

  if (subject.includes('[hoxhunt report]')) {
    return { action: 'archive', reason: 'Hoxhunt security training report' };
  }

  if (from.includes('notifications@') && (subject.includes('1:1') || subject.includes('meeting'))) {
    return { action: 'archive', reason: 'Calendar reminder' };
  }

  // Archive Airbrake alerts that come via Digital Workplace group email
  // (but keep direct Airbrake alerts or other Digital Workplace alerts)
  if (from.includes('airbrake') && from.includes('via digital workplace')) {
    return { action: 'archive', reason: 'Airbrake via Digital Workplace' };
  }

  // Archive automated offboarding/onboarding emails from Digital Workplace systems
  if (from.includes('group@example.com') &&
      (subject.includes('offboarding') || subject.includes('onboarding'))) {
    return { action: 'archive', reason: 'Automated onboarding/offboarding notification' };
  }

  // Archive Okta/Jira automated notifications about user lifecycle
  if (from.includes("via digital workplace") &&
      (subject.includes('[jira]') || subject.includes('okta')) &&
      (subject.includes('offboarding') || subject.includes('onboarding'))) {
    return { action: 'archive', reason: 'Okta/Jira user lifecycle notification' };
  }

  // Archive Vanta Trust Center access requests (automated vendor requests)
  if (from.includes('no-reply@vanta.com') &&
      subject.includes('would like access to your trust center')) {
    return { action: 'archive', reason: 'Vanta Trust Center request' };
  }

  // Delete GCP alerts (managed elsewhere)
  if (from.includes('alerting-noreply@google.com') && subject.includes('[ALERT')) {
    return { action: 'delete', reason: 'GCP alerts (handled in GCP console)' };
  }

  // Auto-delete/unsubscribe rules (spam/marketing)
  if (from.match(/@(cio\.com|grouptogether\.com)/)) {
    return { action: 'delete', reason: 'External marketing' };
  }

  if (subject.match(/webcast|webinar|newsletter/i) && !from.includes('@example.com')) {
    return { action: 'delete', reason: 'Marketing content' };
  }

  // Keep for batch/AI review
  return { action: 'keep', reason: 'Passed filters' };
}

/**
 * Archive email in Gmail
 */
function archiveEmail(emailId) {
  try {
    execSync(
      `gog gmail messages modify "${emailId}" --account ${CONFIG.gmailAccount} --remove-labels INBOX --add-labels UNREAD 2>/dev/null`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    console.error(`     ✗ Archive failed: ${error.message}`);
    return false;
  }
}

/**
 * Delete email in Gmail (move to trash)
 */
function deleteEmail(emailId) {
  try {
    execSync(
      `gog gmail messages trash "${emailId}" --account ${CONFIG.gmailAccount} 2>/dev/null`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    console.error(`     ✗ Delete failed: ${error.message}`);
    return false;
  }
}

/**
 * Tag email with a Gmail label (keeps in inbox)
 */
function tagEmail(emailId, label) {
  try {
    execSync(
      `gog gmail messages modify "${emailId}" --account ${CONFIG.gmailAccount} --add-labels "${label}" 2>/dev/null`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    console.error(`     ✗ Tag failed: ${error.message}`);
    return false;
  }
}

/**
 * Check if sender is a VIP
 */
function isVIP(fromEmail) {
  const email = fromEmail.toLowerCase();

  // Check exact matches or domain patterns
  for (const vip of VIPS) {
    if (email.includes(vip.toLowerCase())) {
      return true;
    }
  }

  // Check if email contains VIP title keywords
  for (const title of VIP_TITLES) {
    if (email.toLowerCase().includes(title.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Check urgency with VIP detection
 */
function checkUrgency(email) {
  // VIP check first
  if (isVIP(email.from)) {
    return { urgent: true, reason: '⭐ VIP sender', priority: 'high' };
  }

  // Keyword check with word boundaries for short keywords
  const text = `${email.subject} ${email.snippet || ''}`.toLowerCase();
  const foundKeyword = URGENT_KEYWORDS.find(kw => {
    const keyword = kw.toLowerCase();
    // Use word boundaries for short keywords like "down" to avoid matching "download"
    if (keyword.length <= 4) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      return regex.test(text);
    }
    return text.includes(keyword);
  });
  if (foundKeyword) {
    return { urgent: true, reason: `🔴 Keyword: "${foundKeyword}"`, priority: 'high' };
  }

  return { urgent: false, priority: 'normal' };
}

/**
 * Get recent emails
 */
function getRecentEmails() {
  try {
    const result = execSync(
      `gog gmail messages search "newer_than:10m is:unread" --account ${CONFIG.gmailAccount} --max 50 --json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const data = JSON.parse(result);
    return data.messages || [];
  } catch (error) {
    console.error('Error fetching emails:', error.message);
    return [];
  }
}

/**
 * Get last check time
 */
function getLastCheckTime() {
  try {
    if (fs.existsSync(CONFIG.historyFile)) {
      return parseInt(fs.readFileSync(CONFIG.historyFile, 'utf-8'));
    }
  } catch (error) {}
  return Date.now() - (10 * 60 * 1000); // 10 minutes ago
}

/**
 * Save check time
 */
function saveLastCheckTime() {
  try {
    fs.writeFileSync(CONFIG.historyFile, Date.now().toString());
  } catch (error) {
    console.error('Error saving history:', error.message);
  }
}

/**
 * Load batch queue
 */
function loadBatchQueue() {
  try {
    if (fs.existsSync(CONFIG.batchQueueFile)) {
      const data = fs.readFileSync(CONFIG.batchQueueFile, 'utf-8');
      batchQueue = JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading batch queue:', error.message);
    batchQueue = [];
  }
}

/**
 * Save batch queue
 */
function saveBatchQueue() {
  try {
    fs.writeFileSync(CONFIG.batchQueueFile, JSON.stringify(batchQueue, null, 2));
  } catch (error) {
    console.error('Error saving batch queue:', error.message);
  }
}

/**
 * Check if it's time to send batch summary
 */
function shouldSendBatch() {
  const now = new Date();
  const currentHour = now.getHours();

  // Check if we're at a batch time and haven't sent this hour yet
  if (CONFIG.batchTimes.includes(currentHour) && lastBatchHour !== currentHour) {
    return true;
  }
  return false;
}

/**
 * Extract thread ID from email for tracking
 */
function getEmailThreadId(email) {
  // Use thread ID if available, otherwise use message ID
  return `email:${email.threadId || email.id}`;
}

/**
 * Track email conversation in follow-ups database
 */
function trackEmailConversation(db, email, direction) {
  if (!db) return;

  try {
    const threadId = getEmailThreadId(email);
    const now = Math.floor(Date.now() / 1000);

    // Determine who sent last and who's waiting
    const lastSender = direction === 'incoming' ? 'them' : 'me';
    const waitingFor = direction === 'incoming' ? 'my-response' : 'their-response';

    // Extract sender name from "Name <email@domain.com>" format
    let fromName = email.from;
    const match = email.from.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      fromName = match[1].replace(/"/g, '');
    }

    followupsDb.trackConversation(db, {
      id: threadId,
      type: 'email',
      subject: email.subject,
      from_user: email.from,
      from_name: fromName,
      last_activity: Math.floor(new Date(email.date).getTime() / 1000),
      last_sender: lastSender,
      waiting_for: waitingFor,
      first_seen: now
    });
  } catch (error) {
    console.error('     ✗ Failed to track email:', error.message);
  }
}

/**
 * Send batch summary with interactive buttons
 */
async function sendBatchSummary() {
  if (batchQueue.length === 0) {
    console.log('  ℹ️  No non-urgent emails to summarize');
    return;
  }

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Sanitize text to avoid JSON issues
  const sanitize = (text) => text.replace(/[^\x20-\x7E]/g, '').substring(0, 200);

  // Build Block Kit blocks
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📬 *Email Summary - ${timeStr}*\nFound ${batchQueue.length} non-urgent email(s):`
      }
    },
    { type: "divider" }
  ];

  // Add up to 10 emails with action buttons
  const emailsToShow = batchQueue.slice(0, 10);

  for (const email of emailsToShow) {
    const safeFrom = sanitize(email.from);
    const safeSubject = sanitize(email.subject);

    // Email info section
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*From:* ${safeFrom}\n*Subject:* ${safeSubject}`
      }
    });

    // Action buttons for this email
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📧 View" },
          action_id: "view_email_modal",
          value: email.id,
          style: "primary"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🌐 Gmail" },
          action_id: "open_in_gmail",
          value: email.id,
          url: `https://mail.google.com/mail/u/0/#inbox/${email.id}`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✓ Archive" },
          action_id: "archive_email",
          value: email.id
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🗑️ Trash" },
          action_id: "delete_email",
          value: email.id,
          style: "danger"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Unsubscribe" },
          action_id: "unsubscribe_email",
          value: email.id
        }
      ]
    });
  }

  // Add note if there are more emails
  if (batchQueue.length > 10) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_...and ${batchQueue.length - 10} more emails not shown_`
        }
      ]
    });
  }

  try {
    const fallbackText = `📬 Email Summary - ${timeStr} (${batchQueue.length} emails)`;
    await sendSlackDM(fallbackText, blocks);
    console.log(`  ✓ Sent batch summary (${batchQueue.length} emails)`);

    // Pre-cache emails for instant "View" button response
    console.log(`  💾 Pre-caching ${emailsToShow.length} email(s)...`);
    const cachePromises = emailsToShow.map(email => fetchAndCacheEmail(email.id));
    await Promise.all(cachePromises);
    console.log(`  ✓ Cached ${emailsToShow.length} email(s)`);

    // Clear queue
    batchQueue = [];
    saveBatchQueue();
    lastBatchHour = now.getHours();
  } catch (error) {
    console.error('  ✗ Failed to send batch summary:', error.message);
  }
}

/**
 * Main check function
 */
async function checkEmails() {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] Checking for new emails...`);

  const emails = getRecentEmails();
  const lastCheck = getLastCheckTime();

  if (emails.length === 0) {
    console.log('  No unread emails in last 10 minutes');
    saveLastCheckTime();
    return;
  }

  console.log(`  Found ${emails.length} unread email(s)`);

  let urgentCount = 0;

  for (const email of emails) {
    const emailDate = new Date(email.date).getTime();
    if (emailDate < lastCheck) continue; // Already processed

    // Apply rule-based filtering first
    const filter = applyRuleBasedFilter(email);
    const fromShort = email.from.length > 50 ? email.from.substring(0, 47) + '...' : email.from;

    if (filter.action === 'archive') {
      console.log(`  📦 Archiving: ${fromShort}`);
      console.log(`     Reason: ${filter.reason}`);
      if (archiveEmail(email.id)) {
        filteringStats.archived++;
      }
      continue;
    }

    if (filter.action === 'delete') {
      console.log(`  🗑️  Deleting: ${fromShort}`);
      console.log(`     Reason: ${filter.reason}`);
      if (deleteEmail(email.id)) {
        filteringStats.deleted++;
      }
      continue;
    }

    if (filter.action === 'tag') {
      console.log(`  🏷️  Tagging: ${fromShort}`);
      console.log(`     Label: ${filter.label}`);
      console.log(`     Reason: ${filter.reason}`);
      tagEmail(email.id, filter.label);
      // Continue processing (don't skip) - email stays in inbox and will be checked for urgency
    }

    // Email passed filters - check urgency
    const urgency = checkUrgency(email);

    console.log(`  📧 From: ${fromShort}`);
    console.log(`     Subject: ${email.subject}`);
    console.log(`     ${urgency.urgent ? '🔴 URGENT - ' + urgency.reason : '⚪ Normal'}`);

    if (urgency.urgent) {
      urgentCount++;

      // Sanitize email data to avoid JSON issues
      const sanitize = (text) => text.replace(/[^\x20-\x7E]/g, '').substring(0, 200);
      const safeFrom = sanitize(email.from);
      const safeSubject = sanitize(email.subject);

      // Try Slack notification with interactive buttons
      try {
        const blocks = createUrgentEmailBlocks(
          safeFrom,
          safeSubject,
          urgency.reason,
          email.date,
          email.id
        );
        const target = await sendSlackDM(
          `🔴 URGENT EMAIL from ${safeFrom}`, // Fallback text
          blocks
        );
        console.log(`     ✓ Sent Slack DM with action buttons (${target})`);

        // Pre-cache email content for instant "View" button response
        await fetchAndCacheEmail(email.id);
      } catch (error) {
        console.error(`     ✗ Slack error:`, error.message);
      }

      // Always send macOS notification (independent of Slack)
      try {
        sendMacOSNotification(
          `🔴 Urgent Email: ${urgency.reason}`,
          `From: ${safeFrom.substring(0, 50)}\n${safeSubject.substring(0, 100)}`
        );
        console.log(`     ✓ Sent macOS notification`);
      } catch (error) {
        console.error(`     ✗ macOS notification error:`, error.message);
      }

      // Track in follow-ups database
      trackEmailConversation(followupsDbConn, email, 'incoming');
    } else {
      // Add to batch queue for later summary
      batchQueue.push({
        from: email.from,
        subject: email.subject,
        date: email.date,
        id: email.id
      });
      // Track in follow-ups database
      trackEmailConversation(followupsDbConn, email, 'incoming');
    }
  }

  // Report processing summary
  const filtered = filteringStats.archived + filteringStats.deleted;
  if (urgentCount > 0 || batchQueue.length > 0 || filtered > 0) {
    let summary = `  ✓ Processed ${emails.length} emails`;
    if (urgentCount > 0) summary += `, ${urgentCount} urgent`;
    if (filtered > 0) summary += `, ${filtered} filtered (${filteringStats.archived} archived, ${filteringStats.deleted} deleted)`;
    if (batchQueue.length > 0) summary += `, ${batchQueue.length} in batch queue`;
    console.log(summary);
  }

  // Reset filtering stats for next check
  filteringStats = { archived: 0, deleted: 0, unsubscribed: 0 };

  saveBatchQueue();
  saveLastCheckTime();

  // Check if it's time to send batch summary
  if (shouldSendBatch()) {
    console.log('\n  ⏰ Batch summary time!');
    await sendBatchSummary();
  }
}

/**
 * Main
 */
async function main() {
  console.log('🦞 OpenClaw Gmail Monitor');
  console.log(`   Account: ${CONFIG.gmailAccount}`);
  console.log(`   Mode: DM notifications for urgent emails`);
  console.log(`   VIPs configured: ${VIPS.length} patterns`);
  console.log(`   Batch times: ${CONFIG.batchTimes.map(h => `${h}:00`).join(', ')}`);
  console.log(`   Check interval: ${CONFIG.checkInterval / 1000}s\n`);

  // Load batch queue from previous session
  loadBatchQueue();
  if (batchQueue.length > 0) {
    console.log(`   Loaded ${batchQueue.length} emails from previous batch queue\n`);
  }

  // Initialize follow-ups database
  try {
    followupsDbConn = followupsDb.initDatabase();
    console.log('   ✓ Follow-ups tracking initialized\n');
  } catch (error) {
    console.error('   ✗ Failed to init follow-ups DB:', error.message);
  }

  // Initial check
  await checkEmails();
  console.log('');

  // Loop
  setInterval(async () => {
    try {
      await checkEmails();
      console.log('');
    } catch (error) {
      console.error('Check error:', error);
    }
  }, CONFIG.checkInterval);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
