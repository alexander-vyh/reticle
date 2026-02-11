#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CREDENTIALS_PATH = process.env.HOME + '/.openclaw/gmail-credentials.json';
const TOKEN_PATH = process.env.HOME + '/.openclaw/calendar-token.json';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

async function getCalendarClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Credentials file not found: ${CREDENTIALS_PATH}\nSet up Google OAuth credentials first.`);
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);

    if (token.expiry_date && token.expiry_date < Date.now()) {
      try {
        const { credentials: refreshed } = await oAuth2Client.refreshAccessToken();
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(refreshed, null, 2));
        oAuth2Client.setCredentials(refreshed);
      } catch (err) {
        console.error('Token refresh failed, re-authorizing...');
        await getNewToken(oAuth2Client);
      }
    }

    return google.calendar({ version: 'v3', auth: oAuth2Client });
  }

  await getNewToken(oAuth2Client);
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const redirectUri = credentials.installed.redirect_uris[0];
    const parsed = new url.URL(redirectUri);
    const port = parsed.port || 80;

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });

    console.log('\n📅 Calendar authorization required.');
    console.log(`Opening browser (callback on port ${port})...\n`);

    const server = http.createServer(async (req, res) => {
      const qs = new url.URL(req.url, redirectUri).searchParams;
      const code = qs.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Calendar authorized! You can close this tab.</h1>');

        try {
          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log('✓ Calendar token saved to', TOKEN_PATH);
          server.close();
          resolve();
        } catch (err) {
          server.close();
          reject(err);
        }
      }
    });

    server.listen(port, () => {
      const { exec } = require('child_process');
      exec(`open "${authUrl}"`);
    });
  });
}

module.exports = { getCalendarClient, google, CREDENTIALS_PATH, TOKEN_PATH };
