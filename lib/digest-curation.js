'use strict';

const { listTeamMembers } = require('./people-store');

// --- Team display names: key → human-readable label ---
// Only the member lists come from the DB; display names are domain knowledge.

const TEAM_DISPLAY_NAMES = {
  cse: 'Corporate Systems Engineering',
  desktop: 'Desktop Support',
  security: 'Security (Platform & Endpoint)',
};

// --- Topic patterns: regex → topic label ---
// Domain knowledge about project ownership, not people data.

const TOPIC_PATTERNS = {
  okta: /\bokta\b/i,
  jamf: /\bjamf\b/i,
  intune: /\bintune\b/i,
  sso: /\bsso\b/i,
  mfa: /\bmfa\b/i,
  idp: /\bidp\b/i,
  vpn: /\bvpn\b/i,
  endpoint: /\bendpoint\b/i,
  mdm: /\bmdm\b/i,
  asset: /\basset\b/i,
  onboarding: /\bonboarding\b/i,
  offboarding: /\boffboarding\b/i,
};

// --- Topic → team overrides ---
// Maps specific topics to teams regardless of who mentioned them.

const TOPIC_TEAM_OVERRIDES = {
  okta: 'security',
  sso: 'security',
  mfa: 'security',
  idp: 'security',
  jamf: 'desktop',
  intune: 'desktop',
  mdm: 'desktop',
  endpoint: 'desktop',
  vpn: 'cse',
  asset: 'cse',
  onboarding: 'cse',
  offboarding: 'cse',
};

/**
 * Build teams object from the database.
 * Calls people-store.listTeamMembers(db) and groups by team field.
 *
 * @param {object} db - better-sqlite3 database instance
 * @returns {object} Teams keyed by team slug with { name, members, slackIds, emails }
 */
function buildTeamsFromDB(db) {
  const rows = listTeamMembers(db);
  const teams = {};

  for (const row of rows) {
    const teamKey = row.team;
    if (!teams[teamKey]) {
      const displayName = TEAM_DISPLAY_NAMES[teamKey]
        || teamKey.charAt(0).toUpperCase() + teamKey.slice(1);
      teams[teamKey] = {
        name: displayName,
        members: [],
        slackIds: [],
        emails: [],
      };
    }

    teams[teamKey].members.push(row.name || row.email);
    teams[teamKey].emails.push(row.email);
    if (row.slack_id) {
      teams[teamKey].slackIds.push(row.slack_id);
    }
  }

  return teams;
}

/**
 * Curate digest items for weekly summary, organized by team.
 *
 * @param {Array} sources - raw digest items from collectors
 * @param {object} teams - teams object from buildTeamsFromDB()
 * @returns {object} { sections: [{ teamKey, teamName, items }], unassigned: [...] }
 */
function curateForWeeklySummary(sources, teams) {
  const sections = [];
  const unassigned = [];

  // Build lookup maps from teams
  const slackIdToTeam = new Map();
  const emailToTeam = new Map();
  const nameToTeam = new Map();

  for (const [teamKey, teamData] of Object.entries(teams)) {
    for (const sid of teamData.slackIds) {
      slackIdToTeam.set(sid, teamKey);
    }
    for (const email of teamData.emails) {
      emailToTeam.set(email.toLowerCase(), teamKey);
    }
    for (const name of teamData.members) {
      nameToTeam.set(name.toLowerCase(), teamKey);
    }
  }

  // Assign each source item to a team
  const teamBuckets = {};
  for (const teamKey of Object.keys(teams)) {
    teamBuckets[teamKey] = [];
  }

  for (const item of sources) {
    let assignedTeam = null;

    // 1. Check topic-based overrides first
    const text = (item.observation || item.subject || item.summary || '').toLowerCase();
    for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
      if (pattern.test(text) && TOPIC_TEAM_OVERRIDES[topic]) {
        assignedTeam = TOPIC_TEAM_OVERRIDES[topic];
        break;
      }
    }

    // 2. Check by slack ID
    if (!assignedTeam && item.slackId) {
      assignedTeam = slackIdToTeam.get(item.slackId) || null;
    }

    // 3. Check by email
    if (!assignedTeam && item.from) {
      assignedTeam = emailToTeam.get(item.from.toLowerCase()) || null;
    }

    // 4. Check by name
    if (!assignedTeam && item.from_name) {
      assignedTeam = nameToTeam.get(item.from_name.toLowerCase()) || null;
    }

    if (assignedTeam && teamBuckets[assignedTeam]) {
      teamBuckets[assignedTeam].push(item);
    } else {
      unassigned.push(item);
    }
  }

  // Build sections for teams that have items
  for (const [teamKey, items] of Object.entries(teamBuckets)) {
    if (items.length > 0) {
      sections.push({
        teamKey,
        teamName: teams[teamKey].name,
        items,
      });
    }
  }

  return { sections, unassigned };
}

module.exports = {
  TEAM_DISPLAY_NAMES,
  TOPIC_PATTERNS,
  TOPIC_TEAM_OVERRIDES,
  buildTeamsFromDB,
  curateForWeeklySummary,
};
