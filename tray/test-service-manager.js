'use strict';

const assert = require('assert');
const { parseLaunchctlList, SERVICES, statusFromEntry } = require('./service-manager');

// --- Test: parseLaunchctlList ---
const SAMPLE_OUTPUT = [
  'PID\tStatus\tLabel',
  '23103\t0\tai.openclaw.slack-monitor',
  '-\t1\tcom.openclaw.meeting-alerts',
  '58827\t-15\tai.openclaw.gmail-monitor',
  '-\t0\tai.openclaw.slack-events',
  '18910\t0\tai.openclaw.gateway',
].join('\n');

const parsed = parseLaunchctlList(SAMPLE_OUTPUT);

assert.strictEqual(parsed['ai.openclaw.slack-monitor'].pid, 23103);
assert.strictEqual(parsed['ai.openclaw.slack-monitor'].exitCode, 0);
assert.strictEqual(parsed['com.openclaw.meeting-alerts'].pid, null);
assert.strictEqual(parsed['com.openclaw.meeting-alerts'].exitCode, 1);
assert.strictEqual(parsed['ai.openclaw.gmail-monitor'].pid, 58827);
assert.strictEqual(parsed['ai.openclaw.gmail-monitor'].exitCode, -15);

// --- Test: statusFromEntry ---
assert.strictEqual(statusFromEntry({ pid: 23103, exitCode: 0 }), 'running');
assert.strictEqual(statusFromEntry({ pid: null, exitCode: 0 }), 'stopped');
assert.strictEqual(statusFromEntry({ pid: null, exitCode: 1 }), 'error');
assert.strictEqual(statusFromEntry(undefined), 'unloaded');

console.log('All service-manager tests passed');
