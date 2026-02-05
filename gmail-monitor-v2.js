#!/usr/bin/env node
/**
 * OpenClaw Gmail Monitor - Simple polling-based email assistant
 * Checks Gmail every 5 minutes and sends notifications to Slack
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');

// Configuration
const CONFIG = {
  gmailAccount: 'user@example.com',
  slackToken: 'REDACTED_SLACK_BOT_TOKEN',
  slackUserId: 'U05KZQZQZQZ', // TODO: Get your Slack user ID
  checkInterval: 5 * 60 * 1000, // 5 minutes
  historyFile: process.env.HOME + '/.openclaw/workspace/gmail-last-check.txt'
};

// VIP senders (will notify immediately)
const VIPS = [
  // Add VIP email addresses or domains here
  // e.g., 'boss@company.com', '@client.com'
];

// Urgent keywords
const URGENT_KEYWORDS = [
  'urgent', 'asap', 'emergency', 'critical', 'immediate',
  'production', 'down', 'outage', 'p0', 'p1',
  'security incident', 'breach'
];

/**
 * Send a Slack DM
 */
function sendSlackDM(message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      channel: CONFIG.slackUserId,
      text: message,
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
        const response = JSON.parse(body);
        if (response.ok) {
          resolve(response);
        } else {
          reject(new Error(`Slack API error: ${response.error}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Check if email is urgent
 */
function isUrgent(email) {
  const { from, subject, snippet } = email;

  // Check VIPs
  if (VIPS.some(vip => from.toLowerCase().includes(vip.toLowerCase()))) {
    return { urgent: true, reason: 'VIP sender' };
  }

  // Check keywords
  const text = `${subject} ${snippet}`.toLowerCase();
  const foundKeyword = URGENT_KEYWORDS.find(kw => text.includes(kw.toLowerCase()));
  if (foundKeyword) {
    return { urgent: true, reason: `Keyword: ${foundKeyword}` };
  }

  return { urgent: false };
}

/**
 * Get new emails
 */
function getNewEmails() {
  try {
    const result = execSync(
      `gog gmail messages search "newer_than:10m" --account ${CONFIG.gmailAccount} --max 50 --json`,
      { encoding: 'utf-8' }
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
  } catch (error) {
    console.error('Error reading history:', error.message);
  }
  return Date.now() - (10 * 60 * 1000); // Default to 10 minutes ago
}

/**
 * Save last check time
 */
function saveLastCheckTime() {
  try {
    fs.writeFileSync(CONFIG.historyFile, Date.now().toString());
  } catch (error) {
    console.error('Error saving history:', error.message);
  }
}

/**
 * Process emails
 */
async function checkEmails() {
  console.log(`[${new Date().toISOString()}] Checking for new emails...`);

  const emails = getNewEmails();
  const lastCheck = getLastCheckTime();

  console.log(`  Found ${emails.length} recent emails`);

  let urgentCount = 0;
  let processedCount = 0;

  for (const email of emails) {
    // Skip if we've already processed this (rough check)
    const emailDate = new Date(email.date).getTime();
    if (emailDate < lastCheck) {
      continue;
    }

    processedCount++;
    const urgencyCheck = isUrgent(email);

    console.log(`  📧 ${email.from.substring(0, 40)}`);
    console.log(`     Subject: ${email.subject}`);
    console.log(`     Urgent: ${urgencyCheck.urgent ? '🔴 YES - ' + urgencyCheck.reason : '⚪ No'}`);

    if (urgencyCheck.urgent) {
      urgentCount++;
      try {
        await sendSlackDM(
          `🔴 *URGENT EMAIL*\n` +
          `*From:* ${email.from}\n` +
          `*Subject:* ${email.subject}\n` +
          `*Reason:* ${urgencyCheck.reason}\n` +
          `*Preview:* ${email.snippet || '(no preview)'}`
        );
        console.log(`     ✓ Sent Slack notification`);
      } catch (error) {
        console.error(`     ✗ Failed to send Slack notification:`, error.message);
      }
    }
  }

  if (processedCount > 0) {
    console.log(`  ✓ Processed ${processedCount} new emails (${urgentCount} urgent)`);
  } else {
    console.log(`  No new emails since last check`);
  }

  saveLastCheckTime();
}

/**
 * Main loop
 */
async function main() {
  console.log('🦞 OpenClaw Gmail Monitor started');
  console.log(`   Account: ${CONFIG.gmailAccount}`);
  console.log(`   Check interval: ${CONFIG.checkInterval / 1000}s`);
  console.log(`   VIPs configured: ${VIPS.length}`);
  console.log('');

  // Initial check
  await checkEmails();

  // Set up interval
  setInterval(async () => {
    try {
      await checkEmails();
    } catch (error) {
      console.error('Error in check cycle:', error);
    }
  }, CONFIG.checkInterval);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
