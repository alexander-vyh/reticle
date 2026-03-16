#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');

// We can't import isMeetingAppRunning directly from meeting-alert-monitor.js
// because it requires a full service setup (DB, Slack, etc). Instead, test the
// pgrep pattern independently — same logic, same arguments.

const MEETING_APP_PROCESS_NAMES = ['zoom.us', 'Slack', 'Microsoft Teams'];

function isMeetingAppRunning() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', MEETING_APP_PROCESS_NAMES.join('|')], (err) => {
      resolve(!err);
    });
  });
}

// Tests for the pgrep-based process detection pattern.
// These test the actual system state — at least one of Zoom/Slack/Teams
// is typically running on a dev machine. If none are running, the "no apps"
// test becomes the active one.

async function testPgrepPatternIsValid() {
  // Verify pgrep accepts the regex pattern without error
  const result = await new Promise((resolve) => {
    execFile('pgrep', ['-x', 'zoom.us|Slack|Microsoft Teams'], (err, stdout, stderr) => {
      // Exit 0 = found, exit 1 = not found, exit 2 = invalid pattern
      resolve({ code: err ? err.code : 0, stderr: stderr || '' });
    });
  });
  // pgrep exit code 2 means invalid pattern — that's the failure we care about
  assert.notStrictEqual(result.code, 2, `pgrep rejected the pattern: ${result.stderr}`);
  console.log('  PASS: pgrep accepts the meeting app regex pattern');
}

async function testPgrepNonexistentAppReturnsFalse() {
  // A process name that definitely doesn't exist
  const result = await new Promise((resolve) => {
    execFile('pgrep', ['-x', 'zzz_nonexistent_process_12345'], (err) => {
      resolve(!err);
    });
  });
  assert.strictEqual(result, false, 'Should return false for nonexistent process');
  console.log('  PASS: nonexistent process returns false');
}

async function testIsMeetingAppRunningReturnsBoolean() {
  const result = await isMeetingAppRunning();
  assert.strictEqual(typeof result, 'boolean', `Expected boolean, got ${typeof result}`);
  console.log(`  PASS: isMeetingAppRunning returns boolean (${result})`);
}

async function testArmAndStartRecordingSkipsWhenNoApps() {
  // Simulate armAndStartRecording with a mocked isMeetingAppRunning that
  // always returns false, and verify startRecording is never called.
  let startCalled = false;
  const mockIsMeetingAppRunning = () => Promise.resolve(false);
  const mockStartRecording = () => { startCalled = true; };

  // Inline version with short timeout for testing
  const endTime = Date.now() + 200; // 200ms window
  let attempts = 0;
  while (Date.now() < endTime) {
    const running = await mockIsMeetingAppRunning();
    if (running) {
      mockStartRecording();
      break;
    }
    attempts++;
    await new Promise(r => setTimeout(r, 50));
  }

  assert.strictEqual(startCalled, false, 'startRecording should not be called when no apps running');
  assert.ok(attempts >= 1, `Should have polled at least once, got ${attempts}`);
  console.log(`  PASS: arm loop exits without recording when no meeting apps (${attempts} polls)`);
}

async function testArmAndStartRecordingStartsWhenAppAppears() {
  // Simulate app appearing on 3rd poll
  let startCalled = false;
  let pollCount = 0;
  const mockIsMeetingAppRunning = () => {
    pollCount++;
    return Promise.resolve(pollCount >= 3);
  };
  const mockStartRecording = () => { startCalled = true; };

  const endTime = Date.now() + 2000;
  while (Date.now() < endTime) {
    const running = await mockIsMeetingAppRunning();
    if (running) {
      mockStartRecording();
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  assert.strictEqual(startCalled, true, 'startRecording should be called when app appears');
  assert.strictEqual(pollCount, 3, `Should have polled 3 times, got ${pollCount}`);
  console.log('  PASS: arm loop starts recording when meeting app appears');
}

console.log('test-meeting-recording-gate.js');

testPgrepPatternIsValid()
  .then(() => testPgrepNonexistentAppReturnsFalse())
  .then(() => testIsMeetingAppRunningReturnsBoolean())
  .then(() => testArmAndStartRecordingSkipsWhenNoApps())
  .then(() => testArmAndStartRecordingStartsWhenAppAppears())
  .then(() => { console.log('All tests passed'); process.exit(0); })
  .catch(err => { console.error('FAIL:', err); process.exit(1); });
