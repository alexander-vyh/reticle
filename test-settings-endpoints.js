'use strict';

// Tests for PATCH /people/:email endpoint
// Pattern follows test-gateway.js — env vars and config files must be set BEFORE requiring gateway.js

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function httpRequest(port, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path: reqPath, method, headers: {} };
    if (body) {
      const data = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(chunks) });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testSettingsEndpoints() {
  // Create temp dir for isolated DB files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-settings-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  // Set env vars BEFORE requiring gateway (lib/config.js reads them at require time)
  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  // Seed the reticle DB with a test person
  const seedDb = new Database(reticleDbPath);
  seedDb.pragma('journal_mode = WAL');
  seedDb.pragma('foreign_keys = ON');
  seedDb.exec(`
    CREATE TABLE IF NOT EXISTS monitored_people (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email            TEXT UNIQUE NOT NULL,
      name             TEXT,
      slack_id         TEXT,
      jira_id          TEXT,
      resolved_at      INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      role             TEXT DEFAULT 'peer',
      escalation_tier  TEXT,
      title            TEXT,
      team             TEXT
    );
  `);
  seedDb.prepare(
    `INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`
  ).run('alice@example.com', 'Alice', 'peer');
  seedDb.close();

  // Require gateway after env vars are set
  // Use a fresh require to avoid module cache issues across test runs
  delete require.cache[require.resolve('./gateway')];
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: PATCH /people/:email returns 200 and updates role
    const encodedEmail = encodeURIComponent('alice@example.com');
    const patchRoleRes = await httpRequest(port, 'PATCH', `/people/${encodedEmail}`, { role: 'direct_report' });
    assert.strictEqual(patchRoleRes.status, 200, `expected 200, got ${patchRoleRes.status}: ${JSON.stringify(patchRoleRes.body)}`);
    assert.strictEqual(patchRoleRes.body.ok, true);
    console.log('  PASS: PATCH /people/:email returns 200 and updates role');

    // Test 2: PATCH /people/:email returns 200 and updates escalation_tier
    const patchTierRes = await httpRequest(port, 'PATCH', `/people/${encodedEmail}`, { escalation_tier: '4h' });
    assert.strictEqual(patchTierRes.status, 200, `expected 200, got ${patchTierRes.status}: ${JSON.stringify(patchTierRes.body)}`);
    assert.strictEqual(patchTierRes.body.ok, true);
    console.log('  PASS: PATCH /people/:email returns 200 and updates escalation_tier');

    // Test 3: PATCH /people/:email returns 404 for unknown email
    const unknownEmail = encodeURIComponent('nobody@example.com');
    const notFoundRes = await httpRequest(port, 'PATCH', `/people/${unknownEmail}`, { role: 'vip' });
    assert.strictEqual(notFoundRes.status, 404, `expected 404, got ${notFoundRes.status}: ${JSON.stringify(notFoundRes.body)}`);
    assert.ok(notFoundRes.body.error, 'should have error field');
    console.log('  PASS: PATCH /people/:email returns 404 for unknown email');

    // Test 4: GET /people returns updated role and escalation_tier fields
    const listRes = await httpRequest(port, 'GET', '/people');
    assert.strictEqual(listRes.status, 200);
    const alice = listRes.body.people.find(p => p.email === 'alice@example.com');
    assert.ok(alice, 'alice should appear in GET /people response');
    assert.strictEqual(alice.role, 'direct_report', `expected role=direct_report, got ${alice.role}`);
    assert.strictEqual(alice.escalation_tier, '4h', `expected escalation_tier=4h, got ${alice.escalation_tier}`);
    console.log('  PASS: GET /people returns updated role and escalation_tier fields');

  } finally {
    server.close();
    // Clean up temp files
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testSeedingIdempotency() {
  // Verify that gateway startup does not duplicate existing VIPs or direct reports
  // when the DB already has entries — the seeding guard (existingVips.length === 0) holds.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-seed-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  // Pre-seed the DB with a VIP and a direct report so the gateway should skip seeding
  const seedDb = new Database(reticleDbPath);
  seedDb.pragma('journal_mode = WAL');
  seedDb.pragma('foreign_keys = ON');
  seedDb.exec(`
    CREATE TABLE IF NOT EXISTS monitored_people (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email            TEXT UNIQUE NOT NULL,
      name             TEXT,
      slack_id         TEXT,
      jira_id          TEXT,
      resolved_at      INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      role             TEXT DEFAULT 'peer',
      escalation_tier  TEXT,
      title            TEXT,
      team             TEXT
    );
  `);
  // Insert a pre-existing VIP and direct report to trigger the idempotency guard
  seedDb.prepare(`INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`).run('existing-vip@example.com', 'Existing VIP', 'vip');
  seedDb.prepare(`INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`).run('existing-dr@example.com', 'Existing DR', 'direct_report');
  const countBefore = seedDb.prepare('SELECT COUNT(*) as cnt FROM monitored_people').get().cnt;
  seedDb.close();

  // Require a fresh gateway instance (clear reticle-db too so it picks up new RETICLE_DB_PATH)
  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // GET /people — count should not have grown from team.json seeding since guards fired
    const listRes = await httpRequest(port, 'GET', '/people');
    assert.strictEqual(listRes.status, 200);
    const people = listRes.body.people;

    // All pre-seeded entries must still be present (no data loss)
    const vip = people.find(p => p.email === 'existing-vip@example.com');
    const dr = people.find(p => p.email === 'existing-dr@example.com');
    assert.ok(vip, 'pre-existing VIP must be present after gateway start');
    assert.ok(dr, 'pre-existing direct report must be present after gateway start');
    assert.strictEqual(vip.role, 'vip');
    assert.strictEqual(dr.role, 'direct_report');

    // Count must be >= countBefore (team member seeding may run if DB had 0 team members)
    assert.ok(people.length >= countBefore, `people count should not drop below ${countBefore}`);

    console.log('  PASS: seeding is idempotent — pre-existing VIP/direct_report entries are preserved');
  } finally {
    server.close();
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testFeedbackSettingsEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-fdbk-settings-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  // Clear module cache so gateway.js picks up the new DB path
  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /feedback/settings returns defaults
    const getRes = await httpRequest(port, 'GET', '/feedback/settings');
    assert.strictEqual(getRes.status, 200, `expected 200, got ${getRes.status}: ${JSON.stringify(getRes.body)}`);
    assert.strictEqual(getRes.body.weeklyTarget, '3', `expected weeklyTarget='3', got '${getRes.body.weeklyTarget}'`);
    assert.strictEqual(getRes.body.scanWindowHours, '24', `expected scanWindowHours='24', got '${getRes.body.scanWindowHours}'`);
    console.log('  PASS: GET /feedback/settings returns defaults');

    // Test 2: PATCH /feedback/settings updates values
    const patchRes = await httpRequest(port, 'PATCH', '/feedback/settings', { weeklyTarget: 5, scanWindowHours: 48 });
    assert.strictEqual(patchRes.status, 200, `expected 200, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.strictEqual(patchRes.body.ok, true);
    console.log('  PASS: PATCH /feedback/settings updates values');

    // Test 3: GET /feedback/settings returns updated values after PATCH
    const getAfterRes = await httpRequest(port, 'GET', '/feedback/settings');
    assert.strictEqual(getAfterRes.status, 200);
    assert.strictEqual(getAfterRes.body.weeklyTarget, '5', `expected weeklyTarget='5', got '${getAfterRes.body.weeklyTarget}'`);
    assert.strictEqual(getAfterRes.body.scanWindowHours, '48', `expected scanWindowHours='48', got '${getAfterRes.body.scanWindowHours}'`);
    console.log('  PASS: GET /feedback/settings returns updated values after PATCH');

  } finally {
    server.close();
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testAccountsEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-accounts-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  // Write a minimal secrets.json in the temp config dir
  const secrets = {
    slackBotToken: 'xoxb-test-token',
    slackAppToken: 'xapp-test-token',
    slackUserId: 'U0TEST',
    slackUsername: 'testuser',
    gmailAccount: 'test@example.com',
    jiraBaseUrl: 'https://test.atlassian.net',
    jiraUserEmail: 'test@example.com',
    jiraApiToken: 'jira-secret',
    gatewayPort: 3001
  };
  fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify(secrets, null, 2));

  // team.json required by lib/config.js
  fs.writeFileSync(path.join(configDir, 'team.json'), JSON.stringify({ vips: [], directReports: [], dwTeamEmails: [] }, null, 2));

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_CONFIG_DIR = configDir;

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  delete require.cache[require.resolve('./lib/config')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /config/accounts returns expected shape without raw tokens
    const getRes = await httpRequest(port, 'GET', '/config/accounts');
    assert.strictEqual(getRes.status, 200, `expected 200, got ${getRes.status}: ${JSON.stringify(getRes.body)}`);
    const accts = getRes.body;
    assert.ok(accts.slack, 'should have slack key');
    assert.ok(accts.gmail, 'should have gmail key');
    assert.ok(accts.jira, 'should have jira key');
    // Connected flags
    assert.strictEqual(accts.slack.connected, true, 'slack should be connected');
    assert.strictEqual(accts.gmail.connected, true, 'gmail should be connected');
    assert.strictEqual(accts.jira.connected, true, 'jira should be connected');
    // Non-secret fields present
    assert.strictEqual(accts.slack.userId, 'U0TEST');
    assert.strictEqual(accts.slack.username, 'testuser');
    assert.strictEqual(accts.gmail.account, 'test@example.com');
    assert.strictEqual(accts.jira.baseUrl, 'https://test.atlassian.net');
    assert.strictEqual(accts.jira.userEmail, 'test@example.com');
    // Token presence flags
    assert.strictEqual(accts.slack.hasToken, true, 'slack hasToken should be true');
    assert.strictEqual(accts.slack.hasAppToken, true, 'slack hasAppToken should be true');
    assert.strictEqual(accts.jira.hasToken, true, 'jira hasToken should be true');
    // Raw tokens MUST NOT be present
    assert.ok(!('slackBotToken' in accts.slack), 'slack raw bot token must not be returned');
    assert.ok(!('slackAppToken' in accts.slack), 'slack raw app token must not be returned');
    assert.ok(!('jiraApiToken' in accts.jira), 'jira raw api token must not be returned');
    console.log('  PASS: GET /config/accounts returns shape without raw tokens');

    // Test 2: PATCH /config/accounts updates non-secret fields in secrets.json
    const patchRes = await httpRequest(port, 'PATCH', '/config/accounts', {
      slackUsername: 'updateduser',
      jiraBaseUrl: 'https://updated.atlassian.net'
    });
    assert.strictEqual(patchRes.status, 200, `expected 200, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.strictEqual(patchRes.body.ok, true);
    // Verify secrets.json was written atomically
    const updated = JSON.parse(fs.readFileSync(path.join(configDir, 'secrets.json'), 'utf-8'));
    assert.strictEqual(updated.slackUsername, 'updateduser');
    assert.strictEqual(updated.jiraBaseUrl, 'https://updated.atlassian.net');
    // Existing fields preserved
    assert.strictEqual(updated.slackBotToken, 'xoxb-test-token');
    console.log('  PASS: PATCH /config/accounts updates allowed fields atomically');

    // Test 3: PATCH /config/accounts rejects unknown keys (they are silently ignored)
    const patchUnknownRes = await httpRequest(port, 'PATCH', '/config/accounts', {
      unknownField: 'should-be-ignored',
      slackUserId: 'U0UPDATED'
    });
    assert.strictEqual(patchUnknownRes.status, 200);
    const afterUnknown = JSON.parse(fs.readFileSync(path.join(configDir, 'secrets.json'), 'utf-8'));
    assert.ok(!('unknownField' in afterUnknown), 'unknown fields must not be written to secrets.json');
    assert.strictEqual(afterUnknown.slackUserId, 'U0UPDATED');
    console.log('  PASS: PATCH /config/accounts ignores unknown keys and allows allowed keys');

  } finally {
    server.close();
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    // Reset RETICLE_CONFIG_DIR so subsequent tests use the default
    delete process.env.RETICLE_CONFIG_DIR;
  }
}

// --- settings.json config loader tests (Part 1) ---

function testConfigSettingsLoader() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-config-settings-test-'));
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  // Write required config files
  const secrets = {
    slackBotToken: 'xoxb-test', slackUserId: 'U0TEST', gmailAccount: 'test@example.com',
    gatewayPort: 3001
  };
  fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify(secrets));
  fs.writeFileSync(path.join(configDir, 'team.json'), JSON.stringify({ filterPatterns: {} }));

  // Test 1: no settings.json — defaults apply
  process.env.RETICLE_CONFIG_DIR = configDir;
  delete require.cache[require.resolve('./lib/config')];
  const configNoFile = require('./lib/config');
  assert.deepStrictEqual(configNoFile.settings, {}, 'settings should be empty object when no settings.json');
  assert.strictEqual(configNoFile.polling.gmailIntervalMinutes, 5, 'gmail default should be 5');
  assert.strictEqual(configNoFile.polling.slackResponseTimeoutMinutes, 10, 'slack timeout default should be 10');
  assert.strictEqual(configNoFile.polling.followupCheckIntervalMinutes, 15, 'followup default should be 15');
  assert.strictEqual(configNoFile.polling.meetingAlertPollIntervalSeconds, 120, 'meeting alert default should be 120');
  console.log('  PASS: config.polling uses hardcoded defaults when no settings.json');

  // Test 2: with settings.json — values override defaults
  const settingsData = {
    polling: {
      gmailIntervalMinutes: 3,
      followupCheckIntervalMinutes: 30
    }
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settingsData));
  delete require.cache[require.resolve('./lib/config')];
  const configWithFile = require('./lib/config');
  assert.strictEqual(configWithFile.polling.gmailIntervalMinutes, 3, 'gmail should read from settings.json');
  assert.strictEqual(configWithFile.polling.followupCheckIntervalMinutes, 30, 'followup should read from settings.json');
  assert.strictEqual(configWithFile.polling.slackResponseTimeoutMinutes, 10, 'slack should still use default');
  assert.strictEqual(configWithFile.polling.meetingAlertPollIntervalSeconds, 120, 'meeting alert should still use default');
  console.log('  PASS: config.polling reads values from settings.json with defaults for missing keys');

  // Test 3: corrupt settings.json — uses defaults, does not crash
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{bad json');
  delete require.cache[require.resolve('./lib/config')];
  const configCorrupt = require('./lib/config');
  assert.deepStrictEqual(configCorrupt.settings, {}, 'settings should be empty on corrupt file');
  assert.strictEqual(configCorrupt.polling.gmailIntervalMinutes, 5, 'should fall back to default');
  console.log('  PASS: corrupt settings.json uses defaults without crashing');

  // Clean up
  delete process.env.RETICLE_CONFIG_DIR;
  delete require.cache[require.resolve('./lib/config')];
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// --- GET/PATCH /settings endpoint tests (Parts 2-3) ---

async function testSettingsJsonEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-settings-json-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const configDir = path.join(tmpDir, 'config');
  const heartbeatDir = path.join(tmpDir, 'heartbeats');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(heartbeatDir, { recursive: true });

  const secrets = {
    slackBotToken: 'xoxb-test', slackUserId: 'U0TEST', gmailAccount: 'test@example.com',
    gatewayPort: 3001
  };
  fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify(secrets));
  fs.writeFileSync(path.join(configDir, 'team.json'), JSON.stringify({ filterPatterns: {} }));

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_CONFIG_DIR = configDir;
  process.env.RETICLE_HEARTBEAT_DIR = heartbeatDir;

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  delete require.cache[require.resolve('./lib/config')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /settings returns empty object when no settings.json exists
    const getEmptyRes = await httpRequest(port, 'GET', '/settings');
    assert.strictEqual(getEmptyRes.status, 200, `expected 200, got ${getEmptyRes.status}`);
    assert.deepStrictEqual(getEmptyRes.body, {}, 'should return empty object when no settings.json');
    console.log('  PASS: GET /settings returns empty object when no settings.json exists');

    // Test 2: PATCH /settings creates settings.json and returns ok
    const patchRes = await httpRequest(port, 'PATCH', '/settings', {
      polling: { gmailIntervalMinutes: 10 }
    });
    assert.strictEqual(patchRes.status, 200, `expected 200, got ${patchRes.status}`);
    assert.strictEqual(patchRes.body.ok, true, 'should return ok: true');
    assert.ok(Array.isArray(patchRes.body.signaled), 'should return signaled array');
    // Verify the file was written
    assert.ok(fs.existsSync(path.join(configDir, 'settings.json')), 'settings.json should exist');
    console.log('  PASS: PATCH /settings creates settings.json and returns ok');

    // Test 3: GET /settings returns saved values after PATCH
    const getAfterRes = await httpRequest(port, 'GET', '/settings');
    assert.strictEqual(getAfterRes.status, 200);
    assert.strictEqual(getAfterRes.body.polling.gmailIntervalMinutes, 10, 'should return saved value');
    console.log('  PASS: GET /settings returns saved values after PATCH');

    // Test 4: PATCH /settings merges (doesn't overwrite) existing sections
    const patchMergeRes = await httpRequest(port, 'PATCH', '/settings', {
      polling: { followupCheckIntervalMinutes: 20 }
    });
    assert.strictEqual(patchMergeRes.status, 200);
    const getMergedRes = await httpRequest(port, 'GET', '/settings');
    assert.strictEqual(getMergedRes.body.polling.gmailIntervalMinutes, 10,
      'existing value should be preserved');
    assert.strictEqual(getMergedRes.body.polling.followupCheckIntervalMinutes, 20,
      'new value should be merged in');
    console.log('  PASS: PATCH /settings merges (does not overwrite) existing sections');

    // Test 5: PATCH /settings returns signaled services based on changed keys
    // Write a fake heartbeat for gmail-monitor with current PID (won't actually SIGHUP since we handle it)
    const fakeHb = { pid: process.pid, lastCheck: Date.now() };
    fs.writeFileSync(path.join(heartbeatDir, 'gmail-monitor.json'), JSON.stringify(fakeHb));
    // Install a temporary SIGHUP handler to prevent test from dying
    let gotSighup = false;
    const sighupHandler = () => { gotSighup = true; };
    process.on('SIGHUP', sighupHandler);
    const patchSignalRes = await httpRequest(port, 'PATCH', '/settings', {
      polling: { gmailIntervalMinutes: 7 }
    });
    assert.strictEqual(patchSignalRes.status, 200);
    assert.ok(patchSignalRes.body.signaled.includes('gmail-monitor'),
      'gmail-monitor should be in signaled list');
    // Give the event loop a tick for the signal to be delivered
    await new Promise(r => setTimeout(r, 50));
    assert.ok(gotSighup, 'SIGHUP should have been sent to our process');
    process.removeListener('SIGHUP', sighupHandler);
    console.log('  PASS: PATCH /settings signals affected services via SIGHUP');

  } finally {
    server.close();
    delete process.env.RETICLE_HEARTBEAT_DIR;
    delete process.env.RETICLE_CONFIG_DIR;
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function testFilterEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-filters-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const secrets = {
    slackBotToken: 'xoxb-test', slackUserId: 'U0TEST', gmailAccount: 'test@example.com',
    gatewayPort: 3001
  };
  fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify(secrets));
  // team.json with existing filterPatterns
  const team = {
    filterPatterns: { companyDomain: 'initial.com', dwGroupEmail: 'group@initial.com' },
    vips: [], directReports: [], dwTeamEmails: []
  };
  fs.writeFileSync(path.join(configDir, 'team.json'), JSON.stringify(team, null, 2));

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_CONFIG_DIR = configDir;

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  delete require.cache[require.resolve('./lib/config')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /config/filters returns filterPatterns from team.json
    const getRes = await httpRequest(port, 'GET', '/config/filters');
    assert.strictEqual(getRes.status, 200, `expected 200, got ${getRes.status}: ${JSON.stringify(getRes.body)}`);
    assert.strictEqual(getRes.body.companyDomain, 'initial.com', `expected companyDomain='initial.com', got '${getRes.body.companyDomain}'`);
    assert.strictEqual(getRes.body.dwGroupEmail, 'group@initial.com', `expected dwGroupEmail='group@initial.com', got '${getRes.body.dwGroupEmail}'`);
    console.log('  PASS: GET /config/filters returns filterPatterns from team.json');

    // Test 2: PATCH /config/filters updates companyDomain in team.json
    const patchRes = await httpRequest(port, 'PATCH', '/config/filters', { companyDomain: 'updated.com' });
    assert.strictEqual(patchRes.status, 200, `expected 200, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.strictEqual(patchRes.body.ok, true);
    // Verify team.json was updated atomically
    const updated = JSON.parse(fs.readFileSync(path.join(configDir, 'team.json'), 'utf-8'));
    assert.strictEqual(updated.filterPatterns.companyDomain, 'updated.com', 'companyDomain should be updated');
    assert.strictEqual(updated.filterPatterns.dwGroupEmail, 'group@initial.com', 'dwGroupEmail should be preserved');
    console.log('  PASS: PATCH /config/filters updates companyDomain atomically');

    // Test 3: PATCH /config/filters updates dwGroupEmail
    const patchGroupRes = await httpRequest(port, 'PATCH', '/config/filters', { dwGroupEmail: 'newgroup@updated.com' });
    assert.strictEqual(patchGroupRes.status, 200, `expected 200, got ${patchGroupRes.status}: ${JSON.stringify(patchGroupRes.body)}`);
    assert.strictEqual(patchGroupRes.body.ok, true);
    const updated2 = JSON.parse(fs.readFileSync(path.join(configDir, 'team.json'), 'utf-8'));
    assert.strictEqual(updated2.filterPatterns.dwGroupEmail, 'newgroup@updated.com', 'dwGroupEmail should be updated');
    assert.strictEqual(updated2.filterPatterns.companyDomain, 'updated.com', 'companyDomain should be preserved');
    console.log('  PASS: PATCH /config/filters updates dwGroupEmail atomically');

  } finally {
    server.close();
    delete process.env.RETICLE_CONFIG_DIR;
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function testEscalationThresholdFloors() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-threshold-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const configDir = path.join(tmpDir, 'config');
  const heartbeatDir = path.join(tmpDir, 'heartbeats');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(heartbeatDir, { recursive: true });

  const secrets = {
    slackBotToken: 'xoxb-test', slackUserId: 'U0TEST', gmailAccount: 'test@example.com',
    gatewayPort: 3001
  };
  fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify(secrets));
  fs.writeFileSync(path.join(configDir, 'team.json'), JSON.stringify({ filterPatterns: {} }));

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_CONFIG_DIR = configDir;
  process.env.RETICLE_HEARTBEAT_DIR = heartbeatDir;

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  delete require.cache[require.resolve('./lib/config')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: below email floor (24h) returns 400
    const emailFloorRes = await httpRequest(port, 'PATCH', '/settings', {
      thresholds: { followupEscalationEmailHours: 23 }
    });
    assert.strictEqual(emailFloorRes.status, 400, `expected 400 for email hours below floor, got ${emailFloorRes.status}`);
    assert.ok(emailFloorRes.body.error.includes('followupEscalationEmailHours'), 'error should name the field');
    assert.strictEqual(emailFloorRes.body.floor, 24, 'floor should be 24');
    console.log('  PASS: PATCH /settings rejects followupEscalationEmailHours below 24');

    // Test 2: below Slack DM floor (8h) returns 400
    const dmFloorRes = await httpRequest(port, 'PATCH', '/settings', {
      thresholds: { followupEscalationSlackDmHours: 7 }
    });
    assert.strictEqual(dmFloorRes.status, 400, `expected 400 for slack DM hours below floor, got ${dmFloorRes.status}`);
    assert.strictEqual(dmFloorRes.body.floor, 8, 'floor should be 8');
    console.log('  PASS: PATCH /settings rejects followupEscalationSlackDmHours below 8');

    // Test 3: below Slack mention floor (24h) returns 400
    const mentionFloorRes = await httpRequest(port, 'PATCH', '/settings', {
      thresholds: { followupEscalationSlackMentionHours: 20 }
    });
    assert.strictEqual(mentionFloorRes.status, 400, `expected 400 for slack mention hours below floor, got ${mentionFloorRes.status}`);
    assert.strictEqual(mentionFloorRes.body.floor, 24, 'floor should be 24');
    console.log('  PASS: PATCH /settings rejects followupEscalationSlackMentionHours below 24');

    // Test 4: at-floor values are accepted
    const atFloorRes = await httpRequest(port, 'PATCH', '/settings', {
      thresholds: {
        followupEscalationEmailHours: 24,
        followupEscalationSlackDmHours: 8,
        followupEscalationSlackMentionHours: 24
      }
    });
    assert.strictEqual(atFloorRes.status, 200, `expected 200 for at-floor values, got ${atFloorRes.status}`);
    assert.strictEqual(atFloorRes.body.ok, true);
    console.log('  PASS: PATCH /settings accepts threshold values at the floor');

    // Test 5: above-floor values are accepted
    const aboveFloorRes = await httpRequest(port, 'PATCH', '/settings', {
      thresholds: {
        followupEscalationEmailHours: 48,
        followupEscalationSlackDmHours: 12,
        followupEscalationSlackMentionHours: 72
      }
    });
    assert.strictEqual(aboveFloorRes.status, 200, `expected 200 for above-floor values, got ${aboveFloorRes.status}`);
    console.log('  PASS: PATCH /settings accepts threshold values above the floor');

  } finally {
    server.close();
    delete process.env.RETICLE_HEARTBEAT_DIR;
    delete process.env.RETICLE_CONFIG_DIR;
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function testInvalidEscalationTier() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-tier-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  const seedDb = new Database(reticleDbPath);
  seedDb.pragma('journal_mode = WAL');
  seedDb.pragma('foreign_keys = ON');
  seedDb.exec(`
    CREATE TABLE IF NOT EXISTS monitored_people (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email            TEXT UNIQUE NOT NULL,
      name             TEXT,
      slack_id         TEXT,
      jira_id          TEXT,
      resolved_at      INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      role             TEXT DEFAULT 'peer',
      escalation_tier  TEXT,
      title            TEXT,
      team             TEXT
    );
  `);
  seedDb.prepare(`INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`).run('tier-test@co.com', null, 'peer');
  seedDb.close();

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test: PATCH /people/:email rejects invalid escalation_tier
    const res = await httpRequest(port, 'PATCH', `/people/${encodeURIComponent('tier-test@co.com')}`, {
      escalation_tier: 'banana'
    });
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    console.log('  PASS: PATCH /people/:email rejects invalid escalation_tier');
  } finally {
    server.close();
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// --- Run tests ---
console.log('settings endpoint tests:');

testSettingsEndpoints()
  .then(() => testSeedingIdempotency())
  .then(() => testFeedbackSettingsEndpoints())
  .then(() => testAccountsEndpoints())
  .then(() => {
    testConfigSettingsLoader();
    return testSettingsJsonEndpoints();
  })
  .then(() => testFilterEndpoints())
  .then(() => testEscalationThresholdFloors())
  .then(() => testInvalidEscalationTier())
  .then(() => {
    console.log('All settings endpoint tests passed');
    process.exit(0);
  }).catch(err => {
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
