// lib/heartbeat.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HEARTBEAT_DIR = process.env.CLAUDIA_HEARTBEAT_DIR ||
  path.join(os.homedir(), '.claudia', 'heartbeats');

// Staleness multiplier: if lastCheck is older than checkInterval * this, service is unresponsive
const STALE_MULTIPLIER = 3;

function ensureDir() {
  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
}

function filePath(serviceName) {
  return path.join(HEARTBEAT_DIR, `${serviceName}.json`);
}

function write(serviceName, { checkInterval, status = 'ok', errors = null, metrics = null }) {
  ensureDir();
  const data = {
    service: serviceName,
    pid: process.pid,
    startedAt: write._startedAt || (write._startedAt = Date.now()),
    lastCheck: Date.now(),
    uptime: Math.round(process.uptime()),
    checkInterval,
    status,
    errors: errors || { lastError: null, lastErrorAt: null, countSinceStart: 0 },
    metrics: metrics || {}
  };
  const target = filePath(serviceName);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target);
}

function read(serviceName) {
  try {
    const raw = fs.readFileSync(filePath(serviceName), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readAll() {
  ensureDir();
  const results = [];
  for (const file of fs.readdirSync(HEARTBEAT_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(HEARTBEAT_DIR, file), 'utf8');
      results.push(JSON.parse(raw));
    } catch {
      // Skip corrupt/partial files
    }
  }
  return results;
}

function evaluate(heartbeatData) {
  if (!heartbeatData) {
    return { health: 'unknown', error: 'No heartbeat file found', errorCount: 0 };
  }

  if (heartbeatData.status === 'startup-failed') {
    return {
      health: 'startup-failed',
      error: heartbeatData.errors ? heartbeatData.errors.lastError : 'Unknown startup error',
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  if (heartbeatData.status === 'error') {
    return {
      health: 'error',
      error: heartbeatData.errors ? heartbeatData.errors.lastError : null,
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  if (heartbeatData.status === 'degraded') {
    return {
      health: 'degraded',
      error: heartbeatData.errors ? heartbeatData.errors.lastError : null,
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  if (heartbeatData.status === 'shutting-down') {
    return { health: 'shutting-down', error: null, errorCount: 0 };
  }

  // Check staleness
  const age = Date.now() - heartbeatData.lastCheck;
  const threshold = heartbeatData.checkInterval * STALE_MULTIPLIER;
  if (age > threshold) {
    return {
      health: 'unresponsive',
      error: `No heartbeat for ${Math.round(age / 60000)} minutes (expected every ${Math.round(heartbeatData.checkInterval / 60000)} min)`,
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  return {
    health: 'healthy',
    error: null,
    errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
  };
}

module.exports = { write, read, readAll, evaluate, HEARTBEAT_DIR };
