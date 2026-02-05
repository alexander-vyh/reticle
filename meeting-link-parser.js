#!/usr/bin/env node
'use strict';

// Patterns ordered by specificity - check location first (more reliable),
// then description. Within each field, order: zoom > meet > teams.
const PATTERNS = {
  zoom: /https?:\/\/[a-z0-9.-]*zoom\.us\/[^\s<>"')]+/i,
  meet: /https?:\/\/meet\.google\.com\/[^\s<>"')]+/i,
  teams: /https?:\/\/teams\.microsoft\.com\/[^\s<>"')]+/i
};

/**
 * Extract meeting link from a Google Calendar event.
 * Checks location first (more reliable), then description.
 * Falls back to calendar event URL if no meeting link found.
 *
 * @param {Object} event - Calendar event with description, location, htmlLink
 * @returns {{ platform: string, url: string }}
 */
function extractMeetingLink(event) {
  const location = event.location || '';
  const description = event.description || '';

  // Check location first (usually more reliable/intentional)
  for (const [platform, pattern] of Object.entries(PATTERNS)) {
    const match = location.match(pattern);
    if (match) return { platform, url: match[0] };
  }

  // Then check description
  for (const [platform, pattern] of Object.entries(PATTERNS)) {
    const match = description.match(pattern);
    if (match) return { platform, url: match[0] };
  }

  // Fallback to calendar event URL
  return { platform: 'calendar', url: event.htmlLink };
}

module.exports = { extractMeetingLink, PATTERNS };
