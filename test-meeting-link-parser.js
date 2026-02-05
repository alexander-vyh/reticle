#!/usr/bin/env node
'use strict';

const parser = require('./meeting-link-parser');

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

console.log('meeting-link-parser tests\n');

// Test 1: Zoom link in description
console.log('Zoom detection:');
assert('finds zoom link in description',
  parser.extractMeetingLink({
    description: 'Join our meeting: https://zoom.us/j/123456789?pwd=abc123',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=123'
  }),
  { platform: 'zoom', url: 'https://zoom.us/j/123456789?pwd=abc123' }
);

assert('finds zoom link with subdomain',
  parser.extractMeetingLink({
    description: 'https://simpli-fi.zoom.us/j/987654321',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=456'
  }),
  { platform: 'zoom', url: 'https://simpli-fi.zoom.us/j/987654321' }
);

// Test 2: Google Meet link
console.log('\nGoogle Meet detection:');
assert('finds meet link in location',
  parser.extractMeetingLink({
    description: '',
    location: 'https://meet.google.com/abc-defg-hij',
    htmlLink: 'https://calendar.google.com/event?eid=789'
  }),
  { platform: 'meet', url: 'https://meet.google.com/abc-defg-hij' }
);

assert('finds meet link in description',
  parser.extractMeetingLink({
    description: 'Video call: https://meet.google.com/xyz-abcd-efg\nAgenda: ...',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=101'
  }),
  { platform: 'meet', url: 'https://meet.google.com/xyz-abcd-efg' }
);

// Test 3: Teams link
console.log('\nTeams detection:');
assert('finds teams link',
  parser.extractMeetingLink({
    description: 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=202'
  }),
  { platform: 'teams', url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc' }
);

// Test 4: Fallback to calendar
console.log('\nFallback behavior:');
assert('falls back to calendar URL when no meeting link',
  parser.extractMeetingLink({
    description: 'Lunch with the team',
    location: 'Conference Room B',
    htmlLink: 'https://calendar.google.com/event?eid=303'
  }),
  { platform: 'calendar', url: 'https://calendar.google.com/event?eid=303' }
);

assert('handles missing description and location',
  parser.extractMeetingLink({
    htmlLink: 'https://calendar.google.com/event?eid=404'
  }),
  { platform: 'calendar', url: 'https://calendar.google.com/event?eid=404' }
);

// Test 5: Priority - location takes precedence if both have links
console.log('\nPriority:');
assert('location link takes precedence over description',
  parser.extractMeetingLink({
    description: 'Notes about the call https://meet.google.com/old-link-xyz',
    location: 'https://zoom.us/j/111222333',
    htmlLink: 'https://calendar.google.com/event?eid=505'
  }),
  { platform: 'zoom', url: 'https://zoom.us/j/111222333' }
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
