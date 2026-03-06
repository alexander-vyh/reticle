'use strict';

const fs = require('fs');
const { google } = require('googleapis');
const config = require('./config');
const log = require('./logger')('gmail-api');

/**
 * Create an authenticated Gmail API client from stored OAuth credentials.
 */
function getGmailClient() {
  const credentials = JSON.parse(fs.readFileSync(config.gmailCredentialsPath));
  const token = JSON.parse(fs.readFileSync(config.gmailTokenPath));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

/**
 * Search for recent unread emails and return parsed objects with full headers.
 * @param {object} client - Gmail API client
 * @param {object} [opts]
 * @param {number} [opts.maxResults=50]
 * @returns {Promise<Array<{id, threadId, from, to, cc, subject, date, snippet}>>}
 */
async function searchRecentUnread(client, { maxResults = 50 } = {}) {
  const res = await client.users.messages.list({
    userId: 'me',
    q: 'newer_than:10m is:unread',
    maxResults
  });

  const messageIds = res.data.messages || [];
  if (messageIds.length === 0) return [];

  const emails = [];
  for (const { id } of messageIds) {
    const msg = await client.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date']
    });

    const headers = msg.data.payload?.headers || [];
    const header = (name) => headers.find(h => h.name === name)?.value || '';

    emails.push({
      id: msg.data.id,
      threadId: msg.data.threadId,
      from: header('From'),
      to: header('To'),
      cc: header('Cc'),
      subject: header('Subject'),
      date: header('Date'),
      snippet: msg.data.snippet || ''
    });
  }

  return emails;
}

/**
 * Archive a message (remove from INBOX).
 * @returns {Promise<boolean>} true on success
 */
async function archiveMessage(client, messageId) {
  try {
    await client.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['INBOX'] }
    });
    return true;
  } catch (err) {
    log.error({ err, messageId }, 'Archive failed');
    return false;
  }
}

/**
 * Trash a message (add TRASH, remove INBOX).
 * @returns {Promise<boolean>} true on success
 */
async function trashMessage(client, messageId) {
  try {
    await client.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }
    });
    return true;
  } catch (err) {
    log.error({ err, messageId }, 'Trash failed');
    return false;
  }
}

/**
 * Add a label to a message.
 * @returns {Promise<boolean>} true on success
 */
async function tagMessage(client, messageId, label) {
  try {
    await client.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: [label] }
    });
    return true;
  } catch (err) {
    log.error({ err, messageId, label }, 'Tag failed');
    return false;
  }
}

/**
 * Create a Gmail filter.
 * @param {object} client - Gmail API client
 * @param {object} opts
 * @param {string} [opts.from] - Match sender
 * @param {string} [opts.to] - Match recipient
 * @param {string} [opts.subject] - Match subject
 * @param {string[]} [opts.addLabelIds] - Labels to add
 * @param {string[]} [opts.removeLabelIds] - Labels to remove (e.g. ['INBOX', 'UNREAD'])
 * @returns {Promise<object|null>} Created filter or null on error
 */
async function createFilter(client, { from, to, subject, addLabelIds, removeLabelIds } = {}) {
  try {
    const criteria = {};
    if (from) criteria.from = from;
    if (to) criteria.to = to;
    if (subject) criteria.subject = subject;

    const action = {};
    if (addLabelIds) action.addLabelIds = addLabelIds;
    if (removeLabelIds) action.removeLabelIds = removeLabelIds;

    const res = await client.users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria, action }
    });
    return res.data;
  } catch (err) {
    log.error({ err }, 'Create filter failed');
    return null;
  }
}

module.exports = { getGmailClient, searchRecentUnread, archiveMessage, trashMessage, tagMessage, createFilter };
