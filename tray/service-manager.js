'use strict';

const { execSync } = require('child_process');

const SERVICES = [
  { label: 'Meeting Alerts',   launchdLabel: 'com.openclaw.meeting-alerts' },
  { label: 'Meeting Recorder', launchdLabel: 'ai.openclaw.meeting-recorder' },
  { label: 'Gmail Monitor',    launchdLabel: 'ai.openclaw.gmail-monitor' },
  { label: 'Slack Monitor',    launchdLabel: 'ai.openclaw.slack-monitor' },
  { label: 'Slack Events',     launchdLabel: 'ai.openclaw.slack-events' },
  { label: 'Gateway',          launchdLabel: 'ai.openclaw.gateway' },
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

function getStatuses() {
  let output;
  try {
    output = execSync('launchctl list', { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return SERVICES.map(s => ({ ...s, status: 'unknown', pid: null, exitCode: null }));
  }
  const parsed = parseLaunchctlList(output);
  return SERVICES.map(svc => {
    const entry = parsed[svc.launchdLabel];
    return {
      ...svc,
      status: statusFromEntry(entry),
      pid: entry ? entry.pid : null,
      exitCode: entry ? entry.exitCode : null
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

module.exports = { SERVICES, parseLaunchctlList, statusFromEntry, getStatuses, startService, stopService, restartService };
