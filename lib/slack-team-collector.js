'use strict';

const slackReader = require('./slack-reader');
const { listTeamMembers } = require('./people-store');
const log = require('./logger')('slack-team-collector');

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
 * Resolve a conversation to a human-readable label.
 *
 * - Public/private channels: use channel.name
 * - DMs (is_im): resolve via getUserInfo on the other participant
 * - Group DMs (is_mpim): resolve via getConversationInfo (returns purpose or member list)
 *
 * @param {Object} channel - conversation object from conversations.list
 * @returns {Promise<string>}
 */
async function resolveChannelLabel(channel) {
  if (channel.is_im) {
    // DM — resolve the other user's name
    const userName = await slackReader.getUserInfo(channel.user);
    return `dm-${userName}`;
  }
  if (channel.is_mpim) {
    // Group DM — use conversation info for a better label
    const label = await slackReader.getConversationInfo(channel.id);
    return `group-${label}`;
  }
  // Public or private channel — use the name
  return channel.name || channel.id;
}

/**
 * Check if a conversation had activity within the target window using metadata.
 * Uses the `updated` field (epoch seconds with decimal) from the Slack API.
 * Falls back to true (fetch history) if the field is missing.
 *
 * @param {Object} channel - conversation object from conversations.list
 * @param {number} weekStart - epoch seconds
 * @returns {boolean}
 */
function hasRecentActivity(channel, weekStart) {
  // Slack provides `updated` as epoch timestamp (seconds with decimal)
  const lastActivity = channel.updated || channel.last_message_ts;
  if (!lastActivity) return true; // no metadata — be safe, fetch history
  return parseFloat(lastActivity) >= weekStart;
}

/**
 * Search-based collection strategy (fast path).
 * Uses Slack's search.messages API to find messages from each team member directly.
 * One search per team member: from:<@SLACK_ID> with date filters.
 *
 * @param {Array<{name: string, team: string, slack_id: string|null}>} teamMembers
 * @param {number} weekStart - epoch seconds
 * @param {number} weekEnd - epoch seconds
 * @returns {Promise<Array<{author: string, authorTeam: string, channel: string, date: string, content: string, slackId: string}>>}
 */
async function collectViaSearch(teamMembers, weekStart, weekEnd) {
  const messages = [];
  const startDate = epochToISODate(weekStart);
  const endDate = epochToISODate(weekEnd);

  for (const member of teamMembers) {
    if (!member.slack_id) continue;

    const query = `from:<@${member.slack_id}> after:${startDate} before:${endDate}`;

    let results;
    try {
      results = await slackReader.searchMessages(query);
    } catch (err) {
      log.warn({ err, member: member.name, query }, 'Search failed for team member');
      continue;
    }

    let memberMessageCount = 0;
    for (const match of results) {
      // Skip bot messages
      if (isBotMessage(match)) continue;

      // Skip trivial messages
      if (isTrivialMessage(match.text)) continue;

      const ts = parseFloat(match.ts);

      // Channel name comes from search result — channel object has id and name
      const channelName = match.channel?.name || match.channel?.id || 'unknown';

      messages.push({
        author: member.name,
        authorTeam: member.team,
        channel: channelName,
        date: epochToISODate(ts),
        content: match.text,
        slackId: match.ts,
      });
      memberMessageCount++;
    }

    if (memberMessageCount > 0) {
      log.info({ member: member.name, messages: memberMessageCount }, 'Search collected messages for member');
    }
  }

  log.info({ totalMessages: messages.length, membersSearched: teamMembers.filter(m => m.slack_id).length }, 'Search strategy complete');
  return messages;
}

/**
 * Channel sweep collection strategy (background validation).
 * Reads all conversations and filters for team member messages.
 * This is the original implementation, now used only for comparison.
 *
 * @param {Map<string, Object>} slackIdToMember - Slack ID to team member mapping
 * @param {number} weekStart - epoch seconds
 * @param {number} weekEnd - epoch seconds
 * @returns {Promise<{messages: Object[], warnings: string[], channelsRead: number}>}
 */
async function collectViaSweep(slackIdToMember, weekStart, weekEnd) {
  const warnings = [];
  const messages = [];
  let channelsRead = 0;

  let conversations;
  try {
    conversations = await slackReader.listConversations({
      types: 'public_channel,private_channel,mpim,im'
    });
  } catch (err) {
    log.error({ err }, 'Sweep: failed to list Slack conversations');
    return { messages, warnings: ['Sweep: failed to list conversations: ' + err.message], channelsRead: 0 };
  }

  const totalEnumerated = conversations.length;
  const activeConversations = conversations.filter(ch => hasRecentActivity(ch, weekStart));
  const skippedInactive = totalEnumerated - activeConversations.length;

  log.info({
    totalEnumerated,
    activeConversations: activeConversations.length,
    skippedInactive,
  }, 'Sweep: conversations enumerated');

  let channelsWithTeamMessages = 0;

  for (const channel of activeConversations) {
    let channelLabel;
    try {
      channelLabel = await resolveChannelLabel(channel);
    } catch (err) {
      channelLabel = channel.name || channel.id;
    }

    try {
      const rawMessages = await slackReader.getConversationHistory(channel.id, weekStart, weekEnd);

      let channelMessageCount = 0;
      for (const msg of rawMessages) {
        if (isBotMessage(msg)) continue;
        const member = slackIdToMember.get(msg.user);
        if (!member) continue;
        if (isTrivialMessage(msg.text)) continue;

        const ts = parseFloat(msg.ts);

        messages.push({
          author: member.name,
          authorTeam: member.team,
          channel: channelLabel,
          date: epochToISODate(ts),
          content: msg.text,
          slackId: msg.ts,
        });
        channelMessageCount++;
      }

      channelsRead++;

      if (channelMessageCount > 0) {
        channelsWithTeamMessages++;
      }
    } catch (err) {
      const warning = `Failed to read ${channelLabel}: ${err.message}`;
      warnings.push(warning);
      log.warn({ err, channel: channelLabel }, warning);
    }
  }

  log.info({
    totalEnumerated,
    activeConversations: activeConversations.length,
    channelsRead,
    channelsWithTeamMessages,
    messagesFound: messages.length,
    warnings: warnings.length,
  }, 'Sweep: collection complete');

  return { messages, warnings, channelsRead };
}

/**
 * Compare search results against sweep results and log the diff.
 *
 * @param {Object[]} searchMessages - Messages from search strategy
 * @param {Object[]} sweepMessages - Messages from sweep strategy
 */
function logStrategyComparison(searchMessages, sweepMessages) {
  const searchKeys = new Set(searchMessages.map(m => m.slackId));
  const sweepKeys = new Set(sweepMessages.map(m => m.slackId));

  const overlap = [...searchKeys].filter(k => sweepKeys.has(k)).length;
  const searchOnly = [...searchKeys].filter(k => !sweepKeys.has(k)).length;
  const sweepOnly = [...sweepKeys].filter(k => !searchKeys.has(k)).length;

  // Find which channels the sweep-only messages came from
  const sweepOnlyChannels = new Set();
  for (const msg of sweepMessages) {
    if (!searchKeys.has(msg.slackId)) {
      sweepOnlyChannels.add(msg.channel);
    }
  }

  log.info({
    searchTotal: searchMessages.length,
    sweepTotal: sweepMessages.length,
    overlap,
    searchOnly,
    sweepOnly,
    sweepOnlyChannels: [...sweepOnlyChannels],
  }, 'Strategy comparison: search vs sweep');
}

/**
 * Collect Slack messages from team members within a date range.
 * Uses a dual-strategy approach:
 *   1. Search strategy (primary, fast): search.messages per team member
 *   2. Channel sweep (background validation): reads all channels, logs comparison
 *
 * @param {Object} db - reticle database handle
 * @param {string} slackToken - Slack bot token (unused — slack-reader uses its own)
 * @param {number} weekStart - epoch seconds for the start of the window
 * @param {number} weekEnd - epoch seconds for the end of the window
 * @returns {Promise<{messages: Object[], warnings: string[], channelsRead: number, messagesFound: number, strategy: string}>}
 */
async function collectSlackTeamChannels(db, slackToken, weekStart, weekEnd) {
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
    return { messages: [], warnings: ['No team members with Slack IDs found'], channelsRead: 0, messagesFound: 0, strategy: 'none' };
  }

  // 2. Try search strategy first (fast path)
  let searchMessages = [];
  let searchSucceeded = false;
  try {
    searchMessages = await collectViaSearch(teamMembers, weekStart, weekEnd);
    searchSucceeded = true;
    log.info({ messagesFound: searchMessages.length }, 'Search strategy completed');
  } catch (err) {
    log.warn({ err }, 'Search strategy failed — falling back to channel sweep');
  }

  // 3. Start channel sweep in background for validation (don't await)
  const sweepPromise = collectViaSweep(slackIdToMember, weekStart, weekEnd)
    .then(sweepResult => {
      // Log comparison when sweep completes
      const primaryMessages = searchSucceeded ? searchMessages : [];
      if (primaryMessages.length > 0 || sweepResult.messages.length > 0) {
        logStrategyComparison(primaryMessages, sweepResult.messages);
      }
      return sweepResult;
    })
    .catch(err => {
      log.warn({ err }, 'Background sweep failed — non-critical');
      return { messages: [], warnings: ['Background sweep failed'], channelsRead: 0 };
    });

  // 4. If search succeeded, return search results immediately
  if (searchSucceeded) {
    // Collect unique channels from search results for the channelsRead count
    const uniqueChannels = new Set(searchMessages.map(m => m.channel));

    const result = {
      messages: searchMessages,
      warnings: [],
      channelsRead: uniqueChannels.size,
      messagesFound: searchMessages.length,
      strategy: 'search',
      _sweepPromise: sweepPromise, // Exposed for callers that want to await validation
    };

    log.info({
      strategy: 'search',
      channelsRead: result.channelsRead,
      messagesFound: result.messagesFound,
    }, 'Slack team channel collection complete (search strategy)');

    return result;
  }

  // 5. Search failed — await sweep results as fallback
  const sweepResult = await sweepPromise;

  const result = {
    messages: sweepResult.messages,
    warnings: sweepResult.warnings,
    channelsRead: sweepResult.channelsRead,
    messagesFound: sweepResult.messages.length,
    strategy: 'sweep',
  };

  log.info({
    strategy: 'sweep',
    channelsRead: result.channelsRead,
    messagesFound: result.messagesFound,
    warnings: result.warnings.length,
  }, 'Slack team channel collection complete (sweep fallback)');

  return result;
}

// Exported for testing
function _resetCache() {
  // No module-level cache to reset — conversations are enumerated fresh each call.
  // Kept for backward compatibility with tests.
}

module.exports = { collectSlackTeamChannels, collectViaSearch, _resetChannelCache: _resetCache };
