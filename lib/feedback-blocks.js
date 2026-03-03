// lib/feedback-blocks.js
'use strict';

const TYPE_EMOJI = { affirming: ':large_green_circle:', adjusting: ':large_yellow_circle:' };

function buildFeedbackBlocks(feedbackItems) {
  if (feedbackItems.length === 0) return [];

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Feedback Opportunities (${feedbackItems.length})`, emoji: true } },
    { type: 'divider' }
  ];

  for (const item of feedbackItems) {
    const emoji = TYPE_EMOJI[item.category] || ':white_circle:';
    const valuePayload = JSON.stringify({ report: item.counterparty, feedbackType: item.feedbackType, entityId: item.entityId });

    blocks.push(
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${emoji} *${item.counterparty}* — ${item.category}` }] },
      { type: 'section', text: { type: 'mrkdwn', text: `> ${item.rawArtifact}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Draft:* ${item.feedbackDraft}` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Delivered', emoji: true }, action_id: 'feedback_delivered', value: valuePayload, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Skip', emoji: true }, action_id: 'feedback_skipped', value: valuePayload }
        ]
      },
      { type: 'divider' }
    );
  }

  return blocks;
}

module.exports = { buildFeedbackBlocks };
