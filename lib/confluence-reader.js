'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('confluence-reader');

const CONFLUENCE_SPACE = 'EMGT';

// --- Ordinal date formatting ---

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Get the ordinal suffix for a day number.
 * @param {number} day
 * @returns {string} 'st', 'nd', 'rd', or 'th'
 */
function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Format a date as an ordinal date string matching Confluence page titles.
 * e.g. "March 9th, 2026"
 *
 * @param {Date} date
 * @returns {string}
 */
function formatOrdinalDate(date) {
  const month = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month} ${day}${ordinalSuffix(day)}, ${year}`;
}

/**
 * Get the previous Monday's date (7 days before the most recent Monday).
 * Used to find the previous week's Confluence page.
 *
 * When run on a Monday (the typical digest run day), this returns the Monday
 * 7 days prior — the date of last week's Monday Morning Meeting notes.
 *
 * @param {Date} today
 * @returns {Date}
 */
function getPreviousMondayDate(today) {
  const d = new Date(today);
  // dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat
  const dayOfWeek = d.getDay();
  // Days since the most recent Monday (including today if today is Monday)
  const daysSinceMonday = (dayOfWeek === 0) ? 6 : dayOfWeek - 1;
  // Go to the most recent Monday
  d.setDate(d.getDate() - daysSinceMonday);
  // Then go back 7 more days to get the previous Monday
  d.setDate(d.getDate() - 7);
  return d;
}

/**
 * Build a CQL query to find a Confluence page by space and date title.
 *
 * @param {string} spaceKey
 * @param {Date} targetDate
 * @returns {string}
 */
function buildCQL(spaceKey, targetDate) {
  const title = formatOrdinalDate(targetDate);
  return `space = "${spaceKey}" AND title = "${title}" AND type = page`;
}

// --- HTML extraction ---

/**
 * Extract the Digital Workplace section from Confluence page HTML.
 * Looks for an h2 containing "Digital Workplace" (with or without bold tags)
 * and returns everything until the next h2.
 *
 * Returns the extracted content as cleaned-up text (HTML tags stripped,
 * headings and list items preserved with simple formatting).
 *
 * @param {string} html - The page body HTML
 * @returns {string|null} The DW section text, or null if not found
 */
function extractDWSection(html) {
  // Find the start of the Digital Workplace h2 heading
  // Matches: <h2>Digital Workplace</h2> or <h2><strong>Digital Workplace</strong></h2>
  const dwPattern = /<h2[^>]*>\s*(?:<[^>]+>\s*)*Digital\s+Workplace\s*(?:<\/[^>]+>\s*)*<\/h2>/i;
  const match = dwPattern.exec(html);
  if (!match) return null;

  // Content starts after the matched h2 tag
  const startIdx = match.index + match[0].length;

  // Find the next h2 tag (end of DW section)
  const nextH2 = /<h2[\s>]/i;
  const endMatch = nextH2.exec(html.slice(startIdx));
  const endIdx = endMatch ? startIdx + endMatch.index : html.length;

  const sectionHtml = html.slice(startIdx, endIdx).trim();

  // Convert HTML to readable text
  return htmlToText(sectionHtml);
}

/**
 * Convert HTML to clean readable text.
 * Preserves heading structure and list items.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  let text = html;

  // Convert headings to markdown-style
  text = text.replace(/<h3[^>]*>(?:<[^>]+>)*(.*?)(?:<\/[^>]+>)*<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>(?:<[^>]+>)*(.*?)(?:<\/[^>]+>)*<\/h4>/gi, '\n#### $1\n');

  // Convert list items to bullets
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Normalize whitespace: collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// --- Confluence API ---

/**
 * Make a GET request to the Confluence REST API.
 *
 * @param {string} apiPath - Path relative to the Confluence API base
 * @param {Object} [params] - Query parameters
 * @returns {Promise<Object>} Parsed JSON response
 */
function confluenceGet(apiPath, params = {}) {
  const token = config.jiraApiToken;
  const email = config.jiraUserEmail;
  const baseUrl = config.jiraBaseUrl;

  if (!token || !email || !baseUrl) {
    return Promise.reject(new Error('Confluence/Atlassian credentials not configured (jiraApiToken, jiraUserEmail, jiraBaseUrl)'));
  }

  const auth = 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
  const url = new URL(baseUrl);
  const query = new URLSearchParams(params).toString();
  const fullPath = `/wiki/rest/api/${apiPath}${query ? '?' + query : ''}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: fullPath,
      method: 'GET',
      headers: {
        'Authorization': auth,
        'Accept': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Confluence API error (${res.statusCode}): ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Confluence response parse error: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Search Confluence using CQL.
 *
 * @param {string} cql - CQL query string
 * @returns {Promise<Object[]>} Array of content results
 */
async function searchConfluence(cql) {
  const res = await confluenceGet('content/search', {
    cql,
    limit: '5'
  });
  return res.results || [];
}

/**
 * Fetch a Confluence page body by content ID.
 *
 * @param {string} contentId
 * @returns {Promise<string>} Page body HTML (view representation)
 */
async function fetchPageBody(contentId) {
  const res = await confluenceGet(`content/${contentId}`, {
    expand: 'body.view'
  });
  return res.body?.view?.value || '';
}

/**
 * Fetch the previous week's Digital Workplace section from Confluence.
 *
 * Searches for the Monday Morning Meeting page matching the previous Monday's
 * ordinal date, fetches it, and extracts the DW section.
 *
 * @param {Date} [today] - Current date (for testability; defaults to now)
 * @returns {Promise<{notes: string|null, pageTitle: string|null, warning: string|null}>}
 */
async function fetchPreviousWeekNotes(today = new Date()) {
  const previousMonday = getPreviousMondayDate(today);
  const pageTitle = formatOrdinalDate(previousMonday);
  const cql = buildCQL(CONFLUENCE_SPACE, previousMonday);

  log.info({ pageTitle, cql }, 'Searching Confluence for previous week notes');

  try {
    const results = await searchConfluence(cql);

    if (results.length === 0) {
      log.warn({ pageTitle }, 'Confluence page not found for previous Monday');
      return { notes: null, pageTitle, warning: `Confluence page "${pageTitle}" not found` };
    }

    const page = results[0];
    const contentId = page.id;

    log.info({ contentId, title: page.title }, 'Found Confluence page');

    const bodyHtml = await fetchPageBody(contentId);
    if (!bodyHtml) {
      log.warn({ contentId }, 'Confluence page body is empty');
      return { notes: null, pageTitle, warning: `Confluence page "${pageTitle}" has no content` };
    }

    const dwSection = extractDWSection(bodyHtml);
    if (!dwSection) {
      log.warn({ contentId, pageTitle }, 'Digital Workplace section not found in page');
      return { notes: null, pageTitle, warning: `Digital Workplace section not found in "${pageTitle}"` };
    }

    log.info({ pageTitle, chars: dwSection.length }, 'Confluence previous notes fetched');
    return { notes: dwSection, pageTitle, warning: null };

  } catch (err) {
    log.warn({ err, pageTitle }, 'Confluence fetch failed');
    return { notes: null, pageTitle, warning: `Confluence fetch failed: ${err.message}` };
  }
}

module.exports = {
  formatOrdinalDate,
  extractDWSection,
  buildCQL,
  getPreviousMondayDate,
  fetchPreviousWeekNotes,
  htmlToText,
};
