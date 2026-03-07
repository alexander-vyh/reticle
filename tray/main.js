'use strict';

const { app, Tray, Menu, Notification, shell, dialog } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const serviceManager = require('./service-manager');
const icons = require('./icons');

const configDir = process.env.RETICLE_CONFIG_DIR || path.join(os.homedir(), '.reticle', 'config');
let gatewayPort = 3001;
let feedbackConfig = { weeklyTarget: 3 };
try {
  const secrets = JSON.parse(fs.readFileSync(path.join(configDir, 'secrets.json'), 'utf-8'));
  if (secrets.gatewayPort) gatewayPort = secrets.gatewayPort;
  const team = JSON.parse(fs.readFileSync(path.join(configDir, 'team.json'), 'utf-8'));
  if (team.feedback) feedbackConfig = team.feedback;
} catch {}

const RECORDER_PORT = 9847;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

const STATUS_EMOJI = {
  running: '🟢', stopped: '⚫', error: '🔴', unloaded: '⚪', unknown: '❓',
  unresponsive: '🟡', degraded: '🟡', 'startup-failed': '🔴'
};

function getEffectiveStatus(svc) {
  if (svc.status !== 'running') return svc.status;
  if (!svc.heartbeatHealth) return 'running';
  const hh = svc.heartbeatHealth.health;
  if (hh === 'healthy') return 'running';
  if (hh === 'unresponsive' || hh === 'startup-failed' || hh === 'error') return hh;
  if (hh === 'degraded') return 'degraded';
  return 'running';
}

// Project root (where log files live) -- resolve from app path or fallback
const PROJECT_DIR = path.resolve(__dirname, '..');

let tray = null;
let previousStatuses = {};
let iconCache = {};
let spinInterval = null;
let lastNotificationTime = {};
const NOTIFICATION_COOLDOWN = 15 * 60 * 1000; // 15 minutes

// Recorder session state — polled every 5s, used synchronously in buildMenu
let recorderStatus = null;

function recorderHttp(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: RECORDER_PORT, path, method,
      headers: bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function pollRecorderStatus() {
  try {
    recorderStatus = await recorderHttp('GET', '/status');
  } catch {
    recorderStatus = null;
  }
  refreshStatus();
}

// Feedback stats — polled every 60s, used synchronously in buildMenu
let feedbackMenuItems = [{ label: '  Feedback: loading...', enabled: false }];

async function getFeedbackMenu() {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${gatewayPort}/feedback/stats`, (r) => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(); } });
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    const { weekly } = res;
    const items = [];
    const target = feedbackConfig.weeklyTarget || 3;

    for (const name of Object.keys(weekly || {})) {
      const w = weekly[name] || { delivered: 0 };
      const bar = '\u2588'.repeat(Math.min(w.delivered, target)) + '\u2500'.repeat(Math.max(0, target - w.delivered));
      items.push({ label: `  ${name}  ${bar} ${w.delivered}/${target}`, enabled: false });
    }

    if (items.length === 0) {
      items.push({ label: '  No feedback data yet', enabled: false });
    }

    return items;
  } catch {
    return [{ label: '  Feedback unavailable', enabled: false }];
  }
}

async function pollFeedbackStats() {
  feedbackMenuItems = await getFeedbackMenu();
  refreshStatus(); // rebuild menu with updated data
}

async function stopRecording() {
  try { await recorderHttp('POST', '/stop', { meetingId: 'manual-stop' }); } catch {}
  setTimeout(pollRecorderStatus, 800);
}

async function startRecordingNow() {
  const now = new Date();
  const meetingId = `manual-${now.toISOString().replace(/[:.]/g, '-')}`;
  try {
    await recorderHttp('POST', '/start', {
      meetingId,
      title: 'Manual Recording',
      attendees: [],
      startTime: now.toISOString(),
      endTime: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()
    });
  } catch {}
  setTimeout(pollRecorderStatus, 800);
}

function getIcon(name) {
  if (!iconCache[name]) iconCache[name] = icons[name]();
  return iconCache[name];
}

function getAggregateIcon(statuses) {
  const persistent = statuses.filter(s => !s.scheduled);
  const effectives = persistent.map(s => getEffectiveStatus(s));
  if (effectives.some(e => e === 'error' || e === 'stopped' || e === 'startup-failed')) return getIcon('red');
  if (effectives.some(e => e === 'unresponsive' || e === 'degraded')) return getIcon('yellow');
  if (effectives.every(e => e === 'running' || e === 'unloaded' || e === 'unknown')) return getIcon('green');
  return getIcon('yellow');
}

function buildRecordingItems() {
  const rs = recorderStatus;
  if (!rs) {
    return [
      { label: '⚫  Recorder: offline', enabled: false },
      { type: 'separator' }
    ];
  }
  if (rs.recording) {
    const mins = rs.duration != null ? Math.round(rs.duration / 60) : 0;
    const title = (rs.title || 'Unknown Meeting').slice(0, 40);
    return [
      { label: `⏺  ${title}  (${mins}m)`, enabled: false },
      { label: 'Stop Recording', click: () => stopRecording() },
      { type: 'separator' }
    ];
  }
  return [
    { label: '○  Recorder: idle', enabled: false },
    { label: 'Start Recording Now', click: () => startRecordingNow() },
    { type: 'separator' }
  ];
}

function buildMenu(statuses) {
  const runningCount = statuses.filter(s => s.status === 'running').length;

  const serviceItems = statuses.map(svc => {
    const effective = getEffectiveStatus(svc);
    const emoji = STATUS_EMOJI[effective] || '❓';
    const isRunning = svc.status === 'running';

    let detail = '';
    if (isRunning && svc.heartbeat) {
      const age = Math.round((Date.now() - svc.heartbeat.lastCheck) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
      detail = `PID ${svc.pid}, last check ${ageStr}`;
      if (svc.heartbeatHealth && svc.heartbeatHealth.errorCount > 0) {
        detail += `, ${svc.heartbeatHealth.errorCount} errors`;
      }
    } else if (isRunning) {
      detail = `PID ${svc.pid}`;
    } else if (effective === 'startup-failed' && svc.heartbeatHealth) {
      detail = svc.heartbeatHealth.detail || 'startup failed';
    } else if (svc.exitCode != null && svc.status === 'error') {
      detail = `exit ${svc.exitCode}`;
    }

    return {
      label: `${emoji}  ${svc.label}${detail ? '  (' + detail + ')' : ''}`,
      submenu: [
        {
          label: isRunning ? 'Stop' : 'Start',
          click: () => {
            try {
              if (isRunning) serviceManager.stopService(svc.launchdLabel);
              else serviceManager.startService(svc.launchdLabel);
            } catch (e) {}
            setTimeout(refreshStatus, 1500);
          }
        },
        {
          label: 'Restart',
          enabled: isRunning,
          click: () => {
            try { serviceManager.restartService(svc.launchdLabel); } catch (e) {}
            setTimeout(refreshStatus, 1500);
          }
        }
      ]
    };
  });

  return Menu.buildFromTemplate([
    ...buildRecordingItems(),
    { label: `Reticle — ${runningCount}/${statuses.length} running`, enabled: false },
    { type: 'separator' },
    ...serviceItems,
    { type: 'separator' },
    { label: '── Feedback ──', enabled: false },
    ...feedbackMenuItems,
    { type: 'separator' },
    {
      label: 'Start All',
      click: () => {
        for (const s of statuses) {
          if (s.status !== 'running') {
            try { serviceManager.startService(s.launchdLabel); } catch (e) {}
          }
        }
        setTimeout(refreshStatus, 2000);
      }
    },
    {
      label: 'Stop All',
      click: () => {
        for (const s of statuses) {
          if (s.status === 'running') {
            try { serviceManager.stopService(s.launchdLabel); } catch (e) {}
          }
        }
        setTimeout(refreshStatus, 2000);
      }
    },
    { type: 'separator' },
    {
      label: 'Open Logs Folder',
      click: () => shell.openPath(PROJECT_DIR)
    },
    { type: 'separator' },
    { label: 'Quit Reticle', click: () => app.quit() }
  ]);
}

function refreshStatus() {
  const statuses = serviceManager.getStatuses();

  // Don't override the icon while spinning — animation owns the image
  if (!spinInterval) tray.setImage(getAggregateIcon(statuses));
  const runningCount = statuses.filter(s => s.status === 'running').length;
  tray.setToolTip(`Reticle — ${runningCount}/${statuses.length} services running`);
  tray.setContextMenu(buildMenu(statuses));

  // Smart notifications with dedup cooldown
  for (const svc of statuses) {
    const effective = getEffectiveStatus(svc);
    const prevEffective = previousStatuses[svc.launchdLabel];
    const now = Date.now();
    const lastNotif = lastNotificationTime[svc.launchdLabel] || 0;

    // State transition notifications
    if (prevEffective && prevEffective !== effective) {
      if (['error', 'stopped', 'unresponsive', 'startup-failed'].includes(effective)) {
        const body = svc.heartbeatHealth && svc.heartbeatHealth.detail
          ? svc.heartbeatHealth.detail
          : (svc.exitCode ? `Exit code ${svc.exitCode}` : 'Service stopped.');
        new Notification({
          title: `Reticle: ${svc.label} — ${effective}`,
          body
        }).show();
        lastNotificationTime[svc.launchdLabel] = now;
      } else if (['error', 'unresponsive', 'startup-failed', 'stopped'].includes(prevEffective) && effective === 'running') {
        new Notification({
          title: `Reticle: ${svc.label} recovered`,
          body: 'Service is running normally again.'
        }).show();
        lastNotificationTime[svc.launchdLabel] = now;
      }
    }

    // Persistent problem reminder (every 15 min)
    if (['error', 'unresponsive', 'startup-failed'].includes(effective) &&
        (now - lastNotif > NOTIFICATION_COOLDOWN) && prevEffective === effective) {
      new Notification({
        title: `Reticle: ${svc.label} still ${effective}`,
        body: (svc.heartbeatHealth && svc.heartbeatHealth.detail) || 'Check logs for details.'
      }).show();
      lastNotificationTime[svc.launchdLabel] = now;
    }
  }

  // Store effective status for next comparison
  previousStatuses = {};
  for (const svc of statuses) previousStatuses[svc.launchdLabel] = getEffectiveStatus(svc);
}

const SPIN_FRAMES = 12;
const SPIN_INTERVAL_MS = 80;
const STAR_COLORS = { green: 'none', yellow: '#FFC107', red: '#F44336' };

/**
 * Start spinning the inner arcs in the tray icon.
 * Call only when explicit activity is happening (deploy, restart).
 * @param {'green'|'yellow'|'red'} status - Current status color name
 */
function startSpinning(status) {
  if (spinInterval) return; // already spinning

  const color = STAR_COLORS[status] || STAR_COLORS.yellow;
  const frames = [];
  for (let i = 0; i < SPIN_FRAMES; i++) {
    frames.push(icons.frame(color, (360 / SPIN_FRAMES) * i));
  }

  let frameIdx = 0;
  spinInterval = setInterval(() => {
    if (tray) tray.setImage(frames[frameIdx]);
    frameIdx = (frameIdx + 1) % SPIN_FRAMES;
  }, SPIN_INTERVAL_MS);
}

/**
 * Stop spinning and return to the static status icon.
 */
function stopSpinning() {
  if (!spinInterval) return;
  clearInterval(spinInterval);
  spinInterval = null;
  // Restore the static icon for current status
  refreshStatus();
}

async function promptLoginItem() {
  const flagFile = path.join(app.getPath('userData'), '.login-item-prompted');
  if (fs.existsSync(flagFile)) return;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Yes', 'No'],
    defaultId: 0,
    title: 'Reticle',
    message: 'Start Reticle automatically at login?',
    detail: 'Reticle monitors your background services. Starting at login keeps the menu bar icon available whenever you\'re logged in.'
  });

  if (response === 0) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  fs.writeFileSync(flagFile, JSON.stringify({ asked: true, enabled: response === 0 }));
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();

  tray = new Tray(getIcon('yellow'));
  tray.setToolTip('Reticle — loading...');

  refreshStatus();
  setInterval(refreshStatus, 10 * 1000);

  // Recorder session polling (independent of service status)
  pollRecorderStatus();
  setInterval(pollRecorderStatus, 5 * 1000);

  // Feedback stats polling
  pollFeedbackStats();
  setInterval(pollFeedbackStats, 60 * 1000);

  await promptLoginItem();
});

app.on('window-all-closed', (e) => e.preventDefault());
