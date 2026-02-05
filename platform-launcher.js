#!/usr/bin/env node
'use strict';

const { exec } = require('child_process');

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
 * Get the shell command to launch a meeting (without executing it).
 * Useful for testing and logging.
 *
 * @param {string} platform - 'zoom', 'meet', 'teams', 'calendar', or other
 * @param {string} url - Meeting URL
 * @returns {string} Shell command
 */
function getLaunchCommand(platform, url) {
  const app = PLATFORM_APPS[platform];
  if (app) {
    return `open -a "${app}" "${url}"`;
  }
  return `open "${url}"`;
}

/**
 * Launch a meeting in the appropriate app.
 *
 * @param {string} platform - 'zoom', 'meet', 'teams', 'calendar', or other
 * @param {string} url - Meeting URL
 * @returns {Promise<void>}
 */
function launchMeeting(platform, url) {
  return new Promise((resolve, reject) => {
    const command = getLaunchCommand(platform, url);
    console.log(`Launching: ${command}`);
    exec(command, (error) => {
      if (error) {
        console.error(`Launch failed: ${error.message}`);
        // Fallback: try default browser
        exec(`open "${url}"`, (fallbackError) => {
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
