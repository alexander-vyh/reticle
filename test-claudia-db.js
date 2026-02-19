'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `claudia-test-${Date.now()}.db`);
process.env.CLAUDIA_DB_PATH = TEST_DB_PATH;

const claudiaDb = require('./claudia-db');

// Cleanup on exit
process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = claudiaDb.initDatabase();

// --- Test: Database initializes with all tables ---
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);
assert.deepStrictEqual(tables, [
  'accounts', 'action_log', 'conversations', 'email_rules',
  'emails', 'entity_links', 'notification_log', 'o3_sessions', 'unsubscribes'
]);
console.log('PASS: all 9 tables created');

// --- Test: upsertAccount + getAccount ---
const acct = claudiaDb.upsertAccount(db, {
  email: 'alexanderv@example.com',
  provider: 'gmail',
  display_name: 'Alexander (Work)',
  is_primary: 1
});
assert.ok(acct.id);
assert.strictEqual(acct.email, 'alexanderv@example.com');

const fetched = claudiaDb.getAccount(db, 'alexanderv@example.com');
assert.strictEqual(fetched.id, acct.id);
assert.strictEqual(fetched.is_primary, 1);
console.log('PASS: upsertAccount + getAccount');

// --- Test: getPrimaryAccount ---
const primary = claudiaDb.getPrimaryAccount(db);
assert.strictEqual(primary.email, 'alexanderv@example.com');
console.log('PASS: getPrimaryAccount');

// --- Test: upsert is idempotent ---
const acct2 = claudiaDb.upsertAccount(db, {
  email: 'alexanderv@example.com',
  display_name: 'Alexander V'
});
assert.strictEqual(acct2.id, acct.id);
assert.strictEqual(acct2.display_name, 'Alexander V');
console.log('PASS: upsert idempotent');

console.log('\n--- Task 1 accounts tests passed ---');

// --- Test: link + getLinked ---
claudiaDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'conversation', targetId: 'conv-1',
  relationship: 'belongs_to'
});

const linked = claudiaDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(linked.length, 1);
assert.strictEqual(linked[0].target_type, 'conversation');
assert.strictEqual(linked[0].target_id, 'conv-1');
console.log('PASS: link + getLinked (forward)');

// Reverse lookup
const reverse = claudiaDb.getLinked(db, 'conversation', 'conv-1');
assert.strictEqual(reverse.length, 1);
assert.strictEqual(reverse[0].source_type, 'email');
console.log('PASS: getLinked (reverse)');

// Filtered lookup
claudiaDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'todo', targetId: 'todo-1',
  relationship: 'triggered'
});
const filtered = claudiaDb.getLinked(db, 'email', 'email-1', {
  targetType: 'todo'
});
assert.strictEqual(filtered.length, 1);
assert.strictEqual(filtered[0].relationship, 'triggered');
console.log('PASS: getLinked (filtered)');

// Duplicate link is idempotent (upsert)
claudiaDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'conversation', targetId: 'conv-1',
  relationship: 'belongs_to'
});
const afterDup = claudiaDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(afterDup.length, 2); // still 2, not 3
console.log('PASS: duplicate link is idempotent');

// Invalid entity type throws
assert.throws(() => {
  claudiaDb.link(db, {
    sourceType: 'bogus', sourceId: 'x',
    targetType: 'email', targetId: 'y',
    relationship: 'belongs_to'
  });
}, /Unknown entity type/);
console.log('PASS: invalid entity type throws');

// unlink
claudiaDb.unlink(db, 'email', 'email-1', 'todo', 'todo-1', 'triggered');
const afterUnlink = claudiaDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(afterUnlink.length, 1);
console.log('PASS: unlink');

console.log('\n--- Task 1 entity_links tests passed ---');

// --- Test: logAction + getEntityHistory + getRecentActions ---
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'system', entityType: 'email', entityId: 'email-1',
  action: 'received', context: { from: 'test@example.com' }
});
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'rule:5', entityType: 'email', entityId: 'email-1',
  action: 'archived', context: { rule: 'zoom-filter' }, outcome: { labels_removed: ['INBOX'] }
});
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'user', entityType: 'email', entityId: 'email-1',
  action: 'moved_to_inbox', context: { reason: 'user override' }
});

const history = claudiaDb.getEntityHistory(db, 'email', 'email-1');
assert.strictEqual(history.length, 3);
assert.strictEqual(history[0].action, 'received');
assert.strictEqual(history[2].action, 'moved_to_inbox');
console.log('PASS: logAction + getEntityHistory');

const userActions = claudiaDb.getRecentActions(db, { actor: 'user' });
assert.strictEqual(userActions.length, 1);
assert.strictEqual(userActions[0].action, 'moved_to_inbox');
console.log('PASS: getRecentActions filtered by actor');

const allActions = claudiaDb.getRecentActions(db, { accountId: acct.id });
assert.strictEqual(allActions.length, 3);
console.log('PASS: getRecentActions filtered by account');

console.log('\n--- Task 1 action_log tests passed ---');

// --- Test: upsertEmail + getEmailByGmailId + getEmailsByThread ---
const email = claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b21d',
  thread_id: 'thread-abc',
  from_addr: 'noreply@okta.com',
  from_name: 'Okta',
  to_addrs: ['alexanderv@example.com'],
  subject: 'Okta rate limit warning',
  date: Math.floor(Date.now() / 1000),
  direction: 'inbound',
  snippet: 'Your org has exceeded...'
});
assert.ok(email.id);
assert.strictEqual(email.gmail_id, '19c748749068b21d');
console.log('PASS: upsertEmail');

const byGmail = claudiaDb.getEmailByGmailId(db, acct.id, '19c748749068b21d');
assert.strictEqual(byGmail.id, email.id);
console.log('PASS: getEmailByGmailId');

// Second email in same thread
claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b22e',
  thread_id: 'thread-abc',
  from_addr: 'alexanderv@example.com',
  to_addrs: ['noreply@okta.com'],
  subject: 'Re: Okta rate limit warning',
  date: Math.floor(Date.now() / 1000) + 60,
  direction: 'outbound'
});

const thread = claudiaDb.getEmailsByThread(db, acct.id, 'thread-abc');
assert.strictEqual(thread.length, 2);
console.log('PASS: getEmailsByThread');

// Upsert same gmail_id updates existing
const updated = claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b21d',
  thread_id: 'thread-abc',
  from_addr: 'noreply@okta.com',
  subject: 'Okta rate limit warning (updated)',
  date: Math.floor(Date.now() / 1000),
  direction: 'inbound'
});
assert.strictEqual(updated.id, email.id);
assert.strictEqual(updated.subject, 'Okta rate limit warning (updated)');
console.log('PASS: upsertEmail idempotent');

console.log('\n--- Task 2 email tests passed ---');

// --- Test: trackConversation ---
const now = Math.floor(Date.now() / 1000);
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:thread-1',
  type: 'email',
  subject: 'Q1 Budget Review',
  from_user: 'boss@example.com',
  from_name: 'Boss',
  last_sender: 'them',
  waiting_for: 'my-response',
  metadata: { urgency: 'high' }
});

const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.strictEqual(conv.type, 'email');
assert.strictEqual(conv.subject, 'Q1 Budget Review');
assert.strictEqual(conv.waiting_for, 'my-response');
assert.strictEqual(conv.account_id, acct.id);
console.log('PASS: trackConversation');

// --- Test: updateConversationState ---
claudiaDb.updateConversationState(db, 'email:thread-1', 'me', 'their-response');
const updated2 = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.strictEqual(updated2.waiting_for, 'their-response');
console.log('PASS: updateConversationState');

// --- Test: getPendingResponses ---
// Flip back to my-response for this test
claudiaDb.updateConversationState(db, 'email:thread-1', 'them', 'my-response');
const pending = claudiaDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.strictEqual(pending.length, 1);
assert.strictEqual(pending[0].id, 'email:thread-1');
console.log('PASS: getPendingResponses');

// --- Test: resolveConversation ---
claudiaDb.resolveConversation(db, 'email:thread-1');
const resolved = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.ok(resolved.resolved_at);
assert.strictEqual(resolved.state, 'resolved');
console.log('PASS: resolveConversation');

// --- Test: getAwaitingReplies ---
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:thread-2',
  type: 'email',
  subject: 'Pending question',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response'
});
const awaiting = claudiaDb.getAwaitingReplies(db, acct.id, {});
assert.ok(awaiting.length >= 1);
console.log('PASS: getAwaitingReplies');

// --- Test: getResolvedToday ---
// Includes both explicitly resolved AND flipped-to-their-response today
const resolvedToday = claudiaDb.getResolvedToday(db, acct.id, 'email');
assert.ok(resolvedToday.length >= 1);
console.log('PASS: getResolvedToday');

// --- Test: getStats ---
const stats = claudiaDb.getStats(db, acct.id);
assert.ok(stats.total >= 1);
console.log('PASS: getStats');

console.log('\n--- Task 3 conversation tests passed ---');

// --- Test: recordUnsubscribe ---
const unsub = claudiaDb.recordUnsubscribe(db, acct.id, {
  sender_addr: 'marketing@vanta.com',
  sender_domain: 'vanta.com',
  method: 'list-unsubscribe-post',
  unsubscribe_url: 'https://vanta.com/unsubscribe?token=abc',
  metadata: { trigger_email_subject: 'Vanta Security Update' }
});
assert.ok(unsub.id);
assert.strictEqual(unsub.sender_domain, 'vanta.com');
assert.strictEqual(unsub.confirmed, 0);
console.log('PASS: recordUnsubscribe');

// --- Test: checkUnsubscribed ---
const check = claudiaDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check.unsubscribed, true);
assert.strictEqual(check.emails_since, 0);
console.log('PASS: checkUnsubscribed (positive)');

const checkNone = claudiaDb.checkUnsubscribed(db, acct.id, 'unknown.com');
assert.strictEqual(checkNone.unsubscribed, false);
console.log('PASS: checkUnsubscribed (negative)');

// --- Test: incrementEmailsSince ---
claudiaDb.incrementEmailsSince(db, acct.id, 'vanta.com');
claudiaDb.incrementEmailsSince(db, acct.id, 'vanta.com');
const check2 = claudiaDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check2.emails_since, 2);
console.log('PASS: incrementEmailsSince');

// --- Test: confirmUnsubscribe ---
claudiaDb.confirmUnsubscribe(db, unsub.id);
const check3 = claudiaDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check3.confirmed, true);
console.log('PASS: confirmUnsubscribe');

console.log('\n--- Task 4 unsubscribe tests passed ---');

// --- Test: createRule ---
const rule = claudiaDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from: 'noreply@zoom.us',
  source_email: 'noreply@zoom.us',
  source_subject: 'Meeting reminder'
});
assert.ok(rule.id);
assert.strictEqual(rule.rule_type, 'archive');
console.log('PASS: createRule');

// --- Test: getActiveRules ---
const rules = claudiaDb.getActiveRules(db, acct.id);
assert.ok(rules.length >= 1);
assert.strictEqual(rules[0].match_from, 'noreply@zoom.us');
console.log('PASS: getActiveRules');

// --- Test: recordRuleHit ---
claudiaDb.recordRuleHit(db, rule.id);
claudiaDb.recordRuleHit(db, rule.id);
const hitRule = claudiaDb.getRuleById(db, rule.id);
assert.strictEqual(hitRule.hit_count, 2);
console.log('PASS: recordRuleHit');

// --- Test: deactivateRule ---
claudiaDb.deactivateRule(db, rule.id);
const deactivated = claudiaDb.getRuleById(db, rule.id);
assert.strictEqual(deactivated.active, 0);
const activeRules = claudiaDb.getActiveRules(db, acct.id);
assert.strictEqual(activeRules.filter(r => r.match_from === 'noreply@zoom.us').length, 0);
console.log('PASS: deactivateRule');

// --- Test: getRulesSummary ---
// Re-create for summary test
claudiaDb.createRule(db, acct.id, { rule_type: 'archive', match_from_domain: 'example.com' });
const summary = claudiaDb.getRulesSummary(db, acct.id);
assert.ok(summary.total >= 1);
console.log('PASS: getRulesSummary');

// --- Test: no delete rules allowed ---
assert.throws(() => {
  claudiaDb.createRule(db, acct.id, { rule_type: 'delete', match_from: 'spam@bad.com' });
}, /delete rules are not allowed/i);
console.log('PASS: delete rules blocked');

console.log('\n--- Task 5 email_rules tests passed ---');
