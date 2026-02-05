#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cache = require('./meeting-cache');

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertTruthy(name, actual) {
  if (actual) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} (expected truthy, got ${actual})`);
    failed++;
  }
}

// Use temp file for testing
const TEST_CACHE_PATH = '/tmp/test-meeting-cache.json';
const TEST_STATE_PATH = '/tmp/test-alert-state.json';

// Clean up before tests
try { fs.unlinkSync(TEST_CACHE_PATH); } catch (e) {}
try { fs.unlinkSync(TEST_STATE_PATH); } catch (e) {}

console.log('meeting-cache tests\n');

// Test 1: Save and load cache
console.log('Cache persistence:');
const testEvents = [
  {
    id: 'event1',
    summary: 'Team Standup',
    start: { dateTime: new Date(Date.now() + 30 * 60000).toISOString() },
    end: { dateTime: new Date(Date.now() + 60 * 60000).toISOString() },
    description: 'https://zoom.us/j/123',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=1'
  },
  {
    id: 'event2',
    summary: 'Client Call',
    start: { dateTime: new Date(Date.now() + 120 * 60000).toISOString() },
    end: { dateTime: new Date(Date.now() + 150 * 60000).toISOString() },
    description: '',
    location: 'https://meet.google.com/abc-def',
    htmlLink: 'https://calendar.google.com/event?eid=2'
  }
];

cache.saveCache(testEvents, TEST_CACHE_PATH);
const loaded = cache.loadCache(TEST_CACHE_PATH);
assert('saves and loads events', loaded.events.length, 2);
assertTruthy('cache has timestamp', loaded.timestamp > 0);
assert('first event summary', loaded.events[0].summary, 'Team Standup');

// Test 2: Cache validity
console.log('\nCache validity:');
assertTruthy('fresh cache is valid', cache.isCacheValid(loaded));

const staleCache = { timestamp: Date.now() - 25 * 60 * 60 * 1000, events: [] };
assert('stale cache (25h) is invalid', cache.isCacheValid(staleCache), false);

const recentCache = { timestamp: Date.now() - 23 * 60 * 60 * 1000, events: [] };
assertTruthy('recent cache (23h) is valid', cache.isCacheValid(recentCache));

// Test 3: Alert state tracking
console.log('\nAlert state:');
cache.recordAlert('event1', 'tenMin', TEST_STATE_PATH);
assertTruthy('records tenMin alert', cache.hasAlerted('event1', 'tenMin', TEST_STATE_PATH));
assert('has not alerted fiveMin', cache.hasAlerted('event1', 'fiveMin', TEST_STATE_PATH), false);

cache.recordAlert('event1', 'fiveMin', TEST_STATE_PATH);
assertTruthy('records fiveMin alert', cache.hasAlerted('event1', 'fiveMin', TEST_STATE_PATH));

assert('event2 has no alerts', cache.hasAlerted('event2', 'tenMin', TEST_STATE_PATH), false);

// Test 4: Get upcoming meetings
console.log('\nUpcoming meetings:');
const upcoming = cache.getUpcomingMeetings(loaded.events, 180);
assert('both events within 3 hours', upcoming.length, 2);

const soon = cache.getUpcomingMeetings(loaded.events, 60);
assert('one event within 1 hour', soon.length, 1);
assert('soon event is Team Standup', soon[0].summary, 'Team Standup');

// Test 5: Group overlapping meetings
console.log('\nOverlapping meetings:');
const overlapping = [
  { id: 'a', summary: 'Meeting A', start: { dateTime: new Date(Date.now() + 5 * 60000).toISOString() } },
  { id: 'b', summary: 'Meeting B', start: { dateTime: new Date(Date.now() + 5.5 * 60000).toISOString() } },
  { id: 'c', summary: 'Meeting C', start: { dateTime: new Date(Date.now() + 60 * 60000).toISOString() } }
];
const groups = cache.groupOverlappingMeetings(overlapping);
assert('groups A+B together', groups.length, 2);
assert('first group has 2 meetings', groups[0].meetings.length, 2);
assert('second group has 1 meeting', groups[1].meetings.length, 1);

// Clean up
try { fs.unlinkSync(TEST_CACHE_PATH); } catch (e) {}
try { fs.unlinkSync(TEST_STATE_PATH); } catch (e) {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
