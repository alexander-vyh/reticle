// test-heartbeat.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use temp dir for tests
const TEST_DIR = path.join(os.tmpdir(), `claudia-heartbeat-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

// Override heartbeat dir before requiring the module
process.env.CLAUDIA_HEARTBEAT_DIR = TEST_DIR;

const heartbeat = require('./lib/heartbeat');

// Cleanup on exit
process.on('exit', () => {
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
});

// --- Test 1: writeHeartbeat creates a valid JSON file ---
heartbeat.write('test-service', {
  checkInterval: 60000,
  status: 'ok',
  metrics: { emailsProcessed: 42 }
});

const filePath = path.join(TEST_DIR, 'test-service.json');
assert.ok(fs.existsSync(filePath), 'heartbeat file should exist');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
assert.strictEqual(data.service, 'test-service');
assert.strictEqual(data.status, 'ok');
assert.strictEqual(data.checkInterval, 60000);
assert.ok(data.pid > 0);
assert.ok(data.lastCheck > 0);
assert.strictEqual(data.metrics.emailsProcessed, 42);
console.log('PASS: writeHeartbeat creates valid JSON');

// --- Test 2: Stale heartbeat detected as unresponsive ---
// Write a heartbeat with lastCheck 46 minutes ago, checkInterval 15 min (threshold = 45 min)
const staleTime = Date.now() - (46 * 60 * 1000);
fs.writeFileSync(path.join(TEST_DIR, 'stale-service.json'), JSON.stringify({
  service: 'stale-service',
  pid: 12345,
  startedAt: staleTime - 3600000,
  lastCheck: staleTime,
  checkInterval: 15 * 60 * 1000,
  status: 'ok',
  errors: { lastError: null, lastErrorAt: null, countSinceStart: 0 }
}));

const staleHealth = heartbeat.evaluate(heartbeat.read('stale-service'));
assert.strictEqual(staleHealth.health, 'unresponsive');
console.log('PASS: stale heartbeat detected as unresponsive');

// --- Test 3: Fresh heartbeat is healthy ---
heartbeat.write('fresh-service', { checkInterval: 60000, status: 'ok' });
const freshHealth = heartbeat.evaluate(heartbeat.read('fresh-service'));
assert.strictEqual(freshHealth.health, 'healthy');
console.log('PASS: fresh heartbeat is healthy');

// --- Test 4: startup-failed status surfaces error reason ---
fs.writeFileSync(path.join(TEST_DIR, 'broken-service.json'), JSON.stringify({
  service: 'broken-service',
  pid: 0,
  startedAt: Date.now(),
  lastCheck: Date.now(),
  checkInterval: 60000,
  status: 'startup-failed',
  errors: {
    lastError: 'Missing Gmail token: /path/to/gmail-token.json',
    lastErrorAt: Date.now(),
    countSinceStart: 1
  }
}));

const brokenHealth = heartbeat.evaluate(heartbeat.read('broken-service'));
assert.strictEqual(brokenHealth.health, 'startup-failed');
assert.ok(brokenHealth.error.includes('Missing Gmail token'));
console.log('PASS: startup-failed status surfaces error reason');

// --- Test 5: readAll returns all heartbeats ---
const all = heartbeat.readAll();
assert.ok(all.length >= 3);
assert.ok(all.find(h => h.service === 'test-service'));
assert.ok(all.find(h => h.service === 'stale-service'));
console.log('PASS: readAll returns all heartbeats');

// --- Test 6: Atomic write — no partial reads ---
for (let i = 0; i < 100; i++) {
  heartbeat.write('atomic-test', { checkInterval: 1000, status: 'ok', metrics: { i } });
  const read = heartbeat.read('atomic-test');
  assert.ok(read, `read should succeed on iteration ${i}`);
  assert.strictEqual(read.service, 'atomic-test');
}
console.log('PASS: 100 consecutive write/reads all valid (atomic)');

// --- Test 7: Missing heartbeat returns null ---
const missing = heartbeat.read('nonexistent-service');
assert.strictEqual(missing, null);
console.log('PASS: missing heartbeat returns null');

// --- Test 8: Error tracking in heartbeat ---
heartbeat.write('error-service', {
  checkInterval: 60000,
  status: 'error',
  errors: { lastError: 'SQLITE_CORRUPT', lastErrorAt: Date.now(), countSinceStart: 42 }
});
const errorHealth = heartbeat.evaluate(heartbeat.read('error-service'));
assert.strictEqual(errorHealth.health, 'error');
assert.strictEqual(errorHealth.errorCount, 42);
console.log('PASS: error status with count');

console.log('\n=== ALL HEARTBEAT TESTS PASSED ===');
