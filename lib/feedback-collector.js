'use strict';

const log = require('./logger')('feedback-collector');

/**
 * Filter messages to only those authored by or mentioning a report.
 *
 * @param {Array<{user: string, text: string, ts: string, channelId: string, channelName: string, thread_ts?: string}>} messages
 * @param {Map<string, string>} reportSlackIds - Map of Slack user ID → display name
 * @returns {Array<{reportName: string, reportSlackId: string, channelName: string, channelId: string, messageText: string, timestamp: string, threadTs: string|null, messageType: 'authored'|'mentioned'}>}
 */
function filterToReportMessages(messages, reportSlackIds) {
  const candidates = [];
  const USER_MENTION_PATTERN = /<@(U[A-Z0-9_]+)>/g;

  for (const msg of messages) {
    const authorName = reportSlackIds.get(msg.user);
    let added = false;

    if (authorName) {
      candidates.push({
        reportName: authorName,
        reportSlackId: msg.user,
        channelName: msg.channelName,
        channelId: msg.channelId,
        messageText: msg.text,
        timestamp: msg.ts,
        threadTs: msg.thread_ts || null,
        messageType: 'authored'
      });
      added = true;
    }

    if (!added) {
      let match;
      USER_MENTION_PATTERN.lastIndex = 0;
      while ((match = USER_MENTION_PATTERN.exec(msg.text)) !== null) {
        const mentionedName = reportSlackIds.get(match[1]);
        if (mentionedName) {
          candidates.push({
            reportName: mentionedName,
            reportSlackId: match[1],
            channelName: msg.channelName,
            channelId: msg.channelId,
            messageText: msg.text,
            timestamp: msg.ts,
            threadTs: msg.thread_ts || null,
            messageType: 'mentioned'
          });
          break;
        }
      }
    }
  }

  return candidates;
}

module.exports = { filterToReportMessages };
