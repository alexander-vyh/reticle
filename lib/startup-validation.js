// lib/startup-validation.js
'use strict';

const fs = require('fs');
const heartbeat = require('./heartbeat');

/**
 * Validate service prerequisites before entering the main loop.
 *
 * @param {string} serviceName - Service name for heartbeat file
 * @param {Array} checks - Array of { type: 'file'|'database', path: string, description: string }
 * @returns {{ errors: string[] }} - Empty errors array means all checks passed
 */
function validatePrerequisites(serviceName, checks) {
  const errors = [];

  for (const check of checks) {
    if (check.type === 'file') {
      if (!fs.existsSync(check.path)) {
        errors.push(`Missing ${check.description}: ${check.path}`);
      }
    } else if (check.type === 'database') {
      try {
        // Lazy-load to avoid requiring the native addon in services with no DB checks
        const Database = require('better-sqlite3');
        const db = new Database(check.path, { readonly: true });
        const result = db.pragma('quick_check');
        db.close();
        if (!result || result[0]?.quick_check !== 'ok') {
          errors.push(`${check.description} integrity check failed: ${JSON.stringify(result)}`);
        }
      } catch (e) {
        errors.push(`${check.description} error: ${e.message}`);
      }
    }
  }

  if (errors.length > 0) {
    heartbeat.write(serviceName, {
      checkInterval: 0,
      status: 'startup-failed',
      errors: {
        lastError: errors.join('; '),
        lastErrorAt: Date.now(),
        countSinceStart: errors.length
      }
    });
  }

  return { errors };
}

module.exports = { validatePrerequisites };
