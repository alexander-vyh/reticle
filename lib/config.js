'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const configDir = process.env.RETICLE_CONFIG_DIR || path.join(os.homedir(), '.reticle', 'config');

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

// settings.json is optional — hardcoded defaults if absent
const settingsPath = path.join(configDir, 'settings.json');
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    console.error('WARNING: settings.json is corrupt, using defaults');
  }
}

module.exports = {
  // Secrets
  slackBotToken: secrets.slackBotToken,
  slackAppToken: secrets.slackAppToken,
  slackSigningSecret: secrets.slackSigningSecret,
  slackUserId: secrets.slackUserId,
  slackUsername: secrets.slackUsername,
  slackUserToken: secrets.slackUserToken || null,
  gmailAccount: secrets.gmailAccount,

  // Team data (vips, vipEmails, directReports, feedback removed — now DB-backed via people-store)
  filterPatterns: team.filterPatterns || {},

  // Google OAuth paths (writable — auth helpers regenerate tokens here)
  gmailCredentialsPath: path.join(configDir, 'gmail-credentials.json'),
  gmailTokenPath: path.join(configDir, 'gmail-token.json'),
  calendarTokenPath: path.join(configDir, 'calendar-token.json'),

  // Jira (optional)
  jiraApiToken: secrets.jiraApiToken || null,
  jiraBaseUrl: secrets.jiraBaseUrl || null,
  jiraUserEmail: secrets.jiraUserEmail || null,

  // Gateway
  gatewayPort: secrets.gatewayPort || 3001,

  // DW team roster (for identity seeding)
  dwTeamEmails: team.dwTeamEmails || [],

  // Config directory path (for callers that need it)
  configDir,

  // Settings (optional, from settings.json)
  settings,
  polling: {
    gmailIntervalMinutes: settings.polling?.gmailIntervalMinutes ?? 5,
    slackResponseTimeoutMinutes: settings.polling?.slackResponseTimeoutMinutes ?? 10,
    followupCheckIntervalMinutes: settings.polling?.followupCheckIntervalMinutes ?? 15,
    meetingAlertPollIntervalSeconds: settings.polling?.meetingAlertPollIntervalSeconds ?? 120,
  },
};
