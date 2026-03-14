'use strict';

/**
 * One-time backfill: resolve stale open event facts.
 *
 * Heuristic rules:
 * 1. status_update events → 'completed' (observations, not commitments)
 * 2. decided events → 'completed' (decisions are done when made)
 * 3. raised_risk events older than 30 days → 'abandoned' (unaddressed risks)
 * 4. committed_to / asked_to older than 90 days → 'abandoned' (stale commitments)
 * 5. Recent committed_to / asked_to → left open (new pipeline handles them)
 *
 * Usage: node backfill-resolve-stale.js [--dry-run]
 */

const { initDatabase, DB_PATH } = require('./lib/org-memory-db');

const dryRun = process.argv.includes('--dry-run');
const db = initDatabase();
const now = Math.floor(Date.now() / 1000);
const THIRTY_DAYS = 30 * 86400;
const NINETY_DAYS = 90 * 86400;

console.log(`Database: ${DB_PATH}`);
console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

// Count current state
const openCount = db.prepare(
  "SELECT attribute, COUNT(*) as n FROM facts WHERE fact_type = 'event' AND resolution = 'open' GROUP BY attribute ORDER BY n DESC"
).all();
console.log('Open event facts before backfill:');
for (const r of openCount) console.log(`  ${r.n} ${r.attribute}`);
console.log();

// Rule 1: status_update → completed
const statusUpdates = db.prepare(
  "SELECT COUNT(*) as n FROM facts WHERE fact_type = 'event' AND resolution = 'open' AND attribute = 'status_update'"
).get();
console.log(`Rule 1: ${statusUpdates.n} status_update events → completed`);

// Rule 2: decided → completed
const decided = db.prepare(
  "SELECT COUNT(*) as n FROM facts WHERE fact_type = 'event' AND resolution = 'open' AND attribute = 'decided'"
).get();
console.log(`Rule 2: ${decided.n} decided events → completed`);

// Rule 3: raised_risk > 30 days → abandoned
const staleRisks = db.prepare(
  "SELECT COUNT(*) as n FROM facts WHERE fact_type = 'event' AND resolution = 'open' AND attribute = 'raised_risk' AND valid_from < ?"
).get(now - THIRTY_DAYS);
console.log(`Rule 3: ${staleRisks.n} raised_risk events > 30 days → abandoned`);

// Rule 4: committed_to / asked_to > 90 days → abandoned
const staleCommitments = db.prepare(
  "SELECT COUNT(*) as n FROM facts WHERE fact_type = 'event' AND resolution = 'open' AND attribute IN ('committed_to', 'asked_to') AND valid_from < ?"
).get(now - NINETY_DAYS);
console.log(`Rule 4: ${staleCommitments.n} committed_to/asked_to events > 90 days → abandoned`);

// Count what stays open
const remaining = db.prepare(`
  SELECT COUNT(*) as n FROM facts
  WHERE fact_type = 'event' AND resolution = 'open'
    AND attribute IN ('committed_to', 'asked_to', 'raised_risk')
    AND (
      (attribute IN ('committed_to', 'asked_to') AND valid_from >= ?)
      OR (attribute = 'raised_risk' AND valid_from >= ?)
    )
`).get(now - NINETY_DAYS, now - THIRTY_DAYS);
console.log(`\nRemaining open after backfill: ${remaining.n}`);

if (dryRun) {
  console.log('\n(Dry run — no changes made)');
  db.close();
  process.exit(0);
}

console.log('\nApplying...');

db.transaction(() => {
  // Rule 1
  db.prepare(
    "UPDATE facts SET resolution = 'completed', resolved_at = ? WHERE fact_type = 'event' AND resolution = 'open' AND attribute = 'status_update'"
  ).run(now);

  // Rule 2
  db.prepare(
    "UPDATE facts SET resolution = 'completed', resolved_at = ? WHERE fact_type = 'event' AND resolution = 'open' AND attribute = 'decided'"
  ).run(now);

  // Rule 3
  db.prepare(
    "UPDATE facts SET resolution = 'abandoned', resolved_at = ? WHERE fact_type = 'event' AND resolution = 'open' AND attribute = 'raised_risk' AND valid_from < ?"
  ).run(now, now - THIRTY_DAYS);

  // Rule 4
  db.prepare(
    "UPDATE facts SET resolution = 'abandoned', resolved_at = ? WHERE fact_type = 'event' AND resolution = 'open' AND attribute IN ('committed_to', 'asked_to') AND valid_from < ?"
  ).run(now, now - NINETY_DAYS);
})();

// Verify
const afterCount = db.prepare(
  "SELECT resolution, COUNT(*) as n FROM facts WHERE fact_type = 'event' GROUP BY resolution ORDER BY n DESC"
).all();
console.log('\nFact resolution distribution after backfill:');
for (const r of afterCount) console.log(`  ${r.n} ${r.resolution || 'NULL'}`);

db.close();
console.log('\nDone.');
