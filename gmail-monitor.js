#!/usr/bin/env node
/**
 * Claudia Gmail Monitor - Simple polling-based email assistant
 * Monitors Gmail and sends notifications to Slack
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const emailCache = require('./email-cache');
const followupsDb = require('./followups-db');
const { parseSenderEmail, formatRuleDescription } = require('./lib/email-utils');
const log = require('./lib/logger')('gmail-monitor');
const config = require('./lib/config');

// Configuration
const CONFIG = {
  gmailAccount: config.gmailAccount,
  slackToken: config.slackBotToken,
  mySlackUserId: config.slackUserId,
  checkInterval: 5 * 60 * 1000, // 5 minutes
  batchTimes: [9, 12, 15, 18], // Hours to send batched summaries (9am, 12pm, 3pm, 6pm)
  healthCheckHour: 8, // Daily health summary at 8 AM
  historyFile: path.join(__dirname, 'gmail-last-check.txt'),
  batchQueueFile: path.join(__dirname, 'gmail-batch-queue.json'),
  heartbeatFile: path.join(__dirname, 'gmail-heartbeat.json')
};

// Batch queue for non-urgent emails
let batchQueue = [];
let lastBatchHour = -1;

// Filtering stats (per check cycle)
let filteringStats = {
  archived: 0,
  deleted: 0,
  unsubscribed: 0
};

// Daily cumulative stats (reset after health summary)
let dailyStats = {
  checksRun: 0,
  emailsSeen: 0,
  archived: 0,
  deleted: 0,
  urgent: 0,
  batched: 0,
  batchesSent: 0,
  errors: 0,
  startedAt: Date.now()
};
let lastHealthCheckHour = -1;

// Follow-ups database connection
let followupsDbConn = null;

// Sent-mail detection: use wider window on first run to cover restart gaps
let sentMailFirstRun = true;

// VIP senders (loaded from ~/.config/claudia/team.json)
const VIPS = config.vipEmails;

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
/**
 * Build context-aware overflow menu options for email classification.
 * @param {'urgent'|'batch'} context - Current email context
 * @param {string} emailId - Gmail message ID
 * @param {string} senderDomain - Extracted sender domain
 */
function buildClassifyOverflow(context, emailId, senderDomain) {
  // Short codes: as=archive sender, ds=delete sender, ls=alert sender,
  //              dm=demote sender, ad=archive domain
  const options = context === 'urgent'
    ? [
        { text: { type: 'plain_text', text: "Don't alert from this sender" }, value: `dm|${emailId}` },
        { text: { type: 'plain_text', text: "Don't show from this sender" }, value: `as|${emailId}` },
        { text: { type: 'plain_text', text: 'Auto-delete from this sender' }, value: `ds|${emailId}` },
        { text: { type: 'plain_text', text: `Don't show from @${senderDomain}` }, value: `ad|${emailId}` }
      ]
    : [
        { text: { type: 'plain_text', text: "Don't show from this sender" }, value: `as|${emailId}` },
        { text: { type: 'plain_text', text: 'Auto-delete from this sender' }, value: `ds|${emailId}` },
        { text: { type: 'plain_text', text: 'Always alert from this sender' }, value: `ls|${emailId}` },
        { text: { type: 'plain_text', text: `Don't show from @${senderDomain}` }, value: `ad|${emailId}` }
      ];

  return {
    type: 'overflow',
    action_id: 'classify_email',
    options
  };
}

function createUrgentEmailBlocks(from, subject, reason, date, emailId, threadId) {
  const value = threadId ? `${emailId}|${threadId}` : emailId;
  const { domain: senderDomain } = parseSenderEmail(from);
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
          value: value,
          style: "primary"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🌐 Gmail" },
          action_id: "open_in_gmail",
          value: value,
          url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Replied" },
          action_id: "mark_replied",
          value: value
        },
        {
          type: "button",
          text: { type: "plain_text", text: "No Reply Needed" },
          action_id: "mark_no_response_needed",
          value: value
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✓ Archive" },
          action_id: "archive_email",
          value: value
        }
      ]
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🗑️ Trash" },
          action_id: "delete_email",
          value: value,
          style: "danger"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Unsubscribe" },
          action_id: "unsubscribe_email",
          value: value
        },
        buildClassifyOverflow('urgent', emailId, senderDomain)
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
    log.error({ err: error }, 'macOS notification error');
    if (error.stderr) {
      log.error({ stderr: error.stderr?.toString() }, 'terminal-notifier stderr');
    }
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
    log.info({ emailId }, 'Pre-cached email');
    return true;
  } catch (error) {
    log.error({ err: error, emailId }, 'Failed to pre-cache email');
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
          CONFIG.mySlackUserId = data.user_id || '@' + config.slackUsername;
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
            log.debug({ ts: response.ts, channel }, 'Slack message delivered');
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

// ── User-trained rules (loaded from DB each check cycle) ──────────────
let userRules = [];

function loadUserRules() {
  if (!followupsDbConn) return;
  try {
    userRules = followupsDb.getActiveRules(followupsDbConn);
    if (userRules.length > 0) {
      log.info({ count: userRules.length }, 'Loaded user email rules');
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to load user rules');
    userRules = [];
  }
}

/**
 * Apply user-trained classification rules.
 * Most-specific rule wins (already sorted by getActiveRules).
 * Returns { action, reason, ruleId } or null if no rule matches.
 */
function applyUserRules(email) {
  if (userRules.length === 0) return null;

  const from = email.from.toLowerCase();
  const { email: senderEmail, domain: senderDomain } = parseSenderEmail(email.from);
  const subject = email.subject.toLowerCase();
  const to = (email.to || '').toLowerCase();
  const cc = (email.cc || '').toLowerCase();
  const recipients = `${to} ${cc}`;

  for (const rule of userRules) {
    // All non-null conditions must match (AND logic)
    if (rule.match_from && senderEmail !== rule.match_from) continue;
    if (rule.match_from_domain && senderDomain !== rule.match_from_domain) continue;
    if (rule.match_to && !recipients.includes(rule.match_to)) continue;
    if (rule.match_subject_contains && !subject.includes(rule.match_subject_contains)) continue;

    // Record the hit (fire-and-forget — don't block on DB write)
    try { followupsDb.recordRuleHit(followupsDbConn, rule.id); } catch { /* ignore */ }

    return { action: rule.rule_type, reason: `Learned: ${formatRuleDescription(rule)}`, ruleId: rule.id };
  }

  return null;
}

/**
 * Apply rule-based filtering
 * Returns: { action: 'keep'|'archive'|'delete', reason: string }
 */
function applyRuleBasedFilter(email) {
  const from = email.from.toLowerCase();
  const subject = email.subject.toLowerCase();

  // De-duplicate: archive DW-forwarded copies of emails that also arrive directly
  if (from.includes('via digital workplace')) {
    const dwDuplicateSenders = [
      'datadog', 'cursor', 'google workspace alerts', "'google'",
      'slack', 'atlassian', 'warmly', 'otter.ai'
    ];
    if (dwDuplicateSenders.some(s => from.includes(s))) {
      return { action: 'archive', reason: 'DW duplicate (direct copy exists)' };
    }
  }

  // Auto-archive rules (noise, but keep in archive)
  if (from.includes("' via it") && !from.includes('@' + config.filterPatterns.companyDomain)) {
    return { action: 'archive', reason: 'Kantata via IT notification' };
  }

  if (from.includes('no-reply@zoom.us') && subject.includes('has joined')) {
    return { action: 'archive', reason: 'Zoom join notification' };
  }

  // Archive automated Role Group Audit notifications (DW automation)
  if (subject.includes('role group audit')) {
    return { action: 'archive', reason: 'Role Group Audit automation' };
  }

  // Archive Salesloft notices via DW
  if (from.includes('via digital workplace') && from.includes('salesloft')) {
    return { action: 'archive', reason: 'Salesloft via DW' };
  }

  // Archive Docusign completion/decline via DW (not direct Docusign emails)
  if (from.includes('via digital workplace') && from.includes('docusign')) {
    return { action: 'archive', reason: 'Docusign via DW' };
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
  if (from.includes(config.filterPatterns.dwGroupEmail) &&
      (subject.includes('offboarding') || subject.includes('onboarding'))) {
    return { action: 'archive', reason: 'Automated onboarding/offboarding notification' };
  }

  // Archive Okta/Jira automated notifications about user lifecycle
  if (from.includes("via digital workplace") &&
      (subject.includes('[jira]') || subject.includes('okta')) &&
      (subject.includes('offboarding') || subject.includes('onboarding'))) {
    return { action: 'archive', reason: 'Okta/Jira user lifecycle notification' };
  }

  // Archive all Jira notification emails (already visible in Jira/Slack)
  if (from.includes('jira@company.atlassian.net')) {
    return { action: 'archive', reason: 'Jira notification (available in Jira)' };
  }

  // Archive Confluence digest emails (already visible in Confluence)
  if (from.includes('confluence@company.atlassian.net') && subject.includes('digest')) {
    return { action: 'archive', reason: 'Confluence digest' };
  }

  // Archive Atlassian admin notifications
  if (from.includes('@id.atlassian.net')) {
    return { action: 'archive', reason: 'Atlassian admin notification' };
  }

  // Archive Vanta Trust Center access requests (automated vendor requests)
  if (from.includes('no-reply@vanta.com') &&
      subject.includes('would like access to your trust center')) {
    return { action: 'archive', reason: 'Vanta Trust Center request' };
  }

  // Archive MxToolBox blacklist summaries
  if (from.includes('mxtoolbox.com')) {
    return { action: 'archive', reason: 'MxToolBox summary' };
  }

  // Archive OpenX automated reports (goes to IT team list)
  if (from.includes('openx.com') && subject.includes('scheduled report')) {
    return { action: 'archive', reason: 'OpenX team report' };
  }

  // Archive CISA bulletins (via infosec list)
  if (from.includes('infosec@' + config.filterPatterns.companyDomain) && from.includes('cisa')) {
    return { action: 'archive', reason: 'CISA bulletin' };
  }

  // Delete Slack email notification summaries (redundant with Slack itself)
  if (from.includes('feedback@slack.com') || (from.includes('slack') && subject.match(/notifications in .* for /i))) {
    return { action: 'delete', reason: 'Slack email digest' };
  }

  // Delete GCP alerts (managed elsewhere)
  if (from.includes('alerting-noreply@google.com') && subject.includes('[alert')) {
    return { action: 'delete', reason: 'GCP alerts (handled in GCP console)' };
  }

  // Auto-delete/unsubscribe rules (spam/marketing)
  if (from.match(/@(cio\.com|grouptogether\.com)/)) {
    return { action: 'delete', reason: 'External marketing' };
  }

  if (subject.match(/webcast|webinar|newsletter/i) && !from.includes('@' + config.filterPatterns.companyDomain)) {
    return { action: 'delete', reason: 'Marketing content' };
  }

  // Product marketing / vendor spam (unsubscribed or unwanted)
  if (from.includes('hello@warmly.ai') || from.includes('warmly.ai')) {
    return { action: 'delete', reason: 'Warmly marketing' };
  }
  if (from.includes('@dtdg.co') && subject.match(/digest/i)) {
    return { action: 'delete', reason: 'Datadog digest' };
  }
  if (from.includes('team@mail.cursor.com')) {
    return { action: 'delete', reason: 'Cursor marketing' };
  }
  if (from.includes('otter.ai')) {
    return { action: 'delete', reason: 'Otter.ai notifications' };
  }
  if (from.includes('brighttalk.com')) {
    return { action: 'delete', reason: 'BrightTALK marketing' };
  }
  if (from.includes('tropicapp.io')) {
    return { action: 'delete', reason: 'Tropic marketing' };
  }
  if (from.includes('commvault.com') && !from.includes('@' + config.filterPatterns.companyDomain)) {
    return { action: 'delete', reason: 'Commvault marketing' };
  }
  if (from.includes('stoneflymail')) {
    return { action: 'delete', reason: 'Cold outreach spam' };
  }
  if (from.includes('brightenergywellness')) {
    return { action: 'delete', reason: 'Spam' };
  }
  if (from.includes('trycomp.ai')) {
    return { action: 'delete', reason: 'Comp AI marketing' };
  }

  // Vendor cold outreach / sales spam
  if (from.includes('akeyless.io')) {
    return { action: 'delete', reason: 'Vendor outreach (Akeyless)' };
  }
  if (from.includes('lumos.com')) {
    return { action: 'delete', reason: 'Vendor outreach (Lumos)' };
  }
  if (from.includes('mailboxmerchants.com')) {
    return { action: 'delete', reason: 'Vendor outreach (Mailbox Merchants)' };
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
      `gog gmail batch modify "${emailId}" --remove INBOX --account ${CONFIG.gmailAccount} --no-input`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    log.error({ err: error, emailId }, 'Archive failed');
    return false;
  }
}

/**
 * Delete email in Gmail (move to trash)
 */
function deleteEmail(emailId) {
  try {
    execSync(
      `gog gmail batch modify "${emailId}" --add TRASH --remove INBOX --account ${CONFIG.gmailAccount} --no-input`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    log.error({ err: error, emailId }, 'Delete failed');
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
    log.error({ err: error, emailId, label }, 'Tag failed');
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

  // Okta admin role changes — always urgent
  const fromLower = email.from.toLowerCase();
  const subjLower = email.subject.toLowerCase();
  if (fromLower.includes('noreply@okta.com') && subjLower.includes('admin role')) {
    return { urgent: true, reason: '🔒 Okta admin role change', priority: 'high' };
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
    log.error({ err: error }, 'Error fetching emails');
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
    log.error({ err: error }, 'Error saving history');
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
    log.error({ err: error }, 'Error loading batch queue');
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
    log.error({ err: error }, 'Error saving batch queue');
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
function trackEmailConversation(db, email, direction, metadata) {
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
      first_seen: now,
      metadata: metadata || null
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to track email');
  }
}

/**
 * Send batch summary with interactive buttons
 */
async function sendBatchSummary() {
  if (batchQueue.length === 0) {
    log.info('No non-urgent emails to summarize');
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
    const { domain: senderDomain } = parseSenderEmail(email.from);

    // Email info section
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*From:* ${safeFrom}\n*Subject:* ${safeSubject}`
      }
    });

    // Action buttons for this email (encode emailId|threadId for conversation tracking)
    const batchValue = email.threadId ? `${email.id}|${email.threadId}` : email.id;

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📧 View" },
          action_id: "view_email_modal",
          value: batchValue,
          style: "primary"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🌐 Gmail" },
          action_id: "open_in_gmail",
          value: batchValue,
          url: `https://mail.google.com/mail/u/0/#inbox/${email.id}`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Replied" },
          action_id: "mark_replied",
          value: batchValue
        },
        {
          type: "button",
          text: { type: "plain_text", text: "No Reply Needed" },
          action_id: "mark_no_response_needed",
          value: batchValue
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✓ Archive" },
          action_id: "archive_email",
          value: batchValue
        }
      ]
    });

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🗑️ Trash" },
          action_id: "delete_email",
          value: batchValue,
          style: "danger"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Unsubscribe" },
          action_id: "unsubscribe_email",
          value: batchValue
        },
        buildClassifyOverflow('batch', email.id, senderDomain)
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
    log.info({ count: batchQueue.length }, 'Sent batch summary');

    // Pre-cache emails for instant "View" button response
    log.info({ count: emailsToShow.length }, 'Pre-caching emails');
    const cachePromises = emailsToShow.map(email => fetchAndCacheEmail(email.id));
    await Promise.all(cachePromises);
    log.info({ count: emailsToShow.length }, 'Cached emails');

    // Clear queue
    batchQueue = [];
    saveBatchQueue();
    lastBatchHour = now.getHours();
  } catch (error) {
    log.error({ err: error }, 'Failed to send batch summary');
  }
}

/**
 * Check sent emails to detect replies to tracked conversations
 * Flips waiting_for from 'my-response' to 'their-response' when a reply is found
 */
async function checkSentEmails() {
  if (!followupsDbConn) return;

  try {
    const gmail = getGmailClient();

    // Use wider window on first run to cover restart gaps
    const timeWindow = sentMailFirstRun ? '30m' : '10m';
    sentMailFirstRun = false;

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `in:sent newer_than:${timeWindow}`,
      maxResults: 50
    });

    const sentMessages = res.data.messages || [];
    if (sentMessages.length === 0) {
      log.debug('No recent sent emails');
      return;
    }

    // Get all pending email conversations
    const pending = followupsDb.getPendingResponses(followupsDbConn, { type: 'email' });
    if (pending.length === 0) {
      log.debug('No pending email conversations to match against');
      return;
    }

    // Build set of pending threadIds (strip 'email:' prefix from conversation IDs)
    const pendingByThread = new Map();
    for (const conv of pending) {
      const threadId = conv.id.replace(/^email:/, '');
      pendingByThread.set(threadId, conv);
    }

    let flipped = 0;
    for (const msg of sentMessages) {
      if (!msg.threadId || !pendingByThread.has(msg.threadId)) continue;

      const conv = pendingByThread.get(msg.threadId);

      // Idempotency: skip if already flipped
      if (conv.waiting_for === 'their-response') continue;

      followupsDb.updateConversationState(followupsDbConn, conv.id, 'me', 'their-response');
      flipped++;
    }

    if (flipped > 0) {
      log.info({ flipped, checked: sentMessages.length }, 'Flipped conversations to their-response via sent-mail detection');
    } else {
      log.debug({ checked: sentMessages.length }, 'Sent-mail check: 0 flipped');
    }
  } catch (error) {
    log.error({ err: error }, 'Sent-mail detection failed');
  }
}

/**
 * Main check function
 */
async function checkEmails() {
  log.info('Checking for new emails');

  const emails = getRecentEmails();
  const lastCheck = getLastCheckTime();

  if (emails.length === 0) {
    log.info('No unread emails in last 10 minutes');
    saveLastCheckTime();
    return;
  }

  log.info({ count: emails.length }, 'Found unread emails');

  // Reload user-trained rules each cycle (sub-ms for small table)
  loadUserRules();

  let urgentCount = 0;

  for (const email of emails) {
    const emailDate = new Date(email.date).getTime();
    if (emailDate < lastCheck) continue; // Already processed

    const fromShort = email.from.length > 50 ? email.from.substring(0, 47) + '...' : email.from;

    // Apply user-trained rules first (highest priority)
    const userRule = applyUserRules(email);
    if (userRule) {
      if (userRule.action === 'archive') {
        log.info({ from: fromShort, reason: userRule.reason }, 'Archiving email (user rule)');
        if (archiveEmail(email.id)) filteringStats.archived++;
        continue;
      }
      if (userRule.action === 'delete') {
        log.info({ from: fromShort, reason: userRule.reason }, 'Deleting email (user rule)');
        if (deleteEmail(email.id)) filteringStats.deleted++;
        continue;
      }
      if (userRule.action === 'demote') {
        log.info({ from: fromShort, reason: userRule.reason }, 'Demoting to batch (user rule)');
        batchQueue.push({ from: email.from, subject: email.subject, date: email.date, id: email.id, threadId: email.threadId });
        trackEmailConversation(followupsDbConn, email, 'incoming', { urgency: 'batch', demoted: true });
        continue;
      }
      // 'alert' action: force urgent — skip urgency check, handled below after hardcoded filters
    }

    // Apply hardcoded rule-based filtering
    const filter = applyRuleBasedFilter(email);

    if (filter.action === 'archive') {
      log.info({ from: fromShort, reason: filter.reason }, 'Archiving email');
      if (archiveEmail(email.id)) {
        filteringStats.archived++;
      }
      continue;
    }

    if (filter.action === 'delete') {
      log.info({ from: fromShort, reason: filter.reason }, 'Deleting email');
      if (deleteEmail(email.id)) {
        filteringStats.deleted++;
      }
      continue;
    }

    if (filter.action === 'tag') {
      log.info({ from: fromShort, label: filter.label, reason: filter.reason }, 'Tagging email');
      tagEmail(email.id, filter.label);
      // Continue processing (don't skip) - email stays in inbox and will be checked for urgency
    }

    // If user rule said 'alert', force urgent — bypass normal urgency check
    const urgency = (userRule && userRule.action === 'alert')
      ? { urgent: true, reason: userRule.reason }
      : checkUrgency(email);

    log.info({
      from: fromShort,
      subject: email.subject,
      urgent: urgency.urgent,
      reason: urgency.urgent ? urgency.reason : undefined
    }, urgency.urgent ? 'Urgent email detected' : 'Normal email queued');

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
          email.id,
          email.threadId
        );
        const target = await sendSlackDM(
          `🔴 URGENT EMAIL from ${safeFrom}`, // Fallback text
          blocks
        );
        log.info({ target }, 'Sent Slack DM with action buttons');

        // Pre-cache email content for instant "View" button response
        await fetchAndCacheEmail(email.id);
      } catch (error) {
        log.error({ err: error }, 'Slack notification failed');
      }

      // Always send macOS notification (independent of Slack)
      try {
        sendMacOSNotification(
          `🔴 Urgent Email: ${urgency.reason}`,
          `From: ${safeFrom.substring(0, 50)}\n${safeSubject.substring(0, 100)}`
        );
        log.info('Sent macOS notification');
      } catch (error) {
        log.error({ err: error }, 'macOS notification failed');
      }

      // Track in follow-ups database with urgency metadata
      trackEmailConversation(followupsDbConn, email, 'incoming', { urgency: 'urgent', reason: urgency.reason });
    } else {
      // Add to batch queue for later summary
      batchQueue.push({
        from: email.from,
        subject: email.subject,
        date: email.date,
        id: email.id,
        threadId: email.threadId
      });
      // Track in follow-ups database with batch metadata
      trackEmailConversation(followupsDbConn, email, 'incoming', { urgency: 'batch' });
    }
  }

  // Report processing summary
  log.info({
    total: emails.length,
    urgent: urgentCount,
    archived: filteringStats.archived,
    deleted: filteringStats.deleted,
    queued: batchQueue.length
  }, 'Email check complete');

  // Accumulate daily stats
  dailyStats.checksRun++;
  dailyStats.emailsSeen += emails.length;
  dailyStats.archived += filteringStats.archived;
  dailyStats.deleted += filteringStats.deleted;
  dailyStats.urgent += urgentCount;

  // Reset filtering stats for next check
  filteringStats = { archived: 0, deleted: 0, unsubscribed: 0 };

  saveBatchQueue();
  saveLastCheckTime();
  writeHeartbeat();

  // Check if it's time to send batch summary
  if (shouldSendBatch()) {
    log.info('Batch summary time');
    await sendBatchSummary();
    dailyStats.batchesSent++;
  }

  // Daily health check at configured hour
  await maybeSendHealthCheck();

  // Detect replies in sent mail and flip conversation state
  await checkSentEmails();
}

/**
 * Write heartbeat file with current state
 */
function writeHeartbeat() {
  try {
    const heartbeat = {
      lastCheck: Date.now(),
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      batchQueueSize: batchQueue.length,
      dailyStats
    };
    fs.writeFileSync(CONFIG.heartbeatFile, JSON.stringify(heartbeat));
  } catch (e) {
    log.warn({ err: e }, 'Failed to write heartbeat');
  }
}

/**
 * Send daily health summary at configured hour
 */
async function maybeSendHealthCheck() {
  const currentHour = new Date().getHours();
  if (currentHour !== CONFIG.healthCheckHour || lastHealthCheckHour === currentHour) return;

  lastHealthCheckHour = currentHour;

  const uptimeHrs = Math.round(process.uptime() / 3600);

  // Build learned-rules summary
  let rulesLine = '';
  try {
    if (followupsDbConn) {
      const rulesSummary = followupsDb.getRulesSummary(followupsDbConn);
      if (rulesSummary.total > 0) {
        const topLines = rulesSummary.top.map((r, i) =>
          `    ${i + 1}. ${r.rule_type.charAt(0).toUpperCase() + r.rule_type.slice(1)} ${formatRuleDescription(r)} (${r.hit_count} hits)`
        );
        rulesLine = `\n  📋 Learned Rules: ${rulesSummary.total} active\n${topLines.join('\n')}`;
      }
    }
  } catch { /* don't break health check for rules summary */ }

  const summary = [
    `*Gmail Monitor Health Check*`,
    `Uptime: ${uptimeHrs}h | PID: ${process.pid}`,
    `Since last health check: ${dailyStats.checksRun} checks, ${dailyStats.emailsSeen} emails scanned`,
    `  Archived: ${dailyStats.archived} | Deleted: ${dailyStats.deleted} | Urgent: ${dailyStats.urgent} | Batches sent: ${dailyStats.batchesSent}`,
    `  Queue: ${batchQueue.length} emails pending for next batch${rulesLine}`
  ].join('\n');

  try {
    await sendSlackDM(summary);
    log.info('Daily health check sent');
  } catch (e) {
    log.error({ err: e }, 'Failed to send health check');
  }

  // Reset daily stats
  dailyStats = {
    checksRun: 0, emailsSeen: 0, archived: 0, deleted: 0,
    urgent: 0, batched: 0, batchesSent: 0, errors: 0, startedAt: Date.now()
  };
}

/**
 * Main
 */
async function main() {
  log.info({
    account: CONFIG.gmailAccount,
    vipCount: VIPS.length,
    batchTimes: CONFIG.batchTimes,
    checkInterval: CONFIG.checkInterval / 1000
  }, 'Gmail Monitor starting');

  // Load batch queue from previous session
  loadBatchQueue();
  if (batchQueue.length > 0) {
    log.info({ count: batchQueue.length }, 'Loaded batch queue from previous session');
  }

  // Initialize follow-ups database
  try {
    followupsDbConn = followupsDb.initDatabase();
    log.info('Follow-ups tracking initialized');
  } catch (error) {
    log.error({ err: error }, 'Failed to init follow-ups DB');
  }

  // Initial check
  await checkEmails();

  // Loop
  setInterval(async () => {
    try {
      await checkEmails();
    } catch (error) {
      log.error({ err: error }, 'Check error');
    }
  }, CONFIG.checkInterval);
}

main().catch(error => {
  log.fatal({ err: error }, 'Fatal error');
  process.exit(1);
});
