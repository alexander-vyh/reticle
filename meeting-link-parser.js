#!/usr/bin/env node
'use strict';

// Patterns ordered by specificity - check location first (more reliable),
// then description. Within each field, order: zoom > meet > teams.
const PATTERNS = {
  zoom: /https?:\/\/(?:[a-z0-9-]+\.)*zoom\.us\/[^\s<>"')]+/i,
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
  // Check conferenceData first (most authoritative — set by calendar add-ons)
  if (event.conferenceData && event.conferenceData.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
    if (videoEntry && videoEntry.uri) {
      for (const [platform, pattern] of Object.entries(PATTERNS)) {
        if (pattern.test(videoEntry.uri)) return { platform, url: videoEntry.uri };
      }
      // Video entry exists but doesn't match known patterns — use it anyway
      const name = (event.conferenceData.conferenceSolution && event.conferenceData.conferenceSolution.name) || 'video';
      return { platform: name.toLowerCase().split(' ')[0], url: videoEntry.uri };
    }
  }

  // Check hangoutLink (older Google Meet integration)
  if (event.hangoutLink) {
    return { platform: 'meet', url: event.hangoutLink };
  }

  const location = event.location || '';
  const description = event.description || '';

  // Check location (usually more reliable/intentional)
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
