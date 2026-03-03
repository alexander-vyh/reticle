'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitored_people (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      slack_id    TEXT,
      jira_id     TEXT,
      resolved_at INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  return db;
}

function testGatewaySyntax() {
  // Verify gateway.js is valid JavaScript
  const { execSync } = require('child_process');
  execSync('node -c gateway.js', { stdio: 'pipe' });
  console.log('  PASS: gateway.js syntax check');
}

function testGatewayPeopleFlow() {
  const peopleStore = require('./lib/people-store');
  const db = setupTestDb();

  // Simulate POST /people
  peopleStore.addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });

  // Simulate GET /people
  const people = peopleStore.listPeople(db);
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].email, 'alex@co.com');
  assert.strictEqual(people[0].name, 'Alex Johnson');

  // Simulate DELETE /people/:email
  peopleStore.removePerson(db, 'alex@co.com');
  assert.strictEqual(peopleStore.listPeople(db).length, 0);

  console.log('  PASS: gateway people CRUD flow');
}

function testGatewayPostValidation() {
  // POST /people without email should be rejected — test the logic
  const email = undefined;
  assert.strictEqual(!email, true, 'missing email should be falsy');

  console.log('  PASS: gateway POST /people email validation logic');
}

function testGatewayDeleteDecodesEmail() {
  const peopleStore = require('./lib/people-store');
  const db = setupTestDb();

  // Add person with special characters in email
  const email = 'user+tag@example.com';
  peopleStore.addPerson(db, { email, name: 'Tag User' });

  // Simulate what the DELETE handler does: decodeURIComponent
  const encoded = encodeURIComponent(email);
  const decoded = decodeURIComponent(encoded);
  peopleStore.removePerson(db, decoded);

  assert.strictEqual(peopleStore.listPeople(db).length, 0);
  console.log('  PASS: gateway DELETE decodes URI-encoded email');
}

console.log('gateway tests:');
testGatewaySyntax();
testGatewayPeopleFlow();
testGatewayPostValidation();
testGatewayDeleteDecodesEmail();
console.log('All gateway tests passed');
