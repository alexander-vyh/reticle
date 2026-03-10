// test-slack-capture-isolation.js
// Verifies that the org-memory capture pipeline works independently —
// a failure in trackSlackConversation must not block message capture.
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `reticle-capture-isolation-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

// Cleanup on exit
process.on('exit', () => {
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
});

let dbCounter = 0;
function freshDb() {
  // Clear module caches to get clean state
  for (const mod of ['./lib/org-memory-db', './lib/knowledge-graph', './lib/slack-capture']) {
    delete require.cache[require.resolve(mod)];
  }
  const dbPath = path.join(TEST_DIR, `org-memory-test-${dbCounter++}.db`);
  const orgDb = require('./lib/org-memory-db');
  return orgDb.initDatabase(dbPath);
}

// --- Test 1: captureMessage inserts into a temp DB ---
function testCaptureMessageIntoTempDb() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  const result = capture.captureMessage(db, {
    channel: 'C_ISOLATION',
    channelName: 'test-channel',
    ts: '1709900000.000001',
    user: 'U_TEST_01',
    userName: 'Test User',
    text: 'Isolation test message',
    threadTs: null,
    channelType: 'channel',
  });

  assert.ok(result, 'captureMessage should return the inserted row');
  assert.strictEqual(result.source, 'slack');
  assert.strictEqual(result.content, 'Isolation test message');

  // Verify via direct query
  const row = db.prepare('SELECT * FROM raw_messages WHERE source_id = ?').get('C_ISOLATION:1709900000.000001');
  assert.ok(row, 'Row should exist in raw_messages');
  assert.strictEqual(row.channel_name, 'test-channel');
  assert.strictEqual(row.author_name, 'Test User');
  assert.strictEqual(row.extracted, 0, 'New messages start unextracted');

  db.close();
  console.log('  PASS: captureMessage inserts into temp DB');
}

// --- Test 2: capture works even when a preceding function throws ---
function testCaptureWorksAfterPriorThrow() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  // Simulate the exact failure pattern: a function throws before capture runs
  function trackSlackConversationThatThrows() {
    throw new Error('NOT NULL constraint failed: conversations.account_id');
  }

  // This mimics the fixed handleEvent pattern:
  // try { trackSlackConversation() } catch { /* warn */ }
  // captureMessage() <-- should still run
  let trackingFailed = false;
  try {
    trackSlackConversationThatThrows();
  } catch {
    trackingFailed = true;
  }

  assert.ok(trackingFailed, 'Tracking should have thrown');

  // Now capture should succeed
  const result = capture.captureMessage(db, {
    channel: 'C_AFTER_THROW',
    channelName: 'post-throw-channel',
    ts: '1709900100.000001',
    user: 'U_TEST_02',
    userName: 'Survivor User',
    text: 'This message should still be captured',
    threadTs: null,
    channelType: 'channel',
  });

  assert.ok(result, 'captureMessage should succeed after prior throw is caught');
  assert.strictEqual(result.content, 'This message should still be captured');

  const count = db.prepare('SELECT count(*) as c FROM raw_messages').get();
  assert.strictEqual(count.c, 1, 'Exactly one message should be in the DB');

  db.close();
  console.log('  PASS: capture works after prior throw is caught');
}

// --- Test 3: multiple messages accumulate correctly ---
function testMultipleMessagesAccumulate() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  for (let i = 0; i < 5; i++) {
    capture.captureMessage(db, {
      channel: 'C_MULTI',
      channelName: 'multi-channel',
      ts: `1709900200.00000${i}`,
      user: `U_TEST_0${i}`,
      userName: `User ${i}`,
      text: `Message ${i}`,
      threadTs: null,
      channelType: 'channel',
    });
  }

  const count = db.prepare('SELECT count(*) as c FROM raw_messages').get();
  assert.strictEqual(count.c, 5, 'Should have 5 messages');

  db.close();
  console.log('  PASS: multiple messages accumulate correctly');
}

// --- Test 4: author_ext_id stores the Slack user ID ---
function testAuthorExtId() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  const result = capture.captureMessage(db, {
    channel: 'C_EXT_TEST',
    channelName: 'ext-test',
    ts: '1709900000.000099',
    user: 'U_TEST_EXT_99',
    userName: 'Aragorn King',
    text: 'Testing author_ext_id storage',
    threadTs: null,
    channelType: 'channel',
  });

  assert.strictEqual(result.author_ext_id, 'U_TEST_EXT_99',
    'author_ext_id should store the Slack user ID');

  db.close();
  console.log('  PASS: author_ext_id stores the Slack user ID');
}

// --- Test 5: metadata includes source-specific fields ---
function testMetadataEnrichment() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  const result = capture.captureMessage(db, {
    channel: 'C_META_TEST',
    channelName: 'meta-test',
    ts: '1709900000.000088',
    user: 'U_META_01',
    userName: 'Meta User',
    text: 'Testing metadata enrichment',
    threadTs: '1709900000.000001',
    channelType: 'channel',
    clientMsgId: 'abc-def-123',
    subtype: null,
  });

  const meta = JSON.parse(result.metadata);
  assert.strictEqual(meta.event_type, 'message',
    'metadata should include event_type');
  assert.strictEqual(meta.source_msg_id, 'abc-def-123',
    'metadata should include source_msg_id from client_msg_id');
  assert.strictEqual(meta.source_parent_ref, 'C_META_TEST:1709900000.000001',
    'metadata should include source_parent_ref for threaded messages');

  db.close();
  console.log('  PASS: metadata includes source-specific fields');
}

// Run all tests
console.log('slack-capture-isolation tests:');
testCaptureMessageIntoTempDb();
testCaptureWorksAfterPriorThrow();
testMultipleMessagesAccumulate();
testAuthorExtId();
testMetadataEnrichment();
console.log('All slack-capture-isolation tests passed.');
