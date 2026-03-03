'use strict';

const log = require('./logger')('feedback-collector');
const ai = require('./ai');
const { createDigestItem } = require('./digest-item');
const slackReader = require('./slack-reader');

/**
 * Filter messages to only those authored by or mentioning a report.
 *
 * @param {Array<{user: string, text: string, ts: string, channelId: string, channelName: string, thread_ts?: string}>} messages
 * @param {Map<string, string>} reportSlackIds - Map of Slack user ID → display name
 * @returns {Array<{reportName: string, reportSlackId: string, channelName: string, channelId: string, messageText: string, timestamp: string, threadTs: string|null, messageType: 'authored'|'mentioned'}>}
 */
function filterToReportMessages(messages, reportSlackIds) {
  const candidates = [];
  const USER_MENTION_PATTERN = /<@(U[A-Z0-9_]+)>/g;

  for (const msg of messages) {
    const authorName = reportSlackIds.get(msg.user);
    let added = false;

    if (authorName) {
      candidates.push({
        reportName: authorName,
        reportSlackId: msg.user,
        channelName: msg.channelName,
        channelId: msg.channelId,
        messageText: msg.text,
        timestamp: msg.ts,
        threadTs: msg.thread_ts || null,
        messageType: 'authored'
      });
      added = true;
    }

    if (!added) {
      let match;
      USER_MENTION_PATTERN.lastIndex = 0;
      while ((match = USER_MENTION_PATTERN.exec(msg.text)) !== null) {
        const mentionedName = reportSlackIds.get(match[1]);
        if (mentionedName) {
          candidates.push({
            reportName: mentionedName,
            reportSlackId: match[1],
            channelName: msg.channelName,
            channelId: msg.channelId,
            messageText: msg.text,
            timestamp: msg.ts,
            threadTs: msg.thread_ts || null,
            messageType: 'mentioned'
          });
          break;
        }
      }
    }
  }

  return candidates;
}

const ASSESSMENT_SYSTEM = `You are a feedback opportunity detector for a people manager.

For each Slack message, classify whether it represents a feedback-worthy moment:
- "affirming": The person did something well (shipped work, helped someone, good communication, initiative)
- "adjusting": An opportunity for constructive feedback (missed context, unclear communication)
- "skip": Not feedback-worthy (routine update, factual question, casual chat)

Rules:
- Describe behaviors factually. Never use labels like "poor", "excellent", "bad", "great".
- Focus on observable actions and their impact, not personality.
- When uncertain, classify as "skip" with low confidence.

Respond with a JSON array:
[{"index": <n>, "category": "affirming"|"adjusting"|"skip", "behavior": "<factual description>", "context": "<why it matters>", "confidence": "high"|"medium"|"low"}]`;

const DRAFT_SYSTEM = `You write feedback drafts for a people manager using these principles:
- Start with "When you" followed by a specific, observable behavior
- Follow with the impact on the team, project, or outcome
- 1-2 sentences, factual and specific
- Never use "great", "poor", "excellent", "bad"
- This is a starting point — the manager rewrites it before sending`;

function parseAssessmentResponse(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function filterByConfidence(assessed) {
  return assessed.filter(a =>
    a.category !== 'skip' &&
    (a.confidence === 'high' || a.confidence === 'medium')
  );
}

function buildFeedbackDraftPrompt(candidate, assessment) {
  return {
    system: DRAFT_SYSTEM,
    user: `Report: ${candidate.reportName}
Channel: #${candidate.channelName}
Type: ${assessment.category}
Behavior: ${assessment.behavior}
Context: ${assessment.context}
Original: "${candidate.messageText}"

Write a "When you [behavior], [impact]" feedback draft.`
  };
}

async function assessCandidates(candidates) {
  const client = ai.getClient();
  if (!client) { log.warn('AI client unavailable'); return []; }

  const numbered = candidates.map((c, i) =>
    `[${i}] #${c.channelName} | ${c.reportName} (${c.messageType}): "${c.messageText}"`
  ).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: ASSESSMENT_SYSTEM,
      messages: [{ role: 'user', content: `Classify these Slack messages:\n\n${numbered}` }]
    });

    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      candidateCount: candidates.length
    }, 'Assessment complete');

    const text = response.content[0]?.text;
    if (!text) return [];
    return filterByConfidence(parseAssessmentResponse(text));
  } catch (err) {
    log.error({ err }, 'Assessment failed');
    return [];
  }
}

async function draftFeedback(candidate, assessment) {
  const client = ai.getClient();
  if (!client) return null;

  const prompt = buildFeedbackDraftPrompt(candidate, assessment);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    });

    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'Draft complete');

    return response.content[0]?.text || null;
  } catch (err) {
    log.warn({ err }, 'Draft failed');
    return null;
  }
}

function createFeedbackDigestItem(candidate, assessment, draft) {
  const item = createDigestItem({
    collector: 'feedback',
    observation: assessment.behavior,
    reason: `Feedback opportunity in #${candidate.channelName} (${assessment.context})`,
    authority: `Public channel #${candidate.channelName}`,
    consequence: assessment.context,
    sourceType: 'slack-public',
    category: assessment.category,
    priority: assessment.category === 'adjusting' ? 'high' : 'normal',
    counterparty: candidate.reportName,
    entityId: `${candidate.channelId}:${candidate.timestamp}`,
    observedAt: Math.floor(parseFloat(candidate.timestamp))
  });

  item.feedbackDraft = draft;
  item.rawArtifact = `#${candidate.channelName} — ${candidate.reportName}: "${candidate.messageText}"`;
  item.feedbackType = assessment.category;

  return item;
}

async function collectFeedback(slackIdMap, { scanWindowHours = 24 } = {}) {
  if (slackIdMap.size === 0) {
    log.warn('No monitored people with Slack IDs — skipping');
    return [];
  }

  const oldest = Math.floor(Date.now() / 1000) - (scanWindowHours * 3600);
  log.info({ count: slackIdMap.size, windowHours: scanWindowHours }, 'Starting feedback collection');

  let channels;
  try {
    channels = await slackReader.listConversations({ types: 'public_channel' });
  } catch (err) {
    log.error({ err }, 'Failed to list channels');
    return [];
  }

  const activeChannels = channels.filter(ch => {
    const lastTs = parseFloat(ch.latest?.ts || '0');
    return lastTs >= oldest;
  });

  const allCandidates = [];
  for (const ch of activeChannels) {
    try {
      const rawMessages = await slackReader.getConversationHistory(ch.id, oldest);
      const filtered = slackReader.parseMessages(rawMessages);
      const annotated = filtered.map(msg => ({ ...msg, channelId: ch.id, channelName: ch.name }));
      allCandidates.push(...filterToReportMessages(annotated, slackIdMap));
    } catch (err) {
      log.warn({ err, channel: ch.name }, 'Failed to fetch channel — skipping');
    }
  }

  log.info({ count: allCandidates.length }, 'Candidates collected');
  if (allCandidates.length === 0) return [];

  const assessed = await assessCandidates(allCandidates);
  if (assessed.length === 0) return [];

  const items = [];
  for (const result of assessed) {
    const candidate = allCandidates[result.index];
    if (!candidate) continue;
    const draft = await draftFeedback(candidate, result);
    items.push(createFeedbackDigestItem(
      candidate, result,
      draft || `When you ${result.behavior}, ${result.context}.`
    ));
  }

  log.info({ count: items.length }, 'Feedback collection complete');
  return items;
}

module.exports = {
  filterToReportMessages,
  parseAssessmentResponse,
  filterByConfidence,
  buildFeedbackDraftPrompt,
  assessCandidates,
  draftFeedback,
  createFeedbackDigestItem,
  collectFeedback,
  ASSESSMENT_SYSTEM,
  DRAFT_SYSTEM
};
