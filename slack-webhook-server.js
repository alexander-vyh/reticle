#!/usr/bin/env node
/**
 * OpenClaw Slack Interactive Webhook Server
 * Handles button clicks and interactive components from Slack
 */

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { execSync } = require('child_process');
const https = require('https');

const app = express();
const PORT = 3030;

const CONFIG = {
  slackSigningSecret: 'REDACTED_SIGNING_SECRET',
  slackToken: 'REDACTED_SLACK_BOT_TOKEN',
  gmailAccount: 'user@example.com'
};

// Raw body parser for signature verification
app.use(bodyParser.urlencoded({ extended: true, verify: (req, res, buf) => {
  req.rawBody = buf.toString();
}}));
app.use(bodyParser.json());

/**
 * Verify Slack request signature
 */
function verifySlackSignature(req) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSignature = req.headers['x-slack-signature'];

  // Prevent replay attacks
  const time = Math.floor(new Date().getTime() / 1000);
  if (Math.abs(time - timestamp) > 300) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', CONFIG.slackSigningSecret)
    .update(sigBasestring)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

/**
 * Send Slack message
 */
function sendSlackMessage(channel, text, blocks = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      channel,
      text,
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
      res.on('data', chunk => body += chunk);
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
 * Get full email via Gmail API
 */
async function getFullEmail(emailId) {
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

    return res.data;
  } catch (error) {
    console.error('Error getting email:', error.message);
    return null;
  }
}

/**
 * Archive email
 */
async function archiveEmail(emailId) {
  try {
    execSync(
      `gog gmail messages modify "${emailId}" --account ${CONFIG.gmailAccount} --remove-labels INBOX 2>/dev/null`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Delete email
 */
async function deleteEmail(emailId) {
  try {
    execSync(
      `gog gmail messages trash "${emailId}" --account ${CONFIG.gmailAccount} 2>/dev/null`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Handle interactive actions
 */
async function handleAction(action, user, channel) {
  const actionId = action.action_id;
  const emailId = action.value; // Email ID stored in button value

  console.log(`📱 Action: ${actionId} for email ${emailId} by ${user}`);

  try {
    switch (actionId) {
      case 'view_full':
        const email = await getFullEmail(emailId);
        if (email) {
          const from = email.payload.headers.find(h => h.name === 'From')?.value;
          const subject = email.payload.headers.find(h => h.name === 'Subject')?.value;
          const date = email.payload.headers.find(h => h.name === 'Date')?.value;

          // Get email body
          let body = 'No body content';
          const parts = email.payload.parts || [email.payload];
          for (const part of parts) {
            if (part.mimeType === 'text/plain' && part.body.data) {
              body = Buffer.from(part.body.data, 'base64').toString().substring(0, 2000);
              break;
            }
          }

          await sendSlackMessage(channel, `*Full Email*\n\n*From:* ${from}\n*Subject:* ${subject}\n*Date:* ${date}\n\n${body}`);
        }
        return { text: '✓ Email content sent' };

      case 'open_gmail':
        execSync(`open "https://mail.google.com/mail/u/0/#inbox/${emailId}"`);
        return { text: '✓ Opened in Gmail' };

      case 'archive':
        const archived = await archiveEmail(emailId);
        return { text: archived ? '✓ Email archived' : '✗ Failed to archive' };

      case 'delete':
        const deleted = await deleteEmail(emailId);
        return { text: deleted ? '✓ Email deleted' : '✗ Failed to delete' };

      case 'unsubscribe':
        // Run automated unsubscribe
        try {
          execSync(`cd ~/.openclaw/workspace && ./unsub-email-id "${emailId}"`, { stdio: 'pipe' });
          return { text: '✓ Unsubscribed automatically' };
        } catch (error) {
          return { text: '✗ Unsubscribe failed' };
        }

      default:
        return { text: '✗ Unknown action' };
    }
  } catch (error) {
    console.error('Error handling action:', error);
    return { text: `✗ Error: ${error.message}` };
  }
}

/**
 * Webhook endpoint for Slack interactivity
 */
app.post('/slack/interactive', async (req, res) => {
  // Verify signature
  if (!verifySlackSignature(req)) {
    console.error('Invalid Slack signature');
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(req.body.payload);

  // Handle different interaction types
  if (payload.type === 'block_actions') {
    const action = payload.actions[0];
    const user = payload.user.username;
    const channel = payload.channel.id;

    const result = await handleAction(action, user, channel);

    // Send ephemeral response (only visible to user who clicked)
    res.json({
      replace_original: false,
      text: result.text
    });
  } else {
    res.send('OK');
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`🦞 OpenClaw Slack Webhook Server`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   Webhook URL: http://localhost:${PORT}/slack/interactive\n`);
  console.log(`⚠️  Important: Update CONFIG.slackSigningSecret before using!`);
  console.log(`   Get it from: https://api.slack.com/apps → Your App → Basic Information\n`);
});
