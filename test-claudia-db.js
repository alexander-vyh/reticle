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
  'accounts', 'action_log', 'conversations', 'digest_snapshots', 'email_rules',
  'emails', 'entity_links', 'notification_log', 'o3_sessions', 'unsubscribes'
]);
console.log('PASS: all 10 tables created');

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

// --- Test: upsertO3Session ---
const o3Start = Math.floor(Date.now() / 1000);
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-event-1',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: o3Start,
  scheduled_end: o3Start + 1800,
  created_at: o3Start - 86400
});

const session = claudiaDb.getO3Session(db, 'cal-event-1');
assert.strictEqual(session.report_name, 'Jane Smith');
assert.strictEqual(session.account_id, acct.id);
console.log('PASS: upsertO3Session + getO3Session');

// --- Test: markO3Notified ---
claudiaDb.markO3Notified(db, 'cal-event-1', 'prep_sent_afternoon');
const notified = claudiaDb.getO3Session(db, 'cal-event-1');
assert.strictEqual(notified.prep_sent_afternoon, 1);
console.log('PASS: markO3Notified');

// --- Test: getLastO3ForReport ---
const last = claudiaDb.getLastO3ForReport(db, 'jane@example.com', o3Start + 1);
assert.strictEqual(last.id, 'cal-event-1');
console.log('PASS: getLastO3ForReport');

// --- Test: logNotification + markNotified (uses conv from Task 3) ---
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:notif-test',
  type: 'email',
  subject: 'Notification test',
  from_user: 'test@example.com',
  from_name: 'Test',
  last_sender: 'them',
  waiting_for: 'my-response'
});
claudiaDb.logNotification(db, acct.id, 'email:notif-test', 'immediate');
const notifCount = db.prepare('SELECT COUNT(*) as c FROM notification_log WHERE conversation_id = ?')
  .get('email:notif-test').c;
assert.strictEqual(notifCount, 1);
console.log('PASS: logNotification');

claudiaDb.markNotified(db, 'email:notif-test');
const notifConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:notif-test');
assert.ok(notifConv.notified_at);
console.log('PASS: markNotified');

console.log('\n--- Task 6 O3 + notification tests passed ---');

// ============================================================================
// BEHAVIORAL CONTRACT TESTS
// These test the invariants that services actually rely on.
// ============================================================================

// --- Test: Previously untested exports ---

// ALLOWED_RULE_TYPES constant
assert.deepStrictEqual(claudiaDb.ALLOWED_RULE_TYPES, ['archive', 'alert', 'demote', 'flag']);
console.log('PASS: ALLOWED_RULE_TYPES constant');

// RELATIONSHIPS constant
assert.ok(claudiaDb.RELATIONSHIPS.belongs_to);
assert.ok(claudiaDb.RELATIONSHIPS.triggered);
assert.ok(claudiaDb.RELATIONSHIPS.replied_to);
assert.ok(claudiaDb.RELATIONSHIPS.follow_up_for);
assert.ok(claudiaDb.RELATIONSHIPS.unsubscribed_from);
assert.ok(claudiaDb.RELATIONSHIPS.mentioned_in);
console.log('PASS: RELATIONSHIPS constant');

// ENTITY_TYPES constant
assert.ok(claudiaDb.ENTITY_TYPES.email);
assert.ok(claudiaDb.ENTITY_TYPES.conversation);
assert.ok(claudiaDb.ENTITY_TYPES.o3_session);
console.log('PASS: ENTITY_TYPES constant');

console.log('\n--- Constants tests passed ---');

// --- Test: getO3SessionsForReport ---
// Add a second O3 session for the same report
const o3Start2 = o3Start + 86400; // 1 day later
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-event-2',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: o3Start2,
  scheduled_end: o3Start2 + 1800,
  created_at: o3Start2 - 3600
});

const sessions = claudiaDb.getO3SessionsForReport(db, 'jane@example.com');
assert.strictEqual(sessions.length, 2);
// Should be DESC order -- newest first
assert.strictEqual(sessions[0].id, 'cal-event-2');
assert.strictEqual(sessions[1].id, 'cal-event-1');
console.log('PASS: getO3SessionsForReport (multiple, DESC order)');

// --- Test: getWeeklyO3Summary ---
// Both sessions fall within a week-sized window
const weekStart = o3Start - 3600;
const weekEnd = o3Start2 + 86400;
const weekly = claudiaDb.getWeeklyO3Summary(db, weekStart, weekEnd);
assert.strictEqual(weekly.length, 2);
// Should be ASC order -- earliest first
assert.strictEqual(weekly[0].id, 'cal-event-1');
assert.strictEqual(weekly[1].id, 'cal-event-2');
console.log('PASS: getWeeklyO3Summary (ASC order, range boundaries)');

// Boundary: query range that excludes both sessions
const emptyWeek = claudiaDb.getWeeklyO3Summary(db, o3Start2 + 86400, o3Start2 + 172800);
assert.strictEqual(emptyWeek.length, 0);
console.log('PASS: getWeeklyO3Summary (empty range)');

// --- Test: markO3LatticeLogged ---
claudiaDb.markO3LatticeLogged(db, 'cal-event-2');
const logged = claudiaDb.getO3Session(db, 'cal-event-2');
assert.strictEqual(logged.lattice_logged, 1);
console.log('PASS: markO3LatticeLogged');

// --- Test: markO3Notified with all valid fields ---
claudiaDb.markO3Notified(db, 'cal-event-2', 'prep_sent_before');
const notified2 = claudiaDb.getO3Session(db, 'cal-event-2');
assert.strictEqual(notified2.prep_sent_before, 1);
console.log('PASS: markO3Notified (prep_sent_before)');

claudiaDb.markO3Notified(db, 'cal-event-2', 'post_nudge_sent');
const notified3 = claudiaDb.getO3Session(db, 'cal-event-2');
assert.strictEqual(notified3.post_nudge_sent, 1);
console.log('PASS: markO3Notified (post_nudge_sent)');

// --- Test: markO3Notified with invalid field throws ---
assert.throws(() => {
  claudiaDb.markO3Notified(db, 'cal-event-2', 'evil_field; DROP TABLE o3_sessions;--');
}, /Invalid O3 notification field/);
console.log('PASS: markO3Notified rejects invalid field');

console.log('\n--- Previously untested functions passed ---');

// --- Test: Multi-Account Isolation ---
const acctB = claudiaDb.upsertAccount(db, {
  email: 'personal@example.com',
  provider: 'gmail',
  display_name: 'Personal',
  is_primary: 0
});
assert.notStrictEqual(acctB.id, acct.id);

// Create data scoped to account B
claudiaDb.trackConversation(db, acctB.id, {
  id: 'personal:conv-1',
  type: 'email',
  subject: 'Personal Thread',
  from_user: 'friend@example.com',
  from_name: 'Friend',
  last_sender: 'them',
  waiting_for: 'my-response'
});

claudiaDb.upsertEmail(db, acctB.id, {
  gmail_id: 'personal-gmail-001',
  thread_id: 'personal-thread-1',
  from_addr: 'friend@example.com',
  subject: 'Personal email',
  date: Math.floor(Date.now() / 1000),
  direction: 'inbound'
});

claudiaDb.recordUnsubscribe(db, acctB.id, {
  sender_domain: 'spam-personal.com',
  method: 'list-unsubscribe-post'
});

claudiaDb.createRule(db, acctB.id, {
  rule_type: 'archive',
  match_from: 'noise@personal.com'
});

// Verify account A queries do NOT return account B data
const pendingA = claudiaDb.getPendingResponses(db, acct.id);
assert.ok(!pendingA.some(c => c.id === 'personal:conv-1'), 'Account A pending should not contain account B conversation');

const emailsA = claudiaDb.getEmailsByThread(db, acct.id, 'personal-thread-1');
assert.strictEqual(emailsA.length, 0, 'Account A should not see account B emails');

const unsubA = claudiaDb.checkUnsubscribed(db, acct.id, 'spam-personal.com');
assert.strictEqual(unsubA.unsubscribed, false, 'Account A should not see account B unsubscribes');

const rulesA = claudiaDb.getActiveRules(db, acct.id);
assert.ok(!rulesA.some(r => r.match_from === 'noise@personal.com'), 'Account A should not see account B rules');

// Verify account B queries return ONLY account B data
const pendingB = claudiaDb.getPendingResponses(db, acctB.id);
assert.strictEqual(pendingB.length, 1);
assert.strictEqual(pendingB[0].id, 'personal:conv-1');

const emailByGmailB = claudiaDb.getEmailByGmailId(db, acctB.id, 'personal-gmail-001');
assert.ok(emailByGmailB);

const emailByGmailA = claudiaDb.getEmailByGmailId(db, acct.id, 'personal-gmail-001');
assert.strictEqual(emailByGmailA, undefined, 'Account A should not see account B gmail_id');

console.log('PASS: multi-account isolation (conversations, emails, unsubscribes, rules)');

console.log('\n--- Multi-account isolation tests passed ---');

// --- Test: trackConversation upsert (same ID, updated fields) ---
const origConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('personal:conv-1');
const origFirstSeen = origConv.first_seen;

// Upsert with same ID but different subject and waiting_for
claudiaDb.trackConversation(db, acctB.id, {
  id: 'personal:conv-1',
  type: 'email',
  subject: 'Updated Subject',
  from_user: 'friend@example.com',
  from_name: 'Friend',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: Math.floor(Date.now() / 1000) + 100
});

const upserted = db.prepare('SELECT * FROM conversations WHERE id = ?').get('personal:conv-1');
assert.strictEqual(upserted.subject, 'Updated Subject', 'Subject should update on upsert');
assert.strictEqual(upserted.waiting_for, 'their-response', 'waiting_for should update on upsert');
assert.strictEqual(upserted.first_seen, origFirstSeen, 'first_seen must NOT change on upsert');
assert.strictEqual(upserted.state, 'active', 'state must NOT change on upsert');
console.log('PASS: trackConversation upsert preserves first_seen, updates subject + waiting_for');

// Verify no duplicate was created
const allPersonalConvs = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE id = ?').get('personal:conv-1');
assert.strictEqual(allPersonalConvs.c, 1, 'Upsert must not create duplicates');
console.log('PASS: trackConversation upsert does not create duplicates');

console.log('\n--- Conversation upsert tests passed ---');

// --- Test: olderThan filter for getPendingResponses ---
const now2 = Math.floor(Date.now() / 1000);

// Create conversations with controlled timestamps
claudiaDb.trackConversation(db, acct.id, {
  id: 'age-test:recent',
  type: 'slack-dm',
  from_user: 'recent@example.com',
  from_name: 'Recent',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now2 - 1800 // 30 minutes ago
});

claudiaDb.trackConversation(db, acct.id, {
  id: 'age-test:old',
  type: 'slack-dm',
  from_user: 'old@example.com',
  from_name: 'Old',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now2 - (5 * 3600) // 5 hours ago
});

claudiaDb.trackConversation(db, acct.id, {
  id: 'age-test:very-old',
  type: 'slack-dm',
  from_user: 'veryold@example.com',
  from_name: 'Very Old',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now2 - (25 * 3600) // 25 hours ago
});

// olderThan = 4 hours (14400 seconds): should return 5h and 25h, NOT 30m
const older4h = claudiaDb.getPendingResponses(db, acct.id, {
  type: 'slack-dm',
  olderThan: 4 * 3600
});
const older4hIds = older4h.map(c => c.id);
assert.ok(!older4hIds.includes('age-test:recent'), 'Recent (30m) should NOT appear in olderThan 4h');
assert.ok(older4hIds.includes('age-test:old'), 'Old (5h) should appear in olderThan 4h');
assert.ok(older4hIds.includes('age-test:very-old'), 'Very old (25h) should appear in olderThan 4h');
console.log('PASS: getPendingResponses olderThan filter works correctly');

// olderThan = 24 hours: should return only the 25h one
const older24h = claudiaDb.getPendingResponses(db, acct.id, {
  type: 'slack-dm',
  olderThan: 24 * 3600
});
const older24hIds = older24h.map(c => c.id);
assert.ok(!older24hIds.includes('age-test:recent'), '30m should NOT appear in olderThan 24h');
assert.ok(!older24hIds.includes('age-test:old'), '5h should NOT appear in olderThan 24h');
assert.ok(older24hIds.includes('age-test:very-old'), '25h should appear in olderThan 24h');
console.log('PASS: getPendingResponses olderThan 24h filter');

// --- Test: olderThan for getAwaitingReplies ---
claudiaDb.trackConversation(db, acct.id, {
  id: 'await-test:recent',
  type: 'email',
  subject: 'Recent sent',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: now2 - 1800 // 30 minutes ago
});

claudiaDb.trackConversation(db, acct.id, {
  id: 'await-test:old',
  type: 'email',
  subject: 'Old sent',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: now2 - (25 * 3600) // 25 hours ago
});

const awaitOld = claudiaDb.getAwaitingReplies(db, acct.id, {
  type: 'email',
  olderThan: 24 * 3600
});
const awaitOldIds = awaitOld.map(c => c.id);
assert.ok(!awaitOldIds.includes('await-test:recent'), 'Recent awaiting should NOT appear in olderThan 24h');
assert.ok(awaitOldIds.includes('await-test:old'), 'Old awaiting should appear in olderThan 24h');
console.log('PASS: getAwaitingReplies olderThan filter works correctly');

// --- Test: limit parameter ---
const limitResults = claudiaDb.getPendingResponses(db, acct.id, {
  type: 'slack-dm',
  limit: 1
});
assert.strictEqual(limitResults.length, 1, 'limit should cap results');
console.log('PASS: getPendingResponses limit parameter');

console.log('\n--- Time-based filter tests passed ---');

// --- Test: notified_at read-back in getPendingResponses ---
claudiaDb.markNotified(db, 'age-test:old');
const pendingWithNotified = claudiaDb.getPendingResponses(db, acct.id, { type: 'slack-dm' });
const notifiedConv = pendingWithNotified.find(c => c.id === 'age-test:old');
assert.ok(notifiedConv, 'Notified conv should still appear in pending (it is still active + my-response)');
assert.ok(notifiedConv.notified_at, 'notified_at should be a valid timestamp after markNotified');
assert.ok(typeof notifiedConv.notified_at === 'number', 'notified_at should be numeric');

// Verify non-notified conv has null notified_at
const nonNotified = pendingWithNotified.find(c => c.id === 'age-test:recent');
assert.ok(nonNotified);
assert.strictEqual(nonNotified.notified_at, null, 'Non-notified conv should have null notified_at');
console.log('PASS: notified_at read-back in getPendingResponses');

console.log('\n--- Notification read-back tests passed ---');

// --- Test: resolveConversation idempotency ---
claudiaDb.trackConversation(db, acct.id, {
  id: 'resolve-idem-test',
  type: 'email',
  from_user: 'test@example.com',
  from_name: 'Test',
  last_sender: 'them',
  waiting_for: 'my-response'
});
claudiaDb.resolveConversation(db, 'resolve-idem-test');
const firstResolve = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
const firstResolvedAt = firstResolve.resolved_at;
assert.ok(firstResolvedAt);

// Second resolve should be a no-op (WHERE resolved_at IS NULL prevents it)
claudiaDb.resolveConversation(db, 'resolve-idem-test');
const secondResolve = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
assert.strictEqual(secondResolve.resolved_at, firstResolvedAt, 'Double resolve must not change resolved_at');
console.log('PASS: resolveConversation is idempotent');

// --- Test: updateConversationState on resolved conversation (guard) ---
const beforeGuardUpdate = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
claudiaDb.updateConversationState(db, 'resolve-idem-test', 'them', 'their-response');
const afterUpdate = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
assert.strictEqual(afterUpdate.state, 'resolved', 'State must remain resolved');
assert.strictEqual(afterUpdate.waiting_for, beforeGuardUpdate.waiting_for, 'waiting_for must not change on resolved conv');
assert.strictEqual(afterUpdate.last_activity, beforeGuardUpdate.last_activity, 'last_activity must not change on resolved conv');
console.log('PASS: updateConversationState is no-op on resolved conversation');

console.log('\n--- Guard clause tests passed ---');

// --- Test: createRule with all match patterns + case normalization ---
const domainRule = claudiaDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from_domain: 'ZOOM.US'
});
assert.strictEqual(domainRule.match_from_domain, 'zoom.us', 'Domain should be lowercased');
console.log('PASS: createRule lowercases match_from_domain');

const subjectRule = claudiaDb.createRule(db, acct.id, {
  rule_type: 'alert',
  match_subject_contains: 'URGENT: Server Down'
});
assert.strictEqual(subjectRule.match_subject_contains, 'urgent: server down', 'Subject match should be lowercased');
console.log('PASS: createRule lowercases match_subject_contains');

const toRule = claudiaDb.createRule(db, acct.id, {
  rule_type: 'flag',
  match_to: 'DL-Engineering@EXAMPLE.COM'
});
assert.strictEqual(toRule.match_to, 'dl-engineering@example.com', 'match_to should be lowercased');
console.log('PASS: createRule lowercases match_to');

// Combined multi-condition rule
const comboRule = claudiaDb.createRule(db, acct.id, {
  rule_type: 'demote',
  match_from_domain: 'notifications.github.com',
  match_subject_contains: 'dependabot'
});
assert.strictEqual(comboRule.match_from_domain, 'notifications.github.com');
assert.strictEqual(comboRule.match_subject_contains, 'dependabot');
assert.strictEqual(comboRule.rule_type, 'demote');
console.log('PASS: createRule with combined match conditions');

// --- Test: Rule reactivation after deactivation ---
const ruleToDeactivate = claudiaDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from: 'reactivate-test@example.com'
});
const originalRuleId = ruleToDeactivate.id;
claudiaDb.deactivateRule(db, originalRuleId);

// Verify it's deactivated
const deactivatedCheck = claudiaDb.getRuleById(db, originalRuleId);
assert.strictEqual(deactivatedCheck.active, 0);

// Re-create the exact same rule -- should reactivate, not create a new row
const reactivated = claudiaDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from: 'reactivate-test@example.com'
});
assert.strictEqual(reactivated.active, 1, 'Re-created rule should be active');
// The id might differ due to lastInsertRowid behavior, but the rule should be active
const allMatchingRules = db.prepare(
  "SELECT * FROM email_rules WHERE account_id = ? AND match_from = 'reactivate-test@example.com'"
).all(acct.id);
assert.strictEqual(allMatchingRules.length, 1, 'Reactivation must not create duplicate rows');
assert.strictEqual(allMatchingRules[0].active, 1);
console.log('PASS: createRule reactivates deactivated rule (no duplicates)');

console.log('\n--- Rule edge case tests passed ---');

// --- Test: Full conversation lifecycle ---
// track → getPending → resolve → NOT in pending → in getResolvedToday
claudiaDb.trackConversation(db, acct.id, {
  id: 'lifecycle-test',
  type: 'email',
  subject: 'Lifecycle Test Email',
  from_user: 'lifecycle@example.com',
  from_name: 'Lifecycle',
  last_sender: 'them',
  waiting_for: 'my-response'
});

// Should appear in pending
const lifecyclePending = claudiaDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.ok(lifecyclePending.some(c => c.id === 'lifecycle-test'), 'New conv should appear in pending');

// Resolve it
claudiaDb.resolveConversation(db, 'lifecycle-test');

// Should NOT appear in pending anymore
const lifecyclePending2 = claudiaDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.ok(!lifecyclePending2.some(c => c.id === 'lifecycle-test'), 'Resolved conv must not appear in pending');

// Should appear in resolved today
const lifecycleResolved = claudiaDb.getResolvedToday(db, acct.id, 'email');
assert.ok(lifecycleResolved.some(c => c.id === 'lifecycle-test'), 'Resolved conv should appear in getResolvedToday');

console.log('PASS: full conversation lifecycle (pending → resolve → not pending → resolvedToday)');

console.log('\n--- Lifecycle tests passed ---');

// --- Test: getStats accuracy ---
// Use account B which has a known, controlled state: 1 conversation (personal:conv-1)
// that we upserted to 'their-response' earlier
const statsB = claudiaDb.getStats(db, acctB.id);
assert.strictEqual(statsB.total, 1, 'Account B should have exactly 1 active conversation');
assert.strictEqual(statsB.breakdown.length, 1, 'Account B should have 1 breakdown row');
assert.strictEqual(statsB.breakdown[0].type, 'email');
assert.strictEqual(statsB.breakdown[0].waiting_for, 'their-response');
assert.strictEqual(statsB.breakdown[0].count, 1);
console.log('PASS: getStats returns accurate breakdown');

// --- Test: updateConversationState updates last_activity ---
// Record current last_activity, then update state and verify it changed
const beforeState = db.prepare('SELECT last_activity FROM conversations WHERE id = ?').get('age-test:recent');
const beforeActivity = beforeState.last_activity;

// Brief pause to ensure timestamp changes (SQLite second-level resolution)
// Instead, we can check that it's >= the before value (same second is OK)
claudiaDb.updateConversationState(db, 'age-test:recent', 'me', 'their-response');
const afterState = db.prepare('SELECT last_activity FROM conversations WHERE id = ?').get('age-test:recent');
assert.ok(afterState.last_activity >= beforeActivity, 'last_activity should be updated (>= before value)');
assert.ok(afterState.last_activity >= now2, 'last_activity should be current time, not the original 30min-ago value');
console.log('PASS: updateConversationState updates last_activity');

console.log('\n--- Behavioral contract tests passed ---');

// --- Test: Action log JSON round-trip ---
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'test', entityType: 'email', entityId: 'roundtrip-test',
  action: 'tested',
  context: { nested: { key: 'value' }, arr: [1, 2, 3] },
  outcome: { success: true, count: 42 }
});
const roundTrip = claudiaDb.getEntityHistory(db, 'email', 'roundtrip-test');
assert.strictEqual(roundTrip.length, 1);
const parsedContext = JSON.parse(roundTrip[0].context);
assert.deepStrictEqual(parsedContext.nested, { key: 'value' });
assert.deepStrictEqual(parsedContext.arr, [1, 2, 3]);
const parsedOutcome = JSON.parse(roundTrip[0].outcome);
assert.strictEqual(parsedOutcome.success, true);
assert.strictEqual(parsedOutcome.count, 42);
console.log('PASS: action log JSON round-trip');

console.log('\n--- JSON serialization tests passed ---');

// --- Test: digest_snapshots table exists ---
const snapshotTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='digest_snapshots'"
).get();
assert.ok(snapshotTable, 'digest_snapshots table should exist');
console.log('PASS: digest_snapshots table created');

// --- Test: saveSnapshot ---
const testItems = [
  { id: 'test-1', collector: 'followup', observation: 'test', priority: 'normal' },
  { id: 'test-2', collector: 'email', observation: 'test2', priority: 'high' }
];
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-23',
  cadence: 'daily',
  items: testItems
});
console.log('PASS: saveSnapshot');

// --- Test: getSnapshotsForRange ---
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-22',
  cadence: 'daily',
  items: [{ id: 'test-3', collector: 'followup', observation: 'yesterday' }]
});
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-21',
  cadence: 'weekly',
  items: [{ id: 'test-4' }]
});

const snapshots = claudiaDb.getSnapshotsForRange(db, acct.id, '2026-02-20', '2026-02-24');
assert.strictEqual(snapshots.length, 3, 'Should return all 3 snapshots in range');
// Items should be parsed back to arrays
assert.ok(Array.isArray(snapshots[0].items), 'Items should be parsed from JSON');
console.log('PASS: getSnapshotsForRange');

// Filtered by cadence
const dailyOnly = claudiaDb.getSnapshotsForRange(db, acct.id, '2026-02-20', '2026-02-24', 'daily');
assert.strictEqual(dailyOnly.length, 2, 'Should return only daily snapshots');
console.log('PASS: getSnapshotsForRange with cadence filter');

// --- Test: pruneOldSnapshots ---
// Add an old snapshot
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2025-01-01',
  cadence: 'daily',
  items: [{ id: 'ancient' }]
});
const beforePrune = claudiaDb.getSnapshotsForRange(db, acct.id, '2025-01-01', '2025-01-02');
assert.strictEqual(beforePrune.length, 1);

claudiaDb.pruneOldSnapshots(db, acct.id, 56); // 56 days = 8 weeks
const afterPrune = claudiaDb.getSnapshotsForRange(db, acct.id, '2025-01-01', '2025-01-02');
assert.strictEqual(afterPrune.length, 0, 'Old snapshot should be pruned');
console.log('PASS: pruneOldSnapshots');

// --- Test: account isolation for snapshots ---
claudiaDb.saveSnapshot(db, acctB.id, {
  snapshotDate: '2026-02-23',
  cadence: 'daily',
  items: [{ id: 'acctB-item' }]
});
const acctASnapshots = claudiaDb.getSnapshotsForRange(db, acct.id, '2026-02-23', '2026-02-24');
// Should only have acct A's snapshot from earlier, not acct B's
const acctAItems = acctASnapshots.flatMap(s => s.items);
assert.ok(!acctAItems.some(i => i.id === 'acctB-item'), 'Account A should not see account B snapshots');
console.log('PASS: snapshot account isolation');

console.log('\n--- Digest snapshot tests passed ---');

console.log('\n=== ALL CLAUDIA-DB TESTS PASSED ===');
