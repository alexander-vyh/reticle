'use strict';

const ai = require('./ai');
const log = require('./logger')('org-memory-report');

const ONE_DAY = 24 * 60 * 60;
const ONE_WEEK = 7 * ONE_DAY;

// Fact attributes that map to each report category
const COMMITMENT_ATTRS = new Set(['committed_to', 'asked_to']);
const DECISION_ATTRS = new Set(['decided']);
const RISK_ATTRS = new Set(['raised_risk']);

const ORG_REPORT_SYSTEM = `You are writing a weekly org-memory report for a manager who leads a department.

This report summarizes what the organization's knowledge graph recorded this week: commitments made, decisions taken, risks raised, state changes (role/team), and stale commitments that remain unresolved.

Rules:
- Every claim must trace to the structured data below. Do not add information.
- Group the report into sections:
  1. "New commitments & action items" — who committed to what, who was asked to do what
  2. "Decisions" — choices made this week (only if present)
  3. "Risks raised" — concerns flagged this week (only if present)
  4. "Stale commitments" — open commitments older than 7 days, grouped by person. Flag these for follow-up.
  5. "State changes" — role or team changes detected (only if present)
  6. "Activity summary" — who was most active, who went quiet
- Tone: calm, factual, resolution-oriented. No praise or scolding.
- For stale commitments, note how many days they have been open.
- If a section has no items, omit it entirely.
- If there is nothing to report at all, say "No significant org-memory activity this week."
- Use Slack mrkdwn formatting (*bold*, _italic_, bullet points).

Must never:
- Invent connections between items not present in the data
- Assign emotional states or motivations
- Use motivational language
- Suggest underperformance
- Name-shame — present stale items as follow-up opportunities, not failures`;

/**
 * Query the org-memory database for the past week's facts and produce a structured report.
 *
 * @param {Object} db - org-memory database (better-sqlite3 instance)
 * @param {Object} [opts]
 * @param {number} [opts.now] - Current epoch seconds (default: Date.now()/1000)
 * @param {number} [opts.lookbackDays=7] - How many days to look back for new facts
 * @param {number} [opts.staleDays=7] - Commitments older than this are "stale"
 * @returns {Object} Structured report data
 */
function generateWeeklyOrgReport(db, { now, lookbackDays = 7, staleDays = 7 } = {}) {
  const ts = now || Math.floor(Date.now() / 1000);
  const periodStart = ts - (lookbackDays * ONE_DAY);
  const periodEnd = ts;
  const staleThreshold = ts - (staleDays * ONE_DAY);

  // 1. Event facts created this week
  const recentEvents = db.prepare(`
    SELECT f.*, e.canonical_name, e.entity_type
    FROM facts f
    LEFT JOIN entities e ON e.id = f.entity_id
    WHERE f.fact_type = 'event'
      AND f.valid_from >= ?
      AND f.valid_from <= ?
      AND f.attribute != 'completion_signal'
    ORDER BY f.valid_from DESC
  `).all(periodStart, periodEnd);

  // 2. State facts created or confirmed this week
  const recentStateChanges = db.prepare(`
    SELECT f.*, e.canonical_name, e.entity_type
    FROM facts f
    LEFT JOIN entities e ON e.id = f.entity_id
    WHERE f.fact_type = 'state'
      AND f.valid_to IS NULL
      AND (f.valid_from >= ? OR f.last_confirmed_at >= ?)
      AND f.valid_from >= ?
    ORDER BY f.valid_from DESC
  `).all(periodStart, periodStart, periodStart);

  // 3. Stale commitments: open events older than staleDays
  const staleRows = db.prepare(`
    SELECT f.*, e.canonical_name, e.entity_type
    FROM facts f
    LEFT JOIN entities e ON e.id = f.entity_id
    WHERE f.fact_type = 'event'
      AND f.resolution = 'open'
      AND f.attribute IN ('committed_to', 'asked_to')
      AND f.valid_from < ?
    ORDER BY f.valid_from ASC
  `).all(staleThreshold);

  // 4. Entity activity: count facts per entity this week
  const activityRows = db.prepare(`
    SELECT
      COALESCE(e.canonical_name, f.mentioned_name) AS entity_name,
      COUNT(*) AS fact_count
    FROM facts f
    LEFT JOIN entities e ON e.id = f.entity_id
    WHERE f.valid_from >= ? AND f.valid_from <= ?
      AND (f.entity_id IS NOT NULL OR f.mentioned_name IS NOT NULL)
    GROUP BY entity_name
    ORDER BY fact_count DESC
  `).all(periodStart, periodEnd);

  // Categorize recent events
  const commitments = [];
  const decisions = [];
  const risks = [];

  for (const row of recentEvents) {
    const item = {
      entityName: row.canonical_name || row.mentioned_name || 'Unknown',
      attribute: row.attribute,
      value: row.value,
      validFrom: row.valid_from,
      confidence: row.confidence,
      resolution: row.resolution,
    };

    if (COMMITMENT_ATTRS.has(row.attribute)) {
      commitments.push(item);
    } else if (DECISION_ATTRS.has(row.attribute)) {
      decisions.push(item);
    } else if (RISK_ATTRS.has(row.attribute)) {
      risks.push(item);
    }
  }

  // Build stale commitments list
  const staleCommitments = staleRows.map(row => ({
    entityName: row.canonical_name || row.mentioned_name || 'Unknown',
    attribute: row.attribute,
    value: row.value,
    validFrom: row.valid_from,
    daysSinceCreation: Math.floor((ts - row.valid_from) / ONE_DAY),
  }));

  // Build state changes list
  const stateChanges = recentStateChanges.map(row => ({
    entityName: row.canonical_name || row.mentioned_name || 'Unknown',
    attribute: row.attribute,
    value: row.value,
    validFrom: row.valid_from,
  }));

  // Build entity activity
  const entityActivity = activityRows.map(row => ({
    entityName: row.entity_name,
    factCount: row.fact_count,
  }));

  return {
    periodStart,
    periodEnd,
    commitments,
    decisions,
    risks,
    staleCommitments,
    stateChanges,
    entityActivity,
  };
}

/**
 * Build the AI prompt for narrating the org report.
 *
 * @param {Object} report - Structured report from generateWeeklyOrgReport
 * @returns {{ system: string, user: string }}
 */
function buildOrgReportPrompt(report) {
  return {
    system: ORG_REPORT_SYSTEM,
    user: `Org-memory report data for the past week:\n${JSON.stringify(report, null, 2)}`,
  };
}

/**
 * Deterministic fallback: format the report as Slack mrkdwn without AI.
 *
 * @param {Object} report - Structured report from generateWeeklyOrgReport
 * @returns {string} Slack mrkdwn text
 */
function formatOrgReportFallback(report) {
  const hasContent =
    report.commitments.length > 0 ||
    report.decisions.length > 0 ||
    report.risks.length > 0 ||
    report.staleCommitments.length > 0 ||
    report.stateChanges.length > 0;

  if (!hasContent) {
    return 'No significant org-memory activity this week.';
  }

  const lines = [];
  lines.push('*Weekly Org-Memory Report*');
  lines.push('');

  if (report.commitments.length > 0) {
    lines.push('*New Commitments & Action Items*');
    for (const c of report.commitments) {
      lines.push(`  \u2022 *${c.entityName}*: ${c.value}`);
    }
    lines.push('');
  }

  if (report.decisions.length > 0) {
    lines.push('*Decisions*');
    for (const d of report.decisions) {
      lines.push(`  \u2022 *${d.entityName}*: ${d.value}`);
    }
    lines.push('');
  }

  if (report.risks.length > 0) {
    lines.push('*Risks Raised*');
    for (const r of report.risks) {
      lines.push(`  \u2022 *${r.entityName}*: ${r.value}`);
    }
    lines.push('');
  }

  if (report.staleCommitments.length > 0) {
    lines.push('*Stale Commitments (>7 days open)*');
    for (const s of report.staleCommitments) {
      lines.push(`  \u2022 *${s.entityName}*: ${s.value} _(${s.daysSinceCreation} days)_`);
    }
    lines.push('');
  }

  if (report.stateChanges.length > 0) {
    lines.push('*State Changes*');
    for (const sc of report.stateChanges) {
      lines.push(`  \u2022 *${sc.entityName}*: ${sc.attribute} \u2192 ${sc.value}`);
    }
    lines.push('');
  }

  if (report.entityActivity.length > 0) {
    lines.push('*Activity Summary*');
    for (const ea of report.entityActivity) {
      lines.push(`  \u2022 ${ea.entityName}: ${ea.factCount} facts`);
    }
  }

  return lines.join('\n');
}

/**
 * Narrate the org report using AI. Falls back to deterministic format on failure.
 *
 * @param {Object} report - Structured report from generateWeeklyOrgReport
 * @returns {Promise<string>} Narrated text (Slack mrkdwn)
 */
async function narrateOrgReport(report) {
  const prompt = buildOrgReportPrompt(report);

  const client = ai.getClient();
  if (!client) {
    log.warn('AI client unavailable — using fallback');
    return formatOrgReportFallback(report);
  }

  try {
    const model = 'claude-haiku-4-5-20251001';
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });

    const text = response.content[0]?.text;
    log.info({
      model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }, 'Org report narration complete');

    return text || formatOrgReportFallback(report);
  } catch (err) {
    log.warn({ err }, 'Org report narration failed — using fallback');
    return formatOrgReportFallback(report);
  }
}

module.exports = {
  generateWeeklyOrgReport,
  buildOrgReportPrompt,
  formatOrgReportFallback,
  narrateOrgReport,
  ORG_REPORT_SYSTEM,
};
