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
const { fetchPreviousWeekNotes } = require('./lib/confluence-reader');
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
    log.warn({ err }, 'Calendar fetch failed \u2014 skipping calendar collector');
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
    await sendSlackDM('Weekly digest unavailable \u2014 all collectors failed. Check logs.');
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
    log.warn({ err }, 'Pattern detection failed \u2014 proceeding without patterns');
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
      log.warn('Slack token not configured \u2014 skipping team channel collection');
      summarySourceWarnings.push('Slack team channels: token not configured');
    }
  } catch (err) {
    log.warn({ err }, 'Slack team channel collection failed');
    summarySourceWarnings.push('Slack team channels: collection failed');
  }

  let jiraData = { tickets: [], ktloCount: 0, warnings: [], totalResolved: 0 };
  try {
    const jiraToken = config.jiraToken || config.jiraApiToken;
    if (jiraToken) {
      jiraData = await collectJiraResolved(db, jiraToken, weekStart, weekEnd);
      log.info({ capability: jiraData.tickets.length, ktloStripped: jiraData.ktloCount, total: jiraData.totalResolved }, 'Jira resolved collected');
      summarySourceWarnings.push(...jiraData.warnings);
    } else {
      log.warn('Jira token not configured \u2014 skipping Jira collection');
      summarySourceWarnings.push('Jira: token not configured');
    }
  } catch (err) {
    log.warn({ err }, 'Jira collection failed');
    summarySourceWarnings.push('Jira: collection failed');
  }

  // Abort-and-notify: if BOTH primary sources returned zero qualifying items
  if (slackTeamData.messagesFound === 0 && jiraData.tickets.length === 0) {
    log.warn('No qualifying activity from Slack or Jira \u2014 aborting');
    await sendSlackDM('Weekly summary unavailable \u2014 no qualifying activity found for the week. Manual process required.');

    // Still save snapshot for record
    reticleDb.saveSnapshot(db, accountId, {
      snapshotDate: dateStr,
      cadence: 'weekly',
      items: allItems,
      narration: null,
      curatedItems: JSON.stringify({ sections: [], unassigned: [], gaps: [], secondaryKtloCount: 0 })
    });

    heartbeat.write(SERVICE_NAME, { status: 'degraded', degradedReason: 'no-qualifying-activity' });
    process.exit(0);
  }

  // Build team roster from DB (dynamic, not hardcoded)
  const teams = buildTeamsFromDB(db);

  // Fetch previous week's notes from Confluence for continuity context
  let previousNotes = null;
  let continuitySource = null;
  try {
    const confluenceResult = await fetchPreviousWeekNotes(today);
    if (confluenceResult.notes) {
      previousNotes = confluenceResult.notes;
      continuitySource = 'Confluence';
      log.info({ pageTitle: confluenceResult.pageTitle }, 'Confluence previous notes fetched from ' + confluenceResult.pageTitle);
    } else {
      // Confluence fetch succeeded but no DW section found \u2014 fall back to stored snapshot
      log.warn({ warning: confluenceResult.warning }, 'Confluence fetch did not return DW section \u2014 falling back to stored snapshot');
      const latestSnapshot = reticleDb.getLatestSnapshot(db, 'weekly');
      if (latestSnapshot && latestSnapshot.narration) {
        previousNotes = latestSnapshot.narration;
        continuitySource = 'stored snapshot';
        summarySourceWarnings.push('Continuity: using stored snapshot (Confluence unavailable)');
        log.info({ snapshotDate: latestSnapshot.snapshot_date }, 'Using stored snapshot narration for continuity');
      } else {
        summarySourceWarnings.push(confluenceResult.warning || 'Continuity: no previous notes available');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Confluence fetch failed \u2014 falling back to stored snapshot');
    const latestSnapshot = reticleDb.getLatestSnapshot(db, 'weekly');
    if (latestSnapshot && latestSnapshot.narration) {
      previousNotes = latestSnapshot.narration;
      continuitySource = 'stored snapshot';
      summarySourceWarnings.push('Continuity: using stored snapshot (Confluence unavailable)');
      log.info({ snapshotDate: latestSnapshot.snapshot_date }, 'Using stored snapshot narration for continuity');
    } else {
      summarySourceWarnings.push('Continuity: no previous notes available (Confluence and snapshot both unavailable)');
    }
  }

  // Curate all sources into team-attributed capability signals
  // (curateForWeeklySummary now handles object-format sources, secondary KTLO
  //  filtering, gap threshold detection, and source traceability)
  const curatedData = curateForWeeklySummary({
    jiraTickets: jiraData.tickets,
    slackMessages: slackTeamData.messages,
    digestItems: allItems,
  }, teams);

  const totalCuratedItems = curatedData.sections.reduce((sum, s) => sum + s.items.length, 0);
  log.info({
    sections: curatedData.sections.length,
    totalItems: totalCuratedItems,
    unassigned: curatedData.unassigned.length,
    secondaryKtloFiltered: curatedData.secondaryKtloCount,
    gaps: curatedData.gaps?.length || 0,
    hasContinuityContext: !!previousNotes
  }, 'Curation complete');

  // Narrate as Monday Morning Meeting summary
  let summaryMessage;
  let summaryNarrationSucceeded = false;
  try {
    summaryMessage = await narrateWeeklySummary(curatedData, previousNotes);
    if (summaryMessage) summaryNarrationSucceeded = true;
  } catch (err) {
    log.warn({ err }, 'Summary narration failed');
  }

  if (!summaryMessage) {
    log.warn('Summary narration failed \u2014 using fallback');
    summaryMessage = formatWeeklySummaryFallback(curatedData);
  }

  // Build metadata header \u2014 signal quality, not raw counts
  const metadataLines = [];

  // Source line: show active channels and capability/maintenance split
  const sourceLineParts = [];
  const slackStrategy = slackTeamData.strategy || 'sweep';
  sourceLineParts.push(`Slack (${slackTeamData.channelsRead} channels, ${slackStrategy})`);
  const ktloTotal = jiraData.ktloCount + curatedData.secondaryKtloCount;
  sourceLineParts.push(`Jira (${jiraData.tickets.length} capability / ${ktloTotal} maintenance excluded)`);
  metadataLines.push(`_Sources: ${sourceLineParts.join(' \u00B7 ')}_`);

  // Status check: verified Done count
  const verifiedCount = jiraData.tickets.length;
  if (verifiedCount > 0) {
    metadataLines.push(`_Status check: ${verifiedCount}/${verifiedCount} capability tickets verified Done_`);
  }

  // Gap markers BEFORE content (not after)
  if (curatedData.gaps && curatedData.gaps.length > 0) {
    for (const gap of curatedData.gaps) {
      metadataLines.push(`_\u26A0\uFE0F ${gap}_`);
    }
  }

  // Continuity note
  if (continuitySource) {
    metadataLines.push(`_Continuity: previous week fetched from ${continuitySource}_`);
  }

  // Source warnings (collection failures, missing tokens)
  if (summarySourceWarnings.length > 0) {
    for (const warning of summarySourceWarnings) {
      metadataLines.push(`_${warning}_`);
    }
  }

  // Delimiter with explicit paste instruction
  metadataLines.push('');
  metadataLines.push('_Delete everything above the line before copying to Confluence._');
  metadataLines.push('\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014');

  // Compose final message: metadata header + delimiter + narrated draft
  const message = `${metadataLines.join('\n')}\n\n${summaryMessage}`;
  const narrationSucceeded = summaryNarrationSucceeded;

  if (failedCollectors.length > 0) {
    // Note about original digest collector failures (followup, email, etc.)
    // These feed the reflection digest, not the Monday notes \u2014 but still worth noting
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
    log.warn({ err }, 'Snapshot pruning failed \u2014 non-critical, continuing');
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
