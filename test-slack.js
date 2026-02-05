#!/usr/bin/env node
const https = require('https');

const CONFIG = {
  slackToken: 'REDACTED_SLACK_BOT_TOKEN'
};

function sendSlackMessage(channel, message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      channel: channel,
      text: message,
      unfurl_links: false,
      as_user: true
    });

    console.log('Payload:', data);
    console.log('Character length:', data.length);
    console.log('Byte length:', Buffer.byteLength(data));

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
        console.log('Response:', body);
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

// Test with a message that might have special characters
sendSlackMessage('@redacted.username', '🔔 Test notification with émoji and spécial characters')
  .then(() => console.log('✓ SUCCESS'))
  .catch(err => console.error('✗ FAILED:', err.message));
