'use strict';

/**
 * Tracks Slack conversations (DMs and mentions) with resolved human-readable names.
 * Extracted from slack-events-monitor.js for testability via dependency injection.
 */
async function trackSlackConversation({ db, accountId, slackReader, reticleDb, log, mySlackUserId }, event, direction) {
  if (!db) { log.warn('trackSlackConversation skipped — DB connection unavailable'); return; }

  try {
    if (direction === 'outgoing') {
      return handleOutgoingMessage({ db, accountId, reticleDb, log }, event);
    }

    const now = Math.floor(Date.now() / 1000);
    let conversationId, conversationType;

    if (event.channel_type === 'im' || event.channel_type === 'mpim') {
      conversationId = `slack:dm:${event.user}`;
      conversationType = 'slack-dm';
    } else {
      // Relevance gate: only track channel messages that personally @mention the user
      // or come from app_mention events (bot was explicitly mentioned).
      // Skip: @here/@channel broadcasts, messages mentioning others, general chatter.
      if (!event._appMention && mySlackUserId) {
        const text = event.text || '';
        if (!text.includes(`<@${mySlackUserId}>`)) {
          return; // Not relevant — don't track
        }
        // Also skip if it's a broadcast that happens to include the user
        if (text.includes('<!here>') || text.includes('<!channel>')) {
          return;
        }
      }

      conversationId = `slack:mention:${event.channel}-${event.ts}`;
      conversationType = 'slack-mention';
    }

    // Resolve human-readable names from Slack API (cached internally)
    let fromName = null;
    let channelName = null;
    try {
      fromName = await slackReader.getUserInfo(event.user);
    } catch (err) {
      log.debug({ err, user: event.user }, 'Could not resolve user name for conversation tracking');
    }
    if (event.channel_type !== 'im') {
      try {
        channelName = await slackReader.getConversationInfo(event.channel);
      } catch (err) {
        log.debug({ err, channel: event.channel }, 'Could not resolve channel name for conversation tracking');
      }
    }

    reticleDb.trackConversation(db, accountId, {
      id: conversationId,
      type: conversationType,
      subject: event.text ? event.text.substring(0, 100) : null,
      from_user: event.user,
      from_name: fromName,
      channel_id: event.channel,
      channel_name: channelName,
      last_activity: Math.floor(parseFloat(event.ts)),
      last_sender: 'them',
      waiting_for: 'my-response',
      first_seen: now
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to track Slack conversation');
  }
}

/**
 * Handle Alexander's outgoing messages — resolve or flip matching conversations.
 *
 * DMs: flip existing conversation to 'their-response' (ongoing back-and-forth).
 * Channel mentions: auto-resolve when Alexander replies in the mention's thread.
 */
function handleOutgoingMessage({ db, reticleDb, log }, event) {
  if (event.channel_type === 'im') {
    // DM: find the active conversation for this DM channel and flip it
    const conv = db.prepare(`
      SELECT id FROM conversations
      WHERE channel_id = ? AND type = 'slack-dm' AND state = 'active' AND waiting_for = 'my-response'
    `).get(event.channel);

    if (conv) {
      reticleDb.updateConversationState(db, conv.id, 'me', 'their-response');
      log.info({ conversationId: conv.id, channel: event.channel }, 'DM reply — flipped to their-response');
    }
  } else if (event.thread_ts) {
    // Channel thread reply: resolve the mention that started this thread
    const mentionId = `slack:mention:${event.channel}-${event.thread_ts}`;
    const conv = db.prepare(`
      SELECT id, state FROM conversations WHERE id = ? AND state = 'active'
    `).get(mentionId);

    if (conv) {
      reticleDb.resolveConversation(db, mentionId);
      log.info({ conversationId: mentionId, channel: event.channel }, 'Channel reply — auto-resolved mention');
    }
  }
  // Top-level channel messages without thread_ts: no action (not a reply to anything)
}

module.exports = { trackSlackConversation };
