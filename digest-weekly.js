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
const { narrateWeekly, formatFallback, narrateWeeklySummary, formatWeeklySummaryFallback } = require('./lib/digest-narration');
const { collectSlackTeamChannels } = require('./lib/slack-team-collector');
const { collectJiraResolved } = require('./lib/jira-collector');
const { buildTeamsFromDB, curateForWeeklySummary } = require('./lib/digest-curation');
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

  // Layer 3: Monday Morning Meeting summary (new pipeline)
  // Collect from additional sources: Slack team channels + Jira resolved
  const weekEnd = Math.floor(today.getTime() / 1000);
  const weekStart = weekEnd - (7 * 24 * 60 * 60);
  const summarySourceWarnings = [];

  let slackTeamData = { messages: [], warnings: [], channelsRead: 0, messagesFound: 0 };
  try {
    const slackToken = config.slackBotToken;
    if (slackToken) {
      slackTeamData = await collectSlackTeamChannels(db, slackToken, weekStart, weekEnd);
      log.info({ channels: slackTeamData.channelsRead, messages: slackTeamData.messagesFound }, 'Slack team channels collected');
      summarySourceWarnings.push(...slackTeamData.warnings);
    } else {
      log.warn('Slack token not configured — skipping team channel collection');
      summarySourceWarnings.push('Slack team channels: token not configured');
    }
  } catch (err) {
    log.warn({ err }, 'Slack team channel collection failed');
    summarySourceWarnings.push('Slack team channels: collection failed');
  }

  let jiraData = { tickets: [], ktloCount: 0, warnings: [], totalResolved: 0 };
  try {
    const jiraToken = config.jiraToken;
    if (jiraToken) {
      jiraData = await collectJiraResolved(db, jiraToken, weekStart, weekEnd);
      log.info({ capability: jiraData.tickets.length, ktloStripped: jiraData.ktloCount, total: jiraData.totalResolved }, 'Jira resolved collected');
      summarySourceWarnings.push(...jiraData.warnings);
    } else {
      log.warn('Jira token not configured — skipping Jira collection');
      summarySourceWarnings.push('Jira: token not configured');
    }
  } catch (err) {
    log.warn({ err }, 'Jira collection failed');
    summarySourceWarnings.push('Jira: collection failed');
  }

  // Build team roster from DB (dynamic, not hardcoded)
  const teams = buildTeamsFromDB(db);

  // Curate all sources into team-attributed capability signals
  const curatedData = curateForWeeklySummary({
    jiraTickets: jiraData.tickets,
    slackMessages: slackTeamData.messages,
    digestItems: allItems,
    previousNotes: null // TODO: fetch from Confluence in future increment
  }, teams);

  log.info({
    cseAccomplishments: curatedData.teams?.cse?.accomplishments?.length || 0,
    desktopAccomplishments: curatedData.teams?.desktop?.accomplishments?.length || 0,
    securityAccomplishments: curatedData.teams?.security?.accomplishments?.length || 0,
    gaps: curatedData.gaps?.length || 0
  }, 'Curation complete');

  // Narrate as Monday Morning Meeting summary
  let summaryMessage;
  let summaryNarrationSucceeded = false;
  try {
    summaryMessage = await narrateWeeklySummary(curatedData, null);
    if (summaryMessage) summaryNarrationSucceeded = true;
  } catch (err) {
    log.warn({ err }, 'Summary narration failed');
  }

  if (!summaryMessage) {
    log.warn('Summary narration failed — using fallback');
    summaryMessage = formatWeeklySummaryFallback(curatedData);
  }

  // Build source availability header
  const sourceLines = [];
  sourceLines.push(`Slack (${slackTeamData.channelsRead} channels, ${slackTeamData.messagesFound} messages)`);
  sourceLines.push(`Jira (${jiraData.tickets.length} capability / ${jiraData.ktloCount} KTLO stripped / ${jiraData.totalResolved} total)`);
  sourceLines.push(`Digest collectors (${allItems.length} items)`);
  const sourceHeader = `_Sources: ${sourceLines.join(' · ')}_`;

  // Add gap markers if any team has thin signal
  let gapNotice = '';
  if (curatedData.gaps && curatedData.gaps.length > 0) {
    gapNotice = '\n\n_⚠️ ' + curatedData.gaps.join('. ') + '_';
  }

  // Add source warnings
  let warningNotice = '';
  if (summarySourceWarnings.length > 0) {
    warningNotice = '\n_' + summarySourceWarnings.join('. ') + '_';
  }

  // Compose final message: source header + summary draft + gaps + warnings
  const message = `${sourceHeader}\n\n${summaryMessage}${gapNotice}${warningNotice}`;
  const narrationSucceeded = summaryNarrationSucceeded;

  if (failedCollectors.length > 0) {
    // Note about original digest collector failures (followup, email, etc.)
    // These feed the reflection digest, not the Monday notes — but still worth noting
    log.warn({ failedCollectors }, 'Some digest collectors failed');
  }

  // Save snapshot with both items and curated data
  reticleDb.saveSnapshot(db, accountId, {
    snapshotDate: dateStr,
    cadence: 'weekly',
    items: allItems,
    narration: summaryMessage,
    curatedItems: JSON.stringify(curatedData)
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
  const heartbeatData = { status: heartbeatStatus, checkInterval: 7 * 24 * 60 * 60 * 1000, metrics: { itemCount: allItems.length, patternCount: patterns.length } };
  if (!narrationSucceeded) heartbeatData.degradedReason = 'narration-unavailable';
  heartbeat.write(SERVICE_NAME, heartbeatData);
  process.exit(0);
}

main().catch(err => {
  log.fatal({ err }, 'Weekly digest crashed');
  process.exit(1);
});
