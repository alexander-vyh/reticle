'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');

// Cleanup on exit
process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = reticleDb.initDatabase();

// --- Test: Database initializes with all tables ---
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);
assert.deepStrictEqual(tables, [
  'accounts', 'action_log', 'conversations', 'digest_snapshots', 'email_rules',
  'emails', 'entity_links', 'feedback_candidates', 'feedback_settings',
  'meeting_summaries', 'meetings', 'monitored_people', 'notification_log',
  'o3_sessions', 'speaker_embeddings', 'transcription_corrections', 'unsubscribes'
]);
console.log('PASS: all 18 tables created');

// --- Test: upsertAccount + getAccount ---
const acct = reticleDb.upsertAccount(db, {
  email: 'alexanderv@example.com',
  provider: 'gmail',
  display_name: 'Alexander (Work)',
  is_primary: 1
});
assert.ok(acct.id);
assert.strictEqual(acct.email, 'alexanderv@example.com');

const fetched = reticleDb.getAccount(db, 'alexanderv@example.com');
assert.strictEqual(fetched.id, acct.id);
assert.strictEqual(fetched.is_primary, 1);
console.log('PASS: upsertAccount + getAccount');

// --- Test: getPrimaryAccount ---
const primary = reticleDb.getPrimaryAccount(db);
assert.strictEqual(primary.email, 'alexanderv@example.com');
console.log('PASS: getPrimaryAccount');

// --- Test: upsert is idempotent ---
const acct2 = reticleDb.upsertAccount(db, {
  email: 'alexanderv@example.com',
  display_name: 'Alexander V'
});
assert.strictEqual(acct2.id, acct.id);
assert.strictEqual(acct2.display_name, 'Alexander V');
console.log('PASS: upsert idempotent');

console.log('\n--- Task 1 accounts tests passed ---');

// --- Test: link + getLinked ---
reticleDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'conversation', targetId: 'conv-1',
  relationship: 'belongs_to'
});

const linked = reticleDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(linked.length, 1);
assert.strictEqual(linked[0].target_type, 'conversation');
assert.strictEqual(linked[0].target_id, 'conv-1');
console.log('PASS: link + getLinked (forward)');

// Reverse lookup
const reverse = reticleDb.getLinked(db, 'conversation', 'conv-1');
assert.strictEqual(reverse.length, 1);
assert.strictEqual(reverse[0].source_type, 'email');
console.log('PASS: getLinked (reverse)');

// Filtered lookup
reticleDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'todo', targetId: 'todo-1',
  relationship: 'triggered'
});
const filtered = reticleDb.getLinked(db, 'email', 'email-1', {
  targetType: 'todo'
});
assert.strictEqual(filtered.length, 1);
assert.strictEqual(filtered[0].relationship, 'triggered');
console.log('PASS: getLinked (filtered)');

// Duplicate link is idempotent (upsert)
reticleDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'conversation', targetId: 'conv-1',
  relationship: 'belongs_to'
});
const afterDup = reticleDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(afterDup.length, 2); // still 2, not 3
console.log('PASS: duplicate link is idempotent');

// Invalid entity type throws
assert.throws(() => {
  reticleDb.link(db, {
    sourceType: 'bogus', sourceId: 'x',
    targetType: 'email', targetId: 'y',
    relationship: 'belongs_to'
  });
}, /Unknown entity type/);
console.log('PASS: invalid entity type throws');

// unlink
reticleDb.unlink(db, 'email', 'email-1', 'todo', 'todo-1', 'triggered');
const afterUnlink = reticleDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(afterUnlink.length, 1);
console.log('PASS: unlink');

console.log('\n--- Task 1 entity_links tests passed ---');

// --- Test: logAction + getEntityHistory + getRecentActions ---
reticleDb.logAction(db, {
  accountId: acct.id, actor: 'system', entityType: 'email', entityId: 'email-1',
  action: 'received', context: { from: 'test@example.com' }
});
reticleDb.logAction(db, {
  accountId: acct.id, actor: 'rule:5', entityType: 'email', entityId: 'email-1',
  action: 'archived', context: { rule: 'zoom-filter' }, outcome: { labels_removed: ['INBOX'] }
});
reticleDb.logAction(db, {
  accountId: acct.id, actor: 'user', entityType: 'email', entityId: 'email-1',
  action: 'moved_to_inbox', context: { reason: 'user override' }
});

const history = reticleDb.getEntityHistory(db, 'email', 'email-1');
assert.strictEqual(history.length, 3);
assert.strictEqual(history[0].action, 'received');
assert.strictEqual(history[2].action, 'moved_to_inbox');
console.log('PASS: logAction + getEntityHistory');

const userActions = reticleDb.getRecentActions(db, { actor: 'user' });
assert.strictEqual(userActions.length, 1);
assert.strictEqual(userActions[0].action, 'moved_to_inbox');
console.log('PASS: getRecentActions filtered by actor');

const allActions = reticleDb.getRecentActions(db, { accountId: acct.id });
assert.strictEqual(allActions.length, 3);
console.log('PASS: getRecentActions filtered by account');

console.log('\n--- Task 1 action_log tests passed ---');

// --- Test: upsertEmail + getEmailByGmailId + getEmailsByThread ---
const email = reticleDb.upsertEmail(db, acct.id, {
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

const byGmail = reticleDb.getEmailByGmailId(db, acct.id, '19c748749068b21d');
assert.strictEqual(byGmail.id, email.id);
console.log('PASS: getEmailByGmailId');

// Second email in same thread
reticleDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b22e',
  thread_id: 'thread-abc',
  from_addr: 'alexanderv@example.com',
  to_addrs: ['noreply@okta.com'],
  subject: 'Re: Okta rate limit warning',
  date: Math.floor(Date.now() / 1000) + 60,
  direction: 'outbound'
});

const thread = reticleDb.getEmailsByThread(db, acct.id, 'thread-abc');
assert.strictEqual(thread.length, 2);
console.log('PASS: getEmailsByThread');

// Upsert same gmail_id updates existing
const updated = reticleDb.upsertEmail(db, acct.id, {
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
reticleDb.trackConversation(db, acct.id, {
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
reticleDb.updateConversationState(db, 'email:thread-1', 'me', 'their-response');
const updated2 = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.strictEqual(updated2.waiting_for, 'their-response');
console.log('PASS: updateConversationState');

// --- Test: getPendingResponses ---
// Flip back to my-response for this test
reticleDb.updateConversationState(db, 'email:thread-1', 'them', 'my-response');
const pending = reticleDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.strictEqual(pending.length, 1);
assert.strictEqual(pending[0].id, 'email:thread-1');
console.log('PASS: getPendingResponses');

// --- Test: resolveConversation ---
reticleDb.resolveConversation(db, 'email:thread-1');
const resolved = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.ok(resolved.resolved_at);
assert.strictEqual(resolved.state, 'resolved');
console.log('PASS: resolveConversation');

// --- Test: getAwaitingReplies ---
reticleDb.trackConversation(db, acct.id, {
  id: 'email:thread-2',
  type: 'email',
  subject: 'Pending question',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response'
});
const awaiting = reticleDb.getAwaitingReplies(db, acct.id, {});
assert.ok(awaiting.length >= 1);
console.log('PASS: getAwaitingReplies');

// --- Test: getResolvedToday ---
// Includes both explicitly resolved AND flipped-to-their-response today
const resolvedToday = reticleDb.getResolvedToday(db, acct.id, 'email');
assert.ok(resolvedToday.length >= 1);
console.log('PASS: getResolvedToday');

// --- Test: getStats ---
const stats = reticleDb.getStats(db, acct.id);
assert.ok(stats.total >= 1);
console.log('PASS: getStats');

console.log('\n--- Task 3 conversation tests passed ---');

// --- Test: recordUnsubscribe ---
const unsub = reticleDb.recordUnsubscribe(db, acct.id, {
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
const check = reticleDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check.unsubscribed, true);
assert.strictEqual(check.emails_since, 0);
console.log('PASS: checkUnsubscribed (positive)');

const checkNone = reticleDb.checkUnsubscribed(db, acct.id, 'unknown.com');
assert.strictEqual(checkNone.unsubscribed, false);
console.log('PASS: checkUnsubscribed (negative)');

// --- Test: incrementEmailsSince ---
reticleDb.incrementEmailsSince(db, acct.id, 'vanta.com');
reticleDb.incrementEmailsSince(db, acct.id, 'vanta.com');
const check2 = reticleDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check2.emails_since, 2);
console.log('PASS: incrementEmailsSince');

// --- Test: confirmUnsubscribe ---
reticleDb.confirmUnsubscribe(db, unsub.id);
const check3 = reticleDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check3.confirmed, true);
console.log('PASS: confirmUnsubscribe');

console.log('\n--- Task 4 unsubscribe tests passed ---');

// --- Test: createRule ---
const rule = reticleDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from: 'noreply@zoom.us',
  source_email: 'noreply@zoom.us',
  source_subject: 'Meeting reminder'
});
assert.ok(rule.id);
assert.strictEqual(rule.rule_type, 'archive');
console.log('PASS: createRule');

// --- Test: getActiveRules ---
const rules = reticleDb.getActiveRules(db, acct.id);
assert.ok(rules.length >= 1);
assert.strictEqual(rules[0].match_from, 'noreply@zoom.us');
console.log('PASS: getActiveRules');

// --- Test: recordRuleHit ---
reticleDb.recordRuleHit(db, rule.id);
reticleDb.recordRuleHit(db, rule.id);
const hitRule = reticleDb.getRuleById(db, rule.id);
assert.strictEqual(hitRule.hit_count, 2);
console.log('PASS: recordRuleHit');

// --- Test: deactivateRule ---
reticleDb.deactivateRule(db, rule.id);
const deactivated = reticleDb.getRuleById(db, rule.id);
assert.strictEqual(deactivated.active, 0);
const activeRules = reticleDb.getActiveRules(db, acct.id);
assert.strictEqual(activeRules.filter(r => r.match_from === 'noreply@zoom.us').length, 0);
console.log('PASS: deactivateRule');

// --- Test: getRulesSummary ---
// Re-create for summary test
reticleDb.createRule(db, acct.id, { rule_type: 'archive', match_from_domain: 'example.com' });
const summary = reticleDb.getRulesSummary(db, acct.id);
assert.ok(summary.total >= 1);
console.log('PASS: getRulesSummary');

// --- Test: no delete rules allowed ---
assert.throws(() => {
  reticleDb.createRule(db, acct.id, { rule_type: 'delete', match_from: 'spam@bad.com' });
}, /delete rules are not allowed/i);
console.log('PASS: delete rules blocked');

console.log('\n--- Task 5 email_rules tests passed ---');

// --- Test: upsertO3Session ---
const o3Start = Math.floor(Date.now() / 1000);
reticleDb.upsertO3Session(db, acct.id, {
  id: 'cal-event-1',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: o3Start,
  scheduled_end: o3Start + 1800,
  created_at: o3Start - 86400
});

const session = reticleDb.getO3Session(db, 'cal-event-1');
assert.strictEqual(session.report_name, 'Jane Smith');
assert.strictEqual(session.account_id, acct.id);
console.log('PASS: upsertO3Session + getO3Session');

// --- Test: markO3Notified ---
reticleDb.markO3Notified(db, 'cal-event-1', 'prep_sent_afternoon');
const notified = reticleDb.getO3Session(db, 'cal-event-1');
assert.strictEqual(notified.prep_sent_afternoon, 1);
console.log('PASS: markO3Notified');

// --- Test: getLastO3ForReport ---
const last = reticleDb.getLastO3ForReport(db, 'jane@example.com', o3Start + 1);
assert.strictEqual(last.id, 'cal-event-1');
console.log('PASS: getLastO3ForReport');

// --- Test: logNotification + markNotified (uses conv from Task 3) ---
reticleDb.trackConversation(db, acct.id, {
  id: 'email:notif-test',
  type: 'email',
  subject: 'Notification test',
  from_user: 'test@example.com',
  from_name: 'Test',
  last_sender: 'them',
  waiting_for: 'my-response'
});
reticleDb.logNotification(db, acct.id, 'email:notif-test', 'immediate');
const notifCount = db.prepare('SELECT COUNT(*) as c FROM notification_log WHERE conversation_id = ?')
  .get('email:notif-test').c;
assert.strictEqual(notifCount, 1);
console.log('PASS: logNotification');

reticleDb.markNotified(db, 'email:notif-test');
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
assert.deepStrictEqual(reticleDb.ALLOWED_RULE_TYPES, ['archive', 'alert', 'demote', 'flag']);
console.log('PASS: ALLOWED_RULE_TYPES constant');

// RELATIONSHIPS constant
assert.ok(reticleDb.RELATIONSHIPS.belongs_to);
assert.ok(reticleDb.RELATIONSHIPS.triggered);
assert.ok(reticleDb.RELATIONSHIPS.replied_to);
assert.ok(reticleDb.RELATIONSHIPS.follow_up_for);
assert.ok(reticleDb.RELATIONSHIPS.unsubscribed_from);
assert.ok(reticleDb.RELATIONSHIPS.mentioned_in);
// Knowledge graph relationships
assert.ok(reticleDb.RELATIONSHIPS.assigned_to);
assert.ok(reticleDb.RELATIONSHIPS.decided_by);
assert.ok(reticleDb.RELATIONSHIPS.raised_by);
assert.ok(reticleDb.RELATIONSHIPS.contributed_by);
assert.ok(reticleDb.RELATIONSHIPS.spawned_by);
assert.ok(reticleDb.RELATIONSHIPS.member_of);
assert.ok(reticleDb.RELATIONSHIPS.part_of);
assert.ok(reticleDb.RELATIONSHIPS.relates_to);
assert.ok(reticleDb.RELATIONSHIPS.blocks);
console.log('PASS: RELATIONSHIPS constant');

// ENTITY_TYPES constant
assert.ok(reticleDb.ENTITY_TYPES.email);
assert.ok(reticleDb.ENTITY_TYPES.conversation);
assert.ok(reticleDb.ENTITY_TYPES.o3_session);
// Knowledge graph entity types
assert.ok(reticleDb.ENTITY_TYPES.initiative);
assert.ok(reticleDb.ENTITY_TYPES.decision);
assert.ok(reticleDb.ENTITY_TYPES.action_item);
assert.ok(reticleDb.ENTITY_TYPES.risk);
assert.ok(reticleDb.ENTITY_TYPES.contribution);
assert.ok(reticleDb.ENTITY_TYPES.person);
assert.ok(reticleDb.ENTITY_TYPES.team);
assert.ok(reticleDb.ENTITY_TYPES.vendor);
console.log('PASS: ENTITY_TYPES constant');

// Relationship validation in link()
assert.throws(() => {
  reticleDb.link(db, {
    sourceType: 'person',
    sourceId: crypto.randomUUID(),
    targetType: 'team',
    targetId: crypto.randomUUID(),
    relationship: 'banana'
  });
}, /Unknown relationship/);
// Valid knowledge graph link should work
reticleDb.link(db, {
  sourceType: 'person',
  sourceId: crypto.randomUUID(),
  targetType: 'team',
  targetId: crypto.randomUUID(),
  relationship: 'member_of'
});
console.log('PASS: relationship validation in link()');

console.log('\n--- Constants tests passed ---');

// --- Test: getO3SessionsForReport ---
// Add a second O3 session for the same report
const o3Start2 = o3Start + 86400; // 1 day later
reticleDb.upsertO3Session(db, acct.id, {
  id: 'cal-event-2',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: o3Start2,
  scheduled_end: o3Start2 + 1800,
  created_at: o3Start2 - 3600
});

const sessions = reticleDb.getO3SessionsForReport(db, 'jane@example.com');
assert.strictEqual(sessions.length, 2);
// Should be DESC order -- newest first
assert.strictEqual(sessions[0].id, 'cal-event-2');
assert.strictEqual(sessions[1].id, 'cal-event-1');
console.log('PASS: getO3SessionsForReport (multiple, DESC order)');

// --- Test: getWeeklyO3Summary ---
// Both sessions fall within a week-sized window
const weekStart = o3Start - 3600;
const weekEnd = o3Start2 + 86400;
const weekly = reticleDb.getWeeklyO3Summary(db, weekStart, weekEnd);
assert.strictEqual(weekly.length, 2);
// Should be ASC order -- earliest first
assert.strictEqual(weekly[0].id, 'cal-event-1');
assert.strictEqual(weekly[1].id, 'cal-event-2');
console.log('PASS: getWeeklyO3Summary (ASC order, range boundaries)');

// Boundary: query range that excludes both sessions
const emptyWeek = reticleDb.getWeeklyO3Summary(db, o3Start2 + 86400, o3Start2 + 172800);
assert.strictEqual(emptyWeek.length, 0);
console.log('PASS: getWeeklyO3Summary (empty range)');

// --- Test: markO3LatticeLogged ---
reticleDb.markO3LatticeLogged(db, 'cal-event-2');
const logged = reticleDb.getO3Session(db, 'cal-event-2');
assert.strictEqual(logged.lattice_logged, 1);
console.log('PASS: markO3LatticeLogged');

// --- Test: markO3Notified with all valid fields ---
reticleDb.markO3Notified(db, 'cal-event-2', 'prep_sent_before');
const notified2 = reticleDb.getO3Session(db, 'cal-event-2');
assert.strictEqual(notified2.prep_sent_before, 1);
console.log('PASS: markO3Notified (prep_sent_before)');

reticleDb.markO3Notified(db, 'cal-event-2', 'post_nudge_sent');
const notified3 = reticleDb.getO3Session(db, 'cal-event-2');
assert.strictEqual(notified3.post_nudge_sent, 1);
console.log('PASS: markO3Notified (post_nudge_sent)');

// --- Test: markO3Notified with invalid field throws ---
assert.throws(() => {
  reticleDb.markO3Notified(db, 'cal-event-2', 'evil_field; DROP TABLE o3_sessions;--');
}, /Invalid O3 notification field/);
console.log('PASS: markO3Notified rejects invalid field');

console.log('\n--- Previously untested functions passed ---');

// --- Test: Multi-Account Isolation ---
const acctB = reticleDb.upsertAccount(db, {
  email: 'personal@example.com',
  provider: 'gmail',
  display_name: 'Personal',
  is_primary: 0
});
assert.notStrictEqual(acctB.id, acct.id);

// Create data scoped to account B
reticleDb.trackConversation(db, acctB.id, {
  id: 'personal:conv-1',
  type: 'email',
  subject: 'Personal Thread',
  from_user: 'friend@example.com',
  from_name: 'Friend',
  last_sender: 'them',
  waiting_for: 'my-response'
});

reticleDb.upsertEmail(db, acctB.id, {
  gmail_id: 'personal-gmail-001',
  thread_id: 'personal-thread-1',
  from_addr: 'friend@example.com',
  subject: 'Personal email',
  date: Math.floor(Date.now() / 1000),
  direction: 'inbound'
});

reticleDb.recordUnsubscribe(db, acctB.id, {
  sender_domain: 'spam-personal.com',
  method: 'list-unsubscribe-post'
});

reticleDb.createRule(db, acctB.id, {
  rule_type: 'archive',
  match_from: 'noise@personal.com'
});

// Verify account A queries do NOT return account B data
const pendingA = reticleDb.getPendingResponses(db, acct.id);
assert.ok(!pendingA.some(c => c.id === 'personal:conv-1'), 'Account A pending should not contain account B conversation');

const emailsA = reticleDb.getEmailsByThread(db, acct.id, 'personal-thread-1');
assert.strictEqual(emailsA.length, 0, 'Account A should not see account B emails');

const unsubA = reticleDb.checkUnsubscribed(db, acct.id, 'spam-personal.com');
assert.strictEqual(unsubA.unsubscribed, false, 'Account A should not see account B unsubscribes');

const rulesA = reticleDb.getActiveRules(db, acct.id);
assert.ok(!rulesA.some(r => r.match_from === 'noise@personal.com'), 'Account A should not see account B rules');

// Verify account B queries return ONLY account B data
const pendingB = reticleDb.getPendingResponses(db, acctB.id);
assert.strictEqual(pendingB.length, 1);
assert.strictEqual(pendingB[0].id, 'personal:conv-1');

const emailByGmailB = reticleDb.getEmailByGmailId(db, acctB.id, 'personal-gmail-001');
assert.ok(emailByGmailB);

const emailByGmailA = reticleDb.getEmailByGmailId(db, acct.id, 'personal-gmail-001');
assert.strictEqual(emailByGmailA, undefined, 'Account A should not see account B gmail_id');

console.log('PASS: multi-account isolation (conversations, emails, unsubscribes, rules)');

console.log('\n--- Multi-account isolation tests passed ---');

// --- Test: trackConversation upsert (same ID, updated fields) ---
const origConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('personal:conv-1');
const origFirstSeen = origConv.first_seen;

// Upsert with same ID but different subject and waiting_for
reticleDb.trackConversation(db, acctB.id, {
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

// --- Test: trackConversation upsert backfills from_name and channel_name ---
// First insert with null names (simulates the bug where Slack IDs are stored without resolution)
reticleDb.trackConversation(db, acct.id, {
  id: 'name-backfill-test',
  type: 'slack-mention',
  subject: 'Test mention',
  from_user: 'U12345',
  from_name: null,
  channel_id: 'C99999',
  channel_name: null,
  waiting_for: 'my-response',
  last_activity: Math.floor(Date.now() / 1000)
});
const beforeBackfill = db.prepare('SELECT * FROM conversations WHERE id = ?').get('name-backfill-test');
assert.strictEqual(beforeBackfill.from_name, null, 'from_name should be null initially');
assert.strictEqual(beforeBackfill.channel_name, null, 'channel_name should be null initially');

// Upsert with resolved names — should backfill
reticleDb.trackConversation(db, acct.id, {
  id: 'name-backfill-test',
  type: 'slack-mention',
  subject: 'Test mention',
  from_user: 'U12345',
  from_name: 'Jane Smith',
  channel_id: 'C99999',
  channel_name: 'engineering',
  waiting_for: 'my-response',
  last_activity: Math.floor(Date.now() / 1000) + 10
});
const afterBackfill = db.prepare('SELECT * FROM conversations WHERE id = ?').get('name-backfill-test');
assert.strictEqual(afterBackfill.from_name, 'Jane Smith', 'from_name should be backfilled on upsert');
assert.strictEqual(afterBackfill.channel_name, 'engineering', 'channel_name should be backfilled on upsert');
console.log('PASS: trackConversation upsert backfills from_name and channel_name');

// Verify COALESCE: upsert with null should NOT overwrite existing names
reticleDb.trackConversation(db, acct.id, {
  id: 'name-backfill-test',
  type: 'slack-mention',
  subject: 'Test mention',
  from_user: 'U12345',
  from_name: null,
  channel_id: 'C99999',
  channel_name: null,
  waiting_for: 'my-response',
  last_activity: Math.floor(Date.now() / 1000) + 20
});
const afterNullUpsert = db.prepare('SELECT * FROM conversations WHERE id = ?').get('name-backfill-test');
assert.strictEqual(afterNullUpsert.from_name, 'Jane Smith', 'from_name should NOT be overwritten by null');
assert.strictEqual(afterNullUpsert.channel_name, 'engineering', 'channel_name should NOT be overwritten by null');
console.log('PASS: trackConversation upsert preserves existing names when new values are null');

console.log('\n--- Conversation upsert tests passed ---');

// --- Test: olderThan filter for getPendingResponses ---
const now2 = Math.floor(Date.now() / 1000);

// Create conversations with controlled timestamps
reticleDb.trackConversation(db, acct.id, {
  id: 'age-test:recent',
  type: 'slack-dm',
  from_user: 'recent@example.com',
  from_name: 'Recent',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now2 - 1800 // 30 minutes ago
});

reticleDb.trackConversation(db, acct.id, {
  id: 'age-test:old',
  type: 'slack-dm',
  from_user: 'old@example.com',
  from_name: 'Old',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now2 - (5 * 3600) // 5 hours ago
});

reticleDb.trackConversation(db, acct.id, {
  id: 'age-test:very-old',
  type: 'slack-dm',
  from_user: 'veryold@example.com',
  from_name: 'Very Old',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now2 - (25 * 3600) // 25 hours ago
});

// olderThan = 4 hours (14400 seconds): should return 5h and 25h, NOT 30m
const older4h = reticleDb.getPendingResponses(db, acct.id, {
  type: 'slack-dm',
  olderThan: 4 * 3600
});
const older4hIds = older4h.map(c => c.id);
assert.ok(!older4hIds.includes('age-test:recent'), 'Recent (30m) should NOT appear in olderThan 4h');
assert.ok(older4hIds.includes('age-test:old'), 'Old (5h) should appear in olderThan 4h');
assert.ok(older4hIds.includes('age-test:very-old'), 'Very old (25h) should appear in olderThan 4h');
console.log('PASS: getPendingResponses olderThan filter works correctly');

// olderThan = 24 hours: should return only the 25h one
const older24h = reticleDb.getPendingResponses(db, acct.id, {
  type: 'slack-dm',
  olderThan: 24 * 3600
});
const older24hIds = older24h.map(c => c.id);
assert.ok(!older24hIds.includes('age-test:recent'), '30m should NOT appear in olderThan 24h');
assert.ok(!older24hIds.includes('age-test:old'), '5h should NOT appear in olderThan 24h');
assert.ok(older24hIds.includes('age-test:very-old'), '25h should appear in olderThan 24h');
console.log('PASS: getPendingResponses olderThan 24h filter');

// --- Test: olderThan for getAwaitingReplies ---
reticleDb.trackConversation(db, acct.id, {
  id: 'await-test:recent',
  type: 'email',
  subject: 'Recent sent',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: now2 - 1800 // 30 minutes ago
});

reticleDb.trackConversation(db, acct.id, {
  id: 'await-test:old',
  type: 'email',
  subject: 'Old sent',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: now2 - (25 * 3600) // 25 hours ago
});

const awaitOld = reticleDb.getAwaitingReplies(db, acct.id, {
  type: 'email',
  olderThan: 24 * 3600
});
const awaitOldIds = awaitOld.map(c => c.id);
assert.ok(!awaitOldIds.includes('await-test:recent'), 'Recent awaiting should NOT appear in olderThan 24h');
assert.ok(awaitOldIds.includes('await-test:old'), 'Old awaiting should appear in olderThan 24h');
console.log('PASS: getAwaitingReplies olderThan filter works correctly');

// --- Test: limit parameter ---
const limitResults = reticleDb.getPendingResponses(db, acct.id, {
  type: 'slack-dm',
  limit: 1
});
assert.strictEqual(limitResults.length, 1, 'limit should cap results');
console.log('PASS: getPendingResponses limit parameter');

console.log('\n--- Time-based filter tests passed ---');

// --- Test: notified_at read-back in getPendingResponses ---
reticleDb.markNotified(db, 'age-test:old');
const pendingWithNotified = reticleDb.getPendingResponses(db, acct.id, { type: 'slack-dm' });
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
reticleDb.trackConversation(db, acct.id, {
  id: 'resolve-idem-test',
  type: 'email',
  from_user: 'test@example.com',
  from_name: 'Test',
  last_sender: 'them',
  waiting_for: 'my-response'
});
reticleDb.resolveConversation(db, 'resolve-idem-test');
const firstResolve = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
const firstResolvedAt = firstResolve.resolved_at;
assert.ok(firstResolvedAt);

// Second resolve should be a no-op (WHERE resolved_at IS NULL prevents it)
reticleDb.resolveConversation(db, 'resolve-idem-test');
const secondResolve = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
assert.strictEqual(secondResolve.resolved_at, firstResolvedAt, 'Double resolve must not change resolved_at');
console.log('PASS: resolveConversation is idempotent');

// --- Test: updateConversationState on resolved conversation (guard) ---
const beforeGuardUpdate = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
reticleDb.updateConversationState(db, 'resolve-idem-test', 'them', 'their-response');
const afterUpdate = db.prepare('SELECT * FROM conversations WHERE id = ?').get('resolve-idem-test');
assert.strictEqual(afterUpdate.state, 'resolved', 'State must remain resolved');
assert.strictEqual(afterUpdate.waiting_for, beforeGuardUpdate.waiting_for, 'waiting_for must not change on resolved conv');
assert.strictEqual(afterUpdate.last_activity, beforeGuardUpdate.last_activity, 'last_activity must not change on resolved conv');
console.log('PASS: updateConversationState is no-op on resolved conversation');

console.log('\n--- Guard clause tests passed ---');

// --- Test: createRule with all match patterns + case normalization ---
const domainRule = reticleDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from_domain: 'ZOOM.US'
});
assert.strictEqual(domainRule.match_from_domain, 'zoom.us', 'Domain should be lowercased');
console.log('PASS: createRule lowercases match_from_domain');

const subjectRule = reticleDb.createRule(db, acct.id, {
  rule_type: 'alert',
  match_subject_contains: 'URGENT: Server Down'
});
assert.strictEqual(subjectRule.match_subject_contains, 'urgent: server down', 'Subject match should be lowercased');
console.log('PASS: createRule lowercases match_subject_contains');

const toRule = reticleDb.createRule(db, acct.id, {
  rule_type: 'flag',
  match_to: 'DL-Engineering@EXAMPLE.COM'
});
assert.strictEqual(toRule.match_to, 'dl-engineering@example.com', 'match_to should be lowercased');
console.log('PASS: createRule lowercases match_to');

// Combined multi-condition rule
const comboRule = reticleDb.createRule(db, acct.id, {
  rule_type: 'demote',
  match_from_domain: 'notifications.github.com',
  match_subject_contains: 'dependabot'
});
assert.strictEqual(comboRule.match_from_domain, 'notifications.github.com');
assert.strictEqual(comboRule.match_subject_contains, 'dependabot');
assert.strictEqual(comboRule.rule_type, 'demote');
console.log('PASS: createRule with combined match conditions');

// --- Test: Rule reactivation after deactivation ---
const ruleToDeactivate = reticleDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from: 'reactivate-test@example.com'
});
const originalRuleId = ruleToDeactivate.id;
reticleDb.deactivateRule(db, originalRuleId);

// Verify it's deactivated
const deactivatedCheck = reticleDb.getRuleById(db, originalRuleId);
assert.strictEqual(deactivatedCheck.active, 0);

// Re-create the exact same rule -- should reactivate, not create a new row
const reactivated = reticleDb.createRule(db, acct.id, {
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
reticleDb.trackConversation(db, acct.id, {
  id: 'lifecycle-test',
  type: 'email',
  subject: 'Lifecycle Test Email',
  from_user: 'lifecycle@example.com',
  from_name: 'Lifecycle',
  last_sender: 'them',
  waiting_for: 'my-response'
});

// Should appear in pending
const lifecyclePending = reticleDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.ok(lifecyclePending.some(c => c.id === 'lifecycle-test'), 'New conv should appear in pending');

// Resolve it
reticleDb.resolveConversation(db, 'lifecycle-test');

// Should NOT appear in pending anymore
const lifecyclePending2 = reticleDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.ok(!lifecyclePending2.some(c => c.id === 'lifecycle-test'), 'Resolved conv must not appear in pending');

// Should appear in resolved today
const lifecycleResolved = reticleDb.getResolvedToday(db, acct.id, 'email');
assert.ok(lifecycleResolved.some(c => c.id === 'lifecycle-test'), 'Resolved conv should appear in getResolvedToday');

console.log('PASS: full conversation lifecycle (pending → resolve → not pending → resolvedToday)');

console.log('\n--- Lifecycle tests passed ---');

// --- Test: getStats accuracy ---
// Use account B which has a known, controlled state: 1 conversation (personal:conv-1)
// that we upserted to 'their-response' earlier
const statsB = reticleDb.getStats(db, acctB.id);
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
reticleDb.updateConversationState(db, 'age-test:recent', 'me', 'their-response');
const afterState = db.prepare('SELECT last_activity FROM conversations WHERE id = ?').get('age-test:recent');
assert.ok(afterState.last_activity >= beforeActivity, 'last_activity should be updated (>= before value)');
assert.ok(afterState.last_activity >= now2, 'last_activity should be current time, not the original 30min-ago value');
console.log('PASS: updateConversationState updates last_activity');

console.log('\n--- Behavioral contract tests passed ---');

// --- Test: Action log JSON round-trip ---
reticleDb.logAction(db, {
  accountId: acct.id, actor: 'test', entityType: 'email', entityId: 'roundtrip-test',
  action: 'tested',
  context: { nested: { key: 'value' }, arr: [1, 2, 3] },
  outcome: { success: true, count: 42 }
});
const roundTrip = reticleDb.getEntityHistory(db, 'email', 'roundtrip-test');
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
reticleDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-23',
  cadence: 'daily',
  items: testItems
});
console.log('PASS: saveSnapshot');

// --- Test: getSnapshotsForRange ---
reticleDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-22',
  cadence: 'daily',
  items: [{ id: 'test-3', collector: 'followup', observation: 'yesterday' }]
});
reticleDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-21',
  cadence: 'weekly',
  items: [{ id: 'test-4' }]
});

const snapshots = reticleDb.getSnapshotsForRange(db, acct.id, '2026-02-20', '2026-02-24');
assert.strictEqual(snapshots.length, 3, 'Should return all 3 snapshots in range');
// Items should be parsed back to arrays
assert.ok(Array.isArray(snapshots[0].items), 'Items should be parsed from JSON');
console.log('PASS: getSnapshotsForRange');

// Filtered by cadence
const dailyOnly = reticleDb.getSnapshotsForRange(db, acct.id, '2026-02-20', '2026-02-24', 'daily');
assert.strictEqual(dailyOnly.length, 2, 'Should return only daily snapshots');
console.log('PASS: getSnapshotsForRange with cadence filter');

// --- Test: pruneOldSnapshots ---
// Add an old snapshot
reticleDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2025-01-01',
  cadence: 'daily',
  items: [{ id: 'ancient' }]
});
const beforePrune = reticleDb.getSnapshotsForRange(db, acct.id, '2025-01-01', '2025-01-02');
assert.strictEqual(beforePrune.length, 1);

reticleDb.pruneOldSnapshots(db, acct.id, 56); // 56 days = 8 weeks
const afterPrune = reticleDb.getSnapshotsForRange(db, acct.id, '2025-01-01', '2025-01-02');
assert.strictEqual(afterPrune.length, 0, 'Old snapshot should be pruned');
console.log('PASS: pruneOldSnapshots');

// --- Test: account isolation for snapshots ---
reticleDb.saveSnapshot(db, acctB.id, {
  snapshotDate: '2026-02-23',
  cadence: 'daily',
  items: [{ id: 'acctB-item' }]
});
const acctASnapshots = reticleDb.getSnapshotsForRange(db, acct.id, '2026-02-23', '2026-02-24');
// Should only have acct A's snapshot from earlier, not acct B's
const acctAItems = acctASnapshots.flatMap(s => s.items);
assert.ok(!acctAItems.some(i => i.id === 'acctB-item'), 'Account A should not see account B snapshots');
console.log('PASS: snapshot account isolation');

console.log('\n--- Digest snapshot tests passed ---');

// --- Test: meeting tables exist ---
const meetingTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meetings', 'meeting_summaries', 'speaker_embeddings', 'transcription_corrections') ORDER BY name"
).all().map(r => r.name);
assert.deepStrictEqual(meetingTables, [
  'meeting_summaries', 'meetings', 'speaker_embeddings', 'transcription_corrections'
]);
console.log('PASS: meeting tables created');

// --- Test: createMeeting + getMeeting ---
// Use local noon to avoid date-boundary flakes near midnight
const meetingNoon = new Date();
meetingNoon.setHours(12, 0, 0, 0);
const nowMeeting = Math.floor(meetingNoon.getTime() / 1000);
const meeting = reticleDb.createMeeting(db, {
  id: 'test-meeting-001',
  title: 'Weekly Standup',
  startTime: nowMeeting - 1800,
  endTime: nowMeeting,
  durationSec: 1800,
  attendeeEmails: ['alex@co.com', 'mark@co.com'],
  captureMode: 'tap',
  transcriptPath: '/tmp/transcript.json',
  wavPath: '/tmp/meeting.wav'
});
assert.strictEqual(meeting.id, 'test-meeting-001');
assert.strictEqual(meeting.title, 'Weekly Standup');
assert.strictEqual(meeting.review_status, 'new');
console.log('PASS: createMeeting');

const fetchedMeeting = reticleDb.getMeeting(db, 'test-meeting-001');
assert.strictEqual(fetchedMeeting.title, 'Weekly Standup');
assert.deepStrictEqual(JSON.parse(fetchedMeeting.attendee_emails), ['alex@co.com', 'mark@co.com']);
console.log('PASS: getMeeting');

// --- Test: listMeetings ---
const meetings = reticleDb.listMeetings(db);
assert.ok(meetings.length >= 1);
console.log('PASS: listMeetings');

// --- Test: getTodaysMeetings ---
// Create a meeting guaranteed to be "today" regardless of time-of-day by using local noon
const todayNoon = new Date();
todayNoon.setHours(12, 0, 0, 0);
const noonEpoch = Math.floor(todayNoon.getTime() / 1000);
reticleDb.createMeeting(db, {
  id: 'test-meeting-today',
  title: 'Today Check',
  startTime: noonEpoch,
  endTime: noonEpoch + 1800,
  durationSec: 1800,
  attendeeEmails: ['test@co.com'],
  captureMode: 'tap',
  transcriptPath: '/tmp/today.json',
  wavPath: '/tmp/today.wav'
});
const todayMeetings = reticleDb.getTodaysMeetings(db);
assert.ok(todayMeetings.some(m => m.id === 'test-meeting-today'), 'meeting at local noon should appear in today list');
console.log('PASS: getTodaysMeetings');

// --- Test: saveMeetingSummary + getMeetingSummary ---
reticleDb.saveMeetingSummary(db, {
  meetingId: 'test-meeting-001',
  summary: 'Discussed Q3 goals',
  topics: ['goals', 'hiring'],
  actionItems: [{ owner: 'Mark', item: 'Draft job posting' }],
  decisions: ['Hire 2 engineers'],
  openQuestions: ['Budget approval?'],
  keyPeople: [{ mentioned: 'Mark', context: 'hiring lead' }],
  flaggedItems: [{ type: 'unresolved_speaker', label: 'SPEAKER_02', segmentCount: 4 }],
  modelUsed: 'haiku',
  inputTokens: 2000,
  outputTokens: 500
});
const meetingSummary = reticleDb.getMeetingSummary(db, 'test-meeting-001');
assert.strictEqual(meetingSummary.summary, 'Discussed Q3 goals');
assert.deepStrictEqual(JSON.parse(meetingSummary.topics), ['goals', 'hiring']);
assert.deepStrictEqual(JSON.parse(meetingSummary.flagged_items), [{ type: 'unresolved_speaker', label: 'SPEAKER_02', segmentCount: 4 }]);
console.log('PASS: saveMeetingSummary + getMeetingSummary');

// --- Test: updateMeetingReviewStatus ---
reticleDb.updateMeetingReviewStatus(db, 'test-meeting-001', 'reviewed');
const updatedMeeting = reticleDb.getMeeting(db, 'test-meeting-001');
assert.strictEqual(updatedMeeting.review_status, 'reviewed');
console.log('PASS: updateMeetingReviewStatus');

// --- Test: createMeeting upsert updates title and attendeeEmails ---
const upsertedMeeting = reticleDb.createMeeting(db, {
  id: 'test-meeting-001',
  title: 'Weekly Standup (Renamed)',
  startTime: nowMeeting - 1800,
  attendeeEmails: ['alex@co.com', 'mark@co.com', 'jane@co.com'],
});
assert.strictEqual(upsertedMeeting.title, 'Weekly Standup (Renamed)', 'Title should be updated on upsert');
assert.deepStrictEqual(JSON.parse(upsertedMeeting.attendee_emails), ['alex@co.com', 'mark@co.com', 'jane@co.com'], 'attendee_emails should be updated on upsert');
// Original fields should be preserved
assert.strictEqual(upsertedMeeting.transcript_path, '/tmp/transcript.json', 'transcript_path should be preserved');
assert.strictEqual(upsertedMeeting.capture_mode, 'tap', 'capture_mode should be preserved');
console.log('PASS: createMeeting upsert updates title + attendeeEmails, preserves other fields');

// --- Test: saveMeetingSummary twice, getMeetingSummary returns latest ---
reticleDb.saveMeetingSummary(db, {
  meetingId: 'test-meeting-001',
  summary: 'Second summary — revised after corrections',
  topics: ['goals', 'hiring', 'budget'],
  actionItems: [],
  decisions: [],
  openQuestions: [],
  keyPeople: [],
  flaggedItems: [],
  modelUsed: 'sonnet',
  inputTokens: 3000,
  outputTokens: 800
});
const latestSummary = reticleDb.getMeetingSummary(db, 'test-meeting-001');
assert.strictEqual(latestSummary.summary, 'Second summary — revised after corrections', 'getMeetingSummary should return the latest summary');
assert.strictEqual(latestSummary.model_used, 'sonnet', 'Latest summary should have the newer model');
// Verify there are actually 2 summaries in the table
const summaryCount = db.prepare('SELECT COUNT(*) as c FROM meeting_summaries WHERE meeting_id = ?').get('test-meeting-001').c;
assert.strictEqual(summaryCount, 2, 'Both summaries should exist in the table');
console.log('PASS: saveMeetingSummary twice, getMeetingSummary returns latest');

// --- Test: listMeetings and getTodaysMeetings no duplicate rows with multiple summaries ---
const listedMeetings = reticleDb.listMeetings(db);
const testMeetingRows = listedMeetings.filter(m => m.id === 'test-meeting-001');
assert.strictEqual(testMeetingRows.length, 1, 'listMeetings must not duplicate rows when multiple summaries exist');
assert.strictEqual(testMeetingRows[0].summary, 'Second summary — revised after corrections', 'listMeetings should return the latest summary');
console.log('PASS: listMeetings returns 1 row per meeting even with multiple summaries');

const todayMeetings2 = reticleDb.getTodaysMeetings(db);
const todayTestRows = todayMeetings2.filter(m => m.id === 'test-meeting-001');
assert.strictEqual(todayTestRows.length, 1, 'getTodaysMeetings must not duplicate rows when multiple summaries exist');
assert.strictEqual(todayTestRows[0].summary, 'Second summary — revised after corrections', 'getTodaysMeetings should return the latest summary');
console.log('PASS: getTodaysMeetings returns 1 row per meeting even with multiple summaries');

console.log('\n--- Meeting tables + CRUD tests passed ---');

// --- Speaker embeddings ---
const embeddingBuffer = Buffer.alloc(192 * 4); // 192 floats × 4 bytes
reticleDb.saveSpeakerEmbedding(db, {
  personId: 'person-001',
  embedding: embeddingBuffer,
  sourceMeetingId: 'test-meeting-001',
  modelVersion: 'ecapa-tdnn-v1',
  qualityScore: 0.85
});
const embeddings = reticleDb.getSpeakerEmbeddings(db, 'person-001');
assert.strictEqual(embeddings.length, 1);
assert.strictEqual(embeddings[0].model_version, 'ecapa-tdnn-v1');
assert.ok(Buffer.isBuffer(embeddings[0].embedding));
console.log('PASS: saveSpeakerEmbedding + getSpeakerEmbeddings');

const allEmb = reticleDb.getAllActiveEmbeddings(db);
assert.ok(Array.isArray(allEmb));
console.log('PASS: getAllActiveEmbeddings');

// Upsert: same person+meeting — should update, not duplicate
reticleDb.saveSpeakerEmbedding(db, {
  personId: 'person-001',
  embedding: embeddingBuffer,
  sourceMeetingId: 'test-meeting-001',
  modelVersion: 'ecapa-tdnn-v2',
  qualityScore: 0.91
});
const afterUpsert = reticleDb.getSpeakerEmbeddings(db, 'person-001');
assert.strictEqual(afterUpsert.length, 1, 'upsert should not duplicate');
assert.strictEqual(afterUpsert[0].model_version, 'ecapa-tdnn-v2');
console.log('PASS: saveSpeakerEmbedding upserts on same person+meeting');

// --- Transcription corrections ---
reticleDb.saveCorrection(db, {
  heard: 'Kaczalka',
  correct: 'Kaczorek',
  personId: 'person-001',
  sourceMeetingId: 'test-meeting-001'
});
const corrections = reticleDb.getCorrections(db);
assert.strictEqual(corrections.length, 1);
assert.strictEqual(corrections[0].heard, 'Kaczalka');
assert.strictEqual(corrections[0].correct, 'Kaczorek');
console.log('PASS: saveCorrection + getCorrections');

reticleDb.incrementCorrectionUsage(db, corrections[0].id);
const updated3 = reticleDb.getCorrections(db);
assert.strictEqual(updated3[0].usage_count, 2);
console.log('PASS: incrementCorrectionUsage');

console.log('\n--- Speaker embedding + correction tests passed ---');

console.log('\n=== ALL RETICLE-DB TESTS PASSED ===');
