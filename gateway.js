#!/usr/bin/env node
'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const claudiaDb = require('./claudia-db');
const peopleStore = require('./lib/people-store');
const slackReader = require('./lib/slack-reader');
const feedbackTracker = require('./lib/feedback-tracker');
const config = require('./lib/config');

const app = express();
const PORT = config.gatewayPort || 3001;

app.use(bodyParser.json());

const db = claudiaDb.initDatabase();

// GET /people — list all monitored people
app.get('/people', (req, res) => {
  const people = peopleStore.listPeople(db);
  res.json({ people });
});

// POST /people — add person by email (triggers Slack resolution)
app.post('/people', async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  peopleStore.addPerson(db, { email, name });

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
  const primaryAccount = claudiaDb.getPrimaryAccount(db);
  if (!primaryAccount) return res.json({ weekly: {}, monthly: {}, ratios: {} });

  const now = Math.floor(Date.now() / 1000);
  const weekly = feedbackTracker.getWeeklyCountsByReport(db, primaryAccount.id, now - 7 * 86400);
  const monthly = feedbackTracker.getMonthlyCountsByReport(db, primaryAccount.id, now - 30 * 86400);
  const ratios = feedbackTracker.getRatioByReport(db, primaryAccount.id, now - 30 * 86400);
  res.json({ weekly, monthly, ratios });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Claudia Gateway listening on port ${PORT}`);
});

module.exports = app; // for testing
