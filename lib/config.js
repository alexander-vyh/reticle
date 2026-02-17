'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const configDir = path.join(os.homedir(), '.config', 'claudia');

function loadJSON(filename) {
  const filepath = path.join(configDir, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`FATAL: Missing config file: ${filepath}`);
    console.error(`Run: scripts/sync-secrets.sh  (or create it manually)`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

const secrets = loadJSON('secrets.json');
const team = loadJSON('team.json');

// Validate required secrets
const required = ['slackBotToken', 'slackUserId', 'gmailAccount'];
for (const key of required) {
  if (!secrets[key]) {
    console.error(`FATAL: Missing required secret: ${key} in secrets.json`);
    process.exit(1);
  }
}

module.exports = {
  // Secrets
  slackBotToken: secrets.slackBotToken,
  slackAppToken: secrets.slackAppToken,
  slackSigningSecret: secrets.slackSigningSecret,
  slackUserId: secrets.slackUserId,
  slackUsername: secrets.slackUsername,
  gmailAccount: secrets.gmailAccount,

  // Team data
  vips: team.vips || [],
  vipEmails: (team.vips || []).map(v => v.email.toLowerCase()),
  directReports: team.directReports || [],
  filterPatterns: team.filterPatterns || {},

  // Google OAuth paths (writable — auth helpers regenerate tokens here)
  gmailCredentialsPath: path.join(configDir, 'gmail-credentials.json'),
  gmailTokenPath: path.join(configDir, 'gmail-token.json'),
  calendarTokenPath: path.join(configDir, 'calendar-token.json'),

  // Config directory path (for callers that need it)
  configDir
};
