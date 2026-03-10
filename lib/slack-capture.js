'use strict';

const kg = require('./knowledge-graph');

/**
 * Capture a Slack message into raw_messages for later extraction.
 * This is a synchronous, testable function. The caller is responsible
 * for resolving channel/user names (async Slack API) before calling.
 */
function captureMessage(db, { channel, channelName, ts, user, userName, text, threadTs, channelType, clientMsgId, subtype }) {
  const sourceId = `${channel}:${ts}`;

  // Resolve author to entity ID if identity is known
  const authorEntityId = kg.resolveIdentity(db, 'slack', user);

  // DMs get a synthetic channel name
  const resolvedChannelName = channelType === 'im'
    ? `dm-${userName || user}`
    : (channelName || channel);

  // Build enriched metadata for future consumers
  const metadata = {
    event_type: 'message',
    source_msg_id: clientMsgId || null,
    source_parent_ref: threadTs ? `${channel}:${threadTs}` : null,
    subtype: subtype || null,
  };

  return kg.insertRawMessage(db, {
    source: 'slack',
    sourceId,
    channelId: channel,
    channelName: resolvedChannelName,
    authorExtId: user,
    authorId: authorEntityId,
    authorName: userName || null,
    content: text,
    threadId: threadTs || null,
    occurredAt: Math.floor(parseFloat(ts)),
    metadata,
  });
}

module.exports = { captureMessage };
