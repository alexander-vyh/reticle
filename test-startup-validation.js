// test-startup-validation.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use temp dir for heartbeats
const TEST_DIR = path.join(os.tmpdir(), `claudia-startup-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.CLAUDIA_HEARTBEAT_DIR = TEST_DIR;

const { validatePrerequisites } = require('./lib/startup-validation');

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
});

// --- Test 1: Missing file detected ---
const result1 = validatePrerequisites('test-missing', [
  { type: 'file', path: '/tmp/definitely-does-not-exist-12345.json', description: 'Gmail token' }
]);
assert.ok(result1.errors.length > 0);
assert.ok(result1.errors[0].includes('Gmail token'));
assert.ok(result1.errors[0].includes('/tmp/definitely-does-not-exist'));
console.log('PASS: missing file detected');

// --- Test 2: Existing file passes ---
const tmpFile = path.join(TEST_DIR, 'exists.json');
fs.writeFileSync(tmpFile, '{}');
const result2 = validatePrerequisites('test-exists', [
  { type: 'file', path: tmpFile, description: 'Test file' }
]);
assert.strictEqual(result2.errors.length, 0);
console.log('PASS: existing file passes');

// --- Test 3: Corrupted DB detected ---
const badDb = path.join(TEST_DIR, 'bad.db');
fs.writeFileSync(badDb, 'this is not a sqlite database');
const result3 = validatePrerequisites('test-bad-db', [
  { type: 'database', path: badDb, description: 'Followups DB' }
]);
assert.ok(result3.errors.length > 0);
assert.ok(result3.errors[0].includes('Followups DB'));
console.log('PASS: corrupted database detected');

// --- Test 4: Startup-failed heartbeat written on failure ---
const result4 = validatePrerequisites('test-heartbeat-write', [
  { type: 'file', path: '/tmp/nope-12345.json', description: 'Missing cred' }
]);
assert.ok(result4.errors.length > 0);
const hbFile = path.join(TEST_DIR, 'test-heartbeat-write.json');
assert.ok(fs.existsSync(hbFile), 'heartbeat file should be written on failure');
const hbData = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
assert.strictEqual(hbData.status, 'startup-failed');
assert.ok(hbData.errors.lastError.includes('Missing cred'));
console.log('PASS: startup-failed heartbeat written on failure');

// --- Test 5: All checks pass returns no errors ---
const result5 = validatePrerequisites('test-all-good', [
  { type: 'file', path: tmpFile, description: 'Good file' }
]);
assert.strictEqual(result5.errors.length, 0);
console.log('PASS: all checks pass returns no errors');

// --- Test 6: Multiple failures collected ---
const result6 = validatePrerequisites('test-multi', [
  { type: 'file', path: '/tmp/nope1-12345.json', description: 'Cred A' },
  { type: 'file', path: '/tmp/nope2-12345.json', description: 'Cred B' }
]);
assert.strictEqual(result6.errors.length, 2);
console.log('PASS: multiple failures collected');

console.log('\n=== ALL STARTUP VALIDATION TESTS PASSED ===');
