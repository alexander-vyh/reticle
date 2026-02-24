'use strict';

const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const log = require('./logger')('ai');

// Cached token + client, refreshed from keychain periodically
let cachedToken = null;
let tokenFetchedAt = 0;
let client = null;
const TOKEN_CACHE_TTL = 30 * 60 * 1000; // Re-read keychain every 30 minutes

/**
 * Read the Claude Code OAuth access token from the macOS keychain.
 * Claude Code stores credentials under "Claude Code-credentials" service name.
 * Returns the access token string or null.
 */
function readKeychainToken() {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const data = JSON.parse(raw);
    const token = data.claudeAiOauth?.accessToken;
    if (!token) {
      log.warn('Keychain entry found but no accessToken inside');
      return null;
    }
    const expiresAt = data.claudeAiOauth?.expiresAt;
    if (expiresAt && Date.now() > expiresAt) {
      log.warn({ expiresAt: new Date(expiresAt).toISOString() }, 'Keychain OAuth token is expired');
      return null;
    }
    return token;
  } catch (err) {
    log.debug({ err }, 'Could not read OAuth token from keychain');
    return null;
  }
}

/**
 * Get or create an Anthropic client using the freshest available credentials.
 * Priority: macOS keychain → ANTHROPIC_AUTH_TOKEN env → ANTHROPIC_API_KEY env.
 * Recreates the client when the keychain token changes.
 */
function getClient() {
  const now = Date.now();
  const stale = (now - tokenFetchedAt) > TOKEN_CACHE_TTL;

  if (stale) {
    const token = readKeychainToken();
    if (token && token !== cachedToken) {
      cachedToken = token;
      client = new Anthropic({
        authToken: token,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' }
      });
      log.info('AI client initialized from keychain OAuth token');
    } else if (!token && !client) {
      // No keychain token — try env vars as fallback
      try {
        client = new Anthropic();
        log.info('AI client initialized from environment');
      } catch {
        log.debug('No AI credentials available');
        return null;
      }
    }
    tokenFetchedAt = now;
  }
  return client;
}

const SYSTEM_PROMPT = `You are a triage assistant for a VP of IT at an ad-tech company.
Given an email, decide if it requires URGENT attention (interrupt-worthy) or can wait for a batch summary.

URGENT means: the sender needs a response within the hour, something is broken or at risk,
a decision is blocking people, or there is a time-sensitive business matter.

NOT URGENT: FYI emails, status updates, meeting notes, newsletters, requests that can wait a few hours.

Respond with ONLY a JSON object: {"urgent": true/false, "reason": "one short sentence"}`;

/**
 * Assess whether an email is urgent enough to interrupt.
 * Returns { urgent: boolean, reason: string } or null on any failure.
 */
async function assessEmailUrgency({ from, to, cc, subject, snippet, body }) {
  const anthropic = getClient();
  if (!anthropic) {
    log.debug('AI triage skipped: no credentials available');
    return null;
  }

  // Build a concise email representation (limit body to save tokens)
  const bodyPreview = (body || snippet || '').substring(0, 600);
  const userMessage = [
    `From: ${from}`,
    to ? `To: ${to}` : null,
    cc ? `CC: ${cc}` : null,
    `Subject: ${subject}`,
    `Body:\n${bodyPreview}`
  ].filter(Boolean).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const text = response.content[0]?.text;
    if (!text) {
      log.warn('AI triage: empty response');
      return null;
    }

    // Log token usage for cost monitoring
    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'AI triage tokens');

    // Strip markdown code fences if Haiku wraps the JSON
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const result = JSON.parse(cleaned);
    if (typeof result.urgent !== 'boolean' || typeof result.reason !== 'string') {
      log.warn({ result }, 'AI triage: unexpected shape');
      return null;
    }

    return result;
  } catch (error) {
    // If auth failed, invalidate cached token so next call re-reads keychain
    if (error.status === 401 || error.status === 403) {
      log.warn('AI auth failed — will re-read keychain on next call');
      cachedToken = null;
      client = null;
      tokenFetchedAt = 0;
    }
    log.warn({ err: error }, 'AI triage failed (degrading gracefully)');
    return null;
  }
}

const RULE_REFINEMENT_PROMPT = `You are a rule-builder assistant for an email classification system.
Given email metadata, the current rule, and a user's natural language instruction,
output an updated rule as a JSON object.

Valid condition fields (all lowercase, null means "match any"):
- matchFrom: sender email address (e.g. "noreply@jira.com")
- matchFromDomain: sender domain (e.g. "github.com")
- matchTo: recipient/distribution list address (e.g. "dl-team@company.com")
- matchSubjectContains: substring to match in subject (e.g. "role audit")

Rules:
- At least one field must be non-null.
- Do NOT invent conditions the user didn't ask for.
- If the user says "remove the To condition", set matchTo to null.
- If the user says "only when subject mentions X", set matchSubjectContains to the keyword.
- Keep the existing conditions unless the user explicitly asks to change them.

Respond with ONLY a JSON object: {"matchFrom": ..., "matchFromDomain": ..., "matchTo": ..., "matchSubjectContains": ...}`;

/**
 * Parse a user's natural language rule refinement instruction into structured conditions.
 * Returns { matchFrom, matchFromDomain, matchTo, matchSubjectContains } or null on failure.
 */
async function parseRuleRefinement({ emailMeta, currentRule, userInstruction }) {
  const anthropic = getClient();
  if (!anthropic) {
    log.debug('AI rule refinement skipped: no credentials available');
    return null;
  }

  const userMessage = [
    'Email metadata:',
    `  From: ${emailMeta.from}`,
    emailMeta.to ? `  To: ${emailMeta.to}` : null,
    emailMeta.cc ? `  CC: ${emailMeta.cc}` : null,
    `  Subject: ${emailMeta.subject}`,
    '',
    'Current rule conditions:',
    `  ${JSON.stringify(currentRule)}`,
    '',
    `User instruction: ${userInstruction}`
  ].filter(x => x !== null).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: RULE_REFINEMENT_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const text = response.content[0]?.text;
    if (!text) {
      log.warn('AI rule refinement: empty response');
      return null;
    }

    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'AI rule refinement tokens');

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const result = JSON.parse(cleaned);

    // Validate: at least one condition must be non-null
    const { matchFrom, matchFromDomain, matchTo, matchSubjectContains } = result;
    const hasCondition = [matchFrom, matchFromDomain, matchTo, matchSubjectContains].some(v => v != null);
    if (!hasCondition) {
      log.warn({ result }, 'AI rule refinement: no conditions returned');
      return null;
    }

    return {
      matchFrom: matchFrom || null,
      matchFromDomain: matchFromDomain || null,
      matchTo: matchTo || null,
      matchSubjectContains: matchSubjectContains || null
    };
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      log.warn('AI auth failed — will re-read keychain on next call');
      cachedToken = null;
      client = null;
      tokenFetchedAt = 0;
    }
    log.warn({ err: error }, 'AI rule refinement failed');
    return null;
  }
}

module.exports = { assessEmailUrgency, parseRuleRefinement, getClient };
