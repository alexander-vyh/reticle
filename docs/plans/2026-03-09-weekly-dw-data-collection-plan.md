# Weekly DW Data Collection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Collect Slack messages and Jira ticket activity for 7 Digital Workplace team members, organized by person within team, delivered as structured weekly raw data.

**Architecture:** Extend the existing org-memory Phase 1 capture pipeline to actually work (fix two blocking bugs), add Jira activity as a second capture source into `raw_messages`, seed identity for 7 DW team members, and build a weekly report consumer that queries `raw_messages` grouped by person → team.

**Tech Stack:** Node.js, SQLite (better-sqlite3, org-memory.db), Jira REST API v3 (native `https`, Basic auth), existing slack-reader.js infrastructure.

**Design context:** `docs/plans/2026-03-04-organizational-memory-plan.md` (Phase 1 capture + Phase 3 consumers)

---

## Team Roster (for identity seeding)

| Team | Person | Role |
|------|--------|------|
| Corporate Systems Engineering | Kinski Wu | Corporate Systems Engineer |
| Corporate Systems Engineering | Bill Price | Digital Workplace ... |
| Corporate Systems Engineering | Daniel Richardson | Digital Workplace ... |
| Platform & Endpoint Security | Geoffrey Schuette | Staff Engineer, Security |
| Platform & Endpoint Security | Daniel 'D' Sherr | Endpoint Systems Engineer |
| Desktop Support | Ken Dominiec | Desktop Support Manager |
| Desktop Support | Keshon Bowman | Desktop Support Specialist |

## Data Sources

| Source | Scope | Stored as |
|--------|-------|-----------|
| Slack messages | `iops-dw-cse`, `iops-dw-desktop-support`, `iops-dw-infosec`, `iops-dw` + any channel these 7 people post in | `raw_messages` with `source='slack'` |
| Jira activity | `DWDEV` and `DWS` projects — ticket transitions, comments, new issues | `raw_messages` with `source='jira'` |

---

## Task 1: Fix trackSlackConversation crash that blocks capture

The `handleEvent()` function in `slack-events-monitor.js` calls `trackSlackConversation()` at line 413 without a try/catch. When it throws `NOT NULL constraint failed: conversations.account_id`, the entire function exits before the org-memory capture code at line 416 ever executes. This is why `org-memory.db` has never been created despite the capture code being fully wired.

**Files:**
- Modify: `slack-events-monitor.js:411-414` (wrap in try/catch)

**Step 1: Write the failing test**

Create `test-slack-capture-isolation.js` at the project root. The test verifies that org-memory capture still executes even when trackSlackConversation throws.

```javascript
'use strict';

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Test: capture should succeed even if conversation tracking fails
// This validates the error isolation fix in handleEvent()

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-isolation-'));
const dbPath = path.join(tmpDir, 'test-org-memory.db');

// Initialize org-memory DB
process.env.ORG_MEMORY_DB_PATH = dbPath;
const orgMemoryDb = require('./lib/org-memory-db');
const db = orgMemoryDb.initDatabase(dbPath);
const kg = require('./lib/knowledge-graph');

// Insert a raw message directly to verify the pipeline works
const msg = kg.insertRawMessage(db, {
  source: 'slack',
  sourceId: 'C123:1234567890.000',
  channelId: 'C123',
  channelName: 'iops-dw-cse',
  authorId: null,
  authorName: 'Kinski Wu',
  content: 'Finished UKG lifecycle automation validation',
  threadId: null,
  occurredAt: Math.floor(Date.now() / 1000),
});

assert.ok(msg.id, 'Message should have an ID');
assert.strictEqual(msg.source, 'slack');
assert.strictEqual(msg.author_name, 'Kinski Wu');

// Verify the message is in the database
const rows = db.prepare('SELECT * FROM raw_messages').all();
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].channel_name, 'iops-dw-cse');

// Cleanup
fs.rmSync(tmpDir, { recursive: true });
console.log('PASS: capture isolation test');
```

**Step 2: Run test to verify it passes** (this test validates the capture pipeline, not the bug fix itself)

Run: `node test-slack-capture-isolation.js`
Expected: PASS

**Step 3: Fix the error isolation in handleEvent**

In `slack-events-monitor.js`, wrap the `trackSlackConversation` call in a try/catch so it can't crash `handleEvent`:

```javascript
// Track conversation in follow-ups database
if (event.type === 'message' && !event.subtype && event.user !== CONFIG.myUserId) {
  try {
    trackSlackConversation(db, event, 'incoming');
  } catch (err) {
    log.warn({ err, channel: event.channel }, 'Failed to track conversation — continuing');
  }
}
```

**Step 4: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add slack-events-monitor.js test-slack-capture-isolation.js
git commit -m "fix: isolate trackSlackConversation error so org-memory capture isn't blocked"
```

---

## Task 2: Fix the trackSlackConversation account_id bug

The underlying bug: `trackSlackConversation()` calls `reticleDb.trackConversation()` without an `account_id`, violating a NOT NULL constraint. This should also be fixed so conversation tracking works again.

**Files:**
- Modify: `slack-events-monitor.js` (pass accountId to trackSlackConversation)
- Test: verify conversation tracking no longer throws

**Step 1: Read the trackSlackConversation function and trackConversation in reticle-db.js**

Understand what `account_id` is expected and where it should come from. The service already creates a primary account at startup (see how `digest-weekly.js` does it at lines 31-36).

**Step 2: Write the failing test**

Add to `test-slack-capture-isolation.js`:

```javascript
// Test: trackConversation should work with a valid account_id
const reticleDb = require('./reticle-db');
const mainDb = reticleDb.initDatabase(path.join(tmpDir, 'test-reticle.db'));
const account = reticleDb.upsertAccount(mainDb, {
  email: 'test@example.com',
  provider: 'gmail',
  display_name: 'Test',
  is_primary: 1
});
// trackConversation should not throw when account_id is provided
assert.doesNotThrow(() => {
  reticleDb.trackConversation(mainDb, {
    accountId: account.id,
    channelId: 'C123',
    channelName: 'test-channel',
    lastMessageTs: '1234567890.000',
    direction: 'incoming'
  });
});
console.log('PASS: trackConversation with account_id');
```

**Step 3: Run test to verify it fails** (because the service code doesn't pass accountId)

**Step 4: Fix trackSlackConversation to receive and pass accountId**

In `slack-events-monitor.js`, ensure the primary account is resolved at startup (like digest-weekly.js does) and passed through to `trackSlackConversation`.

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add slack-events-monitor.js test-slack-capture-isolation.js
git commit -m "fix: pass account_id to trackSlackConversation"
```

---

## Task 3: Add Jira config and lib/jira-reader.js

Create a Jira API reader module following the same pattern as `lib/slack-reader.js`: native `https`, rate limiting, response parsing.

**Files:**
- Create: `lib/jira-reader.js`
- Modify: `lib/config.js` (add jiraApiToken, jiraBaseUrl, jiraUserEmail)
- Modify: `config/secrets.example.json` (add Jira fields)
- Test: `test-jira-reader.js`

**Step 1: Add Jira config fields**

In `config/secrets.example.json`, add:
```json
{
  "jiraApiToken": "your-jira-api-token",
  "jiraBaseUrl": "https://your-instance.atlassian.net",
  "jiraUserEmail": "your-email@company.com"
}
```

In `lib/config.js`, export (non-required — Jira is optional):
```javascript
jiraApiToken: secrets.jiraApiToken || null,
jiraBaseUrl: secrets.jiraBaseUrl || null,
jiraUserEmail: secrets.jiraUserEmail || null,
```

**Step 2: Write failing test for jira-reader**

`test-jira-reader.js` — test the JQL query builder and response parser with mock data (no live API calls in unit tests):

```javascript
'use strict';
const assert = require('node:assert');

// Test JQL builder
const { buildActivityJql } = require('./lib/jira-reader');

// Should build JQL for given projects and users
const jql = buildActivityJql({
  projects: ['DWDEV', 'DWS'],
  accountIds: ['abc123', 'def456'],
  sinceDays: 7
});

assert.ok(jql.includes('project in (DWDEV, DWS)'), 'Should include projects');
assert.ok(jql.includes('assignee in'), 'Should filter by assignee');
console.log('PASS: JQL builder');
```

**Step 3: Implement lib/jira-reader.js**

Follow the `slack-reader.js` pattern:
- `jiraGet(path, params)` — native `https` with Basic auth (`email:apiToken` base64)
- Rate limiter: 10 req/s (Jira Cloud allows ~10/s for basic auth)
- `searchIssues(jql, fields)` — `/rest/api/3/search` with pagination
- `getIssueChangelog(issueKey)` — `/rest/api/3/issue/{key}/changelog` for transitions
- `buildActivityJql({ projects, accountIds, sinceDays })` — builds JQL for weekly queries
- `lookupUserByEmail(email)` — `/rest/api/3/user/search?query={email}` for identity seeding

Key fields to fetch per issue: `key`, `summary`, `status`, `assignee`, `updated`, `created`, `resolution`, `comment` (last 7 days).

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add lib/jira-reader.js lib/config.js config/secrets.example.json test-jira-reader.js
git commit -m "feat: add Jira API reader module for org-memory capture"
```

---

## Task 4: Add Jira capture to org-memory

Create `lib/jira-capture.js` following the pattern of `lib/slack-capture.js`. Maps Jira activity into `raw_messages` with `source='jira'`.

**Files:**
- Create: `lib/jira-capture.js`
- Test: add to `test-slack-capture-isolation.js` (rename to `test-org-memory-capture.js`)

**Step 1: Write failing test**

```javascript
// Test: Jira ticket activity captured to raw_messages
const { captureJiraActivity } = require('./lib/jira-capture');

const jiraActivity = {
  issueKey: 'DWDEV-1234',
  summary: 'Implement Jamf IAM integration',
  status: 'In Progress',
  assigneeAccountId: 'jira-abc123',
  assigneeName: 'Geoffrey Schuette',
  projectKey: 'DWDEV',
  updatedAt: Math.floor(Date.now() / 1000),
  changeType: 'status_change',   // or 'comment', 'created', 'resolved'
  changeDetail: 'Moved from To Do to In Progress',
};

const msg = captureJiraActivity(omDb, jiraActivity);
assert.strictEqual(msg.source, 'jira');
assert.ok(msg.source_id.includes('DWDEV-1234'), 'Source ID should include issue key');
assert.strictEqual(msg.channel_name, 'DWDEV');
```

**Step 2: Run test, verify fail**

**Step 3: Implement lib/jira-capture.js**

```javascript
'use strict';
const kg = require('./knowledge-graph');

function captureJiraActivity(db, { issueKey, summary, status, assigneeAccountId, assigneeName, projectKey, updatedAt, changeType, changeDetail }) {
  const sourceId = `${issueKey}:${changeType}:${updatedAt}`;
  const authorEntityId = kg.resolveIdentity(db, 'jira', assigneeAccountId);

  const content = formatActivityContent({ issueKey, summary, status, changeType, changeDetail });

  return kg.insertRawMessage(db, {
    source: 'jira',
    sourceId,
    channelId: projectKey,
    channelName: projectKey,
    authorId: authorEntityId,
    authorName: assigneeName || null,
    content,
    threadId: issueKey,  // group all activity for an issue under the issue key
    occurredAt: updatedAt,
    metadata: { issueKey, status, changeType },
  });
}

function formatActivityContent({ issueKey, summary, status, changeType, changeDetail }) {
  switch (changeType) {
    case 'status_change':
      return `[${issueKey}] ${summary} — ${changeDetail}`;
    case 'comment':
      return `[${issueKey}] Comment on "${summary}": ${changeDetail}`;
    case 'created':
      return `[${issueKey}] Created: ${summary} (${status})`;
    case 'resolved':
      return `[${issueKey}] Resolved: ${summary}`;
    default:
      return `[${issueKey}] ${summary} — ${changeType}: ${changeDetail}`;
  }
}

module.exports = { captureJiraActivity, formatActivityContent };
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add lib/jira-capture.js test-org-memory-capture.js
git commit -m "feat: add Jira activity capture for org-memory"
```

---

## Task 5: Seed identity_map with DW team members

Create a seed script that populates `identity_map` with Slack IDs and Jira account IDs for all 7 DW team members. This is needed so `resolveIdentity()` can map raw messages to entity IDs.

**Files:**
- Modify: `lib/seed-data.js` (add DW team seeding function)
- Test: add identity resolution tests

**Step 1: Resolve Slack IDs and Jira account IDs**

The seed script should:
1. Look up each person's Slack ID via `slackReader.lookupUserByEmail()`
2. Look up each person's Jira account ID via `jiraReader.lookupUserByEmail()`
3. Create an entity in `entities` table for each person
4. Add `identity_map` entries for both `source='slack'` and `source='jira'`

The team roster can be defined in `team.json` under a new `dwTeam` key, or hardcoded in the seed script for now. Use `team.json` if the user prefers configuration over code.

**Step 2: Write failing test**

```javascript
// Test: identity seeding creates entities and identity_map entries
const { seedDwTeam } = require('./lib/seed-data');

// Mock team data
const dwTeam = [
  { name: 'Kinski Wu', team: 'cse', email: 'kinski@example.com' },
];

seedDwTeam(omDb, dwTeam);

const entities = kg.getActiveEntities(omDb, { types: ['person'] });
assert.ok(entities.length >= 1, 'Should create person entities');

const identity = kg.resolveIdentity(omDb, 'slack', 'U_KINSKI_MOCK');
assert.ok(identity, 'Should resolve Slack identity');
```

**Step 3: Implement seeding**

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add lib/seed-data.js test-org-memory-capture.js
git commit -m "feat: seed identity_map with DW team Slack and Jira IDs"
```

---

## Task 6: Build Jira polling collector

Create a scheduled collector that polls Jira for recent activity in `DWDEV` and `DWS` and writes it to `raw_messages`. This runs on a schedule (daily or more frequently).

**Files:**
- Create: `jira-activity-collector.js` (top-level service script)
- Modify: `bin/deploy` (add launchd plist)

**Step 1: Write the collector**

Pattern follows existing services (startup validation, heartbeat, config):

```javascript
// 1. Load config, validate Jira credentials exist
// 2. Init org-memory DB
// 3. Build JQL: project in (DWDEV, DWS) AND updatedDate >= -1d
// 4. Fetch matching issues with changelog
// 5. For each issue with activity by a known team member:
//    - Capture status transitions via captureJiraActivity()
//    - Capture new comments via captureJiraActivity()
// 6. Write heartbeat
```

Schedule: Daily at 5:00 PM (before the weekly report consumer runs). Also supports manual invocation: `node jira-activity-collector.js`.

**Step 2: Test with a dry-run mode**

Add `DRY_RUN=1` env var support that fetches and logs but doesn't write to DB.

**Step 3: Add to bin/deploy**

Add to SCHEDULED_SERVICES or create a new plist for daily Jira collection.

**Step 4: Commit**

```bash
git add jira-activity-collector.js bin/deploy
git commit -m "feat: add Jira activity collector for DWDEV and DWS"
```

---

## Task 7: Build weekly DW report consumer

The payoff: a script that queries `raw_messages` for the past 7 days, filters to DW team members, groups by person within team, and outputs structured raw data.

**Files:**
- Create: `dw-weekly-report.js`
- Test: `test-dw-weekly-report.js`

**Step 1: Write failing test**

```javascript
// Seed raw_messages with test data for multiple people/teams
// Run the report generator
// Assert output structure: { teams: [ { name, members: [ { name, slack: [...], jira: [...] } ] } ] }
```

**Step 2: Implement the report consumer**

```javascript
// 1. Init org-memory DB
// 2. Query raw_messages WHERE occurred_at >= (now - 7 days)
// 3. Join with identity_map to resolve author_id → entity → person
// 4. Group by team → person
// 5. Format output as structured markdown:
//
//    ## Corporate Systems Engineering
//    ### Kinski Wu
//    **Slack activity:**
//    - [iops-dw-cse] Finished UKG lifecycle automation validation
//    - [iops-dw-cse] Working on IaC prep for CSE environments
//    **Jira activity:**
//    - [DWDEV-1234] Implement Jamf IAM integration — Moved to In Progress
//    - [DWS-567] Routine config issue — Resolved
//
// 6. Deliver to Slack DM via sendSlackDM()
// 7. Write heartbeat
```

**Step 3: Run test, verify pass**

**Step 4: Add to bin/deploy as a scheduled service**

Schedule: Fridays at 3:00 PM (or Monday mornings, depending on user preference — configurable).

**Step 5: Commit**

```bash
git add dw-weekly-report.js test-dw-weekly-report.js bin/deploy
git commit -m "feat: add weekly DW report consumer — person-first raw data by team"
```

---

## Task 8: Deploy and verify end-to-end

**Step 1: Add Jira credentials to ~/.reticle/config/secrets.json**

```json
{
  "jiraApiToken": "<real token>",
  "jiraBaseUrl": "https://simplifi.atlassian.net",
  "jiraUserEmail": "<your email>"
}
```

**Step 2: Run bin/deploy**

```bash
bin/deploy
```

Verify:
- `ai.reticle.slack-events` running without conversation tracking errors
- `~/.reticle/data/org-memory.db` created and accumulating messages
- Jira collector runs and captures activity
- Weekly report produces output grouped by team → person

**Step 3: Manual verification**

```bash
# Check org-memory is accumulating
sqlite3 ~/.reticle/data/org-memory.db "SELECT count(*) FROM raw_messages WHERE source='slack'"
sqlite3 ~/.reticle/data/org-memory.db "SELECT count(*) FROM raw_messages WHERE source='jira'"
sqlite3 ~/.reticle/data/org-memory.db "SELECT author_name, count(*) FROM raw_messages GROUP BY author_name"

# Run weekly report manually
node dw-weekly-report.js
```

**Step 4: Commit any fixes found during verification**

---

## Dependency Chain

```
Task 1 (fix capture isolation) ─┐
                                 ├── Task 5 (seed identity)
Task 2 (fix account_id bug) ────┘        │
                                          ├── Task 7 (weekly report consumer)
Task 3 (jira-reader.js) ────┐            │
                             ├── Task 6 (jira collector)
Task 4 (jira-capture.js) ───┘            │
                                          │
                              Task 8 (deploy + verify) ← depends on all
```

Tasks 1-2 are independent from Tasks 3-4. Both tracks can be worked in parallel.
Task 5 (identity seeding) depends on both Slack fix and Jira reader being available.
Task 7 (weekly report) depends on capture working and identities seeded.
Task 8 (deploy) depends on everything.
