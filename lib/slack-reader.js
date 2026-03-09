'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('slack-reader');

const SLACK_TOKEN = config.slackBotToken;

function createRateLimiter(maxTokens, refillPerSecond) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryAcquire() {
      const now = Date.now();
      const elapsed = (now - lastRefill) / 1000;
      tokens = Math.min(maxTokens, tokens + elapsed * refillPerSecond);
      lastRefill = now;
      if (tokens >= 1) { tokens -= 1; return true; }
      return false;
    },
    async acquire() {
      while (!this.tryAcquire()) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  };
}

const defaultLimiter = createRateLimiter(40, 40 / 60);

function slackGet(path, params = {}) {
  return slackGetWithToken(path, params, SLACK_TOKEN);
}

function slackGetWithToken(path, params, token) {
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${fullPath}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
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

async function listConversations({ types = 'public_channel' } = {}) {
  const all = [];
  let cursor;
  do {
    await defaultLimiter.acquire();
    const params = { types, limit: '200', exclude_archived: 'true' };
    if (cursor) params.cursor = cursor;
    const res = await slackGet('conversations.list', params);
    all.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  log.info({ count: all.length }, 'Listed conversations');
  return all;
}

async function getConversationHistory(channelId, oldest, latest) {
  const all = [];
  let cursor;
  do {
    await defaultLimiter.acquire();
    const params = { channel: channelId, limit: '200' };
    if (oldest) params.oldest = String(oldest);
    if (latest) params.latest = String(latest);
    if (cursor) params.cursor = cursor;
    const res = await slackGet('conversations.history', params);
    all.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return all;
}

const userCache = new Map();

async function getUserInfo(userId) {
  if (userCache.has(userId)) return userCache.get(userId);
  await defaultLimiter.acquire();
  try {
    const res = await slackGet('users.info', { user: userId });
    const name = res.user?.real_name || res.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch (err) {
    log.warn({ err, userId }, 'Failed to resolve user');
    userCache.set(userId, userId);
    return userId;
  }
}

async function lookupUserByEmail(email) {
  // users.lookupByEmail requires users:read.email scope — use user token if available
  const userToken = config.slackUserToken;
  if (!userToken) {
    log.warn({ email }, 'No slackUserToken configured — cannot look up user by email');
    return null;
  }
  await defaultLimiter.acquire();
  try {
    const res = await slackGetWithToken('users.lookupByEmail', { email }, userToken);
    return res.user?.id || null;
  } catch (err) {
    log.warn({ err, email }, 'Failed to look up user by email');
    return null;
  }
}

let allUsersCache = null;

async function getAllUsers() {
  if (allUsersCache) return allUsersCache;
  const members = [];
  let cursor = '';
  do {
    await defaultLimiter.acquire();
    const params = { limit: '200' };
    if (cursor) params.cursor = cursor;
    const res = await slackGet('users.list', params);
    members.push(...(res.members || []));
    cursor = res.response_metadata?.next_cursor || '';
  } while (cursor);
  allUsersCache = members;
  return members;
}

async function lookupUserByName(name) {
  try {
    const members = await getAllUsers();
    const lower = name.toLowerCase();
    const parts = lower.split(/\s+/);
    const match = members.find(m => {
      const real = (m.profile?.real_name || '').toLowerCase();
      const display = (m.profile?.display_name || '').toLowerCase();
      if (real === lower || display === lower || real.includes(lower)) return true;
      // Match if all name parts appear in the real name (handles "Gimli 'G' Stone" vs "Gimli Stone")
      return parts.length >= 2 && parts.every(p => real.includes(p));
    });
    return match?.id || null;
  } catch (err) {
    log.warn({ err, name }, 'Failed to look up user by name');
    return null;
  }
}

const channelCache = new Map();

async function getConversationInfo(channelId) {
  if (channelCache.has(channelId)) return channelCache.get(channelId);
  await defaultLimiter.acquire();
  try {
    const res = await slackGet('conversations.info', { channel: channelId });
    const name = res.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch (err) {
    log.warn({ err, channelId }, 'Failed to resolve channel');
    channelCache.set(channelId, channelId);
    return channelId;
  }
}

const LINK_ONLY_PATTERN = /^(<https?:\/\/[^>]+>|https?:\/\/\S+)$/;
const SUBTYPES_TO_SKIP = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive',
  'group_join', 'group_leave', 'group_topic', 'group_purpose',
  'bot_message', 'me_message', 'reminder_add', 'pinned_item', 'unpinned_item'
]);
const MIN_MESSAGE_LENGTH = 20;

function parseMessages(rawMessages) {
  return rawMessages.filter(msg => {
    if (msg.type !== 'message') return false;
    if (msg.subtype && SUBTYPES_TO_SKIP.has(msg.subtype)) return false;
    if (msg.bot_id) return false;
    if (!msg.text || msg.text.length < MIN_MESSAGE_LENGTH) return false;
    if (LINK_ONLY_PATTERN.test(msg.text.trim())) return false;
    return true;
  });
}

function resolveUserMentions(text, cache) {
  return text.replace(/<@(U[A-Z0-9]+)>/g, (match, userId) => {
    return cache.get(userId) || match;
  });
}

module.exports = {
  createRateLimiter,
  listConversations,
  getConversationHistory,
  getUserInfo,
  lookupUserByEmail,
  lookupUserByName,
  getConversationInfo,
  parseMessages,
  resolveUserMentions,
  userCache,
  channelCache
};
