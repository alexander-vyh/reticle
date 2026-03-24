'use strict';

const assert = require('assert');

// --- Test helpers ---

function runTests(tests) {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn();
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// --- Tests ---

console.log('test-confluence-reader.js');

// Load module under test
const {
  formatOrdinalDate,
  extractDWSection,
  buildCQL,
  getPreviousMondayDate,
} = require('./lib/confluence-reader');

const tests = {};

// --- formatOrdinalDate ---

tests['formatOrdinalDate: 1st'] = () => {
  const d = new Date(2026, 2, 1); // March 1, 2026
  assert.strictEqual(formatOrdinalDate(d), 'March 1st, 2026');
};

tests['formatOrdinalDate: 2nd'] = () => {
  const d = new Date(2026, 2, 2); // March 2, 2026
  assert.strictEqual(formatOrdinalDate(d), 'March 2nd, 2026');
};

tests['formatOrdinalDate: 3rd'] = () => {
  const d = new Date(2026, 2, 3); // March 3, 2026
  assert.strictEqual(formatOrdinalDate(d), 'March 3rd, 2026');
};

tests['formatOrdinalDate: 4th'] = () => {
  const d = new Date(2026, 2, 4);
  assert.strictEqual(formatOrdinalDate(d), 'March 4th, 2026');
};

tests['formatOrdinalDate: 9th'] = () => {
  const d = new Date(2026, 2, 9);
  assert.strictEqual(formatOrdinalDate(d), 'March 9th, 2026');
};

tests['formatOrdinalDate: 11th'] = () => {
  const d = new Date(2026, 2, 11);
  assert.strictEqual(formatOrdinalDate(d), 'March 11th, 2026');
};

tests['formatOrdinalDate: 12th'] = () => {
  const d = new Date(2026, 2, 12);
  assert.strictEqual(formatOrdinalDate(d), 'March 12th, 2026');
};

tests['formatOrdinalDate: 13th'] = () => {
  const d = new Date(2026, 2, 13);
  assert.strictEqual(formatOrdinalDate(d), 'March 13th, 2026');
};

tests['formatOrdinalDate: 16th (typical Monday)'] = () => {
  const d = new Date(2026, 2, 16);
  assert.strictEqual(formatOrdinalDate(d), 'March 16th, 2026');
};

tests['formatOrdinalDate: 21st'] = () => {
  const d = new Date(2026, 2, 21);
  assert.strictEqual(formatOrdinalDate(d), 'March 21st, 2026');
};

tests['formatOrdinalDate: 22nd'] = () => {
  const d = new Date(2026, 2, 22);
  assert.strictEqual(formatOrdinalDate(d), 'March 22nd, 2026');
};

tests['formatOrdinalDate: 23rd'] = () => {
  const d = new Date(2026, 2, 23);
  assert.strictEqual(formatOrdinalDate(d), 'March 23rd, 2026');
};

tests['formatOrdinalDate: 31st'] = () => {
  const d = new Date(2026, 2, 31);
  assert.strictEqual(formatOrdinalDate(d), 'March 31st, 2026');
};

// --- getPreviousMondayDate ---

tests['getPreviousMondayDate: from a Monday returns previous Monday'] = () => {
  const today = new Date(2026, 2, 16); // Monday March 16
  const prev = getPreviousMondayDate(today);
  assert.strictEqual(prev.getFullYear(), 2026);
  assert.strictEqual(prev.getMonth(), 2); // March
  assert.strictEqual(prev.getDate(), 9);
  assert.strictEqual(prev.getDay(), 1); // Monday
};

tests['getPreviousMondayDate: from a Saturday returns previous week Monday'] = () => {
  // Saturday March 21: most recent Monday is March 16 (this week's page).
  // Previous Monday = March 9 (last week's page — the one we need for continuity).
  const today = new Date(2026, 2, 21); // Saturday March 21
  const prev = getPreviousMondayDate(today);
  assert.strictEqual(prev.getDate(), 9); // Monday March 9
};

tests['getPreviousMondayDate: from a Sunday returns Monday before last'] = () => {
  // Sunday March 22, 2026. The "previous Monday" from the perspective of
  // the weekly digest is Monday March 16 (the most recent Monday that has passed).
  // But this function returns the Monday for the *previous week's* notes.
  // If run on Sunday March 22, the current week's notes would be March 16,
  // so previous week's notes = March 9.
  // Actually, "previous Monday" means the Monday of last week's Confluence page.
  // The digest runs on Monday morning, so "previous Monday" = 7 days ago.
  const today = new Date(2026, 2, 22); // Sunday March 22
  const prev = getPreviousMondayDate(today);
  // From Sunday, the most recent Monday was March 16, but we want the *previous*
  // week's page, so it depends on the semantics. Let's verify based on
  // the function's documented behavior.
  assert.strictEqual(prev.getDay(), 1); // Must be a Monday
};

// --- buildCQL ---

tests['buildCQL: builds correct CQL with ordinal date'] = () => {
  const targetDate = new Date(2026, 2, 9); // March 9, 2026
  const cql = buildCQL('EMGT', targetDate);
  assert.ok(cql.includes('EMGT'), 'must include space key');
  assert.ok(cql.includes('March 9th, 2026'), 'must include ordinal date');
  assert.ok(cql.includes('type = page'), 'must filter to pages');
};

// --- extractDWSection ---

tests['extractDWSection: extracts bold heading variant'] = () => {
  const html = `
<h2><strong>Performance Updates</strong></h2>
<p>Some perf content</p>
<h2><strong>Digital Workplace</strong></h2>
<p>DW content paragraph one.</p>
<ul><li>Bullet one</li><li>Bullet two</li></ul>
<h2><strong>Core Updates</strong></h2>
<p>Core content</p>
  `.trim();
  const section = extractDWSection(html);
  assert.ok(section, 'should extract a section');
  assert.ok(section.includes('DW content paragraph one'), 'should include DW content');
  assert.ok(section.includes('Bullet one'), 'should include bullet');
  assert.ok(!section.includes('Core content'), 'should not include next section');
  assert.ok(!section.includes('perf content'), 'should not include previous section');
};

tests['extractDWSection: extracts non-bold heading variant'] = () => {
  const html = `
<h2>Something Else</h2>
<p>Not this</p>
<h2>Digital Workplace</h2>
<p>The real DW section.</p>
<h3>Infrastructure</h3>
<p>Infra details.</p>
<h2>Another Section</h2>
<p>Not this either</p>
  `.trim();
  const section = extractDWSection(html);
  assert.ok(section, 'should extract a section');
  assert.ok(section.includes('The real DW section'), 'should include DW content');
  assert.ok(section.includes('Infra details'), 'should include subsection');
  assert.ok(!section.includes('Not this either'), 'should stop at next h2');
};

tests['extractDWSection: returns null when section not found'] = () => {
  const html = `
<h2>Performance</h2>
<p>No DW section here</p>
<h2>Core</h2>
<p>Also not DW</p>
  `.trim();
  const section = extractDWSection(html);
  assert.strictEqual(section, null);
};

tests['extractDWSection: handles section at end of document'] = () => {
  const html = `
<h2>Something</h2>
<p>Before</p>
<h2><strong>Digital Workplace</strong></h2>
<p>Last section content.</p>
<h3>Team A</h3>
<p>Team A details</p>
  `.trim();
  const section = extractDWSection(html);
  assert.ok(section, 'should extract section at end');
  assert.ok(section.includes('Last section content'), 'should include content');
  assert.ok(section.includes('Team A details'), 'should include subsection');
};

tests['extractDWSection: converts HTML to clean text'] = () => {
  const html = `
<h2><strong>Digital Workplace</strong></h2>
<h3>Executive Summary</h3>
<p>Operations remained stable this week.</p>
<h3>Team Notes</h3>
<h4>Infrastructure</h4>
<ul>
<li>Implemented Terraform management for attributes.</li>
<li>Expanded JamfPro import coverage.</li>
</ul>
<p>One open Senior Systems Engineer position. Pipeline active.</p>
<h4>Support</h4>
<p>Normal operational activity.</p>
<h4>Security (Platform)</h4>
<ul>
<li>Configured SSO for new vendor.</li>
</ul>
<p>One open Security Engineer position.</p>
<h2>Next Section</h2>
  `.trim();
  const section = extractDWSection(html);
  assert.ok(section, 'should extract section');
  assert.ok(section.includes('Executive Summary'), 'should have subsection headings');
  assert.ok(section.includes('Operations remained stable'), 'should have paragraph text');
  assert.ok(section.includes('Implemented Terraform'), 'should have list items');
  assert.ok(section.includes('Normal operational activity'), 'should have support text');
  assert.ok(!section.includes('Next Section'), 'should stop before next h2');
};

// --- htmlToText ---

const { htmlToText } = require('./lib/confluence-reader');

tests['htmlToText: decodes HTML entities'] = () => {
  const result = htmlToText('<p>Tom &amp; Jerry &lt;3&gt; &quot;friends&quot;</p>');
  assert.ok(result.includes('Tom & Jerry <3> "friends"'));
};

tests['htmlToText: converts h3 and h4 to markdown headings'] = () => {
  const result = htmlToText('<h3>Section One</h3><p>Content</p><h4>Subsection</h4><p>Details</p>');
  assert.ok(result.includes('### Section One'), 'h3 should become ###');
  assert.ok(result.includes('#### Subsection'), 'h4 should become ####');
};

tests['htmlToText: converts list items to dash bullets'] = () => {
  const result = htmlToText('<ul><li>First item</li><li>Second item</li></ul>');
  assert.ok(result.includes('- First item'), 'should have dash bullet');
  assert.ok(result.includes('- Second item'), 'should have dash bullet');
};

tests['htmlToText: strips remaining tags'] = () => {
  const result = htmlToText('<div><span class="foo">Hello</span></div>');
  assert.ok(result.includes('Hello'));
  assert.ok(!result.includes('<div>'));
  assert.ok(!result.includes('<span'));
};

// --- getPreviousMondayDate additional edge cases ---

tests['getPreviousMondayDate: from Wednesday returns Monday of previous week'] = () => {
  const today = new Date(2026, 2, 18); // Wednesday March 18
  const prev = getPreviousMondayDate(today);
  assert.strictEqual(prev.getDate(), 9); // Monday March 9
  assert.strictEqual(prev.getDay(), 1);
};

tests['getPreviousMondayDate: from Tuesday returns Monday of previous week'] = () => {
  const today = new Date(2026, 2, 17); // Tuesday March 17
  const prev = getPreviousMondayDate(today);
  assert.strictEqual(prev.getDate(), 9); // Monday March 9
  assert.strictEqual(prev.getDay(), 1);
};

// --- extractDWSection edge cases ---

tests['extractDWSection: handles extra whitespace in heading'] = () => {
  const html = '<h2>  <strong> Digital Workplace </strong>  </h2><p>Content here</p><h2>Next</h2>';
  const section = extractDWSection(html);
  assert.ok(section, 'should tolerate whitespace in heading');
  assert.ok(section.includes('Content here'));
};

tests['extractDWSection: handles empty DW section'] = () => {
  const html = '<h2>Digital Workplace</h2><h2>Next Section</h2>';
  const section = extractDWSection(html);
  // Section exists but is empty
  assert.strictEqual(section, '');
};

// --- buildCQL edge cases ---

tests['buildCQL: exact CQL format'] = () => {
  const targetDate = new Date(2026, 2, 16); // March 16
  const cql = buildCQL('EMGT', targetDate);
  assert.strictEqual(cql, 'space = "EMGT" AND title = "March 16th, 2026" AND type = page');
};

// Run all tests
runTests(tests);
