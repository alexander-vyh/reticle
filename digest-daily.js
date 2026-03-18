'use strict';

const config = require('./lib/config');
const reticleDb = require('./reticle-db');
const log = require('./lib/logger')('digest-daily');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
const { sendSlackDM } = require('./lib/slack');
const { collectFollowups, collectEmail, collectO3, collectCalendar, collectCommitments } = require('./lib/digest-collectors');
const { deduplicateItems } = require('./lib/digest-item');
const { narrateDaily, formatFallback } = require('./lib/digest-narration');
const calendarAuth = require('./calendar-auth');
const { collectFeedback } = require('./lib/feedback-collector');
const { buildFeedbackBlocks } = require('./lib/feedback-blocks');
const peopleStore = require('./lib/people-store');

const SERVICE_NAME = 'digest-daily';

async function main() {
  log.info('Daily digest starting');

  // Skip Friday if weekly digest covers it
  const today = new Date();
  if (today.getDay() === 5) {
    log.info('Skipping daily digest on Friday — weekly digest covers it');
    process.exit(0);
  }

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

  // Layer 1: Collect from all sources
  const collectors = [
    { name: 'followup', fn: () => collectFollowups(db, accountId) },
    { name: 'email', fn: () => collectEmail(db, accountId, { vipEmails: config.vipEmails }) },
    { name: 'o3', fn: () => collectO3(db, accountId) }
  ];

  // Calendar collector needs API call
  let calendarEvents = [];
  try {
    const calendar = await calendarAuth.getCalendarClient();
    if (calendar) {
      const now = new Date();
      // Look ahead 48h to cover tomorrow's full day even if digest runs early
      const lookAheadEnd = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: lookAheadEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50
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

  // Expire stale conversations before collecting — prevents noise accumulation
  const expiredCount = reticleDb.expireStaleConversations(db, accountId, { maxAgeDays: 7 });
  if (expiredCount > 0) {
    log.info({ expiredCount }, 'Expired stale conversations before collection');
  }

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

  // Feedback collector (async — separate from sync collectors)
  let feedbackItems = [];
  try {
    const slackIdMap = peopleStore.getSlackIdMap(db);
    feedbackItems = await collectFeedback(slackIdMap, { scanWindowHours: 24 });
    log.info({ count: feedbackItems.length }, 'Feedback collector complete');
  } catch (err) {
    log.error({ err }, 'Feedback collector failed');
    failedCollectors.push('feedback');
  }

  // Persist feedback candidates for gateway/Reticle access
  for (const item of feedbackItems) {
    db.prepare(`
      INSERT OR IGNORE INTO feedback_candidates
        (account_id, report_name, channel, raw_artifact, draft, feedback_type, entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, item.counterparty, item.authority,
        item.rawArtifact, item.feedbackDraft, item.feedbackType, item.entityId);
  }

  // Commitments collector (uses org-memory DB)
  try {
    const { initDatabase: initOrgMemory } = require('./lib/org-memory-db');
    const orgMemDb = initOrgMemory();
    const commitmentItems = collectCommitments(orgMemDb);
    allItems.push(...commitmentItems);
    log.info({ count: commitmentItems.length }, 'Commitments collector complete');
  } catch (err) {
    log.error({ err }, 'Commitments collector failed');
    failedCollectors.push('commitments');
  }

  if (allItems.length === 0 && failedCollectors.length === collectors.length) {
    await sendSlackDM('Daily digest unavailable — all collectors failed. Check logs.');
    process.exit(1);
  }

  // Deduplicate
  allItems = deduplicateItems(allItems);
  log.info({ total: allItems.length, failed: failedCollectors }, 'Collection complete');

  // Snapshot date (use local date to match launchd schedule timezone)
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Separate feedback items from regular digest items for narration
  const regularItems = allItems.filter(i => i.collector !== 'feedback');

  // Cap items for narration — prioritize high/critical, suppress low-priority overflow
  const MAX_NARRATION_ITEMS = 15;
  const priorityOrder = ['critical', 'high', 'normal', 'low'];
  const sortedItems = [...regularItems].sort((a, b) => {
    const ai = priorityOrder.indexOf(a.priority);
    const bi = priorityOrder.indexOf(b.priority);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const narrationItems = sortedItems.slice(0, MAX_NARRATION_ITEMS);
  const suppressedCount = regularItems.length - narrationItems.length;
  if (suppressedCount > 0) {
    log.info({ suppressedCount, total: regularItems.length }, 'Suppressed low-priority items from narration');
  }

  // Layer 3: AI narration
  let message;
  let narrationSucceeded = false;
  try {
    message = await narrateDaily(narrationItems);
    if (message) narrationSucceeded = true;
  } catch (err) {
    log.warn({ err }, 'First narration attempt failed');
  }

  if (!message) {
    log.warn('Retrying narration in 30s');
    await new Promise(r => setTimeout(r, 30000));
    try {
      message = await narrateDaily(narrationItems);
      if (message) narrationSucceeded = true;
    } catch (err) {
      log.warn({ err }, 'Second narration attempt failed');
    }
  }

  if (!message) {
    log.warn('Narration failed — using fallback');
    message = formatFallback(narrationItems);
  }

  // Add suppression note
  if (suppressedCount > 0) {
    message += `\n\n_${suppressedCount} lower-priority items suppressed._`;
  }

  // Add note about failed collectors
  if (failedCollectors.length > 0) {
    message += `\n\n_Note: ${failedCollectors.join(', ')} data unavailable for this digest._`;
  }

  if (feedbackItems.length > 0) {
    message += `\n\n:pencil: *${feedbackItems.length} feedback candidate${feedbackItems.length > 1 ? 's' : ''} waiting* — open Reticle to review`;
  }

  // Save snapshot with narration text
  reticleDb.saveSnapshot(db, accountId, {
    snapshotDate: dateStr,
    cadence: 'daily',
    items: allItems,
    narration: message
  });

  const feedbackBlocks = buildFeedbackBlocks(feedbackItems);

  // Deliver
  try {
    await sendSlackDM(message, feedbackBlocks.length > 0 ? feedbackBlocks : null);
    log.info('Daily digest delivered');
  } catch (err) {
    log.error({ err }, 'Failed to deliver digest to Slack');
    heartbeat.write(SERVICE_NAME, { status: 'degraded', error: 'slack-delivery-failed' });
    process.exit(1);
  }

  const heartbeatStatus = narrationSucceeded ? 'ok' : 'degraded';
  const heartbeatData = { status: heartbeatStatus, checkInterval: 24 * 60 * 60 * 1000, metrics: { itemCount: allItems.length } };
  if (!narrationSucceeded) heartbeatData.degradedReason = 'narration-unavailable';
  heartbeat.write(SERVICE_NAME, heartbeatData);
  process.exit(0);
}

main().catch(err => {
  log.fatal({ err }, 'Daily digest crashed');
  process.exit(1);
});
