#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const log = require('./lib/logger')('gateway');
const reticleDb = require('./reticle-db');
const peopleStore = require('./lib/people-store');
const slackReader = require('./lib/slack-reader');
const feedbackTracker = require('./lib/feedback-tracker');
const kg = require('./lib/knowledge-graph');
const { findCracks } = require('./lib/crack-finder');
const config = require('./lib/config');

const app = express();
const PORT = config.gatewayPort || 3001;

app.use(express.json());

const db = reticleDb.initDatabase();

// Seed team directory from dwTeamEmails
const existingTeam = peopleStore.listTeamMembers(db);
if (existingTeam.length === 0 && config.dwTeamEmails && config.dwTeamEmails.length > 0) {
  for (const t of config.dwTeamEmails) {
    peopleStore.addPerson(db, { email: t.email, name: t.name, team: t.team });
  }
  log.info({ count: config.dwTeamEmails.length }, 'Seeded team members from team.json');
}

// GET /people — list all monitored people
app.get('/people', (req, res) => {
  const people = peopleStore.listPeople(db);
  res.json({ people });
});

// POST /people — add person by email (triggers Slack resolution)
app.post('/people', (req, res) => {
  const { email, name, role, title, team } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    peopleStore.addPerson(db, { email, name: name || null, role: role || 'peer', title: title || null, team: team || null });
  } catch (err) {
    return res.status(500).json({ error: 'failed to add person' });
  }

  // Resolve Slack ID in background
  slackReader.lookupUserByEmail(email).then(slackId => {
    if (slackId) peopleStore.updateSlackId(db, email, slackId);
  }).catch(() => {});

  res.json({ ok: true, email });
});

// DELETE /people/:email — remove person
app.delete('/people/:email', (req, res) => {
  peopleStore.removePerson(db, decodeURIComponent(req.params.email));
  res.json({ ok: true });
});

// PATCH /people/:email — update person fields (role, escalation_tier, title, team, name, slack_id)
app.patch('/people/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const person = db.prepare('SELECT * FROM monitored_people WHERE email = ?').get(email);
    if (!person) {
      return res.status(404).json({ error: 'Person not found' });
    }
    const { role, escalation_tier, title, team, name, slack_id } = req.body;
    if (escalation_tier !== undefined && escalation_tier !== null) {
      const validTiers = ['immediate', '4h', 'daily', 'weekly'];
      if (!validTiers.includes(escalation_tier)) {
        return res.status(400).json({
          error: `Invalid escalation_tier. Must be one of: ${validTiers.join(', ')}`
        });
      }
    }
    const fields = {};
    if (role !== undefined) fields.role = role;
    if (escalation_tier !== undefined) fields.escalation_tier = escalation_tier;
    if (title !== undefined) fields.title = title;
    if (team !== undefined) fields.team = team;
    if (name !== undefined) fields.name = name;
    if (slack_id !== undefined) fields.slack_id = slack_id;

    peopleStore.updatePerson(db, email, fields);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /feedback/candidates — pending candidates
app.get('/feedback/candidates', (req, res) => {
  const candidates = db.prepare(
    `SELECT * FROM feedback_candidates WHERE status = 'pending' ORDER BY created_at DESC`
  ).all();
  res.json({ candidates });
});

// POST /feedback/candidates/:id/delivered
app.post('/feedback/candidates/:id/delivered', (req, res) => {
  const candidate = db.prepare('SELECT * FROM feedback_candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });

  db.prepare(`UPDATE feedback_candidates SET status = 'delivered' WHERE id = ?`).run(req.params.id);
  feedbackTracker.logFeedbackAction(db, candidate.account_id, {
    reportName: candidate.report_name,
    feedbackType: candidate.feedback_type,
    action: 'feedback_delivered',
    entityId: candidate.entity_id
  });
  res.json({ ok: true });
});

// POST /feedback/candidates/:id/skipped
app.post('/feedback/candidates/:id/skipped', (req, res) => {
  const candidate = db.prepare('SELECT * FROM feedback_candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });

  db.prepare(`UPDATE feedback_candidates SET status = 'skipped' WHERE id = ?`).run(req.params.id);
  feedbackTracker.logFeedbackAction(db, candidate.account_id, {
    reportName: candidate.report_name,
    feedbackType: candidate.feedback_type,
    action: 'feedback_skipped',
    entityId: candidate.entity_id
  });
  res.json({ ok: true });
});

// GET /feedback/stats
app.get('/feedback/stats', (req, res) => {
  const primaryAccount = reticleDb.getPrimaryAccount(db);
  if (!primaryAccount) return res.json({ weekly: {}, monthly: {}, ratios: {} });

  const now = Math.floor(Date.now() / 1000);
  const weekly = feedbackTracker.getWeeklyCountsByReport(db, primaryAccount.id, now - 7 * 86400);
  const monthly = feedbackTracker.getMonthlyCountsByReport(db, primaryAccount.id, now - 30 * 86400);
  const ratios = feedbackTracker.getRatioByReport(db, primaryAccount.id, now - 30 * 86400);
  res.json({ weekly, monthly, ratios });
});

// GET /feedback/settings
app.get('/feedback/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM feedback_settings').all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /feedback/settings
app.patch('/feedback/settings', (req, res) => {
  try {
    const { weeklyTarget, scanWindowHours } = req.body;
    const now = Math.floor(Date.now() / 1000);
    if (weeklyTarget !== undefined) {
      db.prepare("INSERT OR REPLACE INTO feedback_settings (key, value, updated_at) VALUES ('weeklyTarget', ?, ?)").run(String(weeklyTarget), now);
    }
    if (scanWindowHours !== undefined) {
      db.prepare("INSERT OR REPLACE INTO feedback_settings (key, value, updated_at) VALUES ('scanWindowHours', ?, ?)").run(String(scanWindowHours), now);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Commitments (org-memory knowledge graph) ---

let orgMemDb = null;
function getOrgMemDb() {
  if (!orgMemDb) {
    const { initDatabase: initOrgMemory } = require('./lib/org-memory-db');
    orgMemDb = initOrgMemory();
  }
  return orgMemDb;
}

// Fetch Slack workspace URL once and cache it (used for permalink construction)
let slackWorkspaceUrl = null;
async function getSlackWorkspaceUrl() {
  if (slackWorkspaceUrl) return slackWorkspaceUrl;
  try {
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'slack.com',
        path: '/api/auth.test',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.slackBotToken}` }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });
    if (result.ok && result.url) {
      slackWorkspaceUrl = result.url.replace(/\/$/, ''); // e.g. https://example.slack.com
    }
  } catch (e) {
    slackWorkspaceUrl = null;
  }
  return slackWorkspaceUrl;
}

function buildSourceUrl(source, sourceId, channelId, jiraBaseUrl, slackBase) {
  if (!source || !sourceId) return null;
  if (source === 'slack' && slackBase && channelId) {
    // source_id format: "CHANNEL_ID:message.ts"
    const ts = sourceId.split(':')[1];
    if (ts) {
      const tsForUrl = 'p' + ts.replace('.', '');
      return `${slackBase}/archives/${channelId}/${tsForUrl}`;
    }
  }
  if (source === 'jira' && jiraBaseUrl) {
    // source_id format: "ISSUE_KEY:field:timestamp"
    const issueKey = sourceId.split(':')[0];
    if (issueKey && /^[A-Z]+-\d+$/.test(issueKey)) {
      return `${jiraBaseUrl}/browse/${issueKey}`;
    }
  }
  return null;
}

// GET /api/commitments — open event facts from knowledge graph
app.get('/api/commitments', async (req, res) => {
  const omDb = getOrgMemDb();
  const now = Math.floor(Date.now() / 1000);
  const staleDays = parseInt(req.query.staleDays) || 7;
  const staleThreshold = now - (staleDays * 24 * 3600);
  const jiraBaseUrl = config.jiraBaseUrl || null;
  const slackBase = await getSlackWorkspaceUrl();

  const facts = omDb.prepare(`
    SELECT f.id, f.attribute, f.value, f.fact_type, f.valid_from, f.resolution,
           f.source_message_id, e.canonical_name as entity_name, e.id as entity_id,
           rm.source, rm.source_id, rm.channel_id, rm.channel_name
    FROM facts f
    JOIN entities e ON f.entity_id = e.id
    LEFT JOIN raw_messages rm ON rm.id = f.source_message_id
    WHERE f.fact_type = 'event'
      AND (f.resolution IS NULL OR f.resolution = 'open')
      AND f.attribute IN ('committed_to', 'asked_to', 'raised_risk', 'decided')
    ORDER BY f.valid_from DESC
  `).all();

  const items = facts.map(f => {
    const ageSeconds = now - f.valid_from;
    const isStale = f.valid_from < staleThreshold;
    let priority;
    if (f.attribute === 'raised_risk') {
      priority = isStale ? 'high' : 'normal';
    } else if (isStale) {
      priority = ageSeconds > 14 * 86400 ? 'critical' : 'high';
    } else {
      priority = 'normal';
    }

    const sourceUrl = buildSourceUrl(f.source, f.source_id, f.channel_id, jiraBaseUrl, slackBase);

    return {
      id: f.id,
      attribute: f.attribute,
      value: f.value,
      entityName: f.entity_name,
      entityId: f.entity_id,
      priority,
      ageSeconds,
      ageDays: Math.floor(ageSeconds / 86400),
      validFrom: f.valid_from,
      isStale,
      source: f.source || null,
      channelName: f.channel_name || null,
      sourceUrl,
    };
  });

  const summary = {
    total: items.length,
    byAttribute: {},
    byPriority: {},
  };
  for (const item of items) {
    summary.byAttribute[item.attribute] = (summary.byAttribute[item.attribute] || 0) + 1;
    summary.byPriority[item.priority] = (summary.byPriority[item.priority] || 0) + 1;
  }

  res.json({ commitments: items, summary });
});

// POST /api/commitments/:id/resolve — mark a fact as completed/abandoned
app.post('/api/commitments/:id/resolve', (req, res) => {
  const { resolution } = req.body;
  if (!resolution || !['completed', 'abandoned', 'superseded'].includes(resolution)) {
    return res.status(400).json({ error: 'resolution must be completed, abandoned, or superseded' });
  }

  const omDb = getOrgMemDb();
  const fact = omDb.prepare('SELECT * FROM facts WHERE id = ?').get(req.params.id);
  if (!fact) return res.status(404).json({ error: 'fact not found' });

  kg.resolveEvent(omDb, {
    factId: req.params.id,
    entityId: fact.entity_id,
    attribute: fact.attribute,
    resolution,
    rationale: 'manual',
  });

  res.json({ ok: true, id: req.params.id, resolution });
});

// GET /config/filters — read filterPatterns from team.json
app.get('/config/filters', (req, res) => {
  try {
    res.json(config.filterPatterns || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /config/filters — update filterPatterns in team.json
app.patch('/config/filters', (req, res) => {
  try {
    const teamPath = path.join(config.configDir, 'team.json');
    const current = JSON.parse(fs.readFileSync(teamPath, 'utf-8'));
    if (req.body.companyDomain !== undefined) {
      current.filterPatterns = current.filterPatterns || {};
      current.filterPatterns.companyDomain = req.body.companyDomain;
    }
    if (req.body.dwGroupEmail !== undefined) {
      current.filterPatterns = current.filterPatterns || {};
      current.filterPatterns.dwGroupEmail = req.body.dwGroupEmail;
    }
    // Atomic write
    const tmpPath = teamPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2));
    fs.renameSync(tmpPath, teamPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /config/accounts — returns account identifiers + connection status (NO raw tokens)
app.get('/config/accounts', (req, res) => {
  try {
    const accounts = {
      slack: {
        identifier: config.slackUsername || config.slackUserId || null,
        connected: !!config.slackBotToken,
        hasToken: !!config.slackBotToken,
        hasAppToken: !!config.slackAppToken,
        userId: config.slackUserId || '',
        username: config.slackUsername || ''
      },
      gmail: {
        identifier: config.gmailAccount || null,
        connected: !!config.gmailAccount,
        account: config.gmailAccount || ''
      },
      jira: {
        identifier: config.jiraBaseUrl || null,
        connected: !!(config.jiraApiToken && config.jiraBaseUrl),
        baseUrl: config.jiraBaseUrl || '',
        userEmail: config.jiraUserEmail || '',
        hasToken: !!config.jiraApiToken
      }
    };
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /config/accounts — update secrets.json fields
app.patch('/config/accounts', (req, res) => {
  try {
    const secretsPath = path.join(config.configDir, 'secrets.json');
    const current = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    const allowed = [
      'slackBotToken', 'slackAppToken', 'slackSigningSecret',
      'slackUserId', 'slackUsername', 'slackUserToken',
      'gmailAccount', 'jiraApiToken', 'jiraBaseUrl', 'jiraUserEmail'
    ];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key)) current[key] = value;
    }
    // Atomic write
    const tmpPath = secretsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2));
    fs.renameSync(tmpPath, secretsPath);
    res.json({ ok: true, note: 'Restart services to apply credential changes' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings (settings.json) ---

const SETTINGS_SERVICE_MAP = {
  polling: {
    gmailIntervalMinutes: 'gmail-monitor',
    slackResponseTimeoutMinutes: 'slack-events',
    followupCheckIntervalMinutes: 'followup-checker',
    meetingAlertPollIntervalSeconds: 'meeting-alerts',
  },
  notifications: 'meeting-alerts',
  thresholds: 'followup-checker',
  o3: 'meeting-alerts',
  // digest: no SIGHUP (launchd-scheduled, reads on next run)
};

function signalAffectedServices(changedKeys) {
  const heartbeatDir = process.env.RETICLE_HEARTBEAT_DIR ||
    path.join(os.homedir(), '.reticle', 'heartbeats');
  const signaled = [];

  const serviceNames = new Set();
  for (const key of changedKeys) {
    const mapping = SETTINGS_SERVICE_MAP[key];
    if (typeof mapping === 'string') serviceNames.add(mapping);
    else if (typeof mapping === 'object' && mapping !== null) {
      Object.values(mapping).forEach(s => serviceNames.add(s));
    }
  }

  for (const name of serviceNames) {
    try {
      const hbPath = path.join(heartbeatDir, `${name}.json`);
      if (!fs.existsSync(hbPath)) continue;
      const hb = JSON.parse(fs.readFileSync(hbPath, 'utf-8'));
      if (!hb.pid) continue;
      // Verify PID is alive before signaling
      try { process.kill(hb.pid, 0); } catch { continue; }
      process.kill(hb.pid, 'SIGHUP');
      signaled.push(name);
    } catch (e) {
      log.warn({ service: name, error: e.message }, 'Failed to signal service');
    }
  }
  return signaled;
}

// GET /settings — read settings.json with defaults
app.get('/settings', (req, res) => {
  try {
    const settingsPath = path.join(config.configDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /settings — validate, write atomically, SIGHUP affected services
app.patch('/settings', (req, res) => {
  try {
    // Validate escalation threshold floors
    if (req.body.thresholds) {
      const t = req.body.thresholds;
      const floors = {
        followupEscalationEmailHours: 24,
        followupEscalationSlackDmHours: 8,
        followupEscalationSlackMentionHours: 24
      };
      for (const [key, floor] of Object.entries(floors)) {
        if (t[key] !== undefined && t[key] < floor) {
          return res.status(400).json({
            error: `${key} minimum is ${floor} hours`,
            floor
          });
        }
      }
    }

    const settingsPath = path.join(config.configDir, 'settings.json');
    let current = {};
    if (fs.existsSync(settingsPath)) {
      current = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }

    // Deep merge changed keys
    const changedKeys = [];
    for (const [section, values] of Object.entries(req.body)) {
      if (typeof values === 'object' && values !== null) {
        current[section] = { ...(current[section] || {}), ...values };
      } else {
        current[section] = values;
      }
      changedKeys.push(section);
    }

    // Atomic write
    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2));
    fs.renameSync(tmpPath, settingsPath);

    // SIGHUP affected services
    const signaled = signalAffectedServices(changedKeys);

    res.json({ ok: true, signaled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Entities (org-memory knowledge graph) ---

// GET /api/entities — all person entities with commitment counts and identities
app.get('/api/entities', (req, res) => {
  const omDb = getOrgMemDb();

  const entities = omDb.prepare(`
    SELECT e.id, e.canonical_name, e.monitored, e.is_active,
           COUNT(f.id) as commitment_count
    FROM entities e
    LEFT JOIN facts f ON f.entity_id = e.id
      AND f.fact_type = 'event'
      AND (f.resolution IS NULL OR f.resolution = 'open')
      AND f.attribute IN ('committed_to', 'asked_to', 'raised_risk', 'decided')
    WHERE e.entity_type = 'person'
    GROUP BY e.id
    ORDER BY e.canonical_name
  `).all();

  const identities = omDb.prepare(`
    SELECT entity_id, source, external_id, display_name
    FROM identity_map
  `).all();

  const identityByEntity = {};
  for (const row of identities) {
    if (!identityByEntity[row.entity_id]) identityByEntity[row.entity_id] = {};
    identityByEntity[row.entity_id][row.source] = row.external_id;
  }

  const result = entities.map(e => ({
    id: e.id,
    canonicalName: e.canonical_name,
    monitored: e.monitored === 1,
    isActive: e.is_active === 1,
    commitmentCount: e.commitment_count,
    slackId: identityByEntity[e.id]?.slack || null,
    jiraId: identityByEntity[e.id]?.jira || null,
    isAnchored: !!identityByEntity[e.id],
  }));

  res.json({ entities: result });
});

// POST /api/entities/:id/monitor — set monitored = 1
app.post('/api/entities/:id/monitor', (req, res) => {
  const omDb = getOrgMemDb();
  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  omDb.prepare('UPDATE entities SET monitored = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, id: req.params.id, monitored: true });
});

// GET /api/entities/:id — single entity detail
app.get('/api/entities/:id', (req, res) => {
  const omDb = getOrgMemDb();

  const entity = omDb.prepare(`
    SELECT e.id, e.canonical_name, e.monitored, e.is_active,
           COUNT(f.id) as commitment_count
    FROM entities e
    LEFT JOIN facts f ON f.entity_id = e.id
      AND f.fact_type = 'event'
      AND (f.resolution IS NULL OR f.resolution = 'open')
      AND f.attribute IN ('committed_to', 'asked_to', 'raised_risk', 'decided')
    WHERE e.id = ?
    GROUP BY e.id
  `).get(req.params.id);

  if (!entity) return res.status(404).json({ error: 'entity not found' });

  const identities = omDb.prepare(
    `SELECT source, external_id FROM identity_map WHERE entity_id = ?`
  ).all(req.params.id);

  const idMap = {};
  for (const row of identities) idMap[row.source] = row.external_id;

  res.json({
    entity: {
      id: entity.id,
      canonicalName: entity.canonical_name,
      monitored: entity.monitored === 1,
      isActive: entity.is_active === 1,
      commitmentCount: entity.commitment_count,
      slackId: idMap.slack || null,
      jiraId: idMap.jira || null,
      isAnchored: Object.keys(idMap).length > 0,
    }
  });
});

// GET /api/entities/:id/commitments — open event facts for one entity
app.get('/api/entities/:id/commitments', async (req, res) => {
  const omDb = getOrgMemDb();
  const now = Math.floor(Date.now() / 1000);
  const staleDays = parseInt(req.query.staleDays) || 7;
  const staleThreshold = now - (staleDays * 24 * 3600);
  const jiraBaseUrl = config.jiraBaseUrl || null;
  const slackBase = await getSlackWorkspaceUrl();

  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  const facts = omDb.prepare(`
    SELECT f.id, f.attribute, f.value, f.fact_type, f.valid_from, f.resolution,
           f.source_message_id, e.canonical_name as entity_name, e.id as entity_id,
           rm.source, rm.source_id, rm.channel_id, rm.channel_name
    FROM facts f
    JOIN entities e ON f.entity_id = e.id
    LEFT JOIN raw_messages rm ON rm.id = f.source_message_id
    WHERE f.entity_id = ?
      AND f.fact_type = 'event'
      AND (f.resolution IS NULL OR f.resolution = 'open')
      AND f.attribute IN ('committed_to', 'asked_to', 'raised_risk', 'decided')
    ORDER BY f.valid_from DESC
  `).all(req.params.id);

  const commitments = facts.map(f => {
    const ageSeconds = now - f.valid_from;
    const isStale = f.valid_from < staleThreshold;
    let priority;
    if (f.attribute === 'raised_risk') {
      priority = isStale ? 'high' : 'normal';
    } else if (isStale) {
      priority = ageSeconds > 14 * 86400 ? 'critical' : 'high';
    } else {
      priority = 'normal';
    }
    return {
      id: f.id,
      attribute: f.attribute,
      value: f.value,
      entityName: f.entity_name,
      entityId: f.entity_id,
      priority,
      ageSeconds,
      ageDays: Math.floor(ageSeconds / 86400),
      validFrom: f.valid_from,
      isStale,
      source: f.source || null,
      channelName: f.channel_name || null,
      sourceUrl: buildSourceUrl(f.source, f.source_id, f.channel_id, jiraBaseUrl, slackBase),
    };
  });

  res.json({ commitments });
});

// POST /api/entities/:id/merge — merge source into target, reassign facts and identities
app.post('/api/entities/:id/merge', (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  if (targetId === req.params.id) return res.status(400).json({ error: 'cannot merge entity into itself' });

  const omDb = getOrgMemDb();
  const source = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'source entity not found' });
  const target = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'target entity not found' });

  const now = Math.floor(Date.now() / 1000);

  omDb.transaction(() => {
    // Reassign all facts from source to target
    omDb.prepare('UPDATE facts SET entity_id = ? WHERE entity_id = ?').run(targetId, req.params.id);

    // Move identity_map entries to target.
    // PK is (source, external_id) — if target already owns it, delete source's duplicate.
    // Otherwise reassign by updating entity_id.
    const srcIdentities = omDb.prepare('SELECT source, external_id FROM identity_map WHERE entity_id = ?').all(req.params.id);
    for (const row of srcIdentities) {
      const claimedByTarget = omDb.prepare('SELECT 1 FROM identity_map WHERE entity_id = ? AND source = ? AND external_id = ?').get(targetId, row.source, row.external_id);
      if (claimedByTarget) {
        omDb.prepare('DELETE FROM identity_map WHERE entity_id = ? AND source = ? AND external_id = ?').run(req.params.id, row.source, row.external_id);
      } else {
        omDb.prepare('UPDATE identity_map SET entity_id = ? WHERE source = ? AND external_id = ?').run(targetId, row.source, row.external_id);
      }
    }

    // Deactivate source
    omDb.prepare('UPDATE entities SET is_active = 0 WHERE id = ?').run(req.params.id);
  })();

  res.json({ ok: true, sourceId: req.params.id, targetId, mergedAt: now });
});

// POST /api/entities/:id/unmonitor — set monitored = 0
app.post('/api/entities/:id/unmonitor', (req, res) => {
  const omDb = getOrgMemDb();
  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  omDb.prepare('UPDATE entities SET monitored = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, id: req.params.id, monitored: false });
});

// GET /api/entities/:id/facts — all facts for an entity (state + event, open + resolved)
app.get('/api/entities/:id/facts', (req, res) => {
  const omDb = getOrgMemDb();
  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  let sql = `
    SELECT f.id, f.attribute, f.value, f.fact_type, f.valid_from, f.valid_to,
           f.resolution, f.resolved_at, f.confidence, f.source_message_id,
           f.resolves_fact_id, f.rationale
    FROM facts f
    WHERE f.entity_id = ?
  `;
  const params = [req.params.id];

  if (req.query.factType) {
    sql += ' AND f.fact_type = ?';
    params.push(req.query.factType);
  }
  if (req.query.attribute) {
    sql += ' AND f.attribute = ?';
    params.push(req.query.attribute);
  }

  sql += ' ORDER BY f.valid_from DESC';
  const rows = omDb.prepare(sql).all(...params);

  res.json({
    facts: rows.map(f => ({
      id: f.id,
      attribute: f.attribute,
      value: f.value,
      factType: f.fact_type,
      validFrom: f.valid_from,
      validTo: f.valid_to,
      resolution: f.resolution,
      resolvedAt: f.resolved_at,
      confidence: f.confidence,
      sourceMessageId: f.source_message_id,
      resolvesFactId: f.resolves_fact_id,
      rationale: f.rationale,
    })),
  });
});

// GET /api/unattributed — facts with entity_id IS NULL (needs review queue)
app.get('/api/unattributed', (req, res) => {
  const omDb = getOrgMemDb();

  const rows = omDb.prepare(`
    SELECT f.id, f.mentioned_name, f.attribute, f.value, f.fact_type,
           f.valid_from, f.resolution, f.source_message_id
    FROM facts f
    WHERE f.entity_id IS NULL
    ORDER BY f.valid_from ASC
  `).all();

  res.json({
    facts: rows.map(f => ({
      id: f.id,
      mentionedName: f.mentioned_name,
      attribute: f.attribute,
      value: f.value,
      factType: f.fact_type,
      validFrom: f.valid_from,
      resolution: f.resolution,
      sourceMessageId: f.source_message_id,
    })),
  });
});

// --- Alias feedback (review queue write-back) ---

// POST /api/entities/:id/aliases — confirm a mentioned_name as an alias for this entity
app.post('/api/entities/:id/aliases', (req, res) => {
  const { mentionedName, sourceFactId } = req.body;
  if (!mentionedName) return res.status(400).json({ error: 'mentionedName required' });

  const omDb = getOrgMemDb();
  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  const result = kg.confirmAlias(omDb, {
    entityId: req.params.id,
    mentionedName,
    sourceFactId: sourceFactId || null,
  });

  res.json({ ok: true, aliasId: result.aliasId, attributedCount: result.attributedCount });
});

// POST /api/entities/:id/aliases/reject — reject a mentioned_name as NOT being an alias
app.post('/api/entities/:id/aliases/reject', (req, res) => {
  const { mentionedName, sourceFactId } = req.body;
  if (!mentionedName) return res.status(400).json({ error: 'mentionedName required' });

  const omDb = getOrgMemDb();
  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  kg.rejectAlias(omDb, {
    entityId: req.params.id,
    mentionedName,
    sourceFactId: sourceFactId || null,
  });

  res.json({ ok: true });
});

// GET /api/entities/:id/aliases — list aliases and rejections for an entity
app.get('/api/entities/:id/aliases', (req, res) => {
  const omDb = getOrgMemDb();
  const entity = omDb.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'entity not found' });

  const aliases = kg.getAliases(omDb, req.params.id);
  const rejections = kg.getRejectedAliases(omDb, req.params.id);

  res.json({
    aliases: aliases.map(a => ({
      id: a.id,
      alias: a.alias,
      aliasSource: a.alias_source,
      confirmedAt: a.confirmed_at || null,
    })),
    rejections: rejections.map(r => ({
      id: r.id,
      alias: r.alias,
      rejectedAt: r.rejected_at,
      sourceFactId: r.source_fact_id || null,
    })),
  });
});

// GET /api/cracks — credibility gap analysis across entities
app.get('/api/cracks', (req, res) => {
  const omDb = getOrgMemDb();
  const staleDays = parseInt(req.query.staleDays) || 7;
  const monitoredOnly = req.query.monitoredOnly === 'true';
  const topN = parseInt(req.query.topN) || 5;

  const cracks = findCracks(omDb, { staleDays, monitoredOnly, topN });
  res.json({ cracks });
});

// --- Digest snapshots ---

// GET /api/digest/latest?cadence=weekly — most recent snapshot for cadence
app.get('/api/digest/latest', (req, res) => {
  const { cadence } = req.query;
  if (!cadence) return res.status(400).json({ error: 'cadence query parameter required' });

  const row = reticleDb.getLatestSnapshot(db, cadence);
  if (!row) return res.json({ snapshot: null });

  res.json({
    snapshot: {
      id: row.id,
      snapshotDate: row.snapshot_date,
      cadence: row.cadence,
      items: row.items,
      narration: row.narration || null,
      createdAt: row.created_at,
    }
  });
});

// GET /api/digest/history?cadence=weekly&limit=4 — last N snapshots
app.get('/api/digest/history', (req, res) => {
  const { cadence } = req.query;
  if (!cadence) return res.status(400).json({ error: 'cadence query parameter required' });

  const limit = parseInt(req.query.limit) || 4;
  const rows = reticleDb.getSnapshotHistory(db, cadence, limit);

  res.json({
    snapshots: rows.map(row => ({
      id: row.id,
      snapshotDate: row.snapshot_date,
      cadence: row.cadence,
      items: row.items,
      narration: row.narration || null,
      createdAt: row.created_at,
    }))
  });
});

// --- Meeting routes ---

function buildFlaggedItems(result, segments) {
  const flagged = [];
  const speakerLabels = [...new Set(segments.map(s => s.speaker))];
  const unresolvedSpeakers = speakerLabels.filter(s => s.startsWith('SPEAKER_'));
  for (const label of unresolvedSpeakers) {
    const count = segments.filter(s => s.speaker === label).length;
    flagged.push({ type: 'unresolved_speaker', label, segmentCount: count });
  }
  if (result.keyPeople) {
    for (const p of result.keyPeople) {
      if (!p.resolvedName) {
        flagged.push({ type: 'unresolved_person', mentioned: p.mentioned, context: p.context });
      }
    }
  }
  if (result.actionItems) {
    for (const a of result.actionItems) {
      if (a.confidence === 'inferred') {
        flagged.push({ type: 'low_confidence_action', item: a.item, owner: a.owner });
      }
    }
  }
  return flagged;
}

async function sendMeetingSlack(meetingId, title, attendeeNames, durationMin, result, flagged) {
  const lines = [];
  lines.push(`*Meeting: ${title || 'Untitled'}* (${durationMin} min)`);
  if (attendeeNames.length > 0) lines.push(`Participants: ${attendeeNames.join(', ')}`);
  if (result.summary) { lines.push(''); lines.push(result.summary); }
  if (result.actionItems && result.actionItems.length > 0) {
    lines.push(''); lines.push('*Action Items:*');
    for (const a of result.actionItems) {
      const dl = a.deadline ? ` (by ${a.deadline})` : '';
      lines.push(`  → ${a.owner}: ${a.item}${dl}`);
    }
  }
  if (result.decisions && result.decisions.length > 0) {
    lines.push(''); lines.push('*Decisions:*');
    for (const d of result.decisions) lines.push(`  ✓ ${d}`);
  }
  if (flagged.length > 0) {
    lines.push(''); lines.push(`⚠ ${flagged.length} item${flagged.length > 1 ? 's' : ''} need review`);
  }
  try { await slack.sendSlackDM(lines.join('\n')); }
  catch (err) { log.error({ err }, 'Failed to send meeting Slack DM'); }
}

async function summarizeAndDeliver(meetingId, segments, attendeeNames, title, durationSec) {
  const durationMin = Math.round((durationSec || 0) / 60);
  const result = await ai.summarizeMeeting({ transcript: segments, attendees: attendeeNames, title: title || 'Untitled Meeting', durationMin });
  if (!result) return;
  const flagged = buildFlaggedItems(result, segments);
  reticleDb.saveMeetingSummary(db, { meetingId, summary: result.summary, topics: result.topics, actionItems: result.actionItems, decisions: result.decisions, openQuestions: result.openQuestions, keyPeople: result.keyPeople, flaggedItems: flagged, modelUsed: result.modelUsed, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  if (flagged.length > 0) reticleDb.updateMeetingReviewStatus(db, meetingId, 'needs_review');
  await sendMeetingSlack(meetingId, title, attendeeNames, durationMin, result, flagged);
}

app.post('/meetings/:id/transcript', async (req, res) => {
  const meetingId = req.params.id;
  const { title, startTime, endTime, durationSec, attendeeEmails, captureMode, transcriptPath, wavPath, segments } = req.body;
  if (!segments || !Array.isArray(segments)) return res.status(400).json({ error: 'segments array required' });
  reticleDb.createMeeting(db, { id: meetingId, title, startTime, endTime, durationSec, attendeeEmails, captureMode, transcriptPath, wavPath });
  const attendeeNames = [];
  if (attendeeEmails) {
    for (const email of attendeeEmails) {
      const person = db.prepare('SELECT name, email FROM monitored_people WHERE email = ?').get(email);
      attendeeNames.push(person ? (person.name || person.email) : email);
    }
  }
  summarizeAndDeliver(meetingId, segments, attendeeNames, title, durationSec).catch(err => { log.error({ err, meetingId }, 'Meeting summarization failed'); });
  res.json({ ok: true, meetingId });
});

app.get('/meetings', (req, res) => { res.json({ meetings: reticleDb.listMeetings(db, { limit: parseInt(req.query.limit) || 50 }) }); });
app.get('/meetings/today', (req, res) => { res.json({ meetings: reticleDb.getTodaysMeetings(db) }); });
app.get('/meetings/:id', (req, res) => {
  const meeting = reticleDb.getMeeting(db, req.params.id);
  if (!meeting) return res.status(404).json({ error: 'not found' });
  res.json({ meeting, summary: reticleDb.getMeetingSummary(db, req.params.id) });
});

app.post('/meetings/:id/speakers', (req, res) => {
  const { speakerLabel, personId } = req.body;
  if (!speakerLabel || !personId) return res.status(400).json({ error: 'speakerLabel and personId required' });
  reticleDb.link(db, { sourceType: 'meeting', sourceId: req.params.id, targetType: 'person', targetId: personId, relationship: 'spoke_in', metadata: JSON.stringify({ speakerLabel }) });
  res.json({ ok: true });
});

app.get('/speakers/embeddings', (req, res) => {
  const embeddings = reticleDb.getAllActiveEmbeddings(db);
  res.json({ embeddings: embeddings.map(e => ({ personId: e.person_id, name: e.name, email: e.email, embedding: e.embedding.toString('base64'), modelVersion: e.model_version })) });
});

app.get('/corrections/dictionary', (req, res) => { res.json({ corrections: reticleDb.getCorrections(db) }); });

app.post('/meetings/:id/corrections', (req, res) => {
  const { heard, correct, personId } = req.body;
  if (!heard || !correct) return res.status(400).json({ error: 'heard and correct required' });
  reticleDb.saveCorrection(db, { heard, correct, personId: personId ?? null, sourceMeetingId: req.params.id });
  res.json({ ok: true });
});

module.exports.buildFlaggedItems = buildFlaggedItems;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Gateway error:', err.message || err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  log.info({ port: PORT }, 'Reticle Gateway listening');
});

module.exports = app; // for testing
