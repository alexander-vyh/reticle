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
  narrateWeekly
};
