'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-slack-capture.db');
process.env.ORG_MEMORY_DB_PATH = TEST_DB_PATH;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch {}
  }
}

function freshDb() {
  cleanup();
  delete require.cache[require.resolve('./lib/org-memory-db')];
  delete require.cache[require.resolve('./lib/knowledge-graph')];
  delete require.cache[require.resolve('./lib/slack-capture')];
  const orgDb = require('./lib/org-memory-db');
  return orgDb.initDatabase(TEST_DB_PATH);
}

function testCaptureSlackMessage() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  capture.captureMessage(db, {
    channel: 'C123ABC',
    channelName: 'iops-dw',
    ts: '1709568000.123456',
    user: 'U04ABC123',
    userName: 'Kinski Wu',
    text: 'We should use Permission Set Groups instead',
    threadTs: null,
    channelType: 'channel',
  });

  const row = db.prepare('SELECT * FROM raw_messages').get();
  assert.ok(row, 'Should have inserted a raw message');
  assert.strictEqual(row.source, 'slack');
  assert.strictEqual(row.source_id, 'C123ABC:1709568000.123456');
  assert.strictEqual(row.channel_id, 'C123ABC');
  assert.strictEqual(row.channel_name, 'iops-dw');
  assert.strictEqual(row.author_name, 'Kinski Wu');
  assert.strictEqual(row.content, 'We should use Permission Set Groups instead');
  assert.strictEqual(row.extracted, 0);

  db.close();
  cleanup();
  console.log('  PASS: capture slack message');
}

function testCaptureDMMessage() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  capture.captureMessage(db, {
    channel: 'D999XYZ',
    channelName: null, // DMs don't have names from the event
    ts: '1709568100.000001',
    user: 'U04DEF456',
    userName: 'Keshon Bowman',
    text: 'Hey, can you review the PR?',
    threadTs: null,
    channelType: 'im',
  });

  const row = db.prepare('SELECT * FROM raw_messages').get();
  assert.ok(row);
  assert.strictEqual(row.channel_name, 'dm-Keshon Bowman');

  db.close();
  cleanup();
  console.log('  PASS: capture DM message');
}

function testCaptureThreadReply() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  capture.captureMessage(db, {
    channel: 'C123ABC',
    channelName: 'iops-dw',
    ts: '1709568200.000001',
    user: 'U04GHI789',
    userName: 'Marissa Chen',
    text: 'I agree, PSGs are the way to go',
    threadTs: '1709568000.123456',
    channelType: 'channel',
  });

  const row = db.prepare('SELECT * FROM raw_messages').get();
  assert.ok(row);
  assert.strictEqual(row.thread_id, '1709568000.123456');

  db.close();
  cleanup();
  console.log('  PASS: capture thread reply');
}

function testCaptureDeduplicates() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  const msg = {
    channel: 'C123ABC',
    channelName: 'iops-dw',
    ts: '1709568000.123456',
    user: 'U04ABC123',
    userName: 'Kinski Wu',
    text: 'Duplicate test',
    threadTs: null,
    channelType: 'channel',
  };

  capture.captureMessage(db, msg);
  capture.captureMessage(db, msg); // Same message again

  const count = db.prepare('SELECT count(*) as c FROM raw_messages').get();
  assert.strictEqual(count.c, 1, 'Should not create duplicate raw messages');

  db.close();
  cleanup();
  console.log('  PASS: capture deduplicates');
}

function testCaptureResolvesIdentity() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');
  const kg = require('./lib/knowledge-graph');

  // Set up a known identity
  const person = kg.createEntity(db, { entityType: 'person', canonicalName: 'Kinski Wu' });
  kg.addIdentity(db, { entityId: person.id, source: 'slack', externalId: 'U04ABC123' });

  capture.captureMessage(db, {
    channel: 'C123ABC',
    channelName: 'iops-dw',
    ts: '1709568300.000001',
    user: 'U04ABC123',
    userName: 'Kinski Wu',
    text: 'Identity resolution test',
    threadTs: null,
    channelType: 'channel',
  });

  const row = db.prepare('SELECT * FROM raw_messages').get();
  assert.strictEqual(row.author_id, person.id, 'Should resolve author to entity ID');

  db.close();
  cleanup();
  console.log('  PASS: capture resolves identity');
}

function testCaptureUnknownIdentity() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  // No identity set up — author_id should be null
  capture.captureMessage(db, {
    channel: 'C123ABC',
    channelName: 'iops-dw',
    ts: '1709568400.000001',
    user: 'U_UNKNOWN',
    userName: 'Unknown Person',
    text: 'Unknown identity test',
    threadTs: null,
    channelType: 'channel',
  });

  const row = db.prepare('SELECT * FROM raw_messages').get();
  assert.strictEqual(row.author_id, null, 'Unknown user should have null author_id');

  db.close();
  cleanup();
  console.log('  PASS: capture unknown identity');
}

// Run all tests
console.log('slack-capture tests:');
testCaptureSlackMessage();
testCaptureDMMessage();
testCaptureThreadReply();
testCaptureDeduplicates();
testCaptureResolvesIdentity();
testCaptureUnknownIdentity();
console.log('All slack-capture tests passed.');
