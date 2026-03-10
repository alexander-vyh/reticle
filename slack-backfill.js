#!/usr/bin/env node
/**
 * Slack Backfill — pulls historical messages from specified channels,
 * filters to known team members (via identity_map), and captures
 * into org-memory raw_messages.
 *
 * Usage:
 *   node slack-backfill.js                    # Default: DW channels, 7 days
 *   node slack-backfill.js --days 14          # Look back 14 days
 *   node slack-backfill.js --channels C123,C456  # Specific channel IDs
 *   DRY_RUN=1 node slack-backfill.js          # Fetch and count, don't write
 */
'use strict';

const https = require('https');
const config = require('./lib/config');
const slackReader = require('./lib/slack-reader');
const { captureMessage } = require('./lib/slack-capture');
const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');

// Use user token for channel access — the user is in these channels, the bot may not be
const USER_TOKEN = config.slackUserToken;

function slackGetAsUser(path, params = {}) {
  if (!USER_TOKEN) return Promise.reject(new Error('No slackUserToken configured in secrets.json'));
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${fullPath}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${USER_TOKEN}` }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.ok) reject(new Error(`Slack API error: ${parsed.error}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Slack response parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listChannelsAsUser(types = 'public_channel,private_channel') {
  const all = [];
  let cursor;
  do {
    const params = { types, limit: '200', exclude_archived: 'true' };
    if (cursor) params.cursor = cursor;
    const res = await slackGetAsUser('conversations.list', params);
    all.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
    if (cursor) await sleep(150);
  } while (cursor);
  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getHistoryAsUser(channelId, oldest, latest) {
  const all = [];
  let cursor;
  let retries = 0;
  do {
    const params = { channel: channelId, limit: '200' };
    if (oldest) params.oldest = String(oldest);
    if (latest) params.latest = String(latest);
    if (cursor) params.cursor = cursor;
    try {
      const res = await slackGetAsUser('conversations.history', params);
      all.push(...(res.messages || []));
      cursor = res.response_metadata?.next_cursor;
      retries = 0;
    } catch (err) {
      if (err.message.includes('ratelimited') && retries < 3) {
        retries++;
        await sleep(retries * 3000);
        continue;
      }
      throw err;
    }
    await sleep(150); // ~6 req/s to stay under Slack's tier limits
  } while (cursor);
  return all;
}

async function getThreadRepliesAsUser(channelId, threadTs, oldest) {
  const all = [];
  let cursor;
  let retries = 0;
  do {
    const params = { channel: channelId, ts: threadTs, limit: '200' };
    if (oldest) params.oldest = String(oldest);
    if (cursor) params.cursor = cursor;
    try {
      const res = await slackGetAsUser('conversations.replies', params);
      // First message is the parent — skip it, we already have it
      const replies = (res.messages || []).filter(m => m.ts !== threadTs);
      all.push(...replies);
      cursor = res.response_metadata?.next_cursor;
      retries = 0;
    } catch (err) {
      if (err.message.includes('ratelimited') && retries < 3) {
        retries++;
        await sleep(retries * 3000);
        continue;
      }
      // thread_not_found can happen for deleted threads — skip silently
      if (err.message.includes('thread_not_found')) return all;
      throw err;
    }
    await sleep(150);
  } while (cursor);
  return all;
}

// Team channels — capture ALL messages, not just known team members.
// These are the shared context channels where cross-team conversation matters.
const TEAM_CHANNEL_PATTERNS = [
  /^iops-dw/,          // iops-dw, iops-dw-cse, iops-dw-desktop-support, etc.
  /^digital-workplace$/,
  /^hr-digitalworkplace$/,
];

function isTeamChannel(channelName) {
  return TEAM_CHANNEL_PATTERNS.some(p => p.test(channelName));
}

/**
 * Get the set of Slack user IDs that belong to known team members.
 * @param {Object} db - org-memory database
 * @returns {Set<string>} Set of Slack external_ids
 */
function getKnownSlackIds(db) {
  const rows = db.prepare(
    "SELECT external_id FROM identity_map WHERE source = 'slack'"
  ).all();
  return new Set(rows.map(r => r.external_id));
}

/**
 * Find channel IDs by name from the workspace channel list.
 * @param {string[]} names - Channel names to find
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function resolveChannelsByName(names) {
  const channels = await listChannelsAsUser();
  const nameSet = new Set(names.map(n => n.toLowerCase()));
  return channels
    .filter(ch => nameSet.has(ch.name.toLowerCase()))
    .map(ch => ({ id: ch.id, name: ch.name }));
}

/**
 * Backfill messages from a single channel.
 * @param {Object} db - org-memory database
 * @param {Object} channel - { id, name }
 * @param {number} oldest - Epoch seconds
 * @param {Set<string>} knownIds - Known Slack user IDs
 * @param {boolean} dryRun
 * @returns {Promise<{captured: number, skipped: number, total: number}>}
 */
async function backfillChannel(db, channel, oldest, knownIds, dryRun) {
  const teamChannel = isTeamChannel(channel.name);
  const topLevel = await getHistoryAsUser(channel.id, oldest);

  // Collect thread parent timestamps to fetch replies from
  const threadParents = topLevel
    .filter(m => m.reply_count > 0 && m.thread_ts === m.ts)
    .map(m => m.ts);

  // Fetch all thread replies
  const threadReplies = [];
  for (const threadTs of threadParents) {
    const replies = await getThreadRepliesAsUser(channel.id, threadTs, oldest);
    threadReplies.push(...replies);
  }

  const messages = [...topLevel, ...threadReplies];
  let captured = 0;
  let skipped = 0;

  for (const msg of messages) {
    if (msg.type !== 'message') continue;
    // Allow thread_broadcast (replies shared to channel) — real content
    if (msg.subtype && msg.subtype !== 'thread_broadcast') continue;
    if (!msg.user) continue;
    if (!msg.text || msg.text.trim().length < 5) continue;

    // Team channels: capture everything. Other channels: known team members only.
    if (!teamChannel && !knownIds.has(msg.user)) {
      skipped++;
      continue;
    }

    if (dryRun) {
      captured++;
      continue;
    }

    const userName = await slackReader.getUserInfo(msg.user);
    try {
      captureMessage(db, {
        channel: channel.id,
        channelName: channel.name,
        ts: msg.ts,
        user: msg.user,
        userName,
        text: msg.text,
        threadTs: msg.thread_ts || null,
        channelType: 'channel',
        clientMsgId: msg.client_msg_id || null,
        subtype: msg.subtype || null,
      });
      captured++;
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        // Already captured (idempotent)
        skipped++;
      } else {
        throw err;
      }
    }
  }

  return { captured, skipped, total: messages.length };
}

async function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 7;
  const channelsIdx = args.indexOf('--channels');
  const dryRun = process.env.DRY_RUN === '1';

  const now = Math.floor(Date.now() / 1000);
  const oldest = now - (days * 24 * 3600);

  console.log(`Slack backfill: ${days} days, dry_run=${dryRun}`);

  const db = initDatabase();
  const knownIds = getKnownSlackIds(db);
  console.log(`Known Slack identities: ${knownIds.size}`);

  if (knownIds.size === 0) {
    console.error('No Slack identities in identity_map. Run: node lib/seed-data.js --seed-dw');
    process.exit(1);
  }

  let channels;
  if (channelsIdx >= 0) {
    const ids = args[channelsIdx + 1].split(',');
    channels = ids.map(id => ({ id, name: id }));
    for (const ch of channels) {
      try {
        const res = await slackGetAsUser('conversations.info', { channel: ch.id });
        ch.name = res.channel?.name || ch.id;
      } catch { ch.name = ch.id; }
    }
  } else {
    // Pull from ALL channels the user is a member of
    console.log('Listing all channels...');
    const allChannels = await listChannelsAsUser('public_channel,private_channel');
    channels = allChannels
      .filter(ch => ch.is_member)
      .map(ch => ({ id: ch.id, name: ch.name }));
    console.log(`Found ${channels.length} channels (member of)`);
  }

  console.log(`Backfilling ${channels.length} channels...\n`);

  let totalCaptured = 0;
  let totalSkipped = 0;
  let channelsWithData = 0;

  for (const channel of channels) {
    try {
      const result = await backfillChannel(db, channel, oldest, knownIds, dryRun);
      if (result.captured > 0) {
        const tag = isTeamChannel(channel.name) ? ' [team]' : '';
        console.log(`  #${channel.name}${tag}: ${result.captured} captured (${result.total} total messages)`);
        channelsWithData++;
      }
      totalCaptured += result.captured;
      totalSkipped += result.skipped;
    } catch (err) {
      if (err.message.includes('not_in_channel') || err.message.includes('channel_not_found') || err.message.includes('missing_scope')) {
        // Silently skip inaccessible channels
      } else {
        console.warn(`  #${channel.name}: ERROR — ${err.message}`);
      }
    }
  }

  console.log(`\nDone. Captured: ${totalCaptured} messages from ${channelsWithData} channels (${totalSkipped} skipped — non-team or duplicates)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
