'use strict';

function addPerson(db, { email, name = null, role = 'peer', title = null, team = null }) {
  db.prepare(`
    INSERT INTO monitored_people (email, name, role, title, team)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(excluded.name, monitored_people.name),
      role = excluded.role,
      title = excluded.title,
      team = excluded.team
  `).run(email, name, role, title, team);
}

function removePerson(db, email) {
  db.prepare('DELETE FROM monitored_people WHERE email = ?').run(email);
}

function listPeople(db) {
  return db.prepare('SELECT * FROM monitored_people ORDER BY name').all();
}

function listPeopleByRole(db, role) {
  return db.prepare('SELECT * FROM monitored_people WHERE role = ? ORDER BY name').all(role);
}

function getVipEmails(db) {
  return db.prepare("SELECT email FROM monitored_people WHERE role = 'vip'")
    .all().map(r => r.email.toLowerCase());
}

function getDirectReports(db) {
  return db.prepare("SELECT * FROM monitored_people WHERE role = 'direct_report' ORDER BY name").all();
}

function listTeamMembers(db) {
  return db.prepare("SELECT * FROM monitored_people WHERE team IS NOT NULL AND role = 'peer' ORDER BY name").all();
}

function updatePerson(db, email, fields) {
  const allowed = ['name', 'role', 'title', 'team', 'escalation_tier', 'slack_id', 'jira_id'];
  const updates = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (updates.length === 0) return;
  values.push(email);
  db.prepare(`UPDATE monitored_people SET ${updates.join(', ')} WHERE email = ?`).run(...values);
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
  listPeopleByRole,
  getVipEmails,
  getDirectReports,
  listTeamMembers,
  updatePerson,
  updateSlackId,
  updateJiraId,
  getSlackIdMap
};
