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
const config = require('./lib/config');

const app = express();
const PORT = config.gatewayPort || 3001;

app.use(express.json());

const db = reticleDb.initDatabase();

// Seed monitored_people from team.json if no VIPs/reports exist yet
const existingVips = peopleStore.listPeopleByRole(db, 'vip');
const existingReports = peopleStore.listPeopleByRole(db, 'direct_report');
if (existingVips.length === 0 && config.vips && config.vips.length > 0) {
  for (const v of config.vips) {
    peopleStore.addPerson(db, { email: v.email, name: null, role: 'vip', title: v.title });
  }
  console.log(`Seeded ${config.vips.length} VIPs from team.json`);
}
if (existingReports.length === 0 && config.directReports && config.directReports.length > 0) {
  for (const r of config.directReports) {
    peopleStore.addPerson(db, { email: r.email, name: r.name, role: 'direct_report' });
    if (r.slackId) peopleStore.updateSlackId(db, r.email, r.slackId);
  }
  console.log(`Seeded ${config.directReports.length} direct reports from team.json`);
}
// Seed team directory from dwTeamEmails
const existingTeam = peopleStore.listTeamMembers(db);
if (existingTeam.length === 0 && config.dwTeamEmails && config.dwTeamEmails.length > 0) {
  for (const t of config.dwTeamEmails) {
    peopleStore.addPerson(db, { email: t.email, name: t.name, team: t.team });
  }
  console.log(`Seeded ${config.dwTeamEmails.length} team members from team.json`);
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

// GET /api/commitments — open event facts from knowledge graph
app.get('/api/commitments', (req, res) => {
  const omDb = getOrgMemDb();
  const now = Math.floor(Date.now() / 1000);
  const staleDays = parseInt(req.query.staleDays) || 7;
  const staleThreshold = now - (staleDays * 24 * 3600);

  const facts = omDb.prepare(`
    SELECT f.id, f.attribute, f.value, f.fact_type, f.valid_from, f.resolution,
           f.source_message_id, e.canonical_name as entity_name, e.id as entity_id
    FROM facts f
    JOIN entities e ON f.entity_id = e.id
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

  const now = Math.floor(Date.now() / 1000);
  omDb.prepare('UPDATE facts SET resolution = ?, resolved_at = ? WHERE id = ?')
    .run(resolution, now, req.params.id);

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
  console.log(`Reticle Gateway listening on port ${PORT}`);
});

module.exports = app; // for testing
