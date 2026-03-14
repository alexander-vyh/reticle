'use strict';

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests (file-based, not :memory:, per project convention)
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-settings-migration-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

// --- Test: monitored_people has all new columns ---
{
  const db = reticleDb.initDatabase();

  const cols = db.pragma('table_info(monitored_people)').map(c => c.name);

  assert.ok(cols.includes('role'), `missing column: role (got: ${cols.join(', ')})`);
  assert.ok(cols.includes('escalation_tier'), `missing column: escalation_tier`);
  assert.ok(cols.includes('title'), `missing column: title`);
  assert.ok(cols.includes('team'), `missing column: team`);

  console.log('PASS: monitored_people has role, escalation_tier, title, team columns');
  db.close();
}

// --- Test: role defaults to 'peer' ---
{
  // Re-use same DB path (already initialized above — test migration path)
  const db = reticleDb.initDatabase();

  db.prepare(`INSERT INTO monitored_people (email, name) VALUES (?, ?)`).run('test@example.com', 'Test User');
  const row = db.prepare(`SELECT * FROM monitored_people WHERE email = ?`).get('test@example.com');

  assert.strictEqual(row.role, 'peer', `expected role='peer', got '${row.role}'`);
  console.log("PASS: role defaults to 'peer'");
  db.close();
}

// --- Test: escalation_tier defaults to NULL ---
{
  const db = reticleDb.initDatabase();

  const row = db.prepare(`SELECT * FROM monitored_people WHERE email = ?`).get('test@example.com');

  assert.strictEqual(row.escalation_tier, null, `expected escalation_tier=null, got '${row.escalation_tier}'`);
  console.log('PASS: escalation_tier defaults to NULL');
  db.close();
}

// --- Test: title and team default to NULL ---
{
  const db = reticleDb.initDatabase();

  const row = db.prepare(`SELECT * FROM monitored_people WHERE email = ?`).get('test@example.com');

  assert.strictEqual(row.title, null, `expected title=null, got '${row.title}'`);
  assert.strictEqual(row.team, null, `expected team=null, got '${row.team}'`);
  console.log('PASS: title and team default to NULL');
  db.close();
}

// --- Task 2: People Store — Role-Aware Query Functions ---

const { addPerson, listPeopleByRole, getVipEmails, getDirectReports, listTeamMembers, updatePerson } = require('./lib/people-store');

// --- Test: addPerson accepts role and title ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'vip@example.com', name: 'VIP User', role: 'vip', title: 'CEO', team: null });
  const row = db.prepare('SELECT * FROM monitored_people WHERE email = ?').get('vip@example.com');

  assert.strictEqual(row.role, 'vip', `expected role='vip', got '${row.role}'`);
  assert.strictEqual(row.title, 'CEO', `expected title='CEO', got '${row.title}'`);
  console.log('PASS: addPerson accepts role and title');
  db.close();
}

// --- Test: addPerson upsert preserves existing name when null passed ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'vip@example.com', name: null, role: 'vip', title: 'Chairman', team: null });
  const row = db.prepare('SELECT * FROM monitored_people WHERE email = ?').get('vip@example.com');

  assert.strictEqual(row.name, 'VIP User', `expected name to be preserved, got '${row.name}'`);
  assert.strictEqual(row.title, 'Chairman', `expected title='Chairman', got '${row.title}'`);
  console.log('PASS: addPerson upsert preserves existing name when null passed');
  db.close();
}

// --- Test: listPeopleByRole filters correctly ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'dr1@example.com', name: 'Direct One', role: 'direct_report' });
  addPerson(db, { email: 'dr2@example.com', name: 'Direct Two', role: 'direct_report' });
  addPerson(db, { email: 'peer1@example.com', name: 'Peer One', role: 'peer' });

  const directs = listPeopleByRole(db, 'direct_report');
  assert.strictEqual(directs.length, 2, `expected 2 direct reports, got ${directs.length}`);
  assert.ok(directs.every(r => r.role === 'direct_report'), 'all results should have role=direct_report');

  console.log('PASS: listPeopleByRole filters correctly');
  db.close();
}

// --- Test: getVipEmails returns lowercase emails ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'VIP@Example.COM', name: 'Uppercase VIP', role: 'vip' });
  addPerson(db, { email: 'notavip@example.com', name: 'Not a VIP', role: 'peer' });

  const emails = getVipEmails(db);
  assert.ok(emails.includes('vip@example.com'), `expected vip@example.com in results, got ${JSON.stringify(emails)}`);
  assert.ok(!emails.includes('notavip@example.com'), 'non-VIP should not appear');
  assert.ok(emails.every(e => e === e.toLowerCase()), 'all emails should be lowercase');

  console.log('PASS: getVipEmails returns lowercase emails');
  db.close();
}

// --- Test: getDirectReports returns rows with slack_id accessible ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'dr1@example.com', name: 'Direct One', role: 'direct_report' });
  const { updateSlackId } = require('./lib/people-store');
  updateSlackId(db, 'dr1@example.com', 'U_DR1');

  const reports = getDirectReports(db);
  assert.ok(reports.length >= 1, 'should return at least one direct report');
  const dr = reports.find(r => r.email === 'dr1@example.com');
  assert.ok(dr, 'dr1@example.com should be in direct reports');
  assert.strictEqual(dr.slack_id, 'U_DR1', `expected slack_id='U_DR1', got '${dr.slack_id}'`);

  console.log('PASS: getDirectReports returns rows with slack_id accessible');
  db.close();
}

// --- Test: listTeamMembers returns only team-affiliated peers ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'tmember@example.com', name: 'Team Member', role: 'peer', team: 'Engineering' });
  addPerson(db, { email: 'noteam@example.com', name: 'No Team', role: 'peer', team: null });
  addPerson(db, { email: 'drteam@example.com', name: 'DR With Team', role: 'direct_report', team: 'Engineering' });

  const members = listTeamMembers(db);
  const emails = members.map(m => m.email);
  assert.ok(emails.includes('tmember@example.com'), 'team peer should be included');
  assert.ok(!emails.includes('noteam@example.com'), 'no-team peer should be excluded');
  assert.ok(!emails.includes('drteam@example.com'), 'direct_report should be excluded even with team');

  console.log('PASS: listTeamMembers returns only team-affiliated peers');
  db.close();
}

// --- Test: updatePerson patches specific fields ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'patch@example.com', name: 'Original', role: 'peer', title: null, team: null });
  updatePerson(db, 'patch@example.com', { title: 'Staff Engineer', team: 'Platform' });

  const row = db.prepare('SELECT * FROM monitored_people WHERE email = ?').get('patch@example.com');
  assert.strictEqual(row.title, 'Staff Engineer', `expected title='Staff Engineer', got '${row.title}'`);
  assert.strictEqual(row.team, 'Platform', `expected team='Platform', got '${row.team}'`);
  assert.strictEqual(row.name, 'Original', `name should be unchanged, got '${row.name}'`);
  assert.strictEqual(row.role, 'peer', `role should be unchanged, got '${row.role}'`);

  console.log('PASS: updatePerson patches specific fields without clobbering others');
  db.close();
}

// --- Test: updatePerson ignores unknown fields ---
{
  const db = reticleDb.initDatabase();

  addPerson(db, { email: 'patch2@example.com', name: 'Safe', role: 'peer' });
  // Should not throw, but should not apply unknown fields
  updatePerson(db, 'patch2@example.com', { unknown_col: 'bad', name: 'Safe Updated' });

  const row = db.prepare('SELECT * FROM monitored_people WHERE email = ?').get('patch2@example.com');
  assert.strictEqual(row.name, 'Safe Updated', `expected name='Safe Updated', got '${row.name}'`);

  console.log('PASS: updatePerson ignores unknown fields');
  db.close();
}

console.log('\nAll settings migration tests passed.');
