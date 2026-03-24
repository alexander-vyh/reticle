'use strict';

const { listTeamMembers } = require('./people-store');

// --- Team display names: key → human-readable label ---
// Only the member lists come from the DB; display names are domain knowledge.

const TEAM_DISPLAY_NAMES = {
  cse: 'Corporate Systems Engineering',
  desktop: 'Desktop Support',
  security: 'Security (Platform & Endpoint)',
};

// Map DB team names → internal slugs for consistent keying
const DB_TEAM_TO_SLUG = {
  'Corporate Systems Engineering': 'cse',
  'Platform & Endpoint Security': 'security',
  'Desktop Support': 'desktop',
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

// --- Secondary KTLO patterns ---
// Items that restore broken functionality (not new capability) or are
// compliance catch-up / incident response details. These slip past the
// primary Jira-level KTLO classifier.

const SECONDARY_KTLO_PATTERNS = [
  /\b(reconnect|restore|re-enable|re-establish|fix broken|repair)\b/i,
  /\b(vanta|compliance|remediat|audit finding)\b/i,
  /\b(incident.*(response|resolve))\b/i,
];

// Fewer than this many capability signals for a team → gap marker
const GAP_THRESHOLD = 2;

/**
 * Check if an item is secondary KTLO — restoring broken functionality,
 * compliance catch-up, or incident response details that slipped past
 * the primary Jira classifier.
 *
 * @param {object} item - curated item with summary/observation fields
 * @returns {boolean}
 */
function isSecondaryKTLO(item) {
  const text = (item.summary || item.observation || item.content || '').toLowerCase();
  if (!text) return false;
  for (const pattern of SECONDARY_KTLO_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

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
    const teamKey = DB_TEAM_TO_SLUG[row.team] || row.team;
    if (!teams[teamKey]) {
      const displayName = TEAM_DISPLAY_NAMES[teamKey]
        || row.team;
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
 * Normalize sources into a flat array of items with source traceability.
 * Accepts either:
 *   - An array of items (backward compat)
 *   - An object { jiraTickets, slackMessages, digestItems }
 *
 * Each item gets a `source` field for traceability:
 *   - Jira: "[source: ENG-1234]"
 *   - Slack: "[source: #channel-name, 2026-03-15]"
 *   - Digest: "[source: digest]"
 *
 * @param {Array|object} sources
 * @returns {Array} flat array of items with source field
 */
function normalizeSources(sources) {
  // Backward compat: if it's an array, return it with source annotations
  if (Array.isArray(sources)) {
    return sources.map(item => ({
      ...item,
      source: item.source || '[source: digest]',
    }));
  }

  const items = [];

  // Jira tickets → normalized items
  if (sources.jiraTickets) {
    for (const ticket of sources.jiraTickets) {
      items.push({
        ...ticket,
        // Use existing summary field — Jira items already have summary, key, team
        observation: ticket.summary,
        source: `[source: ${ticket.key}]`,
      });
    }
  }

  // Slack messages → normalized items
  if (sources.slackMessages) {
    for (const msg of sources.slackMessages) {
      items.push({
        ...msg,
        // Slack items have content, authorTeam, channel, date
        observation: msg.content,
        summary: msg.content,
        team: msg.authorTeam,
        source: `[source: #${msg.channel}, ${msg.date}]`,
      });
    }
  }

  // Digest items → normalized items
  if (sources.digestItems) {
    for (const item of sources.digestItems) {
      items.push({
        ...item,
        source: item.source || '[source: digest]',
      });
    }
  }

  return items;
}

/**
 * Curate digest items for weekly summary, organized by team.
 * Accepts sources as either an array (backward compat) or an object
 * { jiraTickets, slackMessages, digestItems }.
 *
 * @param {Array|object} sources - raw items or object with typed source arrays
 * @param {object} teams - teams object from buildTeamsFromDB()
 * @returns {object} { sections, unassigned, gaps, secondaryKtloCount }
 */
function curateForWeeklySummary(sources, teams) {
  const sections = [];
  const unassigned = [];
  const gaps = [];
  let secondaryKtloCount = 0;

  // Normalize sources into flat array with source traceability
  const allItems = normalizeSources(sources);

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

  for (const item of allItems) {
    // Secondary KTLO filter — items that restore broken functionality
    if (isSecondaryKTLO(item)) {
      secondaryKtloCount++;
      continue;
    }

    let assignedTeam = null;

    // 0. Check explicit team field (Jira tickets and Slack messages carry this)
    if (item.team && teamBuckets[item.team] !== undefined) {
      assignedTeam = item.team;
    }

    // 1. Check topic-based overrides
    if (!assignedTeam) {
      const text = (item.observation || item.subject || item.summary || '').toLowerCase();
      for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
        if (pattern.test(text) && TOPIC_TEAM_OVERRIDES[topic]) {
          assignedTeam = TOPIC_TEAM_OVERRIDES[topic];
          break;
        }
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

  // Gap threshold: teams with fewer than GAP_THRESHOLD capability signals
  for (const [teamKey, teamData] of Object.entries(teams)) {
    const teamItems = teamBuckets[teamKey] || [];
    if (teamItems.length < GAP_THRESHOLD) {
      gaps.push(`${teamData.name}: thin signal — verify before sending`);
    }
  }

  return { sections, unassigned, gaps, secondaryKtloCount };
}

module.exports = {
  TEAM_DISPLAY_NAMES,
  DB_TEAM_TO_SLUG,
  TOPIC_PATTERNS,
  TOPIC_TEAM_OVERRIDES,
  GAP_THRESHOLD,
  buildTeamsFromDB,
  curateForWeeklySummary,
  isSecondaryKTLO,
};
