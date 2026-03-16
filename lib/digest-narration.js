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

#### Corporate Systems Engineering
(Opening narrative sentence setting the week's theme, then bullets. Hiring status as closing line — always present.)

#### Desktop Support
(Usually one sentence. Bullets only when there's a notable operational fact for leadership.)

#### Security (Platform & Endpoint)
(Opening narrative sentence, then bullets. Hiring status as closing line — always present.)

THREE QUESTIONS THIS SECTION ANSWERS (for a scanning executive):
1. Is anything broken or at risk? (Executive Summary — almost always "no")
2. What capability advanced this week? (Team Notes bullets — 2-5 items per team)
3. Where are we on hiring? (Closing line of CSE and Security)

CONTENT RULES — Include:
- Capability advancement (new automation, new IaC coverage, new SSO, new processes)
- Validation/correctness work that prevented future problems
- Risk reduction (naming convention changes, prevent-destroy safeguards)
- Hiring status with pipeline details
- Hardware lifecycle data when notable

CONTENT RULES — Exclude (strictly, never include these):
- Ticket counts
- Individual employee names
- Dollar amounts
- Detailed incident blow-by-blow (just say "incident response")
- Sprint/velocity metrics
- Meeting counts or time tracking
- Vendor negotiations or pricing
- Future commitments with specific dates
- Screenshots, links, or embedded content
- KTLO/BAU laundry lists (summarize as "routine identity lifecycle operations continued")
- Maintenance that restored broken functionality (that is not new capability)

VOCABULARY (use these phrases naturally):
- "remained stable" — exec summary opener
- "no employee-impacting disruptions" — exec summary opener
- "risk posture remains unchanged" — exec summary closer
- "Normal operational activity" — Desktop Support default
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

HIRING STATUS (always last line, always present for Corporate Systems Engineering and Security):
- Format: "One open [role]. [Pipeline status]."
- Each week implicitly answers "what changed since last week?"
- Be candid about setbacks.

DESKTOP SUPPORT DEFAULT:
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

function formatFallback(items) {
  if (items.length === 0) return 'Nothing requiring attention today.';

  const priorityOrder = ['critical', 'high', 'normal', 'low'];
  const sorted = [...items].sort((a, b) => {
    const ai = priorityOrder.indexOf(a.priority);
    const bi = priorityOrder.indexOf(b.priority);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const lines = sorted.map(item =>
    `• [${item.priority || 'normal'}] ${item.observation || '(no details)'}`
  );

  return `*Digest* (narration unavailable — raw items):\n${lines.join('\n')}`;
}

async function narrateDaily(items) {
  const prompt = buildDailyPrompt(items);
  return callNarration(prompt, 'claude-haiku-4-5-20251001', 1000);
}

async function narrateWeekly(items, patterns) {
  const prompt = buildWeeklyPrompt(items, patterns);
  return callNarration(prompt, 'claude-sonnet-4-5-20250514', 2000);
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
  lines.push(`${executiveSummary.stability} ${executiveSummary.highlights ? executiveSummary.highlights + ' ' : ''}${executiveSummary.riskPosture}`);
  lines.push('');
  lines.push('### Team Notes');

  // CSE
  lines.push('');
  lines.push('#### Corporate Systems Engineering');
  const cse = teams.cse;
  if (cse.accomplishments.length > 0 || cse.inProgress.length > 0) {
    for (const item of cse.accomplishments) {
      lines.push(`- ${item}`);
    }
    for (const item of cse.inProgress) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('Routine operations continued.');
  }
  if (cse.hiring) {
    lines.push('');
    lines.push(cse.hiring);
  }

  // Desktop
  lines.push('');
  lines.push('#### Desktop Support');
  const desktop = teams.desktop;
  if (desktop.accomplishments.length > 0 || desktop.inProgress.length > 0) {
    for (const item of desktop.accomplishments) {
      lines.push(`- ${item}`);
    }
    for (const item of desktop.inProgress) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('Normal operational activity; no notable trends or employee-impacting issues requiring attention this week.');
  }
  if (desktop.hiring) {
    lines.push('');
    lines.push(desktop.hiring);
  }

  // Security
  lines.push('');
  lines.push('#### Security (Platform & Endpoint)');
  const sec = teams.security;
  if (sec.accomplishments.length > 0 || sec.inProgress.length > 0) {
    for (const item of sec.accomplishments) {
      lines.push(`- ${item}`);
    }
    for (const item of sec.inProgress) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('Routine operations continued.');
  }
  if (sec.hiring) {
    lines.push('');
    lines.push(sec.hiring);
  }

  return lines.join('\n');
}

async function narrateWeeklySummary(curatedData, previousNotes) {
  const prompt = buildWeeklySummaryPrompt(curatedData, previousNotes);
  const client = ai.getClient();
  if (!client) {
    log.warn('AI client unavailable for weekly summary — using fallback');
    return formatWeeklySummaryFallback(curatedData);
  }

  try {
    const model = 'claude-sonnet-4-6';
    const maxTokens = 2000;
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
    }, 'Weekly summary narration complete');

    return text || formatWeeklySummaryFallback(curatedData);
  } catch (err) {
    log.warn({ err }, 'Weekly summary narration failed — using fallback');
    return formatWeeklySummaryFallback(curatedData);
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
  WEEKLY_SUMMARY_SYSTEM
};
