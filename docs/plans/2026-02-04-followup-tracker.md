# Multi-Channel Follow-Up Tracker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a conversation follow-up tracker across email and Slack that reminds about threads needing responses with multi-tier notifications (immediate, 4h batch, daily digest, escalations).

**Architecture:** SQLite database tracks conversation state, existing monitors (gmail-monitor.js, slack-events-monitor.js) insert tracking records when messages arrive/are sent, a checker service (followup-checker.js) runs every 15 minutes to send notifications based on age thresholds.

**Tech Stack:** Node.js, better-sqlite3, Slack API, Gmail API (via gog CLI)

---

## Task 1: Integrate Email Tracking into Gmail Monitor

**Files:**
- Modify: `gmail-monitor.js` (add tracking after line 776)
- Existing: `followups-db.js` (already created)
- Test: Manual verification via database query

**Step 1: Import followups database module**

Add at top of `gmail-monitor.js` after other requires (around line 11):

```javascript
const followupsDb = require('./followups-db');
```

**Step 2: Initialize database connection in main function**

Add in `main()` function after line 769 (after CONFIG.myUserId is set):

```javascript
  // Initialize follow-ups database
  let followupsDbConn = null;
  try {
    followupsDbConn = followupsDb.initDatabase();
    console.log('   ✓ Follow-ups tracking initialized\n');
  } catch (error) {
    console.error('   ✗ Failed to init follow-ups DB:', error.message);
  }
```

**Step 3: Add helper to extract email thread ID**

Add new function before `checkEmails()` function (around line 678):

```javascript
/**
 * Extract thread ID from email for tracking
 */
function getEmailThreadId(email) {
  // Use thread ID if available, otherwise use message ID
  return `email:${email.threadId || email.id}`;
}

/**
 * Track email conversation in follow-ups database
 */
function trackEmailConversation(db, email, direction) {
  if (!db) return;

  try {
    const threadId = getEmailThreadId(email);
    const now = Math.floor(Date.now() / 1000);

    // Determine who sent last and who's waiting
    const lastSender = direction === 'incoming' ? 'them' : 'me';
    const waitingFor = direction === 'incoming' ? 'my-response' : 'their-response';

    // Extract sender name from "Name <email@domain.com>" format
    let fromName = email.from;
    const match = email.from.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      fromName = match[1].replace(/"/g, '');
    }

    followupsDb.trackConversation(db, {
      id: threadId,
      type: 'email',
      subject: email.subject,
      from_user: email.from,
      from_name: fromName,
      last_activity: Math.floor(new Date(email.date).getTime() / 1000),
      last_sender: lastSender,
      waiting_for: waitingFor,
      first_seen: now
    });
  } catch (error) {
    console.error('     ✗ Failed to track email:', error.message);
  }
}
```

**Step 4: Track incoming emails in checkEmails function**

After line 776 (after adding to batch queue), add:

```javascript
      // Track in follow-ups database
      trackEmailConversation(followupsDbConn, email, 'incoming');
```

**Step 5: Test email tracking**

Run:
```bash
# Wait for next email check cycle or trigger manually
node gmail-monitor.js
```

Then query database:
```bash
sqlite3 ~/.openclaw/workspace/followups.db "SELECT type, from_name, subject, waiting_for FROM conversations WHERE type='email' LIMIT 5;"
```

Expected: See tracked email conversations

**Step 6: Commit email tracking**

```bash
git add gmail-monitor.js
git commit -m "feat: integrate email conversation tracking into gmail monitor"
```

---

## Task 2: Integrate Slack DM Tracking into Slack Events Monitor

**Files:**
- Modify: `slack-events-monitor.js`
- Existing: `followups-db.js`

**Step 1: Import followups database module**

Add at top of `slack-events-monitor.js` after other requires (around line 12):

```javascript
const followupsDb = require('./followups-db');
```

**Step 2: Initialize database in main function**

Add in `main()` function after line 759 (after CONFIG.myUserId is set):

```javascript
  // Initialize follow-ups database
  let followupsDbConn = null;
  try {
    followupsDbConn = followupsDb.initDatabase();
    console.log('   ✓ Follow-ups tracking initialized\n');
  } catch (error) {
    console.error('   ✗ Failed to init follow-ups DB:', error.message);
  }
```

**Step 3: Pass database connection through WebSocket handler**

Modify `connectSocketMode()` function to accept db parameter (line 678):

```javascript
async function connectSocketMode(db) {
```

Update the call in `main()` (around line 765):

```javascript
  await connectSocketMode(followupsDbConn);
```

**Step 4: Add Slack conversation tracking helper**

Add before `handleEvent()` function (around line 150):

```javascript
/**
 * Track Slack conversation in follow-ups database
 */
function trackSlackConversation(db, event, direction) {
  if (!db) return;

  try {
    const now = Math.floor(Date.now() / 1000);
    let conversationId, conversationType;

    if (event.channel_type === 'im') {
      // Direct message
      conversationId = `slack:dm:${event.user}`;
      conversationType = 'slack-dm';
    } else {
      // Channel mention - use message timestamp for uniqueness
      conversationId = `slack:mention:${event.channel}-${event.ts}`;
      conversationType = 'slack-mention';
    }

    const lastSender = direction === 'incoming' ? 'them' : 'me';
    const waitingFor = direction === 'incoming' ? 'my-response' : 'their-response';

    followupsDb.trackConversation(db, {
      id: conversationId,
      type: conversationType,
      subject: event.text ? event.text.substring(0, 100) : null,
      from_user: event.user,
      from_name: event.username || event.user,
      channel_id: event.channel_type === 'im' ? null : event.channel,
      channel_name: null, // Will be enriched later if needed
      last_activity: Math.floor(parseFloat(event.ts)),
      last_sender: lastSender,
      waiting_for: waitingFor,
      first_seen: now
    });
  } catch (error) {
    console.error('     ✗ Failed to track Slack conversation:', error.message);
  }
}
```

**Step 5: Integrate tracking into handleEvent**

Find the `handleEvent()` function. After the event type check, we need to access the db. First, modify the function signature to receive db:

At line 693 where `handleEvent` is called:
```javascript
await handleEvent(envelope.payload.event, db);
```

Modify `handleEvent` function signature (search for `async function handleEvent`):
```javascript
async function handleEvent(event, db) {
```

Then add tracking for message events. Find where message events are processed and add:

```javascript
  // Track conversation in follow-ups database
  if (event.type === 'message' && !event.subtype && event.user !== CONFIG.myUserId) {
    trackSlackConversation(db, event, 'incoming');
  }
```

**Step 6: Track when we send messages**

Add tracking for outgoing messages. After successful `postMessage` calls in the codebase, add:

In `handleInteractive` function, after line 542 where we send responses, track resolution:

```javascript
      // Mark conversation as resolved in follow-ups
      if (followupsDbConn) {
        const convId = `slack:dm:${userId}`;
        followupsDb.resolveConversation(followupsDbConn, convId);
      }
```

**Step 7: Test Slack tracking**

Run:
```bash
# Restart slack-events-monitor
pkill -f slack-events-monitor.js
node slack-events-monitor.js &
```

Send yourself a DM in Slack, then query:
```bash
sqlite3 ~/.openclaw/workspace/followups.db "SELECT type, from_name, subject, waiting_for FROM conversations WHERE type LIKE 'slack%' LIMIT 5;"
```

Expected: See tracked Slack conversations

**Step 8: Commit Slack tracking**

```bash
git add slack-events-monitor.js
git commit -m "feat: integrate Slack DM and mention tracking into events monitor"
```

---

## Task 3: Test and Start Follow-Up Checker Service

**Files:**
- Existing: `followup-checker.js`
- Test: Manual verification via Slack notifications

**Step 1: Create systemd-style startup script**

Create `start-followup-checker.sh`:

```bash
#!/bin/bash
cd ~/.openclaw/workspace
nohup node followup-checker.js > followup-checker.log 2> followup-checker-error.log &
echo $! > followup-checker.pid
echo "Follow-up checker started (PID: $(cat followup-checker.pid))"
```

Make executable:
```bash
chmod +x start-followup-checker.sh
```

**Step 2: Start the checker service**

```bash
./start-followup-checker.sh
```

**Step 3: Verify service is running**

```bash
ps aux | grep followup-checker.js | grep -v grep
```

Expected: See running process

**Step 4: Check logs for initial run**

```bash
tail -20 followup-checker.log
```

Expected: See "Follow-Up Checker started" and initial check output

**Step 5: Test with existing data**

If you have tracked conversations from Tasks 1-2, wait 15 minutes and check if notifications appear in Slack.

Or manually insert test data:
```bash
sqlite3 ~/.openclaw/workspace/followups.db << 'EOF'
INSERT INTO conversations (id, type, subject, from_user, from_name, last_activity, last_sender, waiting_for, first_seen)
VALUES (
  'test:email:1',
  'email',
  'Test urgent follow-up',
  'test@example.com',
  'Test User',
  strftime('%s', 'now', '-5 hours'),
  'them',
  'my-response',
  strftime('%s', 'now', '-5 hours')
);
EOF
```

Wait up to 15 minutes for next check cycle.

**Step 6: Commit startup script**

```bash
git add start-followup-checker.sh
git commit -m "feat: add follow-up checker startup script"
```

---

## Task 4: Add On-Demand Query via Slash Command (Future Enhancement)

**Files:**
- Create: `followup-slash-command.js` (handler for Slack slash command)
- Modify: `slack-events-monitor.js` (add slash command handling)

**Note:** This task is optional for MVP. The checker service provides automatic notifications. On-demand queries can be added later.

**Step 1: Register slash command in Slack**

1. Go to Slack App settings
2. Create slash command: `/followups`
3. Set request URL to your webhook endpoint
4. Note the command configuration for implementation

**Step 2: Implement slash command handler**

Create `followup-slash-command.js`:

```javascript
#!/usr/bin/env node
const followupsDb = require('./followups-db');

function handleFollowupsCommand(userId) {
  const db = followupsDb.initDatabase();

  const pending = followupsDb.getPendingResponses(db);
  const awaiting = followupsDb.getAwaitingReplies(db);

  const now = Math.floor(Date.now() / 1000);

  let message = `📋 *Current Follow-ups*\n\n`;

  if (pending.length === 0) {
    message += `✨ All caught up! No pending responses needed.\n\n`;
  } else {
    message += `*Need your response* (${pending.length}):\n`;
    pending.forEach(conv => {
      const age = Math.floor((now - conv.last_activity) / 3600);
      const icon = conv.type === 'email' ? '📧' : conv.type === 'slack-dm' ? '💬' : '📢';
      message += `${icon} ${conv.from_name} - ${age}h ago\n`;
    });
    message += '\n';
  }

  if (awaiting.length > 0) {
    message += `*Awaiting replies* (${awaiting.length}):\n`;
    awaiting.forEach(conv => {
      const age = Math.floor((now - conv.last_activity) / 3600);
      message += `⏳ ${conv.from_name} - ${age}h since you sent\n`;
    });
  }

  db.close();
  return message;
}

module.exports = { handleFollowupsCommand };
```

**Step 3: Integrate into Slack events handler**

Add to `slack-events-monitor.js` to handle slash commands when envelope type is 'slash_commands'.

**Step 4: Test slash command**

Type `/followups` in Slack and verify response.

**Step 5: Commit slash command**

```bash
git add followup-slash-command.js slack-events-monitor.js
git commit -m "feat: add /followups slash command for on-demand queries"
```

---

## Task 5: Add Gmail Filter for GCP Alerts

**Files:**
- Modify: `gmail-monitor.js` (already done in previous conversation)

**Status:** ✅ Already completed - GCP alerts are being filtered to trash.

**Verify:**
```bash
grep -A 2 "Delete GCP alerts" gmail-monitor.js
```

Expected: See filter rule for alerting-noreply@google.com

---

## Task 6: Update .gitignore and Commit Final State

**Files:**
- Modify: `.gitignore`

**Step 1: Add database to gitignore**

Add to `.gitignore`:
```
# Follow-ups database
followups.db
followups.db-*
followup-checker.log
followup-checker-error.log
followup-checker.pid
```

**Step 2: Commit gitignore update**

```bash
git add .gitignore
git commit -m "chore: ignore follow-ups database and logs"
```

**Step 3: Create final commit with all new files**

```bash
git add followups-db.js followup-checker.js test-followups.js docs/
git commit -m "feat: complete multi-channel follow-up tracker implementation

- SQLite database for conversation tracking
- Gmail monitor integration for email tracking
- Slack events monitor integration for DM/mention tracking
- Checker service with multi-tier notifications (4h, daily, escalations)
- Test suite for database operations
- Implementation plan documentation"
```

**Step 4: Verify git status**

```bash
git status
git log --oneline -5
```

Expected: Clean working directory, see recent commits

---

## Testing Checklist

After implementation, verify:

- [ ] Gmail monitor tracks incoming emails to database
- [ ] Slack events monitor tracks DMs and mentions
- [ ] Follow-up checker service runs every 15 minutes
- [ ] 4-hour batch notifications work for old DMs/mentions
- [ ] Daily digest sent at 9am with pending items
- [ ] Escalation notifications for very old items
- [ ] Conversations marked as resolved when replied to
- [ ] Database queries return correct results
- [ ] All services restart cleanly
- [ ] Logs show tracking activity

## Rollback Plan

If issues occur:

1. Stop services:
```bash
pkill -f followup-checker.js
pkill -f gmail-monitor.js
pkill -f slack-events-monitor.js
```

2. Restore previous commit:
```bash
git log --oneline -10
git checkout <commit-before-followups>
```

3. Restart original services without tracking

## Future Enhancements

- Add `/followups` slash command for on-demand queries
- Enrich Slack mentions with channel names via API
- Add email thread archiving when resolved
- Track conversation resolution reasons (replied, archived, snoozed)
- Add snooze functionality for temporary silence
- Build web dashboard for follow-up visualization
- Add machine learning for priority detection
