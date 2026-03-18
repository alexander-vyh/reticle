'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

function setupDb() {
  const tmpPath = path.join(os.tmpdir(), `test-digest-quality-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.RETICLE_DB_PATH = tmpPath;

  // Clear cached modules to pick up new DB path
  delete require.cache[require.resolve('./reticle-db')];
  delete require.cache[require.resolve('./lib/digest-collectors')];

  const reticleDb = require('./reticle-db');
  const { collectFollowups } = require('./lib/digest-collectors');

  const db = reticleDb.initDatabase();
  const acct = reticleDb.upsertAccount(db, { email: 'test@example.com', provider: 'gmail', is_primary: 1 });
  return { db, accountId: acct.id, tmpPath, reticleDb, collectFollowups };
}

function cleanup(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
}

const HOUR = 3600;
const DAY = 86400;

// ──────────────────────────────────────────────────────────────────────────
// Test 1: expireStaleConversations sets state='expired' for old conversations
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, accountId, tmpPath, reticleDb } = setupDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    reticleDb.trackConversation(db, accountId, {
      id: 'fresh-1', type: 'email', subject: 'Fresh email',
      from_user: 'a@test.com', last_activity: now - 1 * DAY,
      waiting_for: 'my-response', first_seen: now - 1 * DAY,
    });
    reticleDb.trackConversation(db, accountId, {
      id: 'mid-1', type: 'email', subject: 'Mid-age email',
      from_user: 'b@test.com', last_activity: now - 5 * DAY,
      waiting_for: 'my-response', first_seen: now - 5 * DAY,
    });
    reticleDb.trackConversation(db, accountId, {
      id: 'stale-1', type: 'email', subject: 'Stale email',
      from_user: 'c@test.com', last_activity: now - 10 * DAY,
      waiting_for: 'my-response', first_seen: now - 10 * DAY,
    });

    const expired = reticleDb.expireStaleConversations(db, accountId, { maxAgeDays: 7 });
    assert.strictEqual(expired, 1, 'Should expire 1 conversation (10d old)');

    const stale = db.prepare("SELECT state FROM conversations WHERE id = 'stale-1'").get();
    assert.strictEqual(stale.state, 'expired');

    const mid = db.prepare("SELECT state FROM conversations WHERE id = 'mid-1'").get();
    assert.strictEqual(mid.state, 'active');

    const fresh = db.prepare("SELECT state FROM conversations WHERE id = 'fresh-1'").get();
    assert.strictEqual(fresh.state, 'active');

    console.log('PASS: expireStaleConversations expires old conversations');
  } finally {
    db.close();
    cleanup(tmpPath);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 2: Priority based on original urgency signal, not age alone
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, accountId, tmpPath, reticleDb, collectFollowups } = setupDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    reticleDb.trackConversation(db, accountId, {
      id: 'urgent-old', type: 'email', subject: 'Server down',
      from_user: 'ops@test.com', from_name: 'Ops Team',
      last_activity: now - 4 * DAY,
      waiting_for: 'my-response', first_seen: now - 4 * DAY,
      metadata: { urgency: 'urgent', reason: 'Keyword: down' },
    });

    reticleDb.trackConversation(db, accountId, {
      id: 'batch-old', type: 'email', subject: 'Newsletter digest',
      from_user: 'news@test.com', from_name: 'Newsletter',
      last_activity: now - 4 * DAY,
      waiting_for: 'my-response', first_seen: now - 4 * DAY,
      metadata: { urgency: 'batch' },
    });

    const items = collectFollowups(db, accountId);
    const urgentItem = items.find(i => i.entityId === 'urgent-old');
    const batchItem = items.find(i => i.entityId === 'batch-old');

    assert.ok(urgentItem, 'Urgent email should appear');
    assert.ok(batchItem, 'Batch email should appear');

    assert.ok(
      ['critical', 'high'].includes(urgentItem.priority),
      `Urgent 4d old should be critical or high, got: ${urgentItem.priority}`
    );

    assert.ok(
      batchItem.priority !== 'critical',
      `Batch 4d old should NOT be critical, got: ${batchItem.priority}`
    );

    console.log('PASS: priority uses original urgency signal, not age alone');
  } finally {
    db.close();
    cleanup(tmpPath);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 3: Expired conversations don't appear in collectFollowups
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, accountId, tmpPath, reticleDb, collectFollowups } = setupDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    reticleDb.trackConversation(db, accountId, {
      id: 'will-expire', type: 'email', subject: 'Old newsletter',
      from_user: 'news@test.com', from_name: 'Newsletter',
      last_activity: now - 10 * DAY,
      waiting_for: 'my-response', first_seen: now - 10 * DAY,
    });

    reticleDb.trackConversation(db, accountId, {
      id: 'stays-active', type: 'email', subject: 'Recent email',
      from_user: 'boss@test.com', from_name: 'Boss',
      last_activity: now - 2 * DAY,
      waiting_for: 'my-response', first_seen: now - 2 * DAY,
    });

    reticleDb.expireStaleConversations(db, accountId, { maxAgeDays: 7 });

    const items = collectFollowups(db, accountId);
    const expired = items.find(i => i.entityId === 'will-expire');
    const active = items.find(i => i.entityId === 'stays-active');

    assert.strictEqual(expired, undefined, 'Expired conversation should NOT appear in digest');
    assert.ok(active, 'Active conversation should still appear');

    console.log('PASS: expired conversations excluded from collectFollowups');
  } finally {
    db.close();
    cleanup(tmpPath);
  }
}

console.log('\nAll email digest quality tests passed.');
