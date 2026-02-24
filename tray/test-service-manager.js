'use strict';

const assert = require('assert');
const { parseLaunchctlList, SERVICES, statusFromEntry } = require('./service-manager');

// --- Test: parseLaunchctlList ---
const SAMPLE_OUTPUT = [
  'PID\tStatus\tLabel',
  '58827\t0\tai.claudia.gmail-monitor',
  '23103\t0\tai.claudia.slack-events',
  '-\t1\tai.claudia.meeting-alerts',
  '-\t0\tai.claudia.followup-checker',
  '18910\t0\tai.openclaw.gateway',
].join('\n');

const parsed = parseLaunchctlList(SAMPLE_OUTPUT);

assert.strictEqual(parsed['ai.claudia.gmail-monitor'].pid, 58827);
assert.strictEqual(parsed['ai.claudia.gmail-monitor'].exitCode, 0);
assert.strictEqual(parsed['ai.claudia.slack-events'].pid, 23103);
assert.strictEqual(parsed['ai.claudia.meeting-alerts'].pid, null);
assert.strictEqual(parsed['ai.claudia.meeting-alerts'].exitCode, 1);
assert.strictEqual(parsed['ai.claudia.followup-checker'].pid, null);
assert.strictEqual(parsed['ai.claudia.followup-checker'].exitCode, 0);
assert.strictEqual(parsed['ai.openclaw.gateway'].pid, 18910);

// --- Test: statusFromEntry ---
assert.strictEqual(statusFromEntry({ pid: 23103, exitCode: 0 }), 'running');
assert.strictEqual(statusFromEntry({ pid: null, exitCode: 0 }), 'stopped');
assert.strictEqual(statusFromEntry({ pid: null, exitCode: 1 }), 'error');
assert.strictEqual(statusFromEntry(undefined), 'unloaded');

// --- Test: SERVICES list matches expected inventory ---
assert.strictEqual(SERVICES.length, 8);
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.gmail-monitor'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.slack-events'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.meeting-alerts'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.followup-checker'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.openclaw.gateway'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.openclaw.meeting-recorder'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.digest-daily'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.digest-weekly'));
assert.ok(!SERVICES.find(s => s.launchdLabel === 'ai.openclaw.slack-monitor'), 'Old slack-monitor must not be in SERVICES');

console.log('All service-manager tests passed');
