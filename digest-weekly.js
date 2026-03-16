'use strict';

const config = require('./lib/config');
const reticleDb = require('./reticle-db');
const log = require('./lib/logger')('digest-weekly');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
const { sendSlackDM } = require('./lib/slack');
const { collectFollowups, collectEmail, collectO3, collectCalendar } = require('./lib/digest-collectors');
const { deduplicateItems } = require('./lib/digest-item');
const { detectPatterns } = require('./lib/digest-patterns');
const { narrateWeekly, formatFallback } = require('./lib/digest-narration');
const calendarAuth = require('./calendar-auth');

const SERVICE_NAME = 'digest-weekly';
const SNAPSHOT_MAX_AGE_DAYS = 56; // 8 weeks

async function main() {
  log.info('Weekly digest starting');

  // Startup validation
  const validation = validatePrerequisites(SERVICE_NAME, [
    { type: 'database', path: reticleDb.DB_PATH, description: 'Reticle database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  const db = reticleDb.initDatabase();
  const primaryAccount = reticleDb.upsertAccount(db, {
    email: config.gmailAccount,
    provider: 'gmail',
    display_name: 'Primary',
    is_primary: 1
  });
  const accountId = primaryAccount.id;

  // Layer 1: Collect from all sources (same as daily, but full week context)
  const collectors = [
    { name: 'followup', fn: () => collectFollowups(db, accountId) },
    { name: 'email', fn: () => collectEmail(db, accountId, { vipEmails: config.vipEmails }) },
    { name: 'o3', fn: () => collectO3(db, accountId) }
  ];

  // Calendar: fetch next week's events for preview
  let calendarEvents = [];
  try {
    const calendar = await calendarAuth.getCalendarClient();
    if (calendar) {
      const now = new Date();
      // Look ahead 7 days for next-week preview
      const lookAheadEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: lookAheadEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100
      });
      calendarEvents = (response.data.items || []).filter(e => e.start.dateTime);
    }
  } catch (err) {
    log.warn({ err }, 'Calendar fetch failed — skipping calendar collector');
  }

  collectors.push({
    name: 'calendar',
    fn: () => collectCalendar(db, accountId, calendarEvents)
  });

  let allItems = [];
  const failedCollectors = [];

  for (const collector of collectors) {
    try {
      const items = collector.fn();
      allItems.push(...items);
      log.info({ collector: collector.name, count: items.length }, 'Collector completed');
    } catch (err) {
      log.error({ err, collector: collector.name }, 'Collector failed');
      failedCollectors.push(collector.name);
    }
  }

  if (allItems.length === 0 && failedCollectors.length === collectors.length) {
    await sendSlackDM('Weekly digest unavailable — all collectors failed. Check logs.');
    process.exit(1);
  }

  // Deduplicate
  allItems = deduplicateItems(allItems);
  log.info({ total: allItems.length, failed: failedCollectors }, 'Collection complete');

  // Save snapshot date (use local date to match launchd schedule timezone)
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Layer 2: Pattern detection
  let patterns = [];
  try {
    patterns = detectPatterns(db, accountId, allItems, dateStr);
  } catch (err) {
    log.warn({ err }, 'Pattern detection failed — proceeding without patterns');
  }
  log.info({ patternCount: patterns.length }, 'Pattern detection complete');

  // Layer 3: AI narration (with resilient retry)
  let message;
  let narrationSucceeded = false;
  try {
    message = await narrateWeekly(allItems, patterns);
    if (message) narrationSucceeded = true;
  } catch (err) {
    log.warn({ err }, 'First narration attempt failed');
  }

  if (!message) {
    log.warn('Retrying narration in 30s');
    await new Promise(r => setTimeout(r, 30000));
    try {
      message = await narrateWeekly(allItems, patterns);
      if (message) narrationSucceeded = true;
    } catch (err) {
      log.warn({ err }, 'Second narration attempt failed');
    }
  }

  if (!message) {
    log.warn('Narration failed — using fallback');
    message = formatFallback(allItems);
    if (patterns.length > 0) {
      message += '\n\n*Patterns detected:*\n';
      message += patterns.map(p => `• [${p.significance}] ${p.observation}`).join('\n');
    }
  }

  if (failedCollectors.length > 0) {
    message += `\n\n_Note: ${failedCollectors.join(', ')} data unavailable for this digest._`;
  }

  // Save snapshot with narration text
  reticleDb.saveSnapshot(db, accountId, {
    snapshotDate: dateStr,
    cadence: 'weekly',
    items: allItems,
    narration: message
  });

  // Deliver
  try {
    await sendSlackDM(message);
    log.info('Weekly digest delivered');
  } catch (err) {
    log.error({ err }, 'Failed to deliver digest to Slack');
    heartbeat.write(SERVICE_NAME, { status: 'degraded', error: 'slack-delivery-failed' });
    process.exit(1);
  }

  // Prune old snapshots
  try {
    reticleDb.pruneOldSnapshots(db, accountId, SNAPSHOT_MAX_AGE_DAYS);
    log.info({ maxAgeDays: SNAPSHOT_MAX_AGE_DAYS }, 'Old snapshots pruned');
  } catch (err) {
    log.warn({ err }, 'Snapshot pruning failed — non-critical, continuing');
  }

  const heartbeatStatus = narrationSucceeded ? 'ok' : 'degraded';
  const heartbeatData = { status: heartbeatStatus, metrics: { itemCount: allItems.length, patternCount: patterns.length } };
  if (!narrationSucceeded) heartbeatData.degradedReason = 'narration-unavailable';
  heartbeat.write(SERVICE_NAME, heartbeatData);
  process.exit(0);
}

main().catch(err => {
  log.fatal({ err }, 'Weekly digest crashed');
  process.exit(1);
});
