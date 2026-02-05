#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_PATH = path.join(process.env.HOME, '.openclaw/workspace/meeting-cache.json');
const DEFAULT_STATE_PATH = path.join(process.env.HOME, '.openclaw/workspace/alert-state.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OVERLAP_THRESHOLD_MS = 2 * 60 * 1000;

function saveCache(events, cachePath) {
  cachePath = cachePath || DEFAULT_CACHE_PATH;
  const data = { timestamp: Date.now(), events: events };
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  return data;
}

function loadCache(cachePath) {
  cachePath = cachePath || DEFAULT_CACHE_PATH;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function isCacheValid(cacheData) {
  if (!cacheData || !cacheData.timestamp) return false;
  return (Date.now() - cacheData.timestamp) < CACHE_MAX_AGE_MS;
}

function recordAlert(eventId, level, statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  const state = loadAlertState(statePath);
  if (!state[eventId]) state[eventId] = {};
  state[eventId][level] = Date.now();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function hasAlerted(eventId, level, statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  const state = loadAlertState(statePath);
  return !!(state[eventId] && state[eventId][level]);
}

function loadAlertState(statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function getUpcomingMeetings(events, minutesAhead) {
  const now = Date.now();
  const cutoff = now + minutesAhead * 60 * 1000;
  return events
    .filter(event => {
      const start = new Date(event.start.dateTime || event.start.date).getTime();
      return start > now && start <= cutoff;
    })
    .sort((a, b) => {
      const aStart = new Date(a.start.dateTime || a.start.date).getTime();
      const bStart = new Date(b.start.dateTime || b.start.date).getTime();
      return aStart - bStart;
    });
}

function groupOverlappingMeetings(events) {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => {
    const aStart = new Date(a.start.dateTime || a.start.date).getTime();
    const bStart = new Date(b.start.dateTime || b.start.date).getTime();
    return aStart - bStart;
  });
  const groups = [];
  let currentGroup = {
    startTime: new Date(sorted[0].start.dateTime || sorted[0].start.date).getTime(),
    meetings: [sorted[0]]
  };
  for (let i = 1; i < sorted.length; i++) {
    const eventStart = new Date(sorted[i].start.dateTime || sorted[i].start.date).getTime();
    if (eventStart - currentGroup.startTime <= OVERLAP_THRESHOLD_MS) {
      currentGroup.meetings.push(sorted[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = { startTime: eventStart, meetings: [sorted[i]] };
    }
  }
  groups.push(currentGroup);
  return groups;
}

function cleanupAlertState(events, statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  const state = loadAlertState(statePath);
  const activeEventIds = new Set(events.map(e => e.id));
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const eventId of Object.keys(state)) {
    if (!activeEventIds.has(eventId)) {
      const alerts = state[eventId];
      const allOld = Object.values(alerts).every(ts => ts < cutoff);
      if (allOld) delete state[eventId];
    }
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

module.exports = {
  saveCache, loadCache, isCacheValid,
  recordAlert, hasAlerted, loadAlertState,
  getUpcomingMeetings, groupOverlappingMeetings, cleanupAlertState,
  DEFAULT_CACHE_PATH, DEFAULT_STATE_PATH, CACHE_MAX_AGE_MS, OVERLAP_THRESHOLD_MS
};
