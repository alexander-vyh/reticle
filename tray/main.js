'use strict';

const { app, Tray, Menu, Notification, shell } = require('electron');
const path = require('path');
const serviceManager = require('./service-manager');
const icons = require('./icons');

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

function getIcon(name) {
  if (!iconCache[name]) iconCache[name] = icons[name]();
  return iconCache[name];
}

function getAggregateIcon(statuses) {
  const effectives = statuses.map(s => getEffectiveStatus(s));
  if (effectives.some(e => e === 'error' || e === 'stopped' || e === 'startup-failed')) return getIcon('red');
  if (effectives.some(e => e === 'unresponsive' || e === 'degraded')) return getIcon('yellow');
  if (effectives.every(e => e === 'running')) return getIcon('green');
  return getIcon('yellow');
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
    { label: `Claudia — ${runningCount}/${statuses.length} running`, enabled: false },
    { type: 'separator' },
    ...serviceItems,
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
    { label: 'Quit Claudia', click: () => app.quit() }
  ]);
}

function refreshStatus() {
  const statuses = serviceManager.getStatuses();

  // Don't override the icon while spinning — animation owns the image
  if (!spinInterval) tray.setImage(getAggregateIcon(statuses));
  const runningCount = statuses.filter(s => s.status === 'running').length;
  tray.setToolTip(`Claudia — ${runningCount}/${statuses.length} services running`);
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
          title: `Claudia: ${svc.label} — ${effective}`,
          body
        }).show();
        lastNotificationTime[svc.launchdLabel] = now;
      } else if (['error', 'unresponsive', 'startup-failed', 'stopped'].includes(prevEffective) && effective === 'running') {
        new Notification({
          title: `Claudia: ${svc.label} recovered`,
          body: 'Service is running normally again.'
        }).show();
        lastNotificationTime[svc.launchdLabel] = now;
      }
    }

    // Persistent problem reminder (every 15 min)
    if (['error', 'unresponsive', 'startup-failed'].includes(effective) &&
        (now - lastNotif > NOTIFICATION_COOLDOWN) && prevEffective === effective) {
      new Notification({
        title: `Claudia: ${svc.label} still ${effective}`,
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
const STAR_COLORS = { green: '#4CAF50', yellow: '#FFC107', red: '#F44336' };

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

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  tray = new Tray(getIcon('yellow'));
  tray.setToolTip('Claudia — loading...');

  refreshStatus();
  setInterval(refreshStatus, 10 * 1000);
});

app.on('window-all-closed', (e) => e.preventDefault());
