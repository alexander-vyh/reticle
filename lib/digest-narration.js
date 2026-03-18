'use strict';

const ai = require('./ai');
const log = require('./logger')('digest-narration');

const DAILY_SYSTEM = `You are writing a brief end-of-day digest for a busy professional.

Rules:
- Every item below is a verified fact. Do not add information.
- Group items by urgency: critical first, then high, then normal. Omit low items if >10 items total (note the omission count).
- For each item, preserve the observation and consequence.
- Tone: calm, factual, resolution-oriented. No praise or scolding. No urgency theater.
- Keep it concise. Target: 1-2 sentences per item.
- If there are no items, respond: "Nothing requiring attention today."
- Use Slack mrkdwn formatting (*bold*, _italic_, bullet points).

Must never:
- Invent connections between items not present in the data
- Assign emotional states
- Use motivational language
- Create urgency beyond what the priority field indicates
- Suggest underperformance`;

const WEEKLY_SYSTEM = `You are writing a weekly reflection digest for a busy professional.

This is not a task list. It is a mirror — showing what happened this week, what patterns are emerging, and what deserves attention next week.

Rules:
- Every claim must trace to the structured data below. Do not add information.
- Group the digest into sections:
  1. "This week" — items resolved, commitments kept, meetings completed
  2. "Still open" — items carried forward, grouped by counterparty
  3. "Patterns" — only include if pattern insights are provided and non-empty
  4. "Next week" — upcoming O3s, meetings with open followups
- Tone: calm, reflective, resolution-oriented. No praise or scolding.
- Cite sources naturally: "(email, Tuesday)" or "(Slack DM, 3 days ago)"
- If a pattern has significance "notable", lead the Patterns section with it.
- Use Slack mrkdwn formatting.

Must never:
- Invent connections between items not present in the data
- Assign emotional states
- Use motivational language
- Create urgency beyond what the priority field indicates
- Suggest underperformance`;

const WEEKLY_SUMMARY_SYSTEM = `You are drafting the Digital Workplace section for a Monday Morning Meeting executive summary in Confluence. The audience is an EMGT leadership team that scans for risk, capability advancement, and hiring status. They spend <30 seconds on each department section.

OUTPUT FORMAT (Confluence-flavored Markdown — follow exactly):

## Digital Workplace

### Executive Summary
(2-4 sentences. Opens with stability status. Middle: optional initiative highlight. Closes with risk posture.)

### Team Notes

#### Infrastructure
(Opening narrative sentence setting the week's theme, then bullets. Hiring status as closing line — always present.)

#### Support
(Usually one sentence. Bullets only when there's a notable operational fact for leadership.)

#### Security (Platform)
(Opening narrative sentence, then bullets. Hiring status as closing line — always present.)

THREE QUESTIONS THIS SECTION ANSWERS (for a scanning executive):
1. Is anything broken or at risk? (Executive Summary — almost always "no")
2. What capability advanced this week? (Team Notes bullets — 2-5 items per team)
3. Where are we on hiring? (Closing line of Infrastructure and Security)

CONTENT RULES — Include:
- Capability advancement (new automation, new IaC coverage, new SSO, new processes)
- Validation/correctness work that prevented future problems
- Risk reduction (naming convention changes, prevent-destroy safeguards)
- Hiring status with pipeline details
- Hardware lifecycle data when notable

CONTENT RULES — Exclude (strictly, never include these):
- Ticket counts (never mention how many tickets were resolved)
- Individual employee names (never — say "the team" or use role/team names)
- Dollar amounts
- Detailed incident blow-by-blow (just say "incident response")
- Sprint/velocity metrics
- Meeting counts or time tracking
- Vendor negotiations or pricing
- Future commitments with specific dates
- Screenshots, links, or embedded content
- Maintenance that restored broken functionality (that is not new capability)

ALWAYS KTLO — Never surface these as bullets. They are invisible daily operations:
- User/application access provisioning and deprovisioning (Okta, Salesforce, Jira, etc.) — whether 1 request or 50, this is daily routine. NEVER list individual access requests.
- Password resets, MFA enrollment, login troubleshooting
- Hardware ordering, shipping, receiving, desk setup — unless a fleet-wide lifecycle event
- Slack channel management, workspace changes
- Routine onboarding/offboarding task execution
- Confluence documentation updates for existing procedures (new docs for new capabilities ARE notable)
- Storage metrics, backup status checks (unless a notable anomaly)
- If a team's week was entirely KTLO, say "Routine [domain] operations continued" in a single clause or use the Desktop default. Do NOT list the routine items.

COMPRESSION RULES — The restraint is the style:
- Maximum 5 bullets per team. If you have more, you are being too detailed. Merge or drop.
- Support is almost always one sentence with zero bullets. Only add bullets for facts a VP would want (fleet age data, notable operational changes).
- Each bullet must describe a CAPABILITY ADVANCEMENT — something new that did not exist before. If it is not a new capability, new automation, new coverage, or new process, it is not a bullet.
- Compress multiple related signals into one bullet. Three Terraform tickets about the same attribute = one bullet.
- If in doubt whether something is notable or KTLO, it is KTLO. Omit it.

VOCABULARY (use these phrases naturally):
- "remained stable" — exec summary opener
- "no employee-impacting disruptions" — exec summary opener
- "risk posture remains unchanged" — exec summary closer
- "Normal operational activity" — Support default
- "operational maturity" — process/tooling advancement
- "validated" — correctness/verification work
- "continued" — multi-week WIP
- "expanded" — growing coverage/scope
- "implemented" — new automation, safeguards
- "configured" — SSO, integrations
- "standardized" — naming conventions, processes

BULLET STYLE:
- Complete sentences, not fragments.
- Pattern: [Action verb] + [specific technical scope] + [purpose/outcome clause].
- Good: "Implemented Terraform management for the termed-user attribute with prevent-destroy safeguards to guard against accidental deletions."
- Bad: "Added termed-user TF resource" (too terse, no outcome)

WEEK-OVER-WEEK CONTINUITY:
- First mention: "Began importing initial JamfPro resources..."
- Progress: "Continued expansion of..." / "expanded with new production imports"
- Completion: "Validated the 2026 Mac Zero-Touch Deployment (v3) process for production readiness"
- Drop-off: Completed items simply disappear. No closing statement.
- Use the previous week's notes (if provided) to calibrate continuity language.

HIRING STATUS (always last line, always present for Infrastructure and Security):
- Format: "One open [role]. [Pipeline status]."
- Each week implicitly answers "what changed since last week?"
- Be candid about setbacks.

SUPPORT DEFAULT:
"Normal operational activity; no notable trends or employee-impacting issues requiring attention this week."
Expand with bullets only when there is a fact a VP would want.

Must never:
- Invent information not present in the provided data
- Add emotional language or praise
- Use urgency beyond what the data warrants
- Include items from the exclude list above`;

function buildDailyPrompt(items) {
  return {
    system: DAILY_SYSTEM,
    user: `Digest items:\n${JSON.stringify(items, null, 2)}`
  };
}

function buildWeeklyPrompt(items, patterns) {
  return {
    system: WEEKLY_SYSTEM,
    user: `Digest items:\n${JSON.stringify(items, null, 2)}\n\nPattern insights:\n${JSON.stringify(patterns, null, 2)}`
  };
}

function formatFallback(items, { maxItems = 15 } = {}) {
  if (items.length === 0) return 'Nothing requiring attention today.';

  const priorityOrder = ['critical', 'high', 'normal', 'low'];
  const sorted = [...items].sort((a, b) => {
    const ai = priorityOrder.indexOf(a.priority);
    const bi = priorityOrder.indexOf(b.priority);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const shown = sorted.slice(0, maxItems);
  const overflow = sorted.length - shown.length;

  const lines = shown.map(item =>
    `• [${item.priority || 'normal'}] ${item.observation || '(no details)'}`
  );

  let output = lines.join('\n');
  if (overflow > 0) {
    output += `\n• _+ ${overflow} lower-priority items suppressed_`;
  }

  return `*Digest* (narration unavailable — raw items):\n${output}`;
}

async function narrateDaily(items) {
  const prompt = buildDailyPrompt(items);
  return callNarration(prompt, 'claude-haiku-4-5-20251001', 1000);
}

async function narrateWeekly(items, patterns) {
  const prompt = buildWeeklyPrompt(items, patterns);
  return callNarration(prompt, 'claude-sonnet-4-6', 2000);
}

function buildWeeklySummaryPrompt(curatedData, previousNotes) {
  const parts = ['Curated data for this week:', JSON.stringify(curatedData, null, 2)];

  if (previousNotes) {
    parts.push('\n--- Previous week\'s Digital Workplace section (for continuity reference) ---');
    parts.push(previousNotes);
  } else {
    parts.push('\n(No previous week notes available — this is the first week or continuity data is missing.)');
  }

  return {
    system: WEEKLY_SUMMARY_SYSTEM,
    user: parts.join('\n')
  };
}

function formatWeeklySummaryFallback(curatedData) {
  const { teams, executiveSummary } = curatedData;
  const lines = [];

  lines.push('## Digital Workplace');
  lines.push('');
  lines.push('### Executive Summary');

  // executiveSummary.stability is boolean, highlights is array of strings, riskPosture is string
  const stabilityText = executiveSummary.stability
    ? 'Digital Workplace operations remained stable this week with no employee-impacting disruptions.'
    : 'Digital Workplace operations experienced disruptions this week.';
  const highlightText = Array.isArray(executiveSummary.highlights) && executiveSummary.highlights.length > 0
    ? ' ' + executiveSummary.highlights.join('. ') + '.'
    : '';
  const riskText = ` Overall risk posture ${executiveSummary.riskPosture === 'unchanged' ? 'remains unchanged' : 'is ' + executiveSummary.riskPosture} heading into next week.`;
  lines.push(stabilityText + highlightText + riskText);
  lines.push('');
  lines.push('### Team Notes');

  // Helper to render a team section — accomplishments are { signal, sources, confidence } objects
  function renderTeam(label, team, defaultMsg) {
    lines.push('');
    lines.push(`#### ${label}`);
    const hasItems = team.accomplishments.length > 0 || team.inProgress.length > 0;
    if (hasItems) {
      for (const item of team.accomplishments) {
        const text = typeof item === 'string' ? item : item.signal;
        lines.push(`- ${text}`);
      }
      for (const item of team.inProgress) {
        const text = typeof item === 'string' ? item : item.signal;
        lines.push(`- ${text}`);
      }
    } else {
      lines.push(defaultMsg);
    }
    if (team.hiring) {
      lines.push('');
      const hiringText = typeof team.hiring === 'string' ? team.hiring
        : team.hiring.status ? `${team.hiring.status}${team.hiring.details ? ' ' + team.hiring.details : ''}`
        : '';
      if (hiringText) lines.push(hiringText);
    }
  }

  renderTeam('Infrastructure', teams.cse, 'Routine identity lifecycle operations continued.');
  renderTeam('Support', teams.desktop, 'Normal operational activity; no notable trends or employee-impacting issues requiring attention this week.');
  renderTeam('Security (Platform)', teams.security, 'Routine operations continued.');

  return lines.join('\n');
}

// TODO: Anthropic OAuth stopped accepting Sonnet/Opus on 2026-03-17 (only Haiku works).
// The claude CLI still has full model access. Once OAuth model access is restored or an
// API key is configured, switch back to the direct API client (the original implementation
// is preserved in git history at commit cbfee5b). Track: github.com/anomalyco/opencode/issues/17910
async function narrateWeeklySummary(curatedData, previousNotes) {
  const prompt = buildWeeklySummaryPrompt(curatedData, previousNotes);

  // Use claude CLI for Sonnet access (OAuth API path is currently broken for non-Haiku models)
  try {
    const fullPrompt = `${prompt.system}\n\n---\n\n${prompt.user}`;
    const result = callClaudeCli(fullPrompt, 'sonnet');
    if (result) {
      log.info({ model: 'sonnet', method: 'cli', chars: result.length }, 'Weekly summary narration complete');
      return result;
    }
  } catch (err) {
    log.warn({ err }, 'Claude CLI narration failed — trying API fallback');
  }

  // Fallback: try the API client (works if ANTHROPIC_API_KEY is set or OAuth regains Sonnet access)
  const client = ai.getClient();
  if (client) {
    try {
      const model = 'claude-sonnet-4-6';
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }]
      });
      const text = response.content[0]?.text;
      if (text) {
        log.info({ model, method: 'api', inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens }, 'Weekly summary narration complete');
        return text;
      }
    } catch (err) {
      log.warn({ err }, 'API narration also failed — using deterministic fallback');
    }
  }

  return formatWeeklySummaryFallback(curatedData);
}

// Test hook: set to a function to override CLI behavior in tests
let _cliOverride = null;

/**
 * Call the claude CLI in print mode for Sonnet/Opus access.
 * Returns the response text or null on failure.
 */
function callClaudeCli(prompt, model = 'sonnet') {
  if (_cliOverride) return _cliOverride(prompt, model);
  const { execSync } = require('child_process');
  try {
    const result = execSync(
      `claude -p --model ${model} --output-format text`,
      { input: prompt, encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim() || null;
  } catch (err) {
    log.warn({ err: err.message, model }, 'Claude CLI call failed');
    return null;
  }
}

async function callNarration(prompt, model, maxTokens) {
  const client = ai.getClient();
  if (!client) {
    log.warn('AI client unavailable');
    return null;
  }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    });

    const text = response.content[0]?.text;
    log.info({
      model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'Narration complete');

    return text || null;
  } catch (err) {
    log.warn({ err, model }, 'Narration failed');
    return null;
  }
}

module.exports = {
  buildDailyPrompt,
  buildWeeklyPrompt,
  formatFallback,
  narrateDaily,
  narrateWeekly,
  buildWeeklySummaryPrompt,
  formatWeeklySummaryFallback,
  narrateWeeklySummary,
  WEEKLY_SUMMARY_SYSTEM,
  _setCliOverride: (fn) => { _cliOverride = fn; }
};
