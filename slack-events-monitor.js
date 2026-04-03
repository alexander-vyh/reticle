#!/usr/bin/env node
/**
 * Reticle Slack Events Monitor — Bolt.js + Agent SDK
 * Monitors unanswered DMs and @mentions via Slack Socket Mode (Bolt.js)
 * Conversational agent responds to Alexander's DMs with streaming
 */

const { App, LogLevel } = require('@slack/bolt');
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');
const emailCache = require('./email-cache');
const reticleDb = require('./reticle-db');
const { parseSenderEmail, formatRuleDescription } = require('./lib/email-utils');
const { parseRuleRefinement } = require('./lib/ai');
const log = require('./lib/logger')('slack-events');
const orgMemoryDb = require('./lib/org-memory-db');
const slackCapture = require('./lib/slack-capture');
const slackReader = require('./lib/slack-reader');
const { trackSlackConversation: _trackSlackConversation } = require('./lib/conversation-tracker');
// Agent uses direct Anthropic API tool-use (no Agent SDK needed)

const http = require('http');
const os = require('os');
const path = require('path');
const config = require('./lib/config');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');

// ── Configuration ────────────────────────────────────────────────────
const CONFIG = {
  myUserId: null,      // Authenticated user (Alexander when using user token)
  botUserId: null,      // Bot's own user ID (for filtering bot echo messages)
  responseTimeout: 10 * 60 * 1000,
  checkInterval: 60 * 1000,
  stateFile: path.join(__dirname, 'slack-events-state.json'),
};

// ── State ────────────────────────────────────────────────────────────
let pendingMessages = {};
let followupsDbConn = null;
let accountId = null;
let heartbeatInterval = null;
const ruleRefinementThreads = new Map();
let agentAvailable = false;

// ── Bolt App ─────────────────────────────────────────────────────────
const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

// ── State Management ─────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const data = fs.readFileSync(CONFIG.stateFile, 'utf-8');
      pendingMessages = JSON.parse(data);
      log.info({ count: Object.keys(pendingMessages).length }, 'State loaded');
    }
  } catch (error) {
    log.error({ err: error }, 'Error loading state');
    pendingMessages = {};
  }
}

function saveState() {
  try {
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(pendingMessages, null, 2));
  } catch (error) {
    log.error({ err: error }, 'Error saving state');
  }
}

// ── Utility Functions ────────────────────────────────────────────────

function sendMacOSNotification(title, message) {
  try {
    const escapedTitle = title.replace(/"/g, '\\"').substring(0, 100);
    const escapedMessage = message.replace(/"/g, '\\"').substring(0, 200);
    execSync(`osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"'`, { stdio: 'ignore' });
  } catch (error) {
    log.error({ err: error }, 'macOS notification error');
  }
}

function trackSlackConversation(db, event, direction) {
  return _trackSlackConversation({ db, accountId, slackReader, reticleDb, log, mySlackUserId: config.slackUserId }, event, direction);
}

// ── Message Tracking ─────────────────────────────────────────────────

async function trackMessage(client, channel, ts, userId, text, type) {
  const msgKey = `${channel}_${ts}`;
  if (pendingMessages[msgKey]) return;

  let user, channelInfo;
  try {
    const userRes = await client.users.info({ user: userId });
    user = userRes.user;
  } catch (_) { user = null; }

  if (type === 'mention') {
    try {
      const chRes = await client.conversations.info({ channel });
      channelInfo = chRes.channel;
    } catch (_) { channelInfo = null; }
  }

  pendingMessages[msgKey] = {
    channel,
    channelName: channelInfo?.name || 'DM',
    user: user?.name || user?.real_name || userId,
    text: (text || '').substring(0, 100),
    ts,
    time: parseFloat(ts) * 1000,
    type,
    reminded: false
  };

  log.info({ type, user: pendingMessages[msgKey].user, channel }, 'Tracking new message');
  saveState();
}

function markResponded(channel, ts) {
  let removed = 0;
  for (const [key, msg] of Object.entries(pendingMessages)) {
    if (msg.channel === channel && !msg.reminded) {
      const msgTime = parseFloat(msg.ts);
      const responseTime = parseFloat(ts);
      if (responseTime > msgTime) {
        delete pendingMessages[key];
        removed++;
      }
    }
  }
  if (removed > 0) {
    log.info({ count: removed, channel }, 'Cleared tracked messages (user responded)');
    saveState();
  }
}

async function checkTimeouts(client) {
  const now = Date.now();
  let reminders = 0;

  for (const [key, msg] of Object.entries(pendingMessages)) {
    if (msg.reminded) continue;

    const timeSince = now - msg.time;
    if (timeSince > CONFIG.responseTimeout) {
      const minutesAgo = Math.floor(timeSince / 60000);
      const type = msg.type === 'mention' ? '@mention' : 'DM';
      const location = msg.type === 'mention' ? `#${msg.channelName}` : 'DM';

      try {
        await client.chat.postMessage({
          channel: CONFIG.myUserId,
          text: `⏰ *Unanswered ${type} Reminder*\n` +
            `You haven't responded to a ${type} from *${msg.user}* in ${location}\n` +
            `*${minutesAgo} minutes ago*\n` +
            `_"${msg.text}${msg.text.length >= 100 ? '...' : ''}"_`,
          unfurl_links: false,
        });

        sendMacOSNotification(
          `⏰ Unanswered ${type} (${minutesAgo}m)`,
          `From ${msg.user} in ${location}: ${msg.text.substring(0, 100)}`
        );

        pendingMessages[key].reminded = true;
        pendingMessages[key].remindedAt = now;
        reminders++;
        log.info({ type, user: msg.user, minutesAgo }, 'Sent reminder');
      } catch (error) {
        log.error({ err: error, type, user: msg.user }, 'Failed to send reminder');
      }
    }
  }

  if (reminders > 0) saveState();

  // Clean up old entries (>24 hours)
  const dayAgo = now - (24 * 60 * 60 * 1000);
  let cleaned = 0;
  for (const [key, msg] of Object.entries(pendingMessages)) {
    if (msg.time < dayAgo) {
      delete pendingMessages[key];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.debug({ count: cleaned }, 'Cleaned old messages');
    saveState();
  }
}

// ── Agent (Claude Agent SDK) ─────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are Reticle, Alexander's work-alignment instrument. You respond in Slack DMs.

A follow-up snapshot has been loaded at the start of this conversation. Use it to answer questions — do not call get_open_followups again unless Alexander explicitly asks for a refresh.

Core rules:
- STRUCTURED, NOT PROSE: Use "Person — description — age" format. No paragraphs, no emoji headers.
- REMEMBER THE THREAD: You have conversation history. Reference what you already said. Never re-dump data.
- BEFORE RESOLVING: Confirm which specific item by name and fact ID.

What you can do:
- Answer factual questions about a specific person ("did I reply to Josh?", "what's open with Sam?") — answer yes/no, one line of evidence, stop.
- Resolve or waive obligations via tools after confirmation
- Report count summaries ("you have 3 unreplied items")

What you must NOT do:
- Return ranked or prioritized lists — no ranking layer exists yet. If asked "what should I handle first?" or "show me what's urgent", respond: "I don't have a ranking layer yet — ask me about a specific person and I can tell you their status."
- Dump the full queue unprompted. If asked "show me everything" / "show me stale", respond with a count and offer specific lookup: "There are N items. Who do you want to check on?"
- Editorialize ("It's… a lot"). State facts, not commentary.
- Repeat information you already provided in this thread.
- Say "I don't have context" — you DO have the thread history and the loaded snapshot.`;

// Tool definitions for direct Anthropic API tool-use
const AGENT_TOOLS = [
  {
    name: 'list_obligations',
    description: 'List open obligations (commitments, asks) from the org-memory knowledge graph, grouped by person. Returns fact IDs for resolving.',
    input_schema: { type: 'object', properties: { personName: { type: 'string', description: 'Filter by person name (optional)' } } },
  },
  {
    name: 'resolve_obligation',
    description: 'Mark an obligation as completed. Requires the fact ID from list_obligations. Always confirm with the user before calling this.',
    input_schema: {
      type: 'object', required: ['factId'],
      properties: { factId: { type: 'string', description: 'UUID of the fact' }, rationale: { type: 'string', description: 'Why resolved' } },
    },
  },
  {
    name: 'waive_obligation',
    description: 'Mark an obligation as intentionally waived (not acting on it). Different from resolve.',
    input_schema: {
      type: 'object', required: ['factId'],
      properties: { factId: { type: 'string', description: 'UUID of the fact' }, rationale: { type: 'string', description: 'Why waived' } },
    },
  },
  {
    name: 'get_open_followups',
    description: 'Get follow-up status: unreplied conversations (waiting for your response), awaiting (waiting for others), stale (7+ days), resolved today.',
    input_schema: { type: 'object', properties: {} },
  },
];

// Tool execution — calls library functions directly (no MCP, no subprocess)
async function executeAgentTool(name, input) {
  const { getObligations, resolveObligation, getFollowups, groupFollowups } = require('./lib/reticle-mcp-server');

  switch (name) {
    case 'list_obligations': {
      const obligations = await getObligations(
        { mockOrgMemory: false },
        input.personName || undefined
      );
      return JSON.stringify({ obligations });
    }
    case 'resolve_obligation': {
      await resolveObligation({ mockOrgMemory: false }, input.factId, 'completed', input.rationale);
      return JSON.stringify({ resolved: true, factId: input.factId });
    }
    case 'waive_obligation': {
      await resolveObligation({ mockOrgMemory: false }, input.factId, 'abandoned', input.rationale || 'intentionally waived');
      return JSON.stringify({ waived: true, factId: input.factId });
    }
    case 'get_open_followups': {
      const items = await getFollowups({ mockCollectors: false, db: followupsDbConn, accountId });
      return JSON.stringify(groupFollowups(items));
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function handleAgentMessage(client, event) {
  const startTime = Date.now();
  log.info({ channel: event.channel, textLen: (event.text || '').length }, 'Agent handling message');

  // Add thinking indicator
  try {
    await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts });
  } catch (_) {}

  try {
    const { buildConversationMessages } = require('./lib/agent-conversation');
    const { getFollowups, groupFollowups } = require('./lib/reticle-mcp-server');

    // Fetch a single data snapshot upfront — all turns in this request reason from
    // this snapshot, preventing contradictions from independent re-queries.
    let snapshot = null;
    try {
      const items = await getFollowups({ mockCollectors: false, db: followupsDbConn, accountId });
      snapshot = JSON.stringify(groupFollowups(items));
      log.debug({ snapshotLen: snapshot.length }, 'Fetched followup snapshot');
    } catch (err) {
      log.warn({ err: err.message }, 'Could not fetch followup snapshot — proceeding without');
    }

    // Fetch recent Slack conversation history for multi-turn context
    let rawHistory = [];
    try {
      const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
      const historyResult = await client.conversations.history({
        channel: event.channel,
        limit: 20,
        oldest: String(tenMinAgo),
      });
      if (historyResult.messages && historyResult.messages.length > 1) {
        rawHistory = historyResult.messages
          .reverse()
          .filter(m => !m.subtype && m.text)
          .map(m => ({
            role: m.bot_id || m.user === CONFIG.botUserId ? 'assistant' : 'user',
            content: m.text,
          }));
        log.debug({ turns: rawHistory.length }, 'Loaded raw conversation history');
      }
    } catch (err) {
      log.debug({ err: err.message }, 'Could not fetch conversation history — using single message');
    }

    // Direct Anthropic API tool-use loop
    const ai = require('./lib/ai');
    const anthropic = ai.getClient();
    if (!anthropic) throw new Error('AI client not available');

    let messages = buildConversationMessages({
      history: rawHistory,
      currentText: event.text || '',
      snapshot,
    });
    let resultText = '';
    const toolsUsed = [];
    const MAX_ROUNDS = 5;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        system: AGENT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        messages,
      });

      // If Claude is done (no tool calls), extract final text
      if (response.stop_reason === 'end_turn') {
        const textBlocks = response.content.filter(b => b.type === 'text' && b.text?.trim());
        resultText = textBlocks.map(b => b.text).join('\n');
        break;
      }

      // If Claude wants to use tools, execute them
      if (response.stop_reason === 'tool_use') {
        // Append assistant message with tool_use blocks
        messages = [...messages, { role: 'assistant', content: response.content }];

        // Execute each tool call
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            log.info({ tool: block.name, input: block.input }, 'Agent executing tool');
            try {
              const result = await executeAgentTool(block.name, block.input);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            } catch (err) {
              log.error({ err, tool: block.name }, 'Tool execution failed');
              toolResults.push({
                type: 'tool_result', tool_use_id: block.id,
                content: `Error: ${err.message}`, is_error: true,
              });
            }
          }
        }

        // Append tool results and continue the loop
        messages = [...messages, { role: 'user', content: toolResults }];
        continue;
      }

      // Unexpected stop reason — extract whatever text we have
      const textBlocks = response.content.filter(b => b.type === 'text' && b.text?.trim());
      resultText = textBlocks.map(b => b.text).join('\n') || 'I got an unexpected response. Try again?';
      break;
    }

    const elapsed = Date.now() - startTime;
    log.info({ channel: event.channel, elapsed, toolsUsed, rounds: toolsUsed.length }, 'Agent response ready');

    // Remove thinking indicator
    try {
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts });
    } catch (_) {}

    if (resultText) {
      // Resolve the bot's DM channel (event.channel may be from user-token perspective)
      let replyChannel = event.channel;
      try {
        const dm = await client.conversations.open({ users: event.user });
        replyChannel = dm.channel.id;
        log.debug({ eventChannel: event.channel, resolvedChannel: replyChannel }, 'Resolved bot DM channel');
      } catch (dmErr) {
        log.warn({ err: dmErr.message, user: event.user, eventChannel: event.channel }, 'conversations.open failed — using event channel');
      }

      // Split long messages for Slack's 4000-char limit
      if (resultText.length > 3900) {
        const chunks = resultText.match(/[\s\S]{1,3900}/g) || [resultText];
        for (const chunk of chunks) {
          await client.chat.postMessage({ channel: replyChannel, text: chunk, unfurl_links: false });
        }
      } else {
        await client.chat.postMessage({ channel: replyChannel, text: resultText, unfurl_links: false });
      }
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log.error({ err, channel: event.channel, elapsed }, 'Agent pipeline error');

    try {
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts });
    } catch (_) {}

    await client.chat.postMessage({
      channel: event.channel,
      text: "Something went wrong — I couldn't process that. Try again?",
      unfurl_links: false,
    });
  }
}


// ── Gmail Helpers ────────────────────────────────────────────────────

function getGmailClient() {
  const { google } = require('googleapis');
  const credentials = JSON.parse(fs.readFileSync(config.gmailCredentialsPath));
  const token = JSON.parse(fs.readFileSync(config.gmailTokenPath));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

async function getEmailMeta(emailId) {
  const cached = emailCache.getCachedEmail(emailId);
  if (cached) return cached;

  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] });
    const headers = res.data.payload.headers;
    const meta = {
      id: emailId,
      from: headers.find(h => h.name === 'From')?.value || '',
      to: headers.find(h => h.name === 'To')?.value || '',
      cc: headers.find(h => h.name === 'Cc')?.value || '',
      subject: headers.find(h => h.name === 'Subject')?.value || '',
      date: headers.find(h => h.name === 'Date')?.value || ''
    };
    emailCache.cacheEmail(emailId, meta);
    return meta;
  } catch (error) {
    log.error({ err: error, emailId }, 'Failed to fetch email metadata');
    return null;
  }
}

async function sendEmailContent(client, channel, userId, emailId) {
  try {
    let from, subject, date, body;

    const cached = emailCache.getCachedEmail(emailId);
    if (cached) {
      from = cached.from; subject = cached.subject; date = cached.date; body = cached.body;
    } else {
      const gmail = getGmailClient();
      const res = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'full' });
      const email = res.data;
      from = email.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
      subject = email.payload.headers.find(h => h.name === 'Subject')?.value || 'No subject';
      date = email.payload.headers.find(h => h.name === 'Date')?.value || 'Unknown date';

      body = '';
      const parts = email.payload.parts || [email.payload];
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          body = Buffer.from(part.body.data, 'base64').toString();
          break;
        }
      }
      if (!body) {
        for (const part of parts) {
          if (part.mimeType === 'text/html' && part.body.data) {
            const { convert } = require('html-to-text');
            const html = Buffer.from(part.body.data, 'base64').toString();
            body = convert(html, {
              wordwrap: 80,
              selectors: [
                { selector: 'a', options: { ignoreHref: true } },
                { selector: 'img', format: 'skip' },
                { selector: 'table', options: { uppercaseHeaderCells: false } }
              ]
            });
            break;
          }
        }
      }
      if (!body && email.payload.body?.data) {
        body = Buffer.from(email.payload.body.data, 'base64').toString();
      }
      emailCache.cacheEmail(emailId, { from, subject, date, body });
    }

    if (body && body.length > 3000) {
      body = body.substring(0, 3000) + '\n\n... (truncated)';
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `📧 *Email Content*\n\n*From:* ${from}\n*Subject:* ${subject}\n*Date:* ${date}` } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '```\n' + (body || 'No content available').substring(0, 2800) + '\n```' } }
    ];

    await client.chat.postEphemeral({ channel, user: userId, blocks, text: 'Email content' });
    log.info({ emailId }, 'Email content sent as ephemeral message');
  } catch (error) {
    log.error({ err: error, emailId }, 'Error sending email content');
    throw error;
  }
}

async function archiveEmailAction(emailId) {
  try {
    const gmail = getGmailClient();
    await gmail.users.messages.modify({ userId: 'me', id: emailId, requestBody: { removeLabelIds: ['INBOX'] } });
    log.info({ emailId }, 'Email archived via Gmail API');
    return { success: true, message: '✓ Email archived' };
  } catch (error) {
    log.error({ err: error, emailId }, 'Archive failed');
    return { success: false, message: `✗ Archive failed: ${error.message}` };
  }
}

async function deleteEmailAction(emailId) {
  try {
    const gmail = getGmailClient();
    await gmail.users.messages.trash({ userId: 'me', id: emailId });
    log.info({ emailId }, 'Email trashed via Gmail API');
    return { success: true, message: '✓ Email moved to trash' };
  } catch (error) {
    log.error({ err: error, emailId }, 'Delete failed');
    return { success: false, message: `✗ Delete failed: ${error.message}` };
  }
}

async function unsubscribeEmailAction(emailId) {
  try {
    const scriptPath = '/tmp/unsub-by-id.sh';
    fs.writeFileSync(scriptPath, `#!/bin/bash\ncd ${__dirname}\n./unsub "id:${emailId}"\n`);
    execSync(`chmod +x ${scriptPath}`);
    execSync(scriptPath, { stdio: 'pipe', timeout: 30000 });
    log.info({ emailId }, 'Unsubscribe automation completed');
    return { success: true, message: '✓ Unsubscribe automation started' };
  } catch (error) {
    log.error({ err: error, emailId }, 'Unsubscribe failed');
    return { success: false, message: `✗ Unsubscribe failed: ${error.message}` };
  }
}

// ── Classification Helpers ───────────────────────────────────────────

function decodeClassifyAction(value) {
  const [code, emailId] = value.split('|');
  const actionMap = { as: 'archive', ds: 'delete', ls: 'alert', dm: 'demote', ad: 'archive' };
  return { actionType: actionMap[code], isDomain: code === 'ad', emailId };
}

function immediateActionForType(actionType) {
  if (actionType === 'archive' || actionType === 'demote') return 'archive';
  if (actionType === 'delete') return 'delete';
  return null;
}

function buildRuleConfirmationBlocks(ruleType, description, ruleId, extra) {
  const label = ruleType.charAt(0).toUpperCase() + ruleType.slice(1);
  const elements = [];

  if (extra?.suggested) {
    elements.push(
      { type: 'button', text: { type: 'plain_text', text: 'Yes, apply this rule' }, action_id: 'accept_suggested_rule', value: String(ruleId), style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: 'No, just match sender' }, action_id: 'accept_default_rule', value: `${ruleId}|${extra.defaultRuleArgs}` },
      { type: 'button', text: { type: 'plain_text', text: 'Match differently...' }, action_id: 'match_differently', value: String(ruleId) }
    );
  } else {
    elements.push(
      { type: 'button', text: { type: 'plain_text', text: 'Undo rule' }, action_id: 'undo_rule', value: String(ruleId) },
      { type: 'button', text: { type: 'plain_text', text: 'Match differently...' }, action_id: 'match_differently', value: String(ruleId) }
    );
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: extra?.suggested
        ? `📋 Suggested rule: ${label} when ${description}\n${extra.reason}`
        : `✓ Rule created: ${label} when ${description}` } },
    { type: 'actions', elements }
  ];
}

function extractDistributionList(recipients, myEmail) {
  const addresses = recipients.match(/[\w.+-]+@[\w.-]+/g) || [];
  const dlCandidates = addresses.filter(a => a.toLowerCase() !== myEmail);
  return dlCandidates[0] || '';
}

function storeRefinementContext(threadTs, channel, emailMeta, ruleType, currentConditions, ruleId) {
  ruleRefinementThreads.set(threadTs, { emailMeta, ruleType, currentConditions, ruleId, channel });
  setTimeout(() => ruleRefinementThreads.delete(threadTs), 60 * 60 * 1000);
}

async function handleClassifyAction(client, action, channel, userId, messageTs) {
  const selectedValue = action.selected_option?.value;
  if (!selectedValue) return;

  const { actionType, isDomain, emailId } = decodeClassifyAction(selectedValue);
  const cid = `cls_${crypto.randomBytes(4).toString('hex')}`;
  log.info({ cid, actionType, isDomain, emailId }, 'Classify action');

  const meta = await getEmailMeta(emailId);
  if (!meta) {
    await client.chat.postMessage({ channel, text: '✗ Could not load email metadata', unfurl_links: false });
    return;
  }

  const { email: senderEmail, domain: senderDomain } = parseSenderEmail(meta.from);

  if (isDomain && config.filterPatterns?.companyDomain && senderDomain === config.filterPatterns.companyDomain) {
    await client.chat.postMessage({ channel, text: `⚠️ Cannot ${actionType} emails from your own domain (@${senderDomain})`, unfurl_links: false });
    return;
  }

  const immediateAction = immediateActionForType(actionType);
  if (immediateAction === 'archive') {
    try { await archiveEmailAction(emailId); } catch (e) { log.warn({ err: e, emailId }, 'Immediate archive failed'); }
  } else if (immediateAction === 'delete') {
    try { await deleteEmailAction(emailId); } catch (e) { log.warn({ err: e, emailId }, 'Immediate delete failed'); }
  }

  if (isDomain) {
    const confirmBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `⚠️ This will ${actionType} *ALL* emails from @${senderDomain}` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Confirm' }, action_id: 'confirm_domain_rule', value: `${actionType}|${senderDomain}|${meta.from}|${meta.subject}`, style: 'danger' },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'cancel_domain_rule', value: 'cancel' }
      ]}
    ];
    const actionLabel = immediateAction === 'archive' ? '✓ Archived this email\n' : immediateAction === 'delete' ? '✓ Trashed this email\n' : '';
    await client.chat.postMessage({ channel, text: `${actionLabel}⚠️ Confirm domain rule for @${senderDomain}`, unfurl_links: false });
    await client.chat.postMessage({ channel, text: `Confirm domain rule`, blocks: confirmBlocks, unfurl_links: false });
    return;
  }

  const myEmail = config.gmailAccount?.toLowerCase() || '';
  const allRecipients = `${meta.to || ''} ${meta.cc || ''}`.toLowerCase();
  const sentToDL = allRecipients && !allRecipients.includes(myEmail) && allRecipients.includes('@');

  if (sentToDL) {
    const toMatch = extractDistributionList(allRecipients, myEmail);
    const suggestedConditions = { ruleType: actionType, matchFrom: senderEmail, matchTo: toMatch };
    const description = `FROM ${senderEmail} AND TO ${toMatch}`;
    const ruleRow = reticleDb.createRule(followupsDbConn, accountId, {
      rule_type: actionType, match_from: senderEmail, match_to: toMatch,
      source_email: meta.from, source_subject: meta.subject
    });
    const ruleId = ruleRow.id;
    reticleDb.deactivateRule(followupsDbConn, ruleId);

    const defaultRuleArgs = JSON.stringify({ rule_type: actionType, match_from: senderEmail, source_email: meta.from, source_subject: meta.subject });
    const actionLabel = immediateAction === 'archive' ? '✓ Archived this email\n' : immediateAction === 'delete' ? '✓ Trashed this email\n' : '';
    const blocks = buildRuleConfirmationBlocks(actionType, description, ruleId, {
      suggested: true,
      reason: '_(More targeted — this was sent to a distribution list, not directly to you)_',
      defaultRuleArgs: Buffer.from(defaultRuleArgs).toString('base64').substring(0, 60)
    });
    if (actionLabel) {
      blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: actionLabel.trim() } });
    }
    const resp = await client.chat.postMessage({ channel, text: `Suggested rule: ${description}`, blocks, unfurl_links: false });
    if (resp?.ts) {
      storeRefinementContext(resp.ts, channel, meta, actionType, { matchFrom: senderEmail, matchTo: toMatch }, ruleId);
    }
  } else {
    const ruleRow2 = reticleDb.createRule(followupsDbConn, accountId, {
      rule_type: actionType, match_from: senderEmail,
      source_email: meta.from, source_subject: meta.subject
    });
    const ruleId = ruleRow2.id;
    const description = formatRuleDescription(reticleDb.getRuleById(followupsDbConn, ruleId));
    const actionLabel = immediateAction === 'archive' ? '✓ Archived this email\n' : immediateAction === 'delete' ? '✓ Trashed this email\n' : '';
    const blocks = buildRuleConfirmationBlocks(actionType, description, ruleId);
    if (actionLabel) {
      blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: actionLabel.trim() } });
    }
    const resp = await client.chat.postMessage({ channel, text: `Rule created: ${actionType} when ${description}`, blocks, unfurl_links: false });
    if (resp?.ts) {
      storeRefinementContext(resp.ts, channel, meta, actionType, { matchFrom: senderEmail }, ruleId);
    }
    log.info({ cid, ruleId, description }, 'Default rule created');
  }
}

async function handleRuleRefinementReply(client, event) {
  const threadTs = event.thread_ts;
  const ctx = ruleRefinementThreads.get(threadTs);
  if (!ctx) return false;

  const userText = event.text;
  log.info({ threadTs, userText }, 'Rule refinement reply');

  const result = await parseRuleRefinement({
    emailMeta: { from: ctx.emailMeta.from, to: ctx.emailMeta.to, cc: ctx.emailMeta.cc, subject: ctx.emailMeta.subject },
    currentRule: ctx.currentConditions,
    userInstruction: userText
  });

  if (!result) {
    await client.chat.postMessage({ channel: ctx.channel, text: "I couldn't parse that — try being more specific, e.g., \"only when subject mentions role audit\" or \"remove the To condition\"", thread_ts: threadTs, unfurl_links: false });
    return true;
  }

  const description = formatRuleDescription({
    match_from: result.matchFrom, match_from_domain: result.matchFromDomain,
    match_to: result.matchTo, match_subject_contains: result.matchSubjectContains
  });

  const newRuleRow = reticleDb.createRule(followupsDbConn, accountId, {
    rule_type: ctx.ruleType, match_from: result.matchFrom, match_from_domain: result.matchFromDomain,
    match_to: result.matchTo, match_subject_contains: result.matchSubjectContains,
    source_email: ctx.emailMeta.from, source_subject: ctx.emailMeta.subject
  });
  const newRuleId = newRuleRow.id;
  reticleDb.deactivateRule(followupsDbConn, newRuleId);

  ctx.currentConditions = result;
  ctx.ruleId = newRuleId;

  const label = ctx.ruleType.charAt(0).toUpperCase() + ctx.ruleType.slice(1);
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `Updated rule: ${label} when ${description}` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Apply this rule' }, action_id: 'apply_refined_rule', value: String(newRuleId), style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: 'Try again' }, action_id: 'try_again_refine', value: threadTs }
    ]}
  ];
  await client.chat.postMessage({ channel: ctx.channel, text: `Updated rule: ${description}`, blocks, thread_ts: threadTs, unfurl_links: false });
  return true;
}

// ── Bolt Event Handlers ──────────────────────────────────────────────

// Handle all message events (DMs and channel messages)
app.event('message', async ({ event, client }) => {
  // Skip message subtypes (joins, leaves, etc.)
  if (event.subtype) return;

  // Bot's own echo messages — mark responses, don't process further
  if (CONFIG.botUserId && event.user === CONFIG.botUserId) {
    markResponded(event.channel, event.ts);
    if (followupsDbConn && event.channel_type === 'im') {
      await trackSlackConversation(followupsDbConn, event, 'outgoing');
    }
    return;
  }

  // Ignore other bot messages
  if (event.bot_id) {
    log.debug({ botId: event.bot_id, channel: event.channel }, 'Ignoring bot message');
    return;
  }

  // Intercept rule refinement thread replies
  if (event.thread_ts && ruleRefinementThreads.has(event.thread_ts)) {
    const handled = await handleRuleRefinementReply(client, event);
    if (handled) return;
  }

  log.info({ eventType: 'message', channel: event.channel }, 'Event received');

  // Track conversation in follow-ups database
  const isMyMessage = event.user === CONFIG.myUserId;
  if (!isMyMessage) {
    try {
      await trackSlackConversation(followupsDbConn, event, 'incoming');
    } catch (err) {
      log.warn({ err, channel: event.channel, ts: event.ts, user: event.user }, 'Failed to track conversation — continuing');
    }
  } else if (followupsDbConn) {
    // Track Alexander's outgoing messages (DMs and channel thread replies)
    try {
      await trackSlackConversation(followupsDbConn, event, 'outgoing');
    } catch (err) {
      log.warn({ err }, 'Failed to track outgoing conversation');
    }
  }

  // Capture ALL non-bot messages to org-memory (including Alexander's own)
  {
    try {
      const omDb = orgMemoryDb.getDatabase();
      const userName = await slackReader.getUserInfo(event.user);
      const channelName = event.channel_type === 'im'
        ? userName
        : await slackReader.getConversationInfo(event.channel);

      slackCapture.captureMessage(omDb, {
        channel: event.channel,
        channelName,
        ts: event.ts,
        user: event.user,
        userName,
        text: event.text,
        threadTs: event.thread_ts || null,
        channelType: event.channel_type,
        clientMsgId: event.client_msg_id || null,
        subtype: event.subtype || null,
      });
      log.debug({ channel: event.channel, user: event.user, channelName }, 'Message captured to org-memory');
    } catch (err) {
      log.warn({ err, channel: event.channel, ts: event.ts, user: event.user }, 'Failed to capture message to org-memory');
    }
  }

  // Route DMs from Alexander to the conversational agent (async, non-blocking)
  // Only route to the agent for messages in the bot's own DM channel with Alexander
  // (not Alexander's DMs with other people, which the bot can't reply to)
  if (agentAvailable && CONFIG.botDmChannel && event.channel === CONFIG.botDmChannel) {
    handleAgentMessage(client, event).catch(err => {
      log.error({ err, channel: event.channel, ts: event.ts }, 'Agent pipeline failed');
    });
  }

  // Track message for timeout reminders
  if (event.channel_type === 'im') {
    await trackMessage(client, event.channel, event.ts, event.user, event.text, 'dm');
  }
});

// Handle @mentions in channels
app.event('app_mention', async ({ event, client }) => {
  if (event.bot_id) return;

  log.info({ eventType: 'app_mention', channel: event.channel }, 'Event received');

  // Track conversation (app_mention = bot was explicitly @mentioned, always track)
  try {
    await trackSlackConversation(followupsDbConn, { ...event, _appMention: true }, 'incoming');
  } catch (err) {
    log.warn({ err }, 'Failed to track mention conversation');
  }

  // Capture to org-memory
  try {
    const omDb = orgMemoryDb.getDatabase();
    const userName = await slackReader.getUserInfo(event.user);
    const channelName = await slackReader.getConversationInfo(event.channel);
    slackCapture.captureMessage(omDb, {
      channel: event.channel, channelName, ts: event.ts, user: event.user,
      userName, text: event.text, threadTs: event.thread_ts || null,
      channelType: event.channel_type, clientMsgId: event.client_msg_id || null,
      subtype: null,
    });
  } catch (err) {
    log.warn({ err }, 'Failed to capture mention to org-memory');
  }

  await trackMessage(client, event.channel, event.ts, event.user, event.text, 'mention');
});

// Handle Slack huddle start/end for ad-hoc recording
app.event('user_huddle_changed', async ({ event }) => {
  // Only care about our own huddle state
  if (event.user?.id !== config.slackUserId) return;

  const huddleState = event.user?.profile?.huddle_state;
  const callId = event.user?.profile?.huddle_state_call_id;

  if (huddleState === 'in_a_huddle') {
    log.info({ callId }, 'Huddle started — triggering recording');
    try {
      const body = JSON.stringify({
        meetingId: `huddle-${callId || Date.now()}`,
        title: 'Slack Huddle',
        attendees: [],
      });
      const req = http.request({
        hostname: '127.0.0.1', port: 9847, path: '/start', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => log.info({ resp: data }, 'Recorder start response'));
      });
      req.on('error', (err) => log.warn({ err }, 'Recorder not available for huddle'));
      req.setTimeout(3000, () => req.destroy());
      req.write(body);
      req.end();
    } catch (err) {
      log.warn({ err }, 'Failed to trigger huddle recording');
    }
  } else {
    log.info({ callId }, 'Huddle ended — stopping recording');
    try {
      const req = http.request({
        hostname: '127.0.0.1', port: 9847, path: '/stop', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      req.on('error', (err) => log.warn({ err }, 'Recorder not available for huddle stop'));
      req.setTimeout(3000, () => req.destroy());
      req.end();
    } catch (err) {
      log.warn({ err }, 'Failed to stop huddle recording');
    }
  }
});

// ── Bolt Interactive Handlers ────────────────────────────────────────

// Helper: parse action context from interactive payload
function parseActionContext(body) {
  const action = body.actions[0];
  const userId = body.user.id;
  const channel = body.channel.id;
  const valueParts = action.value ? action.value.split('|') : [];
  const emailId = valueParts[0];
  const threadId = valueParts[1] || null;
  const cached = emailId ? emailCache.getCachedEmail(emailId) : null;
  return { action, userId, channel, emailId, threadId, cached };
}

app.action('view_email_modal', async ({ ack, body, client }) => {
  await ack();
  const { userId, channel, emailId } = parseActionContext(body);
  await sendEmailContent(client, channel, userId, emailId);
});

app.action('archive_email', async ({ ack, body, client }) => {
  await ack();
  const { channel, emailId, threadId } = parseActionContext(body);
  const result = await archiveEmailAction(emailId);
  if (result.message) await client.chat.postMessage({ channel, text: result.message, unfurl_links: false });
  if (followupsDbConn && threadId) reticleDb.resolveConversation(followupsDbConn, `email:${threadId}`);
});

app.action('delete_email', async ({ ack, body, client }) => {
  await ack();
  const { channel, emailId, threadId } = parseActionContext(body);
  const result = await deleteEmailAction(emailId);
  if (result.message) await client.chat.postMessage({ channel, text: result.message, unfurl_links: false });
  if (followupsDbConn && threadId) reticleDb.resolveConversation(followupsDbConn, `email:${threadId}`);
});

app.action('unsubscribe_email', async ({ ack, body, client }) => {
  await ack();
  const { channel, emailId, threadId } = parseActionContext(body);
  const result = await unsubscribeEmailAction(emailId);
  if (result.message) await client.chat.postMessage({ channel, text: result.message, unfurl_links: false });
  if (followupsDbConn && threadId) reticleDb.resolveConversation(followupsDbConn, `email:${threadId}`);
});

app.action('mark_replied', async ({ ack, body, client }) => {
  await ack();
  const { channel, threadId } = parseActionContext(body);
  if (threadId && followupsDbConn) {
    reticleDb.updateConversationState(followupsDbConn, `email:${threadId}`, 'me', 'their-response');
  }
  await client.chat.postMessage({ channel, text: '✓ Marked as replied', unfurl_links: false });
});

app.action('mark_no_response_needed', async ({ ack, body, client }) => {
  await ack();
  const { channel, threadId } = parseActionContext(body);
  if (threadId && followupsDbConn) {
    reticleDb.resolveConversation(followupsDbConn, `email:${threadId}`);
  }
  await client.chat.postMessage({ channel, text: '✓ Marked as no reply needed', unfurl_links: false });
});

app.action('open_in_gmail', async ({ ack }) => {
  await ack();
  // Handled by Slack URL button — no server action needed
});

app.action('classify_email', async ({ ack, body, client }) => {
  await ack();
  const action = body.actions[0];
  const userId = body.user.id;
  const channel = body.channel.id;
  await handleClassifyAction(client, action, channel, userId, body.message?.ts);
});

app.action('accept_suggested_rule', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const ruleId = parseInt(body.actions[0].value);
  if (followupsDbConn) {
    reticleDb.createRule(followupsDbConn, accountId, (() => {
      const r = reticleDb.getRuleById(followupsDbConn, ruleId);
      if (!r) return { rule_type: 'archive' };
      return { rule_type: r.rule_type, match_from: r.match_from, match_from_domain: r.match_from_domain, match_to: r.match_to, match_subject_contains: r.match_subject_contains, source_email: r.source_email, source_subject: r.source_subject };
    })());
    const rule = reticleDb.getRuleById(followupsDbConn, ruleId);
    const desc = rule ? formatRuleDescription(rule) : 'unknown';
    await client.chat.postMessage({ channel, text: `✓ Rule created: ${rule?.rule_type || 'archive'} when ${desc}`, unfurl_links: false });
  }
});

app.action('accept_default_rule', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const parts = body.actions[0].value.split('|');
  const proposedRuleId = parseInt(parts[0]);
  try {
    const argsJson = Buffer.from(parts[1] || '', 'base64').toString();
    const args = JSON.parse(argsJson);
    if (followupsDbConn) {
      reticleDb.deactivateRule(followupsDbConn, proposedRuleId);
      const rule = reticleDb.createRule(followupsDbConn, accountId, args);
      const desc = rule ? formatRuleDescription(rule) : 'unknown';
      await client.chat.postMessage({ channel, text: `✓ Rule created: ${rule?.rule_type || 'archive'} when ${desc}`, unfurl_links: false });
    }
  } catch (e) {
    log.warn({ err: e }, 'Failed to parse default rule args');
    await client.chat.postMessage({ channel, text: '✗ Failed to create rule', unfurl_links: false });
  }
});

app.action('undo_rule', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const ruleId = parseInt(body.actions[0].value);
  if (followupsDbConn) {
    const rule = reticleDb.getRuleById(followupsDbConn, ruleId);
    reticleDb.deactivateRule(followupsDbConn, ruleId);
    await client.chat.postMessage({ channel, text: `✓ Rule removed. Emails${rule?.match_from ? ` from ${rule.match_from}` : ''} will appear normally.`, unfurl_links: false });
  }
});

app.action('match_differently', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const ruleId = parseInt(body.actions[0].value);
  const ctx = [...ruleRefinementThreads.values()].find(c => c.ruleId === ruleId);
  if (ctx) {
    const meta = ctx.emailMeta;
    const currentDesc = formatRuleDescription({
      match_from: ctx.currentConditions.matchFrom, match_from_domain: ctx.currentConditions.matchFromDomain,
      match_to: ctx.currentConditions.matchTo, match_subject_contains: ctx.currentConditions.matchSubjectContains
    });
    const prompt = [
      'How should I match future emails like this?', '',
      'This email:',
      `  From: ${meta.from}`,
      meta.to ? `  To: ${meta.to}` : null,
      `  Subject: ${meta.subject}`, '',
      `Current rule: ${ctx.ruleType.charAt(0).toUpperCase() + ctx.ruleType.slice(1)} when ${currentDesc}`, '',
      'Tell me what to change — e.g., "only when subject mentions role audit", "from any sender to this DL", "remove the To condition"'
    ].filter(x => x !== null).join('\n');

    const msgTs = body.message?.ts || body.container?.message_ts;
    await client.chat.postMessage({ channel, text: prompt, thread_ts: msgTs, unfurl_links: false });
    if (msgTs) {
      ruleRefinementThreads.set(msgTs, ctx);
    }
  } else {
    await client.chat.postMessage({ channel, text: 'Session expired — click the overflow menu again to start over.', unfurl_links: false });
  }
});

app.action('apply_refined_rule', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const ruleId = parseInt(body.actions[0].value);
  if (followupsDbConn) {
    const rule = reticleDb.getRuleById(followupsDbConn, ruleId);
    if (rule) {
      reticleDb.createRule(followupsDbConn, accountId, {
        rule_type: rule.rule_type, match_from: rule.match_from, match_from_domain: rule.match_from_domain,
        match_to: rule.match_to, match_subject_contains: rule.match_subject_contains,
        source_email: rule.source_email, source_subject: rule.source_subject
      });
      const desc = formatRuleDescription(rule);
      const threadTs = body.message?.thread_ts || body.container?.thread_ts;
      if (threadTs) {
        const ctx = ruleRefinementThreads.get(threadTs);
        if (ctx && ctx.ruleId !== ruleId) {
          reticleDb.deactivateRule(followupsDbConn, ctx.ruleId);
        }
        ruleRefinementThreads.delete(threadTs);
      }
      await client.chat.postMessage({ channel, text: `✓ Rule created: ${rule.rule_type} when ${desc}`, unfurl_links: false });
    } else {
      await client.chat.postMessage({ channel, text: '✗ Rule not found', unfurl_links: false });
    }
  }
});

app.action('try_again_refine', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  await client.chat.postMessage({ channel, text: 'Tell me how you\'d like to adjust the rule:', thread_ts: body.actions[0].value, unfurl_links: false });
});

app.action('confirm_domain_rule', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const [ruleType, domain, sourceEmail, sourceSubject] = (body.actions[0].value || '').split('|');
  if (followupsDbConn && ruleType && domain) {
    reticleDb.createRule(followupsDbConn, accountId, {
      rule_type: ruleType, match_from_domain: domain,
      source_email: sourceEmail || null, source_subject: sourceSubject || null
    });
    await client.chat.postMessage({ channel, text: `✓ Rule created: ${ruleType} when FROM DOMAIN @${domain}`, unfurl_links: false });
  }
});

app.action('cancel_domain_rule', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  await client.chat.postMessage({ channel, text: '✓ Domain rule cancelled.', unfurl_links: false });
});

app.action('feedback_delivered', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const feedbackTracker = require('./lib/feedback-tracker');
  if (followupsDbConn) {
    const val = body.actions[0].value ? JSON.parse(body.actions[0].value) : {};
    feedbackTracker.logFeedbackAction(followupsDbConn, accountId, {
      reportName: val.report || 'unknown', feedbackType: val.feedbackType || 'unknown',
      action: 'feedback_delivered', entityId: val.entityId || ''
    });
    if (val.entityId) {
      followupsDbConn.prepare('UPDATE feedback_candidates SET status = ? WHERE entity_id = ?').run('delivered', val.entityId);
    }
  }
  await client.chat.postMessage({ channel, text: '✓ Feedback marked as delivered', unfurl_links: false });
});

app.action('feedback_skipped', async ({ ack, body, client }) => {
  await ack();
  const { channel } = parseActionContext(body);
  const feedbackTracker = require('./lib/feedback-tracker');
  if (followupsDbConn) {
    const val = body.actions[0].value ? JSON.parse(body.actions[0].value) : {};
    feedbackTracker.logFeedbackAction(followupsDbConn, accountId, {
      reportName: val.report || 'unknown', feedbackType: val.feedbackType || 'unknown',
      action: 'feedback_skipped', entityId: val.entityId || ''
    });
    if (val.entityId) {
      followupsDbConn.prepare('UPDATE feedback_candidates SET status = ? WHERE entity_id = ?').run('skipped', val.entityId);
    }
  }
  await client.chat.postMessage({ channel, text: '✓ Feedback marked as skipped', unfurl_links: false });
});

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  log.info({ responseTimeoutMin: CONFIG.responseTimeout / 60000 }, 'Slack Events Monitor starting (Bolt.js)');

  // Clean old cache files
  emailCache.cleanOldCache();
  const stats = emailCache.getCacheStats();
  log.info({ cacheCount: stats.count, cacheSizeMB: stats.totalSizeMB }, 'Email cache stats');

  // Validate prerequisites
  const validation = validatePrerequisites('slack-events', [
    { type: 'file', path: path.join(config.configDir, 'secrets.json'), description: 'Reticle secrets (Slack tokens)' },
    { type: 'database', path: reticleDb.DB_PATH, description: 'Reticle database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  // Initialize database
  try {
    followupsDbConn = reticleDb.initDatabase();
    const primaryAccount = reticleDb.upsertAccount(followupsDbConn, {
      email: config.gmailAccount, provider: 'gmail', display_name: 'Primary', is_primary: 1
    });
    accountId = primaryAccount.id;
    log.info('Reticle DB initialized');
  } catch (error) {
    log.error({ err: error }, 'Failed to init follow-ups DB');
  }

  // Check if AI client is available for conversational agent
  try {
    const ai = require('./lib/ai');
    const testClient = ai.getClient();
    if (testClient) {
      agentAvailable = true;
      log.info('AI client available — conversational agent enabled');
    } else {
      log.warn('No AI client — running without conversational agent');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'AI client check failed — running without conversational agent');
  }

  // Load state
  loadState();

  // Authenticate and resolve user IDs
  try {
    const authResult = await app.client.auth.test();
    CONFIG.myUserId = authResult.user_id;
    log.info({ myUserId: CONFIG.myUserId, user: authResult.user }, 'Authenticated with Slack');

    // If using user token, also resolve the bot's ID for echo filtering
    if (config.slackBotToken && config.slackUserToken) {
      try {
        const https = require('https');
        const botAuth = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'slack.com', path: '/api/auth.test', method: 'POST',
            headers: { 'Authorization': `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }
          }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
          req.on('error', reject); req.end();
        });
        if (botAuth.ok) {
          CONFIG.botUserId = botAuth.user_id;
          log.info({ botUserId: CONFIG.botUserId }, 'Resolved bot user ID for echo filtering');
        }
      } catch (err) {
        log.warn({ err }, 'Could not resolve bot user ID — bot echo filtering may not work');
      }
    } else {
      // Using bot token directly — bot IS the authenticated user
      CONFIG.botUserId = CONFIG.myUserId;
    }
  } catch (err) {
    log.fatal({ err }, 'Failed to authenticate with Slack');
    process.exit(1);
  }

  // Start Bolt app (Socket Mode)
  await app.start();
  log.info('Bolt.js Socket Mode connected');

  // Resolve the bot's DM channel with Alexander (for agent routing)
  try {
    const dm = await app.client.conversations.open({ users: config.slackUserId });
    CONFIG.botDmChannel = dm.channel.id;
    log.info({ botDmChannel: CONFIG.botDmChannel }, 'Resolved bot DM channel with Alexander');
  } catch (err) {
    log.warn({ err: err.message }, 'Could not resolve bot DM channel — agent will be unavailable');
  }

  // Heartbeat
  heartbeat.write('slack-events', { checkInterval: 30000, status: 'ok' });
  heartbeatInterval = setInterval(() => {
    heartbeat.write('slack-events', { checkInterval: 30000, status: 'ok' });
  }, 30000);

  // Timeout checker
  setInterval(async () => {
    log.debug('Checking for message timeouts');
    await checkTimeouts(app.client);
  }, CONFIG.checkInterval);
}

// ── Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  heartbeat.write('slack-events', { checkInterval: 30000, status: 'shutting-down' });
  log.info({ signal }, 'Received signal, shutting down');
  saveState();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  try { await app.stop(); } catch (_) {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('SIGHUP', () => {
  log.info('Received SIGHUP, reloading settings');
  try {
    const settingsPath = path.join(config.configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      CONFIG.responseTimeout = (settings.polling?.slackResponseTimeoutMinutes ?? 10) * 60 * 1000;
      log.info({ responseTimeoutMs: CONFIG.responseTimeout }, 'Settings reloaded');
    }
  } catch (e) {
    log.warn({ error: e.message }, 'Failed to reload settings, keeping current values');
  }
});

main().catch(error => {
  log.fatal({ err: error }, 'Fatal error');
  process.exit(1);
});
