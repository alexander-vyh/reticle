'use strict';

/**
 * Parse a From header into structured parts.
 *
 * Handles: "Display Name <email@domain.com>", bare "email@domain.com",
 *          quoted names like '"Last, First" <email>', MIME-encoded names.
 *
 * @param {string} fromHeader - Raw From header value
 * @returns {{ email: string, domain: string, display: string }}
 */
function parseSenderEmail(fromHeader) {
  if (!fromHeader) return { email: '', domain: '', display: '' };

  const raw = fromHeader.trim();

  // Try "Display Name <email>" or "<email>" format
  const angleMatch = raw.match(/<([^>]+)>/);
  if (angleMatch) {
    const email = angleMatch[1].trim().toLowerCase();
    const domain = email.split('@')[1] || '';

    // Everything before the angle bracket is the display name
    let display = raw.substring(0, raw.indexOf('<')).trim();

    // Strip surrounding quotes
    display = display.replace(/^["']|["']$/g, '');

    // Decode MIME-encoded words (=?charset?encoding?text?=)
    display = decodeMimeWords(display);

    if (!display) display = email;
    return { email, domain, display };
  }

  // Bare email address (no angle brackets)
  const bareEmail = raw.toLowerCase();
  const domain = bareEmail.split('@')[1] || '';
  return { email: bareEmail, domain, display: raw };
}

/**
 * Decode RFC 2047 MIME-encoded words in a display name.
 * e.g. "=?UTF-8?B?Sm9obg==?=" → "John"
 */
function decodeMimeWords(text) {
  return text.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (match, charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(encoded, 'base64').toString('utf-8');
      }
      if (encoding.toUpperCase() === 'Q') {
        const decoded = encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
        return decoded;
      }
    } catch { /* fall through */ }
    return match;
  });
}

/**
 * Format a rule DB row into a human-readable description.
 * e.g. "FROM noreply@jira.com AND TO dl-team@company.com"
 */
function formatRuleDescription(rule) {
  const parts = [];
  if (rule.match_from) parts.push(`FROM ${rule.match_from}`);
  if (rule.match_from_domain) parts.push(`FROM DOMAIN @${rule.match_from_domain}`);
  if (rule.match_to) parts.push(`TO ${rule.match_to}`);
  if (rule.match_subject_contains) parts.push(`SUBJECT contains "${rule.match_subject_contains}"`);
  return parts.join(' AND ');
}

module.exports = { parseSenderEmail, formatRuleDescription };
