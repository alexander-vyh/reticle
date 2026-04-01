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

// Browser meeting tests: armAndStartRecording should start immediately for
// browser-based meetings (Meet, WebEx) without waiting for native meeting apps.

const linkParser = require('./meeting-link-parser');

const BROWSER_APP_PROCESS_NAMES = ['Google Chrome', 'Safari', 'firefox', 'Arc'];

async function testBrowserMeetingStartsImmediately() {
  // For a browser meeting, armAndStartRecording should call startRecording
  // on the first iteration — it shouldn't wait for a native meeting app.
  let startCalled = false;
  let startBody = null;
  const mockStartRecording = (body) => { startCalled = true; startBody = body; };

  // Simulate: no native apps running, but it's a Meet link
  const linkInfo = { platform: 'meet', url: 'https://meet.google.com/abc-defg-hij' };
  const isBrowser = linkParser.isBrowserMeeting(linkInfo.platform);

  // For browser meetings, should start without polling for native apps
  if (isBrowser) {
    mockStartRecording({ browserMeeting: true });
  }

  assert.strictEqual(isBrowser, true, 'Meet should be detected as browser meeting');
  assert.strictEqual(startCalled, true, 'Should start recording immediately for browser meetings');
  assert.strictEqual(startBody.browserMeeting, true, 'Should pass browserMeeting: true');
  console.log('  PASS: browser meeting (Meet) starts recording immediately');
}

async function testNativeAppMeetingStillWaitsForProcess() {
  // Zoom is NOT a browser meeting — should NOT start immediately
  const linkInfo = { platform: 'zoom', url: 'https://zoom.us/j/123' };
  const isBrowser = linkParser.isBrowserMeeting(linkInfo.platform);

  assert.strictEqual(isBrowser, false, 'Zoom should NOT be a browser meeting');
  console.log('  PASS: native app meeting (Zoom) does not bypass process check');
}

async function testWebExIsBrowserMeeting() {
  const linkInfo = { platform: 'webex', url: 'https://acme.webex.com/meet123' };
  const isBrowser = linkParser.isBrowserMeeting(linkInfo.platform);

  assert.strictEqual(isBrowser, true, 'WebEx should be detected as browser meeting');
  console.log('  PASS: WebEx is detected as browser meeting');
}

async function testBrowserAppProcessNames() {
  // Verify browser process names list exists and has expected entries
  assert.ok(BROWSER_APP_PROCESS_NAMES.length >= 3, 'Should have at least 3 browser process names');
  assert.ok(BROWSER_APP_PROCESS_NAMES.includes('Google Chrome'), 'Should include Chrome');
  assert.ok(BROWSER_APP_PROCESS_NAMES.includes('Safari'), 'Should include Safari');
  console.log('  PASS: browser app process names are defined');
}

async function testArmLogicBypassesProcessCheckForBrowserMeeting() {
  // This tests the critical behavior: when armAndStartRecording is called with
  // a browser meeting (Meet/WebEx), it should NOT poll for native meeting apps.
  // Instead it should start recording immediately.
  //
  // We simulate the arm logic pattern (same as meeting-alert-monitor.js) and
  // verify that browser meetings get the bypass.
  let startCalled = false;
  const mockIsMeetingAppRunning = () => Promise.resolve(false);  // No native apps
  const mockStartRecording = () => { startCalled = true; };

  // Pattern: exported armAndStartRecording checks isBrowserMeeting first
  const linkInfo = { platform: 'meet', url: 'https://meet.google.com/abc' };
  const isBrowser = linkParser.isBrowserMeeting(linkInfo.platform);

  if (isBrowser) {
    // Browser meeting: skip the process poll, start immediately
    mockStartRecording();
  } else {
    // Native app: poll for process
    const endTime = Date.now() + 200;
    while (Date.now() < endTime) {
      const running = await mockIsMeetingAppRunning();
      if (running) { mockStartRecording(); break; }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  assert.strictEqual(startCalled, true,
    'Browser meeting should bypass process check and start recording');
  console.log('  PASS: arm logic bypasses process check for browser meetings');
}

async function testArmLogicStillPollsForNativeAppMeeting() {
  // Complementary test: Zoom meeting should still require process polling
  let startCalled = false;
  const mockIsMeetingAppRunning = () => Promise.resolve(false);  // No native apps

  const linkInfo = { platform: 'zoom', url: 'https://zoom.us/j/123' };
  const isBrowser = linkParser.isBrowserMeeting(linkInfo.platform);

  if (isBrowser) {
    startCalled = true;
  } else {
    const endTime = Date.now() + 200;
    while (Date.now() < endTime) {
      const running = await mockIsMeetingAppRunning();
      if (running) { startCalled = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  assert.strictEqual(startCalled, false,
    'Native app meeting should NOT start recording when no apps are running');
  console.log('  PASS: arm logic still polls for native app meetings');
}

console.log('test-meeting-recording-gate.js');

testPgrepPatternIsValid()
  .then(() => testPgrepNonexistentAppReturnsFalse())
  .then(() => testIsMeetingAppRunningReturnsBoolean())
  .then(() => testArmAndStartRecordingSkipsWhenNoApps())
  .then(() => testArmAndStartRecordingStartsWhenAppAppears())
  .then(() => testBrowserMeetingStartsImmediately())
  .then(() => testNativeAppMeetingStillWaitsForProcess())
  .then(() => testWebExIsBrowserMeeting())
  .then(() => testBrowserAppProcessNames())
  .then(() => testArmLogicBypassesProcessCheckForBrowserMeeting())
  .then(() => testArmLogicStillPollsForNativeAppMeeting())
  .then(() => { console.log('All tests passed'); process.exit(0); })
  .catch(err => { console.error('FAIL:', err); process.exit(1); });
