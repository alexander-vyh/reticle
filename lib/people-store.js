'use strict';

function addPerson(db, { email, name = null }) {
  db.prepare(`
    INSERT INTO monitored_people (email, name)
    VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name
  `).run(email, name);
}

function removePerson(db, email) {
  db.prepare('DELETE FROM monitored_people WHERE email = ?').run(email);
}

function listPeople(db) {
  return db.prepare('SELECT * FROM monitored_people ORDER BY name').all();
}

function updateSlackId(db, email, slackId) {
  db.prepare(`
    UPDATE monitored_people
    SET slack_id = ?, resolved_at = strftime('%s','now')
    WHERE email = ?
  `).run(slackId, email);
}

function updateJiraId(db, email, jiraId) {
  db.prepare(`
    UPDATE monitored_people SET jira_id = ? WHERE email = ?
  `).run(jiraId, email);
}

function getSlackIdMap(db) {
  const rows = db.prepare(
    'SELECT slack_id, name FROM monitored_people WHERE slack_id IS NOT NULL'
  ).all();
  return new Map(rows.map(r => [r.slack_id, r.name]));
}

module.exports = {
  addPerson,
  removePerson,
  listPeople,
  updateSlackId,
  updateJiraId,
  getSlackIdMap
};
