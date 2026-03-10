#!/usr/bin/env node
/**
 * Backfill author_ext_id on existing raw_messages rows.
 *
 * Strategy:
 * 1. Rows WITH author_id: reverse-lookup identity_map (entity_id → external_id)
 * 2. Rows WITHOUT author_id: cannot be backfilled from DB alone.
 *    Log these for manual review.
 *
 * Idempotent — safe to run multiple times.
 */
'use strict';

const { initDatabase } = require('../lib/org-memory-db');

const db = initDatabase();

// Step 1: Backfill rows that have author_id (resolved entity)
const withAuthor = db.prepare(`
  SELECT rm.id, rm.source, rm.author_id, im.external_id
  FROM raw_messages rm
  JOIN identity_map im ON im.entity_id = rm.author_id AND im.source = rm.source
  WHERE rm.author_ext_id IS NULL AND rm.author_id IS NOT NULL
`).all();

const update = db.prepare('UPDATE raw_messages SET author_ext_id = ? WHERE id = ?');
let backfilled = 0;

const txn = db.transaction(() => {
  for (const row of withAuthor) {
    update.run(row.external_id, row.id);
    backfilled++;
  }
});
txn();

console.log(`Backfilled ${backfilled} rows with author_ext_id from identity_map`);

// Step 2: Report rows that can't be backfilled
const orphaned = db.prepare(`
  SELECT source, author_name, COUNT(*) as count
  FROM raw_messages
  WHERE author_ext_id IS NULL
  GROUP BY source, author_name
  ORDER BY count DESC
`).all();

if (orphaned.length > 0) {
  console.log(`\nRows without author_ext_id (cannot backfill from DB):`);
  for (const row of orphaned) {
    console.log(`  ${row.source} / ${row.author_name || '(null)'}: ${row.count} messages`);
  }
  console.log(`\nThese need re-capture from source APIs or manual update.`);
} else {
  console.log('All rows have author_ext_id. No orphans.');
}
