#!/usr/bin/env node
/**
 * Delete orphaned raw_messages (no author_ext_id) so slack-backfill
 * can re-capture them with the new enriched pipeline.
 *
 * Idempotent — only deletes rows where author_ext_id IS NULL.
 * Run slack-backfill.js immediately after to re-capture.
 */
'use strict';

const { initDatabase } = require('../lib/org-memory-db');

const db = initDatabase();

const dryRun = process.env.DRY_RUN === '1';

// Show what we're about to delete
const orphaned = db.prepare(`
  SELECT source, author_name, COUNT(*) as count
  FROM raw_messages
  WHERE author_ext_id IS NULL
  GROUP BY source, author_name
  ORDER BY count DESC
`).all();

const total = orphaned.reduce((sum, r) => sum + r.count, 0);

if (total === 0) {
  console.log('No orphaned rows — nothing to delete.');
  process.exit(0);
}

console.log(`Found ${total} orphaned rows (no author_ext_id):`);
for (const row of orphaned) {
  console.log(`  ${row.source} / ${row.author_name || '(null)'}: ${row.count}`);
}

if (dryRun) {
  console.log('\nDRY_RUN — no rows deleted. Run without DRY_RUN=1 to delete.');
  process.exit(0);
}

const result = db.prepare('DELETE FROM raw_messages WHERE author_ext_id IS NULL').run();
console.log(`\nDeleted ${result.changes} orphaned rows.`);
console.log('Now run: node slack-backfill.js --days 14');
