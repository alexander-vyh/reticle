'use strict';

const slackReader = require('./slack-reader');
const { listTeamMembers } = require('./people-store');
const log = require('./logger')('slack-team-collector');

const TARGET_CHANNELS = [
  'eng-platform',
  'eng-infra',
  'project-automation',
  'eng-general',
];

// Trivial messages: single-word, emoji-only, acknowledgements
const TRIVIAL_PATTERNS = [
  /^:[\w+-]+:$/,                    // Slack emoji shortcode only (:+1:, :thumbsup:)
  /^[\p{Emoji}\uFE0F\u200D]+$/u,   // Unicode emoji only
  /^\S+$/,                          // Single word (no spaces)
];

const TRIVIAL_EXACT = new Set([
  'ok', 'okay', 'k', 'thanks', 'thank you', 'thx', 'ty', 'yes', 'no',
  'yep', 'yup', 'nope', 'sure', 'np', 'ack', 'lgtm', 'nice', 'cool',
  'done', 'got it', 'sounds good', 'will do',
]);

// Channel name -> channel ID cache (channels rarely change)
let channelCache = null;

async function resolveChannelIds() {
  if (channelCache) return channelCache;

  const conversations = await slackReader.listConversations();
  const map = new Map();
  for (const ch of conversations) {
    map.set(ch.name, ch.id);
  }
  channelCache = map;
  return map;
}

function isTrivialMessage(text) {
  if (!text) return true;
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  if (TRIVIAL_EXACT.has(trimmed)) return true;
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(text.trim())) return true;
  }
  return false;
}

function isBotMessage(msg) {
  return !!msg.bot_id || msg.subtype === 'bot_message';
}

function epochToISODate(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().split('T')[0];
}

/**
 * Collect Slack messages from team channels within a date range.
 *
 * @param {Object} db - reticle database handle
 * @param {string} slackToken - Slack bot token (unused — slack-reader uses its own)
 * @param {number} weekStart - epoch seconds for the start of the window
 * @param {number} weekEnd - epoch seconds for the end of the window
 * @returns {Promise<{messages: Object[], warnings: string[], channelsRead: number, messagesFound: number}>}
 */
async function collectSlackTeamChannels(db, slackToken, weekStart, weekEnd) {
  const warnings = [];
  const messages = [];
  let channelsRead = 0;

  // 1. Get team members and build Slack ID -> person mapping
  const teamMembers = listTeamMembers(db);
  const slackIdToMember = new Map();
  for (const person of teamMembers) {
    if (person.slack_id) {
      slackIdToMember.set(person.slack_id, person);
    }
  }

  if (slackIdToMember.size === 0) {
    log.warn('No team members with Slack IDs found — nothing to collect');
    return { messages, warnings: ['No team members with Slack IDs found'], channelsRead: 0, messagesFound: 0 };
  }

  // 2. Resolve channel names to IDs
  let channelMap;
  try {
    channelMap = await resolveChannelIds();
  } catch (err) {
    log.error({ err }, 'Failed to list Slack conversations');
    return { messages, warnings: ['Failed to list Slack conversations: ' + err.message], channelsRead: 0, messagesFound: 0 };
  }

  // 3. Read each target channel
  for (const channelName of TARGET_CHANNELS) {
    const channelId = channelMap.get(channelName);
    if (!channelId) {
      const warning = `Channel #${channelName} not found`;
      warnings.push(warning);
      log.warn({ channelName }, warning);
      continue;
    }

    try {
      const rawMessages = await slackReader.getConversationHistory(channelId, weekStart, weekEnd);

      for (const msg of rawMessages) {
        // Skip bots
        if (isBotMessage(msg)) continue;

        // Skip non-team members
        const member = slackIdToMember.get(msg.user);
        if (!member) continue;

        // Skip trivial messages
        if (isTrivialMessage(msg.text)) continue;

        const ts = parseFloat(msg.ts);

        messages.push({
          author: member.name,
          authorTeam: member.team,
          channel: channelName,
          date: epochToISODate(ts),
          content: msg.text,
        });
      }

      channelsRead++;
    } catch (err) {
      const warning = `Failed to read #${channelName}: ${err.message}`;
      warnings.push(warning);
      log.warn({ err, channelName }, warning);
    }
  }

  const result = {
    messages,
    warnings,
    channelsRead,
    messagesFound: messages.length,
  };

  log.info({
    channelsRead: result.channelsRead,
    messagesFound: result.messagesFound,
    warnings: result.warnings.length,
  }, 'Slack team channel collection complete');

  return result;
}

// Exported for testing
function _resetChannelCache() {
  channelCache = null;
}

module.exports = { collectSlackTeamChannels, _resetChannelCache };
