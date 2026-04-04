'use strict';

/**
 * Build the Anthropic messages array for an agent turn.
 *
 * Handles three concerns:
 * 1. Inject a cached data snapshot so follow-up questions read from the same
 *    dataset — prevents contradictions from independent re-queries.
 * 2. Merge consecutive same-role messages (Anthropic API requires alternating).
 * 3. Guarantee the array starts with 'user' and ends with the current turn.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.history - Prior turns from Slack history
 * @param {string} opts.currentText - The current user message text
 * @param {string|null} opts.snapshot - JSON string of pre-fetched tool data (or null)
 * @returns {Array<{role: string, content: string}>}
 */
function buildConversationMessages({ history, currentText, snapshot }) {
  // Merge consecutive same-role messages and strip leading non-user messages
  const normalized = normalize(history.filter(m => m.content && m.role));

  // Remove the final message if it duplicates currentText (history often includes it)
  if (normalized.length > 0 &&
      normalized[normalized.length - 1].role === 'user' &&
      normalized[normalized.length - 1].content === currentText) {
    normalized.pop();
  }

  if (snapshot) {
    // Build: [user: bootstrap, assistant: snapshot, ...history, user: current]
    const bootstrap = { role: 'user', content: 'Here is your current follow-up and obligation snapshot:' };
    const snapshotMsg = { role: 'assistant', content: snapshot };

    if (normalized.length === 0) {
      return [bootstrap, snapshotMsg, { role: 'user', content: currentText }];
    }

    const withHistory = normalize([bootstrap, snapshotMsg, ...normalized]);
    const last = withHistory[withHistory.length - 1];
    if (last.role === 'user' && last.content !== currentText) {
      withHistory.push({ role: 'user', content: currentText });
    } else if (last.role !== 'user') {
      withHistory.push({ role: 'user', content: currentText });
    } else {
      withHistory[withHistory.length - 1] = { role: 'user', content: currentText };
    }
    return withHistory;
  }

  // No snapshot — history + current turn
  if (normalized.length === 0) {
    return [{ role: 'user', content: currentText }];
  }

  const last = normalized[normalized.length - 1];
  if (last.role === 'user') {
    normalized[normalized.length - 1] = { role: 'user', content: currentText };
  } else {
    normalized.push({ role: 'user', content: currentText });
  }
  return normalized;
}

/**
 * Normalize a messages array:
 * - Merge consecutive same-role messages (joined with newline)
 * - Strip leading assistant messages (API requires user-first)
 */
function normalize(messages) {
  if (messages.length === 0) return [];

  const merged = [];
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1] = {
        role: msg.role,
        content: merged[merged.length - 1].content + '\n' + msg.content,
      };
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }

  while (merged.length > 0 && merged[0].role !== 'user') {
    merged.shift();
  }

  return merged;
}

module.exports = { buildConversationMessages };
