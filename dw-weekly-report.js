#!/usr/bin/env node
/**
 * DW Weekly Report — queries org-memory for the past 7 days of team activity,
 * groups by team and person, formats as markdown, and delivers to Slack DM.
 *
 * Scheduled Fridays at 3:00 PM via launchd.
 * Supports manual invocation: node dw-weekly-report.js
 */
'use strict';

const kg = require('./lib/knowledge-graph');

const SERVICE_NAME = 'dw-weekly-report';

/**
 * Build structured report data from raw_messages.
 *
 * @param {Object} db - org-memory database
 * @param {Object} opts
 * @param {number} opts.sinceDays - Days to look back (default 7)
 * @param {number} [opts.now] - Current epoch seconds (for testing)
 * @returns {{ teams: Array<{ name: string, members: Array }>, period: { from: number, to: number } }}
 */
function buildReport(db, { sinceDays = 7, now } = {}) {
  const ts = now || Math.floor(Date.now() / 1000);
  const since = ts - (sinceDays * 24 * 3600);

  // Get all raw_messages in the window
  const messages = db.prepare(
    'SELECT * FROM raw_messages WHERE occurred_at >= ? ORDER BY occurred_at DESC'
  ).all(since);

  // Group messages by author — prefer author_id (resolved entity), fall back to author_ext_id
  const byAuthor = new Map(); // key → { authorId, extId, messages[] }
  for (const msg of messages) {
    const key = msg.author_id || msg.author_ext_id;
    if (!key) continue;
    if (!byAuthor.has(key)) byAuthor.set(key, { authorId: msg.author_id, extId: msg.author_ext_id, messages: [] });
    byAuthor.get(key).messages.push(msg);
  }

  // Resolve each author to entity + team
  const teamMap = new Map(); // team name → { name, members: Map<key, memberData> }

  for (const [key, { authorId, extId, messages: authorMessages }] of byAuthor) {
    let entityName = null;
    let teamName = 'Unassigned';

    if (authorId) {
      const entity = kg.getEntity(db, authorId);
      if (!entity || entity.entity_type !== 'person') continue;
      entityName = entity.canonical_name;
      const state = kg.getCurrentState(db, authorId);
      teamName = state.team || 'Unassigned';
    } else {
      // Unresolved author — use author_name from the first message
      entityName = authorMessages[0].author_name || extId;
    }

    if (!teamMap.has(teamName)) {
      teamMap.set(teamName, { name: teamName, members: new Map() });
    }

    const team = teamMap.get(teamName);
    if (!team.members.has(key)) {
      team.members.set(key, {
        name: entityName,
        entityId: authorId || null,
        slackMessages: [],
        jiraMessages: [],
      });
    }

    const member = team.members.get(key);
    for (const msg of authorMessages) {
      if (msg.source === 'slack') {
        member.slackMessages.push(msg);
      } else if (msg.source === 'jira') {
        member.jiraMessages.push(msg);
      }
    }
  }

  // Convert maps to sorted arrays
  const teams = Array.from(teamMap.values())
    .map(t => ({
      name: t.name,
      members: Array.from(t.members.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      // Unassigned goes last
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return a.name.localeCompare(b.name);
    });

  return { teams, period: { from: since, to: ts } };
}

/**
 * Format report data as markdown.
 *
 * @param {{ teams: Array, period: { from: number, to: number } }} report
 * @returns {string} Markdown string
 */
function formatReport(report) {
  const lines = [];

  for (const team of report.teams) {
    lines.push(`## ${team.name}`);

    for (const member of team.members) {
      lines.push(`### ${member.name}`);

      if (member.slackMessages.length > 0) {
        lines.push('**Slack activity:**');
        for (const msg of member.slackMessages) {
          const channel = msg.channel_name ? `[${msg.channel_name}] ` : '';
          lines.push(`- ${channel}${msg.content}`);
        }
      }

      if (member.jiraMessages.length > 0) {
        lines.push('**Jira activity:**');
        for (const msg of member.jiraMessages) {
          // Jira content already includes [ISSUEKEY] prefix from jira-capture
          lines.push(`- ${msg.content}`);
        }
      }

      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

// --- Main entry point ---
async function main() {
  const config = require('./lib/config');
  const log = require('./lib/logger')(SERVICE_NAME);
  const heartbeat = require('./lib/heartbeat');
  const { initDatabase } = require('./lib/org-memory-db');
  const { sendSlackDM } = require('./lib/slack');

  const db = initDatabase();

  try {
    const report = buildReport(db, { sinceDays: 7 });
    const md = formatReport(report);

    if (report.teams.length === 0) {
      log.info('No activity found for the past 7 days');
      heartbeat.write(SERVICE_NAME, {
        checkInterval: 0,
        status: 'ok',
        metrics: { teams: 0, totalMessages: 0 }
      });
      return;
    }

    const totalMessages = report.teams.reduce((sum, t) =>
      sum + t.members.reduce((s, m) => s + m.slackMessages.length + m.jiraMessages.length, 0), 0);

    log.info({ teams: report.teams.length, totalMessages }, 'Report built');

    // Send to Slack
    const header = `*DW Weekly Activity Report*\n_${new Date(report.period.from * 1000).toLocaleDateString()} — ${new Date(report.period.to * 1000).toLocaleDateString()}_\n\n`;
    await sendSlackDM(header + md);

    log.info('Report delivered to Slack');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'ok',
      metrics: { teams: report.teams.length, totalMessages }
    });
  } catch (err) {
    log.error({ err }, 'Report generation failed');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'error',
      errors: { lastError: err.message, lastErrorAt: Date.now(), countSinceStart: 1 }
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildReport, formatReport };
