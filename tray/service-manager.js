'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HEARTBEAT_DIR = path.join(os.homedir(), '.config', 'claudia', 'heartbeats');

// Map launchd labels to heartbeat service names
const HEARTBEAT_NAMES = {
  'ai.claudia.gmail-monitor': 'gmail-monitor',
  'ai.claudia.slack-events': 'slack-events',
  'ai.claudia.meeting-alerts': 'meeting-alerts',
  'ai.claudia.followup-checker': 'followup-checker',
  'ai.openclaw.gateway': null,  // Gateway doesn't write heartbeats (yet)
};

const SERVICES = [
  { label: 'Gmail Monitor',      launchdLabel: 'ai.claudia.gmail-monitor' },
  { label: 'Slack Events',       launchdLabel: 'ai.claudia.slack-events' },
  { label: 'Meeting Alerts',     launchdLabel: 'ai.claudia.meeting-alerts' },
  { label: 'Follow-up Checker',  launchdLabel: 'ai.claudia.followup-checker' },
  { label: 'Gateway',            launchdLabel: 'ai.openclaw.gateway' },
];

function parseLaunchctlList(output) {
  const map = {};
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 3) continue;
    const [pidStr, exitStr, label] = parts;
    if (label === 'Label') continue;
    map[label] = {
      pid: pidStr === '-' ? null : parseInt(pidStr, 10),
      exitCode: parseInt(exitStr, 10)
    };
  }
  return map;
}

function statusFromEntry(entry) {
  if (!entry) return 'unloaded';
  if (entry.pid) return 'running';
  return entry.exitCode === 0 ? 'stopped' : 'error';
}

let cachedUID = null;
function getUID() {
  if (!cachedUID) cachedUID = execSync('id -u', { encoding: 'utf8' }).trim();
  return cachedUID;
}

function readHeartbeat(launchdLabel) {
  const name = HEARTBEAT_NAMES[launchdLabel];
  if (!name) return null;
  try {
    const raw = fs.readFileSync(path.join(HEARTBEAT_DIR, `${name}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function evaluateHeartbeat(hb) {
  if (!hb) return { health: 'unknown', detail: null, errorCount: 0 };
  if (hb.status === 'startup-failed') {
    return { health: 'startup-failed', detail: hb.errors ? hb.errors.lastError : 'Unknown error', errorCount: 0 };
  }
  if (hb.status === 'error' || hb.status === 'degraded') {
    return { health: hb.status, detail: hb.errors ? hb.errors.lastError : null, errorCount: hb.errors ? hb.errors.countSinceStart : 0 };
  }
  if (hb.status === 'shutting-down') {
    return { health: 'shutting-down', detail: null, errorCount: 0 };
  }
  const age = Date.now() - hb.lastCheck;
  if (age > hb.checkInterval * 3) {
    return { health: 'unresponsive', detail: `No heartbeat for ${Math.round(age / 60000)}m`, errorCount: 0 };
  }
  return { health: 'healthy', detail: null, errorCount: hb.errors ? hb.errors.countSinceStart : 0 };
}

function getStatuses() {
  let output;
  try {
    output = execSync('launchctl list', { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return SERVICES.map(s => ({ ...s, status: 'unknown', pid: null, exitCode: null, heartbeat: null, heartbeatHealth: null }));
  }
  const parsed = parseLaunchctlList(output);
  return SERVICES.map(svc => {
    const entry = parsed[svc.launchdLabel];
    const hb = readHeartbeat(svc.launchdLabel);
    const hbHealth = evaluateHeartbeat(hb);
    return {
      ...svc,
      status: statusFromEntry(entry),
      pid: entry ? entry.pid : null,
      exitCode: entry ? entry.exitCode : null,
      heartbeat: hb,
      heartbeatHealth: hbHealth
    };
  });
}

function startService(launchdLabel) {
  execSync(`launchctl kickstart gui/${getUID()}/${launchdLabel}`, { timeout: 5000 });
}

function stopService(launchdLabel) {
  execSync(`launchctl kill SIGTERM gui/${getUID()}/${launchdLabel}`, { timeout: 5000 });
}

function restartService(launchdLabel) {
  execSync(`launchctl kickstart -k gui/${getUID()}/${launchdLabel}`, { timeout: 5000 });
}

module.exports = { SERVICES, parseLaunchctlList, statusFromEntry, getStatuses, startService, stopService, restartService, readHeartbeat, evaluateHeartbeat };
