#!/usr/bin/env node
'use strict';

const assert = require('assert');
const config = require('./lib/config');

// --- Test: AI triage wiring for noisy group mailboxes ---
// DW group and licensing group emails are 95% noise but 5% important.
// Instead of batch-surfacing everything, route them through AI triage.

// Derive test addresses from config so tests work in any environment
const DW_GROUP_EMAIL = config.filterPatterns.dwGroupEmail || 'digitalworkplace@testcorp.com';
const COMPANY_DOMAIN = config.filterPatterns.companyDomain || 'testcorp.com';

// We need applyRuleBasedFilter to be importable from gmail-monitor.js
let applyRuleBasedFilter;
try {
  const monitor = require('./gmail-monitor');
  applyRuleBasedFilter = monitor.applyRuleBasedFilter;
} catch (e) {
  // gmail-monitor.js runs inline code on require (service startup).
  // If it throws due to missing config/deps, that's expected in test.
  console.error('FAIL: could not require gmail-monitor.js for filter testing');
  console.error(`  ${e.message}`);
  process.exit(1);
}

if (typeof applyRuleBasedFilter !== 'function') {
  console.error('FAIL: applyRuleBasedFilter is not exported from gmail-monitor.js');
  process.exit(1);
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log('test-email-filters.js');
  console.log('');

  // --- AI triage for DW group emails ---
  console.log('DW group email triage');

  test('DW group email without onboarding/offboarding returns ai-triage', () => {
    const email = {
      from: `Someone via Digital Workplace <${DW_GROUP_EMAIL}>`,
      subject: 'New request: laptop setup for John Smith',
      to: `user@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'ai-triage', `Expected ai-triage but got ${result.action}`);
  });

  test('DW group onboarding email still gets archived (existing rule)', () => {
    const email = {
      from: `Someone via Digital Workplace <${DW_GROUP_EMAIL}>`,
      subject: 'Onboarding: New hire starting Monday',
      to: `user@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'archive', `Expected archive but got ${result.action}`);
  });

  test('DW group offboarding email still gets archived (existing rule)', () => {
    const email = {
      from: `Someone via Digital Workplace <${DW_GROUP_EMAIL}>`,
      subject: 'Offboarding checklist for Jane Doe',
      to: `user@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'archive', `Expected archive but got ${result.action}`);
  });

  test('DW duplicate senders still get archived (existing rule)', () => {
    const email = {
      from: `Datadog via Digital Workplace <${DW_GROUP_EMAIL}>`,
      subject: 'Alert: CPU usage high',
      to: `user@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'archive', `Expected archive but got ${result.action}`);
  });

  // --- AI triage for licensing group emails ---
  console.log('');
  console.log('Licensing group email triage');

  test('licensing group email returns ai-triage', () => {
    const email = {
      from: 'Vendor Support <support@vendor.com>',
      subject: 'Your license renewal reminder',
      to: `licensing@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'ai-triage', `Expected ai-triage but got ${result.action}`);
  });

  test('licensing email about billing failure returns ai-triage (not archived)', () => {
    const email = {
      from: 'billing@vendor.com',
      subject: 'Payment failed for your subscription',
      to: `licensing@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'ai-triage', `Expected ai-triage but got ${result.action}`);
  });

  // --- Existing filters still work ---
  console.log('');
  console.log('Existing filters unchanged');

  test('Zoom notification still gets archived', () => {
    const email = {
      from: 'no-reply@zoom.us',
      subject: 'Recording available',
      to: `user@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'archive');
  });

  test('normal internal email still passes filters', () => {
    const email = {
      from: `colleague@${COMPANY_DOMAIN}`,
      subject: 'Quick question about the project',
      to: `user@${COMPANY_DOMAIN}`
    };
    const result = applyRuleBasedFilter(email);
    assert.strictEqual(result.action, 'keep');
  });

  // --- Summary ---
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
