#!/usr/bin/env node
'use strict';

const launcher = require('./platform-launcher');

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

function assertEq(name, actual, expected) {
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
console.log('Command generation (display strings):');

assertEq('zoom generates open -a command',
  launcher.getLaunchCommand('zoom', 'https://zoom.us/j/123').display,
  'open -a "zoom.us.app" "https://zoom.us/j/123"'
);

assertEq('meet opens in Chrome',
  launcher.getLaunchCommand('meet', 'https://meet.google.com/abc-def').display,
  'open -a "Google Chrome" "https://meet.google.com/abc-def"'
);

assertEq('teams opens Teams app',
  launcher.getLaunchCommand('teams', 'https://teams.microsoft.com/l/meetup').display,
  'open -a "Microsoft Teams" "https://teams.microsoft.com/l/meetup"'
);

assertEq('calendar opens in default browser',
  launcher.getLaunchCommand('calendar', 'https://calendar.google.com/event?eid=123').display,
  'open "https://calendar.google.com/event?eid=123"'
);

assertEq('unknown platform opens in default browser',
  launcher.getLaunchCommand('unknown', 'https://example.com/meeting').display,
  'open "https://example.com/meeting"'
);

// Test execFile args (shell-safe)
console.log('\nExecFile args (shell-safe):');

assert('zoom args are array',
  launcher.getLaunchCommand('zoom', 'https://zoom.us/j/123').args,
  ['-a', 'zoom.us.app', 'https://zoom.us/j/123']
);

assert('meet args use Chrome',
  launcher.getLaunchCommand('meet', 'https://meet.google.com/abc').args,
  ['-a', 'Google Chrome', 'https://meet.google.com/abc']
);

assert('unknown args are just url',
  launcher.getLaunchCommand('unknown', 'https://example.com').args,
  ['https://example.com']
);

// Test button label generation
console.log('\nButton labels:');
assertEq('zoom label', launcher.getJoinLabel('zoom'), 'Join Zoom');
assertEq('meet label', launcher.getJoinLabel('meet'), 'Join Meet');
assertEq('teams label', launcher.getJoinLabel('teams'), 'Join Teams');
assertEq('calendar label', launcher.getJoinLabel('calendar'), 'Open in Calendar');
assertEq('unknown label', launcher.getJoinLabel('unknown'), 'Join Meeting');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
