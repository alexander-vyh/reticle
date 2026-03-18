// workspace/lib/slack.js
'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('slack');

const SLACK_TOKEN = config.slackBotToken;
const MY_SLACK_USER_ID = config.slackUserId;

/**
 * Send a Slack DM to the configured user.
 * @param {string} message - Fallback text
 * @param {Array|null} blocks - Block Kit blocks (optional)
 * @returns {Promise<object>} Slack API response body
 */
function sendSlackDM(message, blocks = null) {
  return sendSlackMessage(MY_SLACK_USER_ID, message, blocks);
}

/**
 * Send a Slack message to any channel/user.
 * @param {string} channel - Channel or user ID
 * @param {string} message - Fallback text
 * @param {Array|null} blocks - Block Kit blocks (optional)
 * @returns {Promise<object>} Slack API response body
 */
function sendSlackMessage(channel, message, blocks = null) {
  return new Promise((resolve, reject) => {
    const payload = {
      channel,
      text: message,
      unfurl_links: false
    };
    if (blocks) payload.blocks = blocks;

    const data = JSON.stringify(payload);

    const req = https.request({
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.ok) {
            log.warn({ channel, error: parsed.error, textPreview: message?.substring(0, 80) }, 'Slack message delivery failed');
            reject(new Error(`Slack API error: ${parsed.error}`));
          } else {
            log.info({ channel, ts: parsed.ts, textPreview: message?.substring(0, 80) }, 'Slack message delivered');
            resolve(parsed);
          }
        } catch (e) {
          log.error({ channel, responseBody: body.slice(0, 200) }, 'Slack response parse error');
          reject(new Error(`Slack response parse error: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      log.error({ channel, err, textPreview: message?.substring(0, 80) }, 'Slack request failed');
      reject(err);
    });
    req.write(data);
    req.end();
  });
}

module.exports = { sendSlackDM, sendSlackMessage, SLACK_TOKEN, MY_SLACK_USER_ID };
