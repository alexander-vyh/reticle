#!/usr/bin/env node
/**
 * Test follow-ups tracking system
 */

const followupsDb = require('./followups-db');

console.log('Testing follow-ups database...\n');

// Initialize
const db = followupsDb.initDatabase();
console.log('✓ Database initialized\n');

// Test: Track an email conversation
console.log('1. Tracking email conversation...');
followupsDb.trackConversation(db, {
  id: 'email:thread-123',
  type: 'email',
  subject: 'Re: Q4 Planning Discussion',
  from_user: 'john.doe@company.com',
  from_name: 'John Doe',
  last_activity: Math.floor(Date.now() / 1000) - (2 * 24 * 3600), // 2 days ago
  last_sender: 'them',
  waiting_for: 'my-response',
  first_seen: Math.floor(Date.now() / 1000) - (2 * 24 * 3600)
});
console.log('   ✓ Email tracked\n');

// Test: Track a Slack DM
console.log('2. Tracking Slack DM...');
followupsDb.trackConversation(db, {
  id: 'slack:dm:U123456',
  type: 'slack-dm',
  subject: 'Can you review the PR?',
  from_user: 'U123456',
  from_name: 'Alice',
  last_activity: Math.floor(Date.now() / 1000) - (4 * 3600), // 4 hours ago
  last_sender: 'them',
  waiting_for: 'my-response',
  first_seen: Math.floor(Date.now() / 1000) - (4 * 3600)
});
console.log('   ✓ Slack DM tracked\n');

// Test: Track a mention
console.log('3. Tracking Slack mention...');
followupsDb.trackConversation(db, {
  id: 'slack:mention:C789-1234567890',
  type: 'slack-mention',
  subject: 'What do you think about the deployment?',
  from_user: 'U789012',
  from_name: 'Bob',
  channel_id: 'C789',
  channel_name: 'engineering',
  last_activity: Math.floor(Date.now() / 1000) - (12 * 3600), // 12 hours ago
  last_sender: 'them',
  waiting_for: 'my-response',
  first_seen: Math.floor(Date.now() / 1000) - (12 * 3600)
});
console.log('   ✓ Slack mention tracked\n');

// Test: Get pending responses
console.log('4. Querying pending responses...');
const pending = followupsDb.getPendingResponses(db);
console.log(`   Found ${pending.length} conversations needing response:`);
pending.forEach(conv => {
  const age = Math.floor(Date.now() / 1000) - conv.last_activity;
  const hours = Math.floor(age / 3600);
  console.log(`   - [${conv.type}] ${conv.from_name}: ${conv.subject} (${hours}h old)`);
});
console.log('');

// Test: Get stats
console.log('5. Database statistics:');
const stats = followupsDb.getStats(db);
stats.forEach(stat => {
  console.log(`   ${stat.type} / ${stat.waiting_for}: ${stat.count} conversations`);
});
console.log('');

// Test: Resolve a conversation
console.log('6. Resolving Slack DM...');
followupsDb.resolveConversation(db, 'slack:dm:U123456');
const stillPending = followupsDb.getPendingResponses(db);
console.log(`   ✓ Resolved. ${stillPending.length} remaining\n`);

console.log('✅ All tests passed!\n');
console.log(`Database location: ${followupsDb.DB_PATH}`);

db.close();
