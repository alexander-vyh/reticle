# Settings UI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a distributed settings UI to Reticle — domain config in domain views, system config in a new Settings pane — with a 6-phase migration from JSON files to DB-backed configuration.

**Architecture:** Schema changes to `monitored_people` (adding role, escalation_tier, title, team columns) unify VIPs and direct reports into the existing people table. A new `feedback_settings` key-value table backs the feedback strip. A new `settings.json` file replaces hardcoded service constants. SwiftUI views use the existing gateway HTTP pattern for all reads/writes.

**Tech Stack:** Node.js (reticle-db.js, gateway.js, people-store.js, config.js), Swift/SwiftUI (Reticle app), SQLite via better-sqlite3, Express REST API.

**Spec:** `docs/plans/2026-03-13-settings-ui-design.md`

---

## File Map

### Files to Modify

| File | Changes |
|------|---------|
| `reticle-db.js` | Add columns to `monitored_people`, add `feedback_settings` table |
| `lib/people-store.js` | Add role/tier queries, per-tab list functions, PATCH support |
| `lib/config.js` | Add settings.json loader, remove team.json exports in Phase 5 |
| `gateway.js` | Add PATCH /people/:email, feedback/settings, /settings, /config/accounts endpoints |
| `gmail-monitor.js` | Read VIPs from DB instead of config (Phase 3) |
| `meeting-alert-monitor.js` | Read direct reports from DB instead of config (Phase 3) |
| `reticle/Sources/Reticle/ContentView.swift` | Add `.settings` case to SidebarSection, fix Coming Soon |
| `reticle/Sources/Reticle/ReticleApp.swift` | Add Cmd+, shortcut |
| `reticle/Sources/Reticle/Services/GatewayClient.swift` | Add Person.role, new endpoints, settings models |
| `reticle/Sources/Reticle/Views/PeopleView.swift` | Segmented tabs, role badges, escalation tier |
| `reticle/Sources/Reticle/Views/FeedbackView.swift` | Settings strip above candidates |
| `reticle/Sources/Reticle/Views/CommitmentsView.swift` | Stale threshold picker in SummaryBar |

### Files to Create

| File | Purpose |
|------|---------|
| `reticle/Sources/Reticle/Views/SettingsView.swift` | Settings pane (Accounts, Notifications, System) |
| `test-settings-migration.js` | Tests for schema migration, people-store role queries |
| `test-settings-endpoints.js` | Tests for new gateway endpoints |

---

## Chunk 1: Schema + API (Phase 1)

### Task 1: Schema Migration — Add Columns to monitored_people

**Files:**
- Modify: `reticle-db.js` (lines 246-254, schema init)
- Test: `test-settings-migration.js` (create)

- [ ] **Step 1: Write failing test for role column**

Create `test-settings-migration.js`:

```javascript
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Helper: create a temp DB
function createTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-settings-test-'));
  process.env.RETICLE_DB_PATH = path.join(tmpDir, 'test.db');
  // Clear module cache so reticle-db.js re-initializes
  delete require.cache[require.resolve('./reticle-db.js')];
  const db = require('./reticle-db.js');
  return { db, tmpDir };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test: monitored_people has role column
{
  const { db, tmpDir } = createTestDb();
  try {
    const columns = db.pragma('table_info(monitored_people)').map(c => c.name);
    assert.ok(columns.includes('role'), 'monitored_people should have role column');
    assert.ok(columns.includes('escalation_tier'), 'monitored_people should have escalation_tier column');
    assert.ok(columns.includes('title'), 'monitored_people should have title column');
    assert.ok(columns.includes('team'), 'monitored_people should have team column');
    console.log('PASS: monitored_people has new columns');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: role defaults to 'peer'
{
  const { db, tmpDir } = createTestDb();
  try {
    db.prepare("INSERT INTO monitored_people (email) VALUES ('test@example.com')").run();
    const person = db.prepare("SELECT role FROM monitored_people WHERE email = 'test@example.com'").get();
    assert.strictEqual(person.role, 'peer', 'role should default to peer');
    console.log('PASS: role defaults to peer');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: escalation_tier defaults to NULL
{
  const { db, tmpDir } = createTestDb();
  try {
    db.prepare("INSERT INTO monitored_people (email) VALUES ('test@example.com')").run();
    const person = db.prepare("SELECT escalation_tier FROM monitored_people WHERE email = 'test@example.com'").get();
    assert.strictEqual(person.escalation_tier, null, 'escalation_tier should default to null');
    console.log('PASS: escalation_tier defaults to null');
  } finally {
    cleanup(tmpDir);
  }
}

console.log('\nAll schema migration tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-settings-migration.js`
Expected: FAIL — columns do not exist yet.

- [ ] **Step 3: Add columns to reticle-db.js schema**

In `reticle-db.js`, modify the `monitored_people` CREATE TABLE (around line 246):

```sql
CREATE TABLE IF NOT EXISTS monitored_people (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  slack_id TEXT,
  jira_id TEXT,
  role TEXT DEFAULT 'peer',
  escalation_tier TEXT,
  title TEXT,
  team TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

**Important:** Since the DB may already exist with data, also add migration
statements after the CREATE TABLE block (idempotent ALTERs):

```javascript
// Migration: add new columns if they don't exist (safe to re-run)
const cols = db.pragma('table_info(monitored_people)').map(c => c.name);
if (!cols.includes('role')) {
  db.exec("ALTER TABLE monitored_people ADD COLUMN role TEXT DEFAULT 'peer'");
}
if (!cols.includes('escalation_tier')) {
  db.exec("ALTER TABLE monitored_people ADD COLUMN escalation_tier TEXT");
}
if (!cols.includes('title')) {
  db.exec("ALTER TABLE monitored_people ADD COLUMN title TEXT");
}
if (!cols.includes('team')) {
  db.exec("ALTER TABLE monitored_people ADD COLUMN team TEXT");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-settings-migration.js`
Expected: All 3 tests PASS.

- [ ] **Step 5: Run existing tests to ensure no regression**

Run: `node test-reticle-db.js && node test-people-store.js`
Expected: All existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add reticle-db.js test-settings-migration.js
git commit -m "feat: add role, escalation_tier, title, team columns to monitored_people"
```

---

### Task 2: People Store — Role-Aware Query Functions

**Files:**
- Modify: `lib/people-store.js` (lines 3-47)
- Test: `test-settings-migration.js` (append)

- [ ] **Step 1: Write failing tests for role-aware queries**

Append to `test-settings-migration.js`:

```javascript
const peopleStore = require('./lib/people-store.js');

// Test: addPerson with role
{
  const { db, tmpDir } = createTestDb();
  try {
    peopleStore.addPerson(db, { email: 'vip@co.com', name: 'VIP', role: 'vip', title: 'CEO' });
    const person = db.prepare("SELECT * FROM monitored_people WHERE email = 'vip@co.com'").get();
    assert.strictEqual(person.role, 'vip');
    assert.strictEqual(person.title, 'CEO');
    console.log('PASS: addPerson with role and title');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: listPeopleByRole
{
  const { db, tmpDir } = createTestDb();
  try {
    peopleStore.addPerson(db, { email: 'a@co.com', role: 'vip', title: 'CTO' });
    peopleStore.addPerson(db, { email: 'b@co.com', role: 'direct_report' });
    peopleStore.addPerson(db, { email: 'c@co.com' }); // default: peer

    const vips = peopleStore.listPeopleByRole(db, 'vip');
    assert.strictEqual(vips.length, 1);
    assert.strictEqual(vips[0].email, 'a@co.com');

    const peers = peopleStore.listPeopleByRole(db, 'peer');
    assert.strictEqual(peers.length, 1);
    console.log('PASS: listPeopleByRole filters correctly');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: getVipEmails
{
  const { db, tmpDir } = createTestDb();
  try {
    peopleStore.addPerson(db, { email: 'VIP@Co.com', role: 'vip', title: 'CEO' });
    peopleStore.addPerson(db, { email: 'peer@co.com' });
    const vipEmails = peopleStore.getVipEmails(db);
    assert.deepStrictEqual(vipEmails, ['vip@co.com']);
    console.log('PASS: getVipEmails returns lowercase emails');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: getDirectReports
{
  const { db, tmpDir } = createTestDb();
  try {
    peopleStore.addPerson(db, { email: 'report@co.com', name: 'Jane', role: 'direct_report' });
    peopleStore.updateSlackId(db, 'report@co.com', 'U123');
    const reports = peopleStore.getDirectReports(db);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].name, 'Jane');
    assert.strictEqual(reports[0].slackId, 'U123');
    console.log('PASS: getDirectReports returns with slackId');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: updatePerson (PATCH fields)
{
  const { db, tmpDir } = createTestDb();
  try {
    peopleStore.addPerson(db, { email: 'user@co.com', name: 'Old Name' });
    peopleStore.updatePerson(db, 'user@co.com', { role: 'vip', title: 'VP Eng', escalation_tier: 'immediate' });
    const person = db.prepare("SELECT * FROM monitored_people WHERE email = 'user@co.com'").get();
    assert.strictEqual(person.role, 'vip');
    assert.strictEqual(person.title, 'VP Eng');
    assert.strictEqual(person.escalation_tier, 'immediate');
    console.log('PASS: updatePerson patches specific fields');
  } finally {
    cleanup(tmpDir);
  }
}

// Test: listTeamMembers
{
  const { db, tmpDir } = createTestDb();
  try {
    peopleStore.addPerson(db, { email: 'team@co.com', name: 'Dev', team: 'Platform' });
    peopleStore.addPerson(db, { email: 'peer@co.com', name: 'Peer' }); // no team
    const team = peopleStore.listTeamMembers(db);
    assert.strictEqual(team.length, 1);
    assert.strictEqual(team[0].team, 'Platform');
    console.log('PASS: listTeamMembers returns only team-affiliated peers');
  } finally {
    cleanup(tmpDir);
  }
}

console.log('\nAll people-store tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-settings-migration.js`
Expected: FAIL — new functions don't exist.

- [ ] **Step 3: Implement role-aware functions in people-store.js**

```javascript
// Modify existing addPerson to accept role, title, team (preserves upsert behavior)
function addPerson(db, { email, name = null, role = 'peer', title = null, team = null }) {
  db.prepare(`
    INSERT INTO monitored_people (email, name, role, title, team)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(excluded.name, monitored_people.name),
      role = excluded.role,
      title = excluded.title,
      team = excluded.team
  `).run(email, name, role, title, team);
}

// New functions
function listPeopleByRole(db, role) {
  return db.prepare('SELECT * FROM monitored_people WHERE role = ? ORDER BY name').all(role);
}

function getVipEmails(db) {
  return db.prepare("SELECT email FROM monitored_people WHERE role = 'vip'")
    .all()
    .map(r => r.email.toLowerCase());
}

function getDirectReports(db) {
  return db.prepare("SELECT * FROM monitored_people WHERE role = 'direct_report' ORDER BY name").all();
}

function listTeamMembers(db) {
  return db.prepare("SELECT * FROM monitored_people WHERE team IS NOT NULL AND role = 'peer' ORDER BY name").all();
}

function updatePerson(db, email, fields) {
  const allowed = ['name', 'role', 'title', 'team', 'escalation_tier', 'slack_id', 'jira_id'];
  const updates = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (updates.length === 0) return;
  values.push(email);
  db.prepare(`UPDATE monitored_people SET ${updates.join(', ')} WHERE email = ?`).run(...values);
}

module.exports = {
  addPerson, removePerson, listPeople, updateSlackId, updateJiraId, getSlackIdMap,
  listPeopleByRole, getVipEmails, getDirectReports, listTeamMembers, updatePerson
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test-settings-migration.js`
Expected: All tests PASS.

- [ ] **Step 5: Run existing tests**

Run: `node test-people-store.js`
Expected: PASS (existing addPerson calls still work with defaults).

- [ ] **Step 6: Commit**

```bash
git add lib/people-store.js test-settings-migration.js
git commit -m "feat: add role-aware query functions to people-store"
```

---

### Task 3: Gateway — PATCH /people/:email Endpoint

**Files:**
- Modify: `gateway.js` (after line 47, DELETE /people/:email)
- Test: `test-settings-endpoints.js` (create)

- [ ] **Step 1: Write failing test for PATCH /people/:email**

Create `test-settings-endpoints.js`:

```javascript
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3099; // test port, avoid conflict with running gateway
let server;
let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-gw-test-'));
  process.env.RETICLE_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.RETICLE_CONFIG_DIR = path.join(tmpDir, 'config');
  fs.mkdirSync(path.join(tmpDir, 'config'));
  // Write minimal config files
  fs.writeFileSync(path.join(tmpDir, 'config', 'secrets.json'), JSON.stringify({
    slackBotToken: 'xoxb-test', slackUserId: 'U000', gmailAccount: 'test@test.com'
  }));
  fs.writeFileSync(path.join(tmpDir, 'config', 'team.json'), JSON.stringify({
    vips: [], directReports: [], filterPatterns: { companyDomain: 'test.com' }
  }));
}

async function fetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: PORT, path, method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Test: PATCH /people/:email updates role
async function testPatchPeopleRole() {
  // First add a person
  await fetch('/people', { method: 'POST', body: { email: 'test@co.com', name: 'Test' } });

  // Patch role
  const res = await fetch('/people/test%40co.com', {
    method: 'PATCH',
    body: { role: 'vip', title: 'CEO' }
  });

  assert.strictEqual(res.status, 200, 'PATCH should return 200');

  // Verify via GET
  const list = await fetch('/people');
  const person = list.body.find(p => p.email === 'test@co.com');
  assert.strictEqual(person.role, 'vip');
  assert.strictEqual(person.title, 'CEO');
  console.log('PASS: PATCH /people/:email updates role and title');
}

// Test: PATCH /people/:email updates escalation_tier
async function testPatchEscalationTier() {
  const res = await fetch('/people/test%40co.com', {
    method: 'PATCH',
    body: { escalation_tier: 'immediate' }
  });
  assert.strictEqual(res.status, 200);

  const list = await fetch('/people');
  const person = list.body.find(p => p.email === 'test@co.com');
  assert.strictEqual(person.escalation_tier, 'immediate');
  console.log('PASS: PATCH /people/:email updates escalation_tier');
}

// Test: PATCH /people/:email 404 on unknown email
async function testPatchUnknownPerson() {
  const res = await fetch('/people/nobody%40co.com', {
    method: 'PATCH',
    body: { role: 'vip' }
  });
  assert.strictEqual(res.status, 404);
  console.log('PASS: PATCH /people/:email returns 404 for unknown');
}

// Run all
setup();
// Start gateway... (test harness will need to require and start the express app)
// For now, tests document the expected behavior
console.log('Endpoint tests defined — wire into gateway test harness');
```

Note: The test structure follows `test-gateway.js` patterns. The `setup()`
function MUST be called before `require('./gateway')` so env vars are set
before `lib/config.js` loads (it calls `process.exit(1)` on missing files).
Wire tests using the same pattern as `test-gateway.js` (start server on
port 0, run tests, teardown).

**Important:** GET `/people` returns an array directly (not `{ people: [...] }`).
Verify actual response shape matches.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-settings-endpoints.js`
Expected: FAIL — PATCH endpoint doesn't exist.

- [ ] **Step 3: Add PATCH /people/:email to gateway.js**

After the DELETE `/people/:email` handler (around line 47):

```javascript
// PATCH /people/:email — update person fields (role, escalation_tier, title, team)
app.patch('/people/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const person = db.prepare('SELECT * FROM monitored_people WHERE email = ?').get(email);
    if (!person) {
      return res.status(404).json({ error: 'Person not found' });
    }
    const { role, escalation_tier, title, team, name, slack_id } = req.body;
    const fields = {};
    if (role !== undefined) fields.role = role;
    if (escalation_tier !== undefined) fields.escalation_tier = escalation_tier;
    if (title !== undefined) fields.title = title;
    if (team !== undefined) fields.team = team;
    if (name !== undefined) fields.name = name;
    if (slack_id !== undefined) fields.slack_id = slack_id;

    peopleStore.updatePerson(db, email, fields);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Also modify GET `/people` to include new columns in the response (the existing
`SELECT *` already returns them, but verify the `listPeople` function returns them).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test-settings-endpoints.js && node test-gateway.js`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway.js test-settings-endpoints.js
git commit -m "feat: add PATCH /people/:email endpoint for role and escalation tier"
```

---

## Chunk 2: People View Redesign (Phase 2)

### Task 4: Gateway — Seed from team.json

**Files:**
- Modify: `gateway.js` (startup section)
- Test: `test-settings-endpoints.js` (append)

- [ ] **Step 1: Write failing test for seeding**

```javascript
// Test: seeding imports VIPs and direct reports from team.json
async function testSeedFromTeamJson() {
  // Setup with team.json containing VIPs and reports
  // After gateway starts, GET /people should include seeded entries
  const list = await fetch('/people');
  const vips = list.body.filter(p => p.role === 'vip');
  assert.ok(vips.length > 0, 'Should have seeded VIPs from team.json');
  console.log('PASS: seeding imports from team.json');
}
```

- [ ] **Step 2: Implement seeding in gateway.js**

Add after DB initialization, before route definitions:

```javascript
// Seed monitored_people from team.json if no VIPs/reports exist yet
const existingVips = peopleStore.listPeopleByRole(db, 'vip');
const existingReports = peopleStore.listPeopleByRole(db, 'direct_report');
if (existingVips.length === 0 && config.vips) {
  for (const v of config.vips) {
    // VIPs have email + title in team.json (no separate name field)
    peopleStore.addPerson(db, { email: v.email, name: null, role: 'vip', title: v.title });
  }
  logger.info({ count: config.vips.length }, 'Seeded VIPs from team.json');
}
if (existingReports.length === 0 && config.directReports) {
  for (const r of config.directReports) {
    peopleStore.addPerson(db, { email: r.email, name: r.name, role: 'direct_report' });
    if (r.slackId) peopleStore.updateSlackId(db, r.email, r.slackId);
  }
  logger.info({ count: config.directReports.length }, 'Seeded direct reports from team.json');
}
// Seed team directory from dwTeamEmails
const existingTeam = peopleStore.listTeamMembers(db);
if (existingTeam.length === 0 && config.dwTeamEmails) {
  for (const t of config.dwTeamEmails) {
    peopleStore.addPerson(db, { email: t.email, name: t.name, team: t.team });
  }
  logger.info({ count: config.dwTeamEmails.length }, 'Seeded team directory from team.json');
}
```

- [ ] **Step 3: Run tests, verify, commit**

```bash
git add gateway.js test-settings-endpoints.js
git commit -m "feat: seed monitored_people from team.json on gateway startup"
```

---

### Task 5: GatewayClient.swift — Update Person Model

**Files:**
- Modify: `reticle/Sources/Reticle/Services/GatewayClient.swift` (lines 5-19, Person struct)

- [ ] **Step 1: Add new fields to Person struct**

```swift
struct Person: Codable, Identifiable {
    let id: String?
    let email: String
    let name: String?
    let slackId: String?
    let jiraId: String?
    let role: String?          // "vip", "direct_report", "peer"
    let escalationTier: String? // "immediate", "4h", "daily", "weekly" — null = role default
    let title: String?          // VIP title
    let team: String?           // Team affiliation
    let resolvedAt: Int?
    let createdAt: Int?

    enum CodingKeys: String, CodingKey {
        case id, email, name, title, team
        case slackId = "slack_id"
        case jiraId = "jira_id"
        case role
        case escalationTier = "escalation_tier"
        case resolvedAt = "resolved_at"
        case createdAt = "created_at"
    }
}
```

- [ ] **Step 2: Add updatePerson method to GatewayClient**

```swift
func updatePerson(email: String, fields: [String: Any]) async throws {
    let encoded = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
    let _: EmptyResponse = try await request("/people/\(encoded)", method: "PATCH", body: fields)
}

private struct EmptyResponse: Decodable {
    let ok: Bool?
}
```

- [ ] **Step 3: Build to verify compilation**

Run: `cd reticle && swift build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add reticle/Sources/Reticle/Services/GatewayClient.swift
git commit -m "feat: add role, escalation tier, title, team to Person model"
```

---

### Task 6: PeopleView — Segmented Tabs Redesign

**Files:**
- Modify: `reticle/Sources/Reticle/Views/PeopleView.swift` (full rewrite)

- [ ] **Step 1: Rewrite PeopleView with segmented tabs**

Replace the entire PeopleView with:

```swift
import SwiftUI

enum PeopleTab: String, CaseIterable {
    case monitored = "Monitored"
    case directReports = "Direct Reports"
    case vips = "VIPs"
    case team = "Team"
}

struct PeopleView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var people: [Person] = []
    @State private var selectedTab: PeopleTab = .monitored
    @State private var showingAddForm = false
    @State private var error: String?

    private var filteredPeople: [Person] {
        switch selectedTab {
        case .monitored:
            return people.filter { ($0.role ?? "peer") == "peer" && $0.team == nil }
        case .directReports:
            return people.filter { $0.role == "direct_report" }
        case .vips:
            return people.filter { $0.role == "vip" }
        case .team:
            return people.filter { $0.team != nil && ($0.role ?? "peer") == "peer" }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Segmented tab control
            Picker("Category", selection: $selectedTab) {
                ForEach(PeopleTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            // Tab content
            List {
                ForEach(filteredPeople) { person in
                    personRow(person)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await deletePerson(person.email) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
            }
            .listStyle(.inset)
        }
        .navigationTitle("People")
        .toolbar {
            ToolbarItem {
                Button(action: { showingAddForm = true }) {
                    Label("Add", systemImage: "plus")
                }
                .popover(isPresented: $showingAddForm) {
                    AddPersonForm(tab: selectedTab, onAdd: { fields in
                        Task { await addPerson(fields) }
                    })
                    .frame(width: 300, height: 200)
                    .padding()
                }
            }
        }
        .task { await loadPeople() }
    }

    @ViewBuilder
    private func personRow(_ person: Person) -> some View {
        switch selectedTab {
        case .monitored:
            MonitoredPersonRow(person: person)
        case .directReports:
            DirectReportRow(person: person, gateway: gateway, onUpdate: { await loadPeople() })
        case .vips:
            VIPRow(person: person, gateway: gateway, onUpdate: { await loadPeople() })
        case .team:
            TeamMemberRow(person: person)
        }
    }

    private func loadPeople() async {
        do {
            people = try await gateway.listPeople()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func addPerson(_ fields: [String: String]) async {
        do {
            try await gateway.addPerson(
                email: fields["email"] ?? "",
                name: fields["name"] ?? ""
            )
            // If role specified, update it via PATCH
            if let role = fields["role"] {
                var patchFields: [String: Any] = ["role": role]
                if let title = fields["title"] { patchFields["title"] = title }
                if let team = fields["team"] { patchFields["team"] = team }
                try await gateway.updatePerson(email: fields["email"] ?? "", fields: patchFields)
            }
            await loadPeople()
            showingAddForm = false
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func deletePerson(_ email: String) async {
        try? await gateway.removePerson(email: email)
        await loadPeople()
    }
}
```

- [ ] **Step 2: Create per-tab row components**

Add to the same file (or a separate `PeopleRows.swift` if preferred):

```swift
// Row for Monitored tab — shows identity badges
struct MonitoredPersonRow: View {
    let person: Person
    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(person.name ?? person.email).fontWeight(.semibold)
                Text(person.email).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            IdentityBadge(label: "Slack", value: person.slackId)
            IdentityBadge(label: "Jira", value: person.jiraId)
        }
    }
}

// Row for Direct Reports tab — shows slack handle + escalation tier
struct DirectReportRow: View {
    let person: Person
    let gateway: GatewayClient
    let onUpdate: () async -> Void

    private var defaultTier: String { "4h" }
    private var effectiveTier: String { person.escalationTier ?? defaultTier }
    private var isOverridden: Bool { person.escalationTier != nil }

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(person.name ?? person.email).fontWeight(.semibold)
                HStack(spacing: 4) {
                    Text(person.email).font(.caption).foregroundStyle(.secondary)
                    if let slackId = person.slackId {
                        Text("·").font(.caption).foregroundStyle(.tertiary)
                        Text("@\(slackId)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            EscalationTierPicker(
                tier: effectiveTier,
                isOverridden: isOverridden,
                onChange: { newTier in
                    Task {
                        let tierValue = newTier == defaultTier ? nil : newTier
                        try? await gateway.updatePerson(
                            email: person.email,
                            fields: ["escalation_tier": tierValue as Any]
                        )
                        await onUpdate()
                    }
                }
            )
        }
    }
}

// Row for VIPs tab — shows title + escalation tier
struct VIPRow: View {
    let person: Person
    let gateway: GatewayClient
    let onUpdate: () async -> Void

    private var defaultTier: String { "immediate" }
    private var effectiveTier: String { person.escalationTier ?? defaultTier }
    private var isOverridden: Bool { person.escalationTier != nil }

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(person.name ?? person.email).fontWeight(.semibold)
                HStack(spacing: 4) {
                    if let title = person.title {
                        Text(title).font(.caption).foregroundStyle(.secondary)
                        Text("·").font(.caption).foregroundStyle(.tertiary)
                    }
                    Text(person.email).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            EscalationTierPicker(
                tier: effectiveTier,
                isOverridden: isOverridden,
                onChange: { newTier in
                    Task {
                        let tierValue = newTier == defaultTier ? nil : newTier
                        try? await gateway.updatePerson(
                            email: person.email,
                            fields: ["escalation_tier": tierValue as Any]
                        )
                        await onUpdate()
                    }
                }
            )
        }
    }
}

// Row for Team tab — shows team name
struct TeamMemberRow: View {
    let person: Person
    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(person.name ?? person.email).fontWeight(.semibold)
                if let team = person.team {
                    Text(team).font(.caption).foregroundStyle(.blue)
                }
            }
            Spacer()
            Text(person.email).font(.caption).foregroundStyle(.tertiary)
        }
    }
}

// Escalation tier picker with override dot
struct EscalationTierPicker: View {
    let tier: String
    let isOverridden: Bool
    let onChange: (String) -> Void

    private let tiers = [
        ("immediate", "Immediate"),
        ("4h", "Within 4h"),
        ("daily", "Daily digest"),
        ("weekly", "Weekly digest")
    ]

    var body: some View {
        HStack(spacing: 4) {
            if isOverridden {
                Circle()
                    .fill(.orange)
                    .frame(width: 6, height: 6)
            }
            Picker("", selection: Binding(
                get: { tier },
                set: { onChange($0) }
            )) {
                ForEach(tiers, id: \.0) { value, label in
                    Text(label).tag(value)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
        }
    }
}

// Add person form (adapts to current tab)
struct AddPersonForm: View {
    let tab: PeopleTab
    let onAdd: ([String: String]) -> Void

    @State private var email = ""
    @State private var name = ""
    @State private var title = ""
    @State private var team = ""
    @State private var slackId = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add \(tab.rawValue.replacingOccurrences(of: "s$", with: "", options: .regularExpression))")
                .font(.headline)
            TextField("Email", text: $email)
                .textFieldStyle(.roundedBorder)
            if tab != .vips {
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
            }
            if tab == .vips {
                TextField("Title (e.g., VP Engineering)", text: $title)
                    .textFieldStyle(.roundedBorder)
            }
            if tab == .directReports {
                TextField("Slack ID (optional)", text: $slackId)
                    .textFieldStyle(.roundedBorder)
            }
            if tab == .team {
                TextField("Team (e.g., Platform)", text: $team)
                    .textFieldStyle(.roundedBorder)
            }
            HStack {
                Spacer()
                Button("Add") {
                    var fields: [String: String] = ["email": email]
                    if !name.isEmpty { fields["name"] = name }
                    switch tab {
                    case .monitored: break
                    case .directReports:
                        fields["role"] = "direct_report"
                        if !slackId.isEmpty { fields["slackId"] = slackId }
                    case .vips:
                        fields["role"] = "vip"
                        fields["name"] = title  // VIP name = title
                        if !title.isEmpty { fields["title"] = title }
                    case .team:
                        if !team.isEmpty { fields["team"] = team }
                    }
                    onAdd(fields)
                }
                .disabled(email.isEmpty)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
    }
}
```

- [ ] **Step 3: Build and verify**

Run: `cd reticle && swift build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add reticle/Sources/Reticle/Views/PeopleView.swift
git commit -m "feat: redesign PeopleView with segmented tabs and escalation tiers"
```

---

## Chunk 3: Feedback & Sidebar (Phases 4-5)

### Task 7: Feedback Settings Table + Gateway Endpoints

**Files:**
- Modify: `reticle-db.js` (add feedback_settings table)
- Modify: `gateway.js` (add /feedback/settings endpoints)
- Test: `test-settings-migration.js` (append)

- [ ] **Step 1: Write failing test for feedback_settings table**

```javascript
// Test: feedback_settings table exists
{
  const { db, tmpDir } = createTestDb();
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    assert.ok(tables.includes('feedback_settings'), 'feedback_settings table should exist');

    // Test default values are seeded
    const target = db.prepare("SELECT value FROM feedback_settings WHERE key = 'weeklyTarget'").get();
    assert.strictEqual(target.value, '3');
    console.log('PASS: feedback_settings table with defaults');
  } finally {
    cleanup(tmpDir);
  }
}
```

- [ ] **Step 2: Add table to reticle-db.js**

```sql
CREATE TABLE IF NOT EXISTS feedback_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
```

Seed defaults:
```javascript
const existing = db.prepare("SELECT COUNT(*) as count FROM feedback_settings").get();
if (existing.count === 0) {
  db.prepare("INSERT INTO feedback_settings (key, value) VALUES (?, ?)").run('weeklyTarget', '3');
  db.prepare("INSERT INTO feedback_settings (key, value) VALUES (?, ?)").run('scanWindowHours', '24');
}
```

- [ ] **Step 3: Add gateway endpoints**

```javascript
// GET /feedback/settings
app.get('/feedback/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM feedback_settings').all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /feedback/settings
app.patch('/feedback/settings', (req, res) => {
  try {
    const { weeklyTarget, scanWindowHours } = req.body;
    const now = Math.floor(Date.now() / 1000);
    if (weeklyTarget !== undefined) {
      db.prepare("INSERT OR REPLACE INTO feedback_settings (key, value, updated_at) VALUES ('weeklyTarget', ?, ?)").run(String(weeklyTarget), now);
    }
    if (scanWindowHours !== undefined) {
      db.prepare("INSERT OR REPLACE INTO feedback_settings (key, value, updated_at) VALUES ('scanWindowHours', ?, ?)").run(String(scanWindowHours), now);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run tests, commit**

```bash
git add reticle-db.js gateway.js test-settings-migration.js
git commit -m "feat: add feedback_settings table and gateway endpoints"
```

---

### Task 8: FeedbackView — Settings Strip

**Files:**
- Modify: `reticle/Sources/Reticle/Views/FeedbackView.swift`
- Modify: `reticle/Sources/Reticle/Services/GatewayClient.swift`

- [ ] **Step 1: Add feedback settings methods to GatewayClient**

```swift
struct FeedbackSettings: Codable {
    let weeklyTarget: String?
    let scanWindowHours: String?
}

func fetchFeedbackSettings() async throws -> FeedbackSettings {
    return try await request("/feedback/settings")
}

func updateFeedbackSettings(weeklyTarget: Int? = nil, scanWindowHours: Int? = nil) async throws {
    var body: [String: Any] = [:]
    if let t = weeklyTarget { body["weeklyTarget"] = t }
    if let s = scanWindowHours { body["scanWindowHours"] = s }
    let _: EmptyResponse = try await request("/feedback/settings", method: "PATCH", body: body)
}
```

- [ ] **Step 2: Add settings strip to FeedbackView**

Insert a `VStack(spacing: 0)` wrapper with the settings strip above the
existing `HSplitView`:

```swift
@State private var weeklyTarget: Int = 3
@State private var scanWindowHours: Int = 24
@State private var deliveredThisWeek: Int = 0

// In body, wrap the HSplitView:
VStack(spacing: 0) {
    // Settings strip
    HStack(spacing: 12) {
        Text("Your standard:")
            .font(.caption)
            .foregroundStyle(.secondary)
        Stepper(value: $weeklyTarget, in: 1...20) {
            Text("\(weeklyTarget)/wk")
                .font(.caption)
                .monospacedDigit()
        }
        .labelsHidden()
        .onChange(of: weeklyTarget) { _, newValue in
            Task { try? await gateway.updateFeedbackSettings(weeklyTarget: newValue) }
        }

        Text("·").foregroundStyle(.tertiary)

        Text("This week: \(deliveredThisWeek)")
            .font(.caption)
            .foregroundStyle(.secondary)

        Divider().frame(height: 14)

        Text("Scan:")
            .font(.caption)
            .foregroundStyle(.secondary)
        Picker("", selection: $scanWindowHours) {
            Text("24h").tag(24)
            Text("48h").tag(48)
            Text("72h").tag(72)
            Text("14d").tag(336)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 160)
        .onChange(of: scanWindowHours) { _, newValue in
            Task { try? await gateway.updateFeedbackSettings(scanWindowHours: newValue) }
        }

        Spacer()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(.bar)

    Divider()

    // Existing HSplitView goes here
    HSplitView { ... }
}
.task {
    // Load settings
    if let settings = try? await gateway.fetchFeedbackSettings() {
        weeklyTarget = Int(settings.weeklyTarget ?? "3") ?? 3
        scanWindowHours = Int(settings.scanWindowHours ?? "24") ?? 24
    }
    // Load delivered count from stats
    if let stats = try? await gateway.fetchStats() {
        deliveredThisWeek = stats.weekly.values.reduce(0) { $0 + $1.delivered }
    }
}
```

- [ ] **Step 3: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/Views/FeedbackView.swift reticle/Sources/Reticle/Services/GatewayClient.swift
git commit -m "feat: add feedback settings strip with behavioral framing"
```

---

### Task 9: Sidebar — Add Settings + Fix Coming Soon

**Files:**
- Modify: `reticle/Sources/Reticle/ContentView.swift`
- Modify: `reticle/Sources/Reticle/ReticleApp.swift`

- [ ] **Step 1: Add .settings to SidebarSection enum**

```swift
enum SidebarSection: String, CaseIterable, Identifiable {
    case commitments = "Commitments"
    case people = "People"
    case feedback = "Feedback"
    case messages = "Messages"
    case todos = "To-dos"
    case goals = "Goals"
    case settings = "Settings"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .commitments: return "checkmark.circle"
        case .people: return "person.2"
        case .feedback: return "bubble.left.and.bubble.right"
        case .messages: return "envelope"
        case .todos: return "checklist"
        case .goals: return "target"
        case .settings: return "gearshape"
        }
    }

    var isAvailable: Bool {
        switch self {
        case .commitments, .people, .feedback, .settings: return true
        default: return false
        }
    }
}
```

- [ ] **Step 2: Update sidebar layout with separator and disabled items**

In the sidebar `List`, split into sections:

```swift
List(selection: $selectedSection) {
    // Main items — only tag available items (untagged items can't be selected)
    Section {
        ForEach(SidebarSection.allCases.filter { $0 != .settings }) { section in
            if section.isAvailable {
                Label(section.rawValue, systemImage: section.icon)
                    .tag(section)
            } else {
                Label(section.rawValue, systemImage: section.icon)
                    .foregroundStyle(.tertiary)
                    // No .tag() — prevents selection
            }
        }
    }

    // Settings pinned to bottom
    Section {
        Label(SidebarSection.settings.rawValue, systemImage: SidebarSection.settings.icon)
            .tag(SidebarSection.settings)
    }
}
```

- [ ] **Step 3: Add SettingsView to the detail switch**

```swift
case .settings:
    SettingsView()
```

- [ ] **Step 4: Add Cmd+, shortcut in ReticleApp.swift**

In the WindowGroup scene, add a CommandGroup:

```swift
.commands {
    CommandGroup(replacing: .appSettings) {
        Button("Settings...") {
            appState.showManagementWindow()
            // Set selectedSection to .settings
            NotificationCenter.default.post(
                name: .init("navigateToSettings"), object: nil
            )
        }
        .keyboardShortcut(",", modifiers: .command)
    }
}
```

- [ ] **Step 5: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/ContentView.swift reticle/Sources/Reticle/ReticleApp.swift
git commit -m "feat: add Settings to sidebar, fix Coming Soon items, add Cmd+, shortcut"
```

---

## Chunk 4: Settings View (Phase 6)

### Task 10: Create SettingsView — Accounts Section

**Files:**
- Create: `reticle/Sources/Reticle/Views/SettingsView.swift`
- Modify: `reticle/Sources/Reticle/Services/GatewayClient.swift`

- [ ] **Step 1: Add /config/accounts endpoint to gateway**

```javascript
// GET /config/accounts — return account identifiers + connection health
app.get('/config/accounts', (req, res) => {
  try {
    const heartbeatDir = process.env.RETICLE_HEARTBEAT_DIR ||
      path.join(os.homedir(), '.reticle', 'heartbeats');

    // GET returns identifiers + connection status ONLY (never raw tokens)
    // Tokens are read from secrets.json directly by the Swift client
    // via a separate file-read path for the editable SecureFields
    const accounts = {
      slack: {
        identifier: config.slackUsername || config.slackUserId || null,
        connected: !!config.slackBotToken,
        hasToken: !!config.slackBotToken,
        hasAppToken: !!config.slackAppToken,
        userId: config.slackUserId || '',
        username: config.slackUsername || ''
      },
      gmail: {
        identifier: config.gmailAccount || null,
        connected: !!config.gmailAccount,
        account: config.gmailAccount || ''
      },
      jira: {
        identifier: config.jiraBaseUrl || null,
        connected: !!(config.jiraApiToken && config.jiraBaseUrl),
        baseUrl: config.jiraBaseUrl || '',
        userEmail: config.jiraUserEmail || '',
        hasToken: !!config.jiraApiToken
      }
    };
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add PATCH /config/accounts endpoint**

```javascript
// PATCH /config/accounts — update secrets.json fields
app.patch('/config/accounts', (req, res) => {
  try {
    const secretsPath = path.join(config.configDir, 'secrets.json');
    const current = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    const allowed = [
      'slackBotToken', 'slackAppToken', 'slackSigningSecret',
      'slackUserId', 'slackUsername', 'slackUserToken',
      'gmailAccount', 'jiraApiToken', 'jiraBaseUrl', 'jiraUserEmail'
    ];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key)) current[key] = value;
    }
    // Atomic write
    const tmpPath = secretsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2));
    fs.renameSync(tmpPath, secretsPath);
    res.json({ ok: true, note: 'Restart services to apply credential changes' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add Swift models and methods to GatewayClient**

```swift
struct AccountInfo: Codable {
    let identifier: String?
    let connected: Bool
    let fields: [String: String]
}

struct AccountsResponse: Codable {
    let slack: AccountInfo
    let gmail: AccountInfo
    let jira: AccountInfo
}

func fetchAccounts() async throws -> AccountsResponse {
    return try await request("/config/accounts")
}

func updateAccounts(fields: [String: String]) async throws {
    let _: EmptyResponse = try await request("/config/accounts", method: "PATCH", body: fields)
}
```

- [ ] **Step 4: Create SettingsView.swift with Accounts section**

```swift
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var serviceStore: ServiceStore

    var body: some View {
        Form {
            AccountsSection(gateway: gateway)
            NotificationsSection()
            SystemSection(appState: appState, serviceStore: serviceStore)
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
    }
}

struct AccountsSection: View {
    let gateway: GatewayClient
    @State private var accounts: AccountsResponse?
    @State private var slackFields: [String: String] = [:]
    @State private var gmailFields: [String: String] = [:]
    @State private var jiraFields: [String: String] = [:]
    @State private var revealedFields: Set<String> = []

    var body: some View {
        Section("Slack") {
            credentialField("Bot Token", key: "slackBotToken", fields: $slackFields, isSecret: true)
            credentialField("App Token", key: "slackAppToken", fields: $slackFields, isSecret: true)
            credentialField("Signing Secret", key: "slackSigningSecret", fields: $slackFields, isSecret: true)
            credentialField("User ID", key: "slackUserId", fields: $slackFields, isSecret: false)
            credentialField("Username", key: "slackUsername", fields: $slackFields, isSecret: false)
            credentialField("User Token", key: "slackUserToken", fields: $slackFields, isSecret: true)
            Text("Changes take effect after service restart")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        Section("Gmail") {
            credentialField("Account", key: "gmailAccount", fields: $gmailFields, isSecret: false)
        }

        Section("Jira") {
            credentialField("Base URL", key: "jiraBaseUrl", fields: $jiraFields, isSecret: false)
            credentialField("Email", key: "jiraUserEmail", fields: $jiraFields, isSecret: false)
            credentialField("API Token", key: "jiraApiToken", fields: $jiraFields, isSecret: true)
            Text("Changes take effect after service restart")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func credentialField(_ label: String, key: String, fields: Binding<[String: String]>, isSecret: Bool) -> some View {
        LabeledContent(label) {
            HStack {
                if isSecret && !revealedFields.contains(key) {
                    SecureField("", text: binding(for: key, in: fields))
                        .font(.system(.body, design: .monospaced))
                        .textFieldStyle(.roundedBorder)
                } else {
                    TextField("", text: binding(for: key, in: fields))
                        .font(.system(.body, design: .monospaced))
                        .textFieldStyle(.roundedBorder)
                }
                if isSecret {
                    Button(action: { toggleReveal(key) }) {
                        Image(systemName: revealedFields.contains(key) ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
            }
            .onSubmit { saveField(key, value: fields.wrappedValue[key] ?? "") }
        }
    }

    private func binding(for key: String, in fields: Binding<[String: String]>) -> Binding<String> {
        Binding(
            get: { fields.wrappedValue[key] ?? "" },
            set: { fields.wrappedValue[key] = $0 }
        )
    }

    private func toggleReveal(_ key: String) {
        if revealedFields.contains(key) {
            revealedFields.remove(key)
        } else {
            revealedFields.insert(key)
        }
    }

    private func saveField(_ key: String, value: String) {
        Task {
            try? await gateway.updateAccounts(fields: [key: value])
        }
    }
}
```

- [ ] **Step 5: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/Views/SettingsView.swift gateway.js reticle/Sources/Reticle/Services/GatewayClient.swift
git commit -m "feat: add SettingsView with Accounts section (editable SecureFields)"
```

---

### Task 11: SettingsView — Notifications + System Sections

**Files:**
- Modify: `reticle/Sources/Reticle/Views/SettingsView.swift`

- [ ] **Step 1: Add Notifications section placeholder**

```swift
struct NotificationsSection: View {
    // These will be backed by settings.json via gateway in a future step
    @State private var gmailInterval = 5
    @State private var followupInterval = 15
    @State private var emailEscalationHours = 48
    @State private var slackDmEscalationHours = 72
    @State private var slackMentionEscalationHours = 168

    var body: some View {
        Section("Gmail") {
            Picker("Check interval", selection: $gmailInterval) {
                Text("1 min").tag(1)
                Text("5 min").tag(5)
                Text("15 min").tag(15)
                Text("30 min").tag(30)
            }
            .pickerStyle(.segmented)
        }

        Section("Follow-ups") {
            Picker("Check interval", selection: $followupInterval) {
                Text("5 min").tag(5)
                Text("15 min").tag(15)
                Text("30 min").tag(30)
            }
            .pickerStyle(.segmented)

            Stepper("Email escalation: \(emailEscalationHours)h",
                    value: $emailEscalationHours, in: 1...168)
            Stepper("Slack DM escalation: \(slackDmEscalationHours)h",
                    value: $slackDmEscalationHours, in: 1...168)
            Stepper("Slack mention escalation: \(slackMentionEscalationHours)h",
                    value: $slackMentionEscalationHours, in: 1...336)
        }
    }
}
```

- [ ] **Step 2: Add System section**

```swift
struct SystemSection: View {
    let appState: AppState
    let serviceStore: ServiceStore

    var body: some View {
        Section("General") {
            Toggle("Launch at login", isOn: Binding(
                get: { appState.isLoginItemEnabled },
                set: { _ in appState.toggleLoginItem() }
            ))
        }

        Section("Services") {
            ForEach(serviceStore.services, id: \.definition.label) { service in
                HStack {
                    Circle()
                        .fill(serviceStatusColor(service))
                        .frame(width: 8, height: 8)
                    Text(service.definition.label)
                    Spacer()
                    Button(service.status == .running ? "Stop" : "Start") {
                        Task {
                            if service.status == .running {
                                await serviceStore.stop(service.definition.launchdLabel)
                            } else {
                                await serviceStore.start(service.definition.launchdLabel)
                            }
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }

    private func serviceStatusColor(_ service: ServiceState) -> Color {
        switch service.status {
        case .running: return .green
        case .error: return .red
        default: return .gray
        }
    }
}
```

- [ ] **Step 3: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/Views/SettingsView.swift
git commit -m "feat: add Notifications and System sections to SettingsView"
```

---

### Task 12: CommitmentsView — Stale Threshold Picker

**Files:**
- Modify: `reticle/Sources/Reticle/Views/CommitmentsView.swift`

- [ ] **Step 1: Add stale days picker to SummaryBar**

Add a `@State private var staleDays = 7` to CommitmentsView and pass it
to both the SummaryBar and the `listCommitments()` call:

```swift
@State private var staleDays = 7

// In SummaryBar, add:
HStack {
    // ... existing pills ...
    Spacer()
    Text("Stale after:")
        .font(.caption)
        .foregroundStyle(.secondary)
    Picker("", selection: $staleDays) {
        Text("3d").tag(3)
        Text("5d").tag(5)
        Text("7d").tag(7)
        Text("14d").tag(14)
        Text("30d").tag(30)
    }
    .pickerStyle(.menu)
    .labelsHidden()
    .onChange(of: staleDays) { _, _ in
        Task { await loadCommitments() }
    }
}
```

Update `listCommitments()` in GatewayClient to accept `staleDays` parameter:

```swift
func listCommitments(staleDays: Int = 7) async throws -> CommitmentsResponse {
    return try await request("/api/commitments?staleDays=\(staleDays)")
}
```

- [ ] **Step 2: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/Views/CommitmentsView.swift reticle/Sources/Reticle/Services/GatewayClient.swift
git commit -m "feat: add stale days picker to CommitmentsView SummaryBar"
```

---

## Chunk 5: Service Migration + Cleanup (Phases 3, 5)

### Task 13: Gmail Monitor — Read VIPs from DB

**Files:**
- Modify: `gmail-monitor.js`
- Modify: `reticle-db.js` (ensure exported)

- [ ] **Step 1: Replace hardcoded VIPS with DB read**

In `gmail-monitor.js`, change the VIPS initialization from:

```javascript
const VIPS = config.vipEmails;
```

To reading per-cycle inside `checkGmail()`:

```javascript
const peopleStore = require('./lib/people-store');
// Inside checkGmail():
const VIPS = peopleStore.getVipEmails(db);
```

- [ ] **Step 2: Verify gmail-monitor still works**

Run: `node gmail-monitor.js --dry-run` (or check test if available)

- [ ] **Step 3: Commit**

```bash
git add gmail-monitor.js
git commit -m "feat: gmail-monitor reads VIPs from DB per-cycle instead of config"
```

---

### Task 14: Meeting Alert Monitor — Read Direct Reports from DB

**Files:**
- Modify: `meeting-alert-monitor.js`

- [ ] **Step 1: Replace config.directReports with DB read**

Change O3_CONFIG initialization to read from DB before each O3 detection pass:

```javascript
const peopleStore = require('./lib/people-store');
// Inside the O3 detection function, replace config.directReports:
const directReports = peopleStore.getDirectReports(db);
```

- [ ] **Step 2: Commit**

```bash
git add meeting-alert-monitor.js
git commit -m "feat: meeting-alert-monitor reads direct reports from DB per-cycle"
```

---

### Task 15: Strip team.json (Phase 5)

**Files:**
- Modify: `lib/config.js`
- Modify: `config/team.example.json`

- [ ] **Step 1: Remove vips, directReports, feedback exports from config.js**

After Phase 3 services no longer read these from config:

```javascript
// Remove or deprecate these exports:
// vips: team.vips || [],
// vipEmails: (team.vips || []).map(v => v.email.toLowerCase()),
// directReports: team.directReports || [],
// feedback: team.feedback || { weeklyTarget: 3, scanWindowHours: 24 },
```

Keep: `filterPatterns`, `dwTeamEmails`, `configDir`, all secrets exports.

- [ ] **Step 2: Update config/team.example.json**

```json
{
  "filterPatterns": {
    "companyDomain": "example.com",
    "dwGroupEmail": "it-group@example.com"
  },
  "dwTeamEmails": [
    {"name": "Jane Doe", "team": "CSE", "email": "jane@example.com"}
  ]
}
```

- [ ] **Step 3: Run all tests to verify nothing depends on removed exports**

Run: `npm test`

- [ ] **Step 4: Commit**

```bash
git add lib/config.js config/team.example.json
git commit -m "feat: strip vips, directReports, feedback from team.json (now DB-backed)"
```

---

## Chunk 6: settings.json + SIGHUP (Phase 6 completion)

### Task 16: settings.json Loader + Gateway Endpoints

**Files:**
- Modify: `lib/config.js` (add settings.json loading)
- Modify: `gateway.js` (add GET/PATCH /settings endpoints)
- Test: `test-settings-endpoints.js` (append)

- [ ] **Step 1: Add settings.json loader to lib/config.js**

```javascript
// After loading secrets and team, optionally load settings.json
const settingsPath = path.join(configDir, 'settings.json');
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    console.error('WARNING: settings.json is corrupt, using defaults');
  }
}

// Export merged with defaults
module.exports = {
  // ...existing exports...
  settings,
  polling: {
    gmailIntervalMinutes: settings.polling?.gmailIntervalMinutes ?? 5,
    slackResponseTimeoutMinutes: settings.polling?.slackResponseTimeoutMinutes ?? 10,
    followupCheckIntervalMinutes: settings.polling?.followupCheckIntervalMinutes ?? 15,
    meetingAlertPollIntervalSeconds: settings.polling?.meetingAlertPollIntervalSeconds ?? 120,
  },
  configDir,
};
```

- [ ] **Step 2: Add GET/PATCH /settings to gateway.js**

```javascript
// GET /settings — read settings.json with defaults
app.get('/settings', (req, res) => {
  try {
    const settingsPath = path.join(config.configDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /settings — validate, write atomically, SIGHUP affected services
app.patch('/settings', (req, res) => {
  try {
    const settingsPath = path.join(config.configDir, 'settings.json');
    let current = {};
    if (fs.existsSync(settingsPath)) {
      current = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }

    // Deep merge changed keys
    const changedKeys = [];
    for (const [section, values] of Object.entries(req.body)) {
      if (typeof values === 'object' && values !== null) {
        current[section] = { ...(current[section] || {}), ...values };
      } else {
        current[section] = values;
      }
      changedKeys.push(section);
    }

    // Atomic write
    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2));
    fs.renameSync(tmpPath, settingsPath);

    // SIGHUP affected services
    const signaled = signalAffectedServices(changedKeys);

    res.json({ ok: true, signaled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Implement SIGHUP targeting**

```javascript
const SETTINGS_SERVICE_MAP = {
  polling: {
    gmailIntervalMinutes: 'gmail-monitor',
    slackResponseTimeoutMinutes: 'slack-events',
    followupCheckIntervalMinutes: 'followup-checker',
    meetingAlertPollIntervalSeconds: 'meeting-alerts',
  },
  notifications: 'meeting-alerts',
  thresholds: 'followup-checker',
  o3: 'meeting-alerts',
  // digest: no SIGHUP (launchd-scheduled)
};

function signalAffectedServices(changedKeys) {
  const heartbeatDir = process.env.RETICLE_HEARTBEAT_DIR ||
    path.join(os.homedir(), '.reticle', 'heartbeats');
  const signaled = [];

  const serviceNames = new Set();
  for (const key of changedKeys) {
    const mapping = SETTINGS_SERVICE_MAP[key];
    if (typeof mapping === 'string') serviceNames.add(mapping);
    else if (typeof mapping === 'object') {
      Object.values(mapping).forEach(s => serviceNames.add(s));
    }
  }

  for (const name of serviceNames) {
    try {
      const hbPath = path.join(heartbeatDir, `${name}.json`);
      if (!fs.existsSync(hbPath)) continue;
      const hb = JSON.parse(fs.readFileSync(hbPath, 'utf-8'));
      if (!hb.pid) continue;
      // Verify PID is alive before signaling
      try { process.kill(hb.pid, 0); } catch { continue; }
      process.kill(hb.pid, 'SIGHUP');
      signaled.push(name);
    } catch (e) {
      logger.warn({ service: name, error: e.message }, 'Failed to signal service');
    }
  }
  return signaled;
}
```

- [ ] **Step 4: Add SIGHUP handler to service template**

Each long-running service (gmail-monitor, slack-events-monitor,
meeting-alert-monitor, followup-checker) needs:

```javascript
process.on('SIGHUP', () => {
  logger.info('Received SIGHUP, reloading settings');
  // Re-read settings.json (config module caches, so re-read file directly)
  const settingsPath = path.join(config.configDir, 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Update service-specific CONFIG values
    CONFIG.pollInterval = (settings.polling?.gmailIntervalMinutes ?? 5) * 60 * 1000;
    // ... etc for each service's relevant keys
  } catch (e) {
    logger.warn({ error: e.message }, 'Failed to reload settings, keeping current values');
  }
});
```

- [ ] **Step 5: Test, commit**

```bash
node test-settings-endpoints.js && npm test
git add lib/config.js gateway.js gmail-monitor.js slack-events-monitor.js meeting-alert-monitor.js followup-checker.js
git commit -m "feat: add settings.json endpoints with SIGHUP reload"
```

---

### Task 17: Wire Notifications Section to Gateway

**Files:**
- Modify: `reticle/Sources/Reticle/Views/SettingsView.swift`
- Modify: `reticle/Sources/Reticle/Services/GatewayClient.swift`

- [ ] **Step 1: Add settings methods to GatewayClient**

```swift
struct ReticleSettings: Codable {
    var polling: PollingSettings?
    var thresholds: ThresholdSettings?
    var o3: O3Settings?

    struct PollingSettings: Codable {
        var gmailIntervalMinutes: Int?
        var followupCheckIntervalMinutes: Int?
    }
    struct ThresholdSettings: Codable {
        var followupEscalationEmailHours: Int?
        var followupEscalationSlackDmHours: Int?
        var followupEscalationSlackMentionHours: Int?
    }
    struct O3Settings: Codable {
        var prepWindowStartHour: Int?
        var prepWindowEndHour: Int?
        var minGapMinutes: Int?
    }
}

func fetchSettings() async throws -> ReticleSettings {
    return try await request("/settings")
}

func updateSettings(_ settings: [String: Any]) async throws {
    let _: EmptyResponse = try await request("/settings", method: "PATCH", body: settings)
}
```

- [ ] **Step 2: Wire NotificationsSection to load/save via gateway**

Replace `@State` vars with values loaded from gateway on `.task {}`.
Each `.onChange` calls `gateway.updateSettings(...)` with the relevant
section. Example for Gmail interval:

```swift
.onChange(of: gmailInterval) { _, newValue in
    Task {
        try? await gateway.updateSettings([
            "polling": ["gmailIntervalMinutes": newValue]
        ])
    }
}
```

- [ ] **Step 3: Add AccountsSection data loading**

Add `.task {}` to AccountsSection:

```swift
.task {
    if let accts = try? await gateway.fetchAccounts() {
        // Populate non-secret fields from GET response
        slackFields["slackUserId"] = accts.slack.userId
        slackFields["slackUsername"] = accts.slack.username
        gmailFields["gmailAccount"] = accts.gmail.account
        jiraFields["jiraBaseUrl"] = accts.jira.baseUrl
        jiraFields["jiraUserEmail"] = accts.jira.userEmail
        // Secret fields stay empty — user pastes new values
        // The SecureField shows masked placeholder if connected
    }
}
```

- [ ] **Step 4: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/Views/SettingsView.swift reticle/Sources/Reticle/Services/GatewayClient.swift
git commit -m "feat: wire Notifications section to settings.json via gateway"
```

---

### Task 18: Email Filter Patterns in People View

**Files:**
- Modify: `reticle/Sources/Reticle/Views/PeopleView.swift`
- Modify: `gateway.js` (add /config/filters endpoint)

- [ ] **Step 1: Add GET/PATCH /config/filters endpoints**

```javascript
// GET /config/filters — read filterPatterns from team.json
app.get('/config/filters', (req, res) => {
  res.json(config.filterPatterns || {});
});

// PATCH /config/filters — update filterPatterns in team.json
app.patch('/config/filters', (req, res) => {
  try {
    const teamPath = path.join(config.configDir, 'team.json');
    const current = JSON.parse(fs.readFileSync(teamPath, 'utf-8'));
    if (req.body.companyDomain !== undefined) {
      current.filterPatterns = current.filterPatterns || {};
      current.filterPatterns.companyDomain = req.body.companyDomain;
    }
    if (req.body.dwGroupEmail !== undefined) {
      current.filterPatterns = current.filterPatterns || {};
      current.filterPatterns.dwGroupEmail = req.body.dwGroupEmail;
    }
    const tmpPath = teamPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2));
    fs.renameSync(tmpPath, teamPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add filter patterns DisclosureGroup to PeopleView**

Below the tab content List, add:

```swift
DisclosureGroup("Monitoring Filters") {
    LabeledContent("Company domain") {
        TextField("example.com", text: $companyDomain)
            .textFieldStyle(.roundedBorder)
            .onSubmit { saveFilters() }
    }
    LabeledContent("Group email") {
        TextField("team@example.com", text: $groupEmail)
            .textFieldStyle(.roundedBorder)
            .onSubmit { saveFilters() }
    }
}
.padding(.horizontal)
.padding(.bottom, 8)
```

- [ ] **Step 3: Build, verify, commit**

```bash
cd reticle && swift build
git add reticle/Sources/Reticle/Views/PeopleView.swift gateway.js
git commit -m "feat: add email filter patterns DisclosureGroup to People view"
```

---

## Summary

| Phase | Tasks | Key Deliverable |
|-------|-------|-----------------|
| 1 | Tasks 1-3 | Schema migration + PATCH API |
| 2 | Tasks 4-6 | People view with segmented tabs + seeding |
| 4 | Tasks 7-8 | Feedback settings strip |
| Sidebar | Task 9 | Settings in sidebar + Cmd+, |
| 6a | Tasks 10-12 | Settings view (Accounts, Notifications, System) |
| 3 | Tasks 13-14 | Services read from DB |
| 5 | Task 15 | team.json cleanup |
| 6b | Tasks 16-17 | settings.json endpoints + SIGHUP + wiring |
| - | Task 18 | Email filter patterns in People view |

Each task produces a working commit. Each phase is independently deployable.
Run `npm test && cd reticle && swift build` after each commit to verify.

**Review findings addressed:**
- Fixed: ESM→CJS imports in test files
- Fixed: addPerson preserves upsert (ON CONFLICT UPDATE, not INSERT OR IGNORE)
- Fixed: GET /config/accounts never returns raw tokens
- Fixed: ServiceStore.start/stop takes launchdLabel string
- Fixed: Sidebar disabled items have no .tag() (prevents selection)
- Fixed: VIP seeding uses null name (not title as name)
- Added: dwTeamEmails seeding in Task 4
- Added: settings.json loader + endpoints + SIGHUP (Task 16)
- Added: Notifications wiring to gateway (Task 17)
- Added: AccountsSection data loading (Task 17)
- Added: Email filter patterns UI (Task 18)
