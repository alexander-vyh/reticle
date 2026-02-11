#!/usr/bin/env node
/**
 * Gmail API OAuth Authentication
 * Run this once to authorize Gmail API access
 */

const fs = require('fs');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const config = require('./lib/config');
const CREDENTIALS_PATH = config.gmailCredentialsPath;
const TOKEN_PATH = config.gmailTokenPath;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic'
];

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if we already have a token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    console.log('✓ Already authorized!');
    return oAuth2Client;
  }

  // Get new token
  return getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });

    console.log('\n🔐 Gmail API Authorization Required\n');
    console.log('Opening browser for authorization...\n');

    // Start local server to receive callback
    const server = http.createServer(async (req, res) => {
      if (req.url.indexOf('/') > -1) {
        const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
        const code = qs.get('code');

        res.end('Authorization successful! You can close this window.');
        server.close();

        if (code) {
          try {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
            console.log('\n✓ Authorization successful!');
            console.log(`✓ Token saved to ${TOKEN_PATH}\n`);
            resolve(oAuth2Client);
          } catch (error) {
            reject(error);
          }
        }
      }
    }).listen(3000, () => {
      // Open browser
      require('child_process').execSync(`open "${authUrl}"`);
    });
  });
}

authorize().catch(console.error);
