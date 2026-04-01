'use strict';

/**
 * Ranks and caps conversations for notification output.
 *
 * Priority: DMs > mentions > email (DMs are most personal/urgent).
 * Within each type: oldest first (most overdue = most urgent).
 * Caps at MAX_SURFACED to keep notifications readable.
 */

const MAX_SURFACED = 15;

const TYPE_PRIORITY = {
  'slack-dm': 0,
  'slack-mention': 1,
  'email': 2,
};

function rankConversations(conversations) {
  const sorted = [...conversations].sort((a, b) => {
    const typeDiff = (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9);
    if (typeDiff !== 0) return typeDiff;
    return a.last_activity - b.last_activity; // oldest first
  });

  return sorted.slice(0, MAX_SURFACED);
}

module.exports = { rankConversations, MAX_SURFACED };
