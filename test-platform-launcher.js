#!/usr/bin/env node
'use strict';

const launcher = require('./platform-launcher');

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    failed++;
  }
}

console.log('platform-launcher tests\n');

// Test command generation (dry-run mode) - doesn't actually launch apps
console.log('Command generation:');

assert('zoom generates open -a command',
  launcher.getLaunchCommand('zoom', 'https://zoom.us/j/123'),
  'open -a "zoom.us.app" "https://zoom.us/j/123"'
);

assert('meet opens in Chrome',
  launcher.getLaunchCommand('meet', 'https://meet.google.com/abc-def'),
  'open -a "Google Chrome" "https://meet.google.com/abc-def"'
);

assert('teams opens Teams app',
  launcher.getLaunchCommand('teams', 'https://teams.microsoft.com/l/meetup'),
  'open -a "Microsoft Teams" "https://teams.microsoft.com/l/meetup"'
);

assert('calendar opens in default browser',
  launcher.getLaunchCommand('calendar', 'https://calendar.google.com/event?eid=123'),
  'open "https://calendar.google.com/event?eid=123"'
);

assert('unknown platform opens in default browser',
  launcher.getLaunchCommand('unknown', 'https://example.com/meeting'),
  'open "https://example.com/meeting"'
);

// Test button label generation
console.log('\nButton labels:');
assert('zoom label', launcher.getJoinLabel('zoom'), 'Join Zoom');
assert('meet label', launcher.getJoinLabel('meet'), 'Join Meet');
assert('teams label', launcher.getJoinLabel('teams'), 'Join Teams');
assert('calendar label', launcher.getJoinLabel('calendar'), 'Open in Calendar');
assert('unknown label', launcher.getJoinLabel('unknown'), 'Join Meeting');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
