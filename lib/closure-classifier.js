'use strict';

/**
 * Classifies whether a sent email/message is a closure (obligation discharged)
 * or a continuation (new questions, commitments, or follow-up needed).
 *
 * Tier 1: Structural — regex patterns on word count, questions, temporal markers.
 * Tier 2: AI (future) — Haiku for ambiguous cases.
 *
 * Conservative: uncertain = continuation (fail-open). A lingering follow-up
 * is better than a dropped obligation.
 */

const CLOSURE_KEYWORDS = [
  'confirmed', 'noted', 'got it', 'sounds good', 'sounds great',
  'will do', 'done', 'on it', 'ack', 'acknowledged',
  'makes sense', 'perfect', 'approved', 'lgtm', 'looks good',
  'no worries', 'all good', 'all set', 'works for me',
  'thank you', 'thanks', 'ty', 'thx',
];

const CONTINUATION_KEYWORDS = [
  'following up', 'checking in', 'can you', 'could you', 'would you',
  'please', 'by friday', 'by monday', 'by end of', 'by eod', 'by eow',
  'i\'ll check', 'i will check', 'let me check', 'let me look',
  'i\'ll follow up', 'i\'ll get back', 'will circle back',
  'also', 'one more thing', 'additionally', 'another question',
  'what about', 'how about', 'what do you think',
];

const TEMPORAL_MARKERS = [
  'by friday', 'by monday', 'by tuesday', 'by wednesday', 'by thursday',
  'by end of', 'by eod', 'by eow', 'by next week',
  'tomorrow', 'this week', 'next week',
  'i\'ll', 'i will', 'let me', 'going to',
];

/**
 * Classify a sent message as closure or continuation.
 *
 * @param {string} text - The sent message text
 * @returns {{ classification: 'closure'|'continuation', confidence: number, reason: string, tier: 'structural' }}
 */
function classifyClosure(text) {
  if (!text || text.trim().length === 0) {
    return { classification: 'continuation', confidence: 0.5, reason: 'empty message', tier: 'structural' };
  }

  const normalized = text.toLowerCase().trim();
  const words = normalized.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const hasQuestionMark = normalized.includes('?');

  // Check continuation keywords first (higher priority — false closure is worse)
  for (const kw of CONTINUATION_KEYWORDS) {
    if (normalized.includes(kw)) {
      return { classification: 'continuation', confidence: 0.85, reason: `continuation keyword: "${kw}"`, tier: 'structural' };
    }
  }

  // Check temporal markers (implies future commitment — continuation)
  for (const marker of TEMPORAL_MARKERS) {
    if (normalized.includes(marker)) {
      return { classification: 'continuation', confidence: 0.8, reason: `temporal marker: "${marker}"`, tier: 'structural' };
    }
  }

  // Questions are continuations
  if (hasQuestionMark) {
    return { classification: 'continuation', confidence: 0.85, reason: 'contains question mark', tier: 'structural' };
  }

  // Short message + closure keyword = high-confidence closure
  for (const kw of CLOSURE_KEYWORDS) {
    if (normalized.includes(kw)) {
      if (wordCount <= 25) {
        return { classification: 'closure', confidence: 0.9, reason: `short ack (${wordCount} words) with keyword: "${kw}"`, tier: 'structural' };
      }
      // Longer message with closure keyword — lower confidence, still closure
      return { classification: 'closure', confidence: 0.7, reason: `closure keyword "${kw}" in longer message (${wordCount} words)`, tier: 'structural' };
    }
  }

  // Very short message with no continuation signals — lean closure
  if (wordCount <= 10) {
    return { classification: 'closure', confidence: 0.6, reason: `very short message (${wordCount} words), no continuation signals`, tier: 'structural' };
  }

  // Default: continuation (fail-open conservative)
  return { classification: 'continuation', confidence: 0.5, reason: `no strong signals (${wordCount} words), defaulting to continuation`, tier: 'structural' };
}

module.exports = { classifyClosure, CLOSURE_KEYWORDS, CONTINUATION_KEYWORDS };
