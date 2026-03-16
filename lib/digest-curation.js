'use strict';

// lib/digest-curation.js
// Intelligence layer that curates raw signals from multiple sources into
// team-attributed, cross-referenced capability signals for the Monday Morning
// Meeting weekly summary.

// ============================================================================
// Team structure
// ============================================================================

const TEAMS = {
  cse: {
    name: 'Corporate Systems Engineering',
    members: ['Aragorn King', 'Samwise Brown', 'Gandalf Grey'],
    slackIds: ['U0412G376E9', 'U0A0UJ35KE2', 'U08HWQZRCR4'],
    emails: ['billp@example.com', 'daniel.richardson@example.com', 'kinski.wu@example.com'],
    projects: ['okta-terraform', 'identity-management', 'sso-integrations', 'jira-automation', 'saas-provisioning']
  },
  desktop: {
    name: 'Desktop Support',
    members: ['Faramir Guard', 'Eowyn Rider'],
    slackIds: ['U070SD8QX39', 'UJNCSLVTK'],
    emails: ['keshon.bowman@example.com', 'kennethd@example.com'],
    projects: ['hardware-lifecycle', 'onboarding-offboarding', 'endpoint-support', 'asset-management']
  },
  security: {
    name: 'Security (Platform & Endpoint)',
    members: ['Gimli Stone', 'Legolas Wood'],
    slackIds: ['U071J4P5SDD', 'ULPLLCRQF'],
    emails: ['daniel.sherr@example.com', 'geoffrey@example.com'],
    projects: ['ztd', 'zero-touch-deployment', 'jamfpro-terraform', 'crowdstrike', 'perimeter81', 'endpoint-security', 'device-naming']
  }
};

// ============================================================================
// Topic detection patterns
// ============================================================================

const TOPIC_PATTERNS = {
  terraform: {
    keywords: [/\bterraform\b/i, /\bTF\b/, /\bimport\b/i, /\bdrift\b/i],
    // Component names from Jira that map to this topic
    components: ['okta-terraform', 'jamfpro-terraform']
  },
  ztd: {
    keywords: [/\bzero[\s-]?touch\b/i, /\bZTD\b/, /\bfirst[\s-]?deployment\b/i],
    components: ['ZTD', 'ztd', 'zero-touch-deployment']
  },
  'identity-sso': {
    keywords: [/\bSSO\b/i, /\bSAML\b/i, /\bOkta\b/i, /\bidentity\b/i],
    components: ['identity-management', 'sso-integrations']
  },
  jamfpro: {
    keywords: [/\bJamf\s?Pro\b/i, /\bJamf\b/i, /\bJAMF\b/],
    components: ['jamfpro-terraform']
  },
  'hardware-lifecycle': {
    keywords: [/\bonboard\b/i, /\boffboard\b/i, /\bnew\s+hire\b/i, /\bhardware\b/i, /\basset\b/i],
    components: ['hardware-lifecycle', 'onboarding-offboarding', 'asset-management']
  },
  'endpoint-security': {
    keywords: [/\bCrowdStrike\b/i, /\bPerimeter\s?81\b/i, /\bendpoint\s+security\b/i, /\bDruva\b/i, /\bbackup\b/i],
    components: ['crowdstrike', 'perimeter81', 'endpoint-security']
  },
  'device-naming': {
    keywords: [/\bdevice[\s-]?naming\b/i, /\bnaming\s+convention\b/i],
    components: ['device-naming']
  }
};

// Regex for Slack messages that indicate work completion/validation.
// Shared between capability framing and signal classification.
const COMPLETION_RE = /confirm|validated?|successful|complete|finish|resolved/i;

// Cross-team attribution overrides. When a signal matches one of these topics,
// attribute it to the specified team regardless of who authored it.
const TOPIC_TEAM_OVERRIDES = {
  ztd: 'security',
  jamfpro: 'security',
  'identity-sso': 'cse',
  terraform: null // no override — use author's team or component team
};

// ============================================================================
// Team identification
// ============================================================================

/**
 * Identify which team a person belongs to.
 * @param {string|null} name - Person's display name
 * @param {string|null} slackId - Person's Slack user ID
 * @param {string|null} email - Person's email
 * @returns {string|null} Team key or null
 */
function identifyTeam(name, slackId, email) {
  for (const [teamKey, team] of Object.entries(TEAMS)) {
    if (name && team.members.includes(name)) return teamKey;
    if (slackId && team.slackIds.includes(slackId)) return teamKey;
    if (email && team.emails.includes(email.toLowerCase())) return teamKey;
  }
  return null;
}

// ============================================================================
// Topic identification
// ============================================================================

/**
 * Extract topic tags from text content and optional Jira components.
 * @param {string} text - Text to analyze
 * @param {string[]} [components] - Optional Jira component names
 * @returns {string[]} Array of matching topic keys
 */
function identifyTopics(text, components) {
  const matched = new Set();

  for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
    // Check keywords against text
    for (const re of pattern.keywords) {
      if (re.test(text)) {
        matched.add(topic);
        break;
      }
    }

    // Check Jira components
    if (components && pattern.components) {
      for (const comp of components) {
        if (pattern.components.includes(comp)) {
          matched.add(topic);
          break;
        }
      }
    }
  }

  return Array.from(matched);
}

// ============================================================================
// Signal normalization
// ============================================================================

/**
 * Convert raw source items into normalized signal objects.
 * Each signal has: type, text, team, topics, status, key, author
 */
function normalizeSignals(sources) {
  const signals = [];

  // Jira tickets
  for (const ticket of (sources.jiraTickets || [])) {
    const team = ticket.team || identifyTeam(ticket.assignee);
    const topics = identifyTopics(ticket.summary, ticket.components);

    signals.push({
      type: 'jira',
      text: ticket.summary,
      team,
      topics,
      status: ticket.status,
      key: ticket.key,
      resolvedDate: ticket.resolvedDate,
      author: ticket.assignee
    });
  }

  // Slack messages
  for (const msg of (sources.slackMessages || [])) {
    const team = msg.authorTeam || identifyTeam(msg.author);
    const topics = identifyTopics(msg.content);

    signals.push({
      type: 'slack',
      text: msg.content,
      team,
      topics,
      author: msg.author,
      channel: msg.channel,
      date: msg.date
    });
  }

  // Confluence pages
  for (const page of (sources.confluencePages || [])) {
    const team = identifyTeam(page.author);
    const topics = identifyTopics(page.title);

    signals.push({
      type: 'confluence',
      text: page.title,
      team,
      topics,
      author: page.author,
      date: page.lastModified
    });
  }

  // DigestItems from existing collectors
  for (const item of (sources.digestItems || [])) {
    const team = item.counterparty ? identifyTeam(item.counterparty) : null;
    const topics = identifyTopics(item.observation);

    signals.push({
      type: 'digest',
      text: item.observation,
      team,
      topics,
      author: item.counterparty,
      category: item.category,
      priority: item.priority
    });
  }

  return signals;
}

// ============================================================================
// Signal grouping
// ============================================================================

/**
 * Group signals by topic. Signals with multiple topics are assigned to the
 * most specific topic (fewest total signals in that topic group) to avoid
 * duplication. Signals with no topics become ungrouped.
 *
 * @param {Object[]} signals - Normalized signals with topics arrays
 * @returns {Object[]} Array of { topic, team, signals }
 */
function groupSignals(signals) {
  // First pass: count how many signals each topic has (for specificity ranking)
  const topicCounts = new Map();
  for (const sig of signals) {
    for (const topic of sig.topics) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }

  // Second pass: assign each signal to its most specific topic
  const groups = new Map(); // topic -> { signals, teamVotes }

  for (const sig of signals) {
    if (sig.topics.length === 0) continue;

    // Pick the most specific topic (fewest total signals)
    // If counts are equal, prefer topics with team overrides (more meaningful)
    let bestTopic = sig.topics[0];
    let bestCount = topicCounts.get(bestTopic) || Infinity;

    for (const topic of sig.topics) {
      const count = topicCounts.get(topic) || 0;
      if (count < bestCount) {
        bestCount = count;
        bestTopic = topic;
      }
    }

    if (!groups.has(bestTopic)) {
      groups.set(bestTopic, { signals: [], teamVotes: new Map() });
    }

    const group = groups.get(bestTopic);
    group.signals.push(sig);

    if (sig.team) {
      group.teamVotes.set(sig.team, (group.teamVotes.get(sig.team) || 0) + 1);
    }
  }

  // Resolve team attribution for each group
  const result = [];
  for (const [topic, group] of groups) {
    // Check for topic-level team override
    let team = TOPIC_TEAM_OVERRIDES[topic] || null;

    if (!team) {
      // Use majority vote from signals
      let maxVotes = 0;
      for (const [t, count] of group.teamVotes) {
        if (count > maxVotes) {
          maxVotes = count;
          team = t;
        }
      }
    }

    result.push({
      topic,
      team,
      signals: group.signals
    });
  }

  return result;
}

// ============================================================================
// Capability framing
// ============================================================================

/**
 * Convert a signal group into a capability-advancement statement.
 * @param {Object} group - { topic, team, signals }
 * @returns {Object} { signal, sources, confidence }
 */
function frameCababilitySignal(group) {
  const { signals } = group;

  // Determine the framing verb based on signal types present
  const hasResolved = signals.some(s => s.type === 'jira' && s.status === 'Done');
  const hasConfluence = signals.some(s => s.type === 'confluence');
  const hasSlackConfirmation = signals.some(s =>
    s.type === 'slack' && COMPLETION_RE.test(s.text)
  );

  // Build the capability statement
  let verb;
  if (hasResolved && hasSlackConfirmation) {
    verb = 'Completed and validated';
  } else if (hasResolved) {
    verb = 'Completed';
  } else if (hasSlackConfirmation) {
    verb = 'Validated';
  } else if (hasConfluence) {
    verb = 'Documented';
  } else {
    verb = 'Advanced';
  }

  // Pick the best description text — prefer Jira summary (most structured),
  // then Slack content (most descriptive), then Confluence title
  const jiraSignal = signals.find(s => s.type === 'jira');
  const slackSignal = signals.find(s => s.type === 'slack');
  const confSignal = signals.find(s => s.type === 'confluence');

  let description;
  if (jiraSignal) {
    description = jiraSignal.text;
  } else if (slackSignal) {
    // Truncate slack messages to reasonable length
    description = slackSignal.text.length > 100
      ? slackSignal.text.substring(0, 97) + '...'
      : slackSignal.text;
  } else if (confSignal) {
    description = confSignal.text;
  } else {
    description = signals[0].text;
  }

  const signal = `${verb}: ${description}`;

  // Build source references
  const sources = signals.map(s => {
    if (s.type === 'jira' && s.key) return `Jira ${s.key}`;
    if (s.type === 'slack') return `Slack (${s.author || 'unknown'})`;
    if (s.type === 'confluence') return `Confluence: ${s.text}`;
    if (s.type === 'digest') return `Digest: ${s.category || 'item'}`;
    return s.type;
  });

  // Confidence: more source types = higher confidence
  const sourceTypes = new Set(signals.map(s => s.type));
  const confidence = Math.min(1.0, 0.3 + (sourceTypes.size * 0.2) + (signals.length * 0.05));

  return { signal, sources, confidence };
}

// ============================================================================
// Continuity detection
// ============================================================================

/**
 * Parse previous week's notes and check which items have current signal coverage.
 * Items without coverage are flagged for follow-up.
 *
 * @param {string} previousNotes - Text from previous week's DW section
 * @param {Object[]} currentGroups - Signal groups from this week
 * @returns {Object[]} Array of { item, status, team }
 */
function detectContinuityItems(previousNotes, currentGroups) {
  if (!previousNotes || previousNotes.trim().length === 0) return [];

  const continuity = [];

  // Extract line items from the previous notes
  const lines = previousNotes.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-') || l.startsWith('*'));

  // Get all topics covered by current signals
  const coveredTopics = new Set(currentGroups.map(g => g.topic));

  for (const line of lines) {
    // Clean up markdown bullets and bold markers
    const cleanLine = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
    if (!cleanLine) continue;

    // Try to identify the team this line refers to
    let lineTeam = null;
    if (/^CSE:/i.test(cleanLine)) lineTeam = 'cse';
    else if (/^Desktop/i.test(cleanLine)) lineTeam = 'desktop';
    else if (/^Security/i.test(cleanLine)) lineTeam = 'security';
    else if (/^Hiring/i.test(cleanLine)) lineTeam = null; // cross-cutting

    // Extract the topics mentioned in this line
    const lineTopics = identifyTopics(cleanLine);

    // Check if any topic in this line has current-week coverage
    const hasCoverage = lineTopics.some(t => coveredTopics.has(t));

    // Special handling: check for non-topic keywords that indicate ongoing items
    const isHiring = /\bhiring\b|\breq\b|\bsourcing\b|\bcandidate\b|\binterview\b/i.test(cleanLine);
    const isInProgress = /\bin\s+progress\b|\bplanned\b|\binvestigating\b|\bspike\b/i.test(cleanLine);

    // Flag items that: (a) have no current signal coverage, or (b) are hiring-related,
    // or (c) were explicitly "in progress" last week (multi-week items need tracking).
    if (!hasCoverage || isHiring || isInProgress) {
      let status;
      if (isHiring) {
        status = 'no signal this week — verify status';
      } else if (isInProgress && hasCoverage) {
        status = 'still in progress';
      } else if (isInProgress) {
        status = 'no signal this week — verify status';
      } else {
        status = 'no signal this week — verify status';
      }

      continuity.push({
        item: cleanLine,
        status,
        team: lineTeam
      });
    }
  }

  return continuity;
}

// ============================================================================
// Gap detection
// ============================================================================

/**
 * Identify teams with thin signal coverage.
 * @param {Object} teams - The teams output object
 * @returns {string[]} Array of gap descriptions
 */
function detectGaps(teams) {
  const gaps = [];

  for (const [teamKey, team] of Object.entries(teams)) {
    const teamName = TEAMS[teamKey] ? TEAMS[teamKey].name : teamKey;
    const accCount = team.accomplishments.length;

    if (accCount < 2) {
      if (accCount === 0) {
        gaps.push(`${teamName} (${teamKey}): no accomplishment signals this week — review needed`);
      } else {
        gaps.push(`${teamName} (${teamKey}): only ${accCount} accomplishment signal — may need additional context`);
      }
    }
  }

  return gaps;
}

// ============================================================================
// Executive summary generation
// ============================================================================

/**
 * Build the executive summary from curated team data.
 * @param {Object} teams - Curated team data
 * @param {Object[]} signalGroups - All signal groups
 * @returns {Object} { stability, highlights, riskPosture }
 */
function buildExecutiveSummary(teams, signalGroups) {
  // Stability: true if no critical/high priority signals indicate breakage
  // and at least some teams have accomplishments
  const totalAccomplishments = Object.values(teams).reduce(
    (sum, t) => sum + t.accomplishments.length, 0
  );
  const stability = totalAccomplishments > 0;

  // Highlights: pick the top 1-2 capability signals with highest confidence
  const allAccomplishments = [];
  for (const [teamKey, team] of Object.entries(teams)) {
    for (const acc of team.accomplishments) {
      allAccomplishments.push({ ...acc, teamKey });
    }
  }

  // Sort by confidence descending, take top 2
  allAccomplishments.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const highlights = allAccomplishments
    .slice(0, 2)
    .map(a => a.signal);

  // Risk posture: compare in-progress items and any risk signals
  const totalInProgress = Object.values(teams).reduce(
    (sum, t) => sum + t.inProgress.length, 0
  );

  let riskPosture = 'unchanged';
  if (totalAccomplishments > totalInProgress * 2) {
    riskPosture = 'reduced'; // closing more than opening
  } else if (totalInProgress > totalAccomplishments * 2) {
    riskPosture = 'elevated'; // many open items relative to closes
  }

  return { stability, highlights, riskPosture };
}

// ============================================================================
// Main curation function
// ============================================================================

/**
 * Curate raw signals from multiple sources into a structured weekly summary.
 *
 * @param {Object} sources
 * @param {Object[]} sources.jiraTickets
 * @param {Object[]} sources.slackMessages
 * @param {Object[]} sources.confluencePages
 * @param {Object[]} sources.digestItems
 * @param {Object[]} sources.meetingMetadata
 * @param {string} sources.previousNotes
 * @returns {Object} Curated summary with teams, executiveSummary, gaps, continuity
 */
function curateForWeeklySummary(sources) {
  // 1. Normalize all signals
  const allSignals = normalizeSignals(sources);

  // 2. Group signals by topic
  const signalGroups = groupSignals(allSignals);

  // 3. Build team-level output
  const teams = {
    cse: { accomplishments: [], inProgress: [], hiring: null },
    desktop: { accomplishments: [], inProgress: [], hiring: null },
    security: { accomplishments: [], inProgress: [], hiring: null }
  };

  // Track which signals have been assigned to groups (for ungrouped handling)
  const groupedSignalSet = new Set();
  for (const group of signalGroups) {
    for (const sig of group.signals) {
      groupedSignalSet.add(sig);
    }
  }

  // Process grouped signals into team accomplishments/inProgress.
  // When a group has both resolved and in-progress signals, split them so
  // accomplishments and in-progress items are reported separately.
  for (const group of signalGroups) {
    const teamKey = group.team;
    if (!teamKey || !teams[teamKey]) continue;

    // Classify each signal as resolved or in-progress
    const resolvedSignals = [];
    const inProgressSignals = [];
    const supportingSignals = []; // slack confirmations, confluence docs

    for (const sig of group.signals) {
      if (sig.type === 'jira' && sig.status === 'Done') {
        resolvedSignals.push(sig);
      } else if (sig.type === 'jira' && sig.status !== 'Done') {
        inProgressSignals.push(sig);
      } else if (sig.type === 'slack' && COMPLETION_RE.test(sig.text)) {
        resolvedSignals.push(sig);
      } else {
        supportingSignals.push(sig);
      }
    }

    // If we have both resolved and in-progress, create separate entries
    if (resolvedSignals.length > 0 && inProgressSignals.length > 0) {
      // Accomplishment: resolved signals + supporting signals
      const accFramed = frameCababilitySignal({
        topic: group.topic,
        team: teamKey,
        signals: [...resolvedSignals, ...supportingSignals]
      });
      teams[teamKey].accomplishments.push(accFramed);

      // In-progress: remaining signals
      const ipFramed = frameCababilitySignal({
        topic: group.topic,
        team: teamKey,
        signals: inProgressSignals
      });
      teams[teamKey].inProgress.push(ipFramed);
    } else if (resolvedSignals.length > 0) {
      // All resolved
      const framed = frameCababilitySignal(group);
      teams[teamKey].accomplishments.push(framed);
    } else {
      // All in-progress or supporting
      const framed = frameCababilitySignal(group);
      teams[teamKey].inProgress.push(framed);
    }
  }

  // Handle ungrouped signals (no matching topic)
  for (const sig of allSignals) {
    if (groupedSignalSet.has(sig)) continue;
    if (!sig.team || !teams[sig.team]) continue;

    const framed = frameCababilitySignal({
      topic: 'other',
      team: sig.team,
      signals: [sig]
    });

    const isResolved = sig.type === 'jira' && sig.status === 'Done';
    if (isResolved) {
      teams[sig.team].accomplishments.push(framed);
    } else if (sig.type === 'jira' && sig.status !== 'Done') {
      teams[sig.team].inProgress.push(framed);
    }
  }

  // 4. Detect continuity items from previous notes
  const continuity = detectContinuityItems(sources.previousNotes, signalGroups);

  // 5. Check for hiring signals in previous notes and current signals
  for (const item of continuity) {
    if (/\bhiring\b|\breq\b|\bsourcing\b/i.test(item.item)) {
      // Try to attribute hiring to the right team
      const hiringTeam = item.team;
      if (hiringTeam && teams[hiringTeam]) {
        teams[hiringTeam].hiring = {
          status: 'carried from previous week',
          details: item.item,
          sources: ['previous notes']
        };
      }
    }
  }

  // 6. Detect gaps
  const gaps = detectGaps(teams);

  // 7. Build executive summary
  const executiveSummary = buildExecutiveSummary(teams, signalGroups);

  return { teams, executiveSummary, gaps, continuity };
}

module.exports = {
  curateForWeeklySummary,
  TEAMS,
  TOPIC_PATTERNS,
  identifyTeam,
  identifyTopics,
  groupSignals,
  frameCababilitySignal,
  detectContinuityItems,
  detectGaps
};
