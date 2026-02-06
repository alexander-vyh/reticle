#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');

// macOS app names for platform-specific launching
const PLATFORM_APPS = {
  zoom: 'zoom.us.app',
  meet: 'Google Chrome',
  teams: 'Microsoft Teams'
};

const JOIN_LABELS = {
  zoom: 'Join Zoom',
  meet: 'Join Meet',
  teams: 'Join Teams',
  calendar: 'Open in Calendar'
};

/**
 * Get the launch arguments for opening a meeting URL.
 * Returns { command, args } for use with execFile (shell-safe).
 * Also provides a display string for logging.
 *
 * @param {string} platform - 'zoom', 'meet', 'teams', 'calendar', or other
 * @param {string} url - Meeting URL
 * @returns {{ command: string, args: string[], display: string }}
 */
function getLaunchCommand(platform, url) {
  const app = PLATFORM_APPS[platform];
  if (app) {
    return {
      command: 'open',
      args: ['-a', app, url],
      display: `open -a "${app}" "${url}"`
    };
  }
  return {
    command: 'open',
    args: [url],
    display: `open "${url}"`
  };
}

/**
 * Launch a meeting in the appropriate app.
 * Uses execFile (not exec) to avoid shell injection.
 *
 * @param {string} platform - 'zoom', 'meet', 'teams', 'calendar', or other
 * @param {string} url - Meeting URL
 * @returns {Promise<void>}
 */
function launchMeeting(platform, url) {
  return new Promise((resolve, reject) => {
    const cmd = getLaunchCommand(platform, url);
    console.log(`Launching: ${cmd.display}`);
    execFile(cmd.command, cmd.args, (error) => {
      if (error) {
        console.error(`Launch failed: ${error.message}`);
        // Fallback: try default browser (also via execFile for safety)
        execFile('open', [url], (fallbackError) => {
          if (fallbackError) reject(fallbackError);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Get the label for the Join button based on platform.
 *
 * @param {string} platform
 * @returns {string}
 */
function getJoinLabel(platform) {
  return JOIN_LABELS[platform] || 'Join Meeting';
}

module.exports = { getLaunchCommand, launchMeeting, getJoinLabel, PLATFORM_APPS };
