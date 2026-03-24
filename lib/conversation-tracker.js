'use strict';

/**
 * Tracks Slack conversations (DMs and mentions) with resolved human-readable names.
 * Extracted from slack-events-monitor.js for testability via dependency injection.
 */
async function trackSlackConversation({ db, accountId, slackReader, reticleDb, log }, event, direction) {
  if (!db) { log.warn('trackSlackConversation skipped — DB connection unavailable'); return; }

  try {
    const now = Math.floor(Date.now() / 1000);
    let conversationId, conversationType;

    if (event.channel_type === 'im') {
      conversationId = `slack:dm:${event.user}`;
      conversationType = 'slack-dm';
    } else {
      conversationId = `slack:mention:${event.channel}-${event.ts}`;
      conversationType = 'slack-mention';
    }

    const lastSender = direction === 'incoming' ? 'them' : 'me';
    const waitingFor = direction === 'incoming' ? 'my-response' : 'their-response';

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
      last_sender: lastSender,
      waiting_for: waitingFor,
      first_seen: now
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to track Slack conversation');
  }
}

module.exports = { trackSlackConversation };
