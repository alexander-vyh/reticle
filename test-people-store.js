'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE monitored_people (
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
  return db;
}

function testAddPerson() {
  const { addPerson, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  const people = listPeople(db);

  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].email, 'alex@co.com');
  assert.strictEqual(people[0].name, 'Alex Johnson');
  assert.strictEqual(people[0].slack_id, null);

  console.log('  PASS: addPerson + listPeople');
}

function testAddPersonDuplicate() {
  const { addPerson, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson Updated' });

  const people = listPeople(db);
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].name, 'Alex Johnson Updated');

  console.log('  PASS: addPerson — upsert on duplicate email');
}

function testUpdateSlackId() {
  const { addPerson, updateSlackId, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  updateSlackId(db, 'alex@co.com', 'U01ABC123');

  const people = listPeople(db);
  assert.strictEqual(people[0].slack_id, 'U01ABC123');

  console.log('  PASS: updateSlackId');
}

function testRemovePerson() {
  const { addPerson, removePerson, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  removePerson(db, 'alex@co.com');

  assert.strictEqual(listPeople(db).length, 0);

  console.log('  PASS: removePerson');
}

function testGetSlackIdMap() {
  const { addPerson, updateSlackId, getSlackIdMap } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  addPerson(db, { email: 'priya@co.com', name: 'Priya Patel' });
  addPerson(db, { email: 'noslack@co.com', name: 'No Slack' });
  updateSlackId(db, 'alex@co.com', 'U_ALEX');
  updateSlackId(db, 'priya@co.com', 'U_PRIYA');

  const map = getSlackIdMap(db);
  assert.strictEqual(map.size, 2);
  assert.strictEqual(map.get('U_ALEX'), 'Alex Johnson');
  assert.strictEqual(map.get('U_PRIYA'), 'Priya Patel');

  console.log('  PASS: getSlackIdMap — only resolved people');
}

console.log('people-store tests:');
testAddPerson();
testAddPersonDuplicate();
testUpdateSlackId();
testRemovePerson();
testGetSlackIdMap();
console.log('All people-store tests passed');
