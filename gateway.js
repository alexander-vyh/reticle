#!/usr/bin/env node
'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const claudiaDb = require('./claudia-db');
const peopleStore = require('./lib/people-store');
const slackReader = require('./lib/slack-reader');
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Claudia Gateway listening on port ${PORT}`);
});

module.exports = app; // for testing
