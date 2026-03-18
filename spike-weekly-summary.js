#!/usr/bin/env node
'use strict';

// spike-weekly-summary.js
// One-time spike test: can we produce a Monday Morning Meeting draft from collected data?
// Week of March 10-14, 2026

const ai = require('./lib/ai');

// =============================================================================
// Step 1: Define the raw data fixtures (hardcoded from our data gathering)
// =============================================================================

const jiraTickets = [
  // CSE - Aragorn King
  { key: 'ENG-9407', summary: 'Create a Terraform user object for Termed User attribute', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENG-9434', summary: 'Add prevent destroy code block to this user attribute', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENG-9408', summary: 'Edit permissions attribute to HIDE', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16537', summary: 'Versapay access on Okta', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16701', summary: 'Application Access Request - Pathmatics', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16742', summary: 'Get me access to liveramp', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16739', summary: 'Jira permissions for user', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16649', summary: 'Send Hardware to Test Ken', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16648', summary: 'Order Hardware for Test Ken', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16646', summary: 'Sync and apply default Signite template for Test Ken', assignee: 'Aragorn King', team: 'cse' },
  { key: 'ENGSUP-16492', summary: 'Check role groups for Celeborn Grey', assignee: 'Aragorn King', team: 'cse' },
  // CSE - Gandalf Grey
  { key: 'ENG-9318', summary: 'Import and Normalize Contractors & Core Organizational Groups into Terraform (Prod)', assignee: 'Gandalf Grey', team: 'cse' },
  { key: 'ENGSUP-16728', summary: 'Okta Terraform Drift Detected - 2026-03-12', assignee: 'Gandalf Grey', team: 'cse' },
  { key: 'ENGSUP-16735', summary: 'Export list of all active users in Docusign eSignature', assignee: 'Gandalf Grey', team: 'cse' },
  { key: 'ENGSUP-16733', summary: 'Salesforce config request for Galadriel White', assignee: 'Gandalf Grey', team: 'cse' },
  { key: 'ENGSUP-16732', summary: 'Salesforce Access for Galadriel White', assignee: 'Gandalf Grey', team: 'cse' },
  { key: 'ENGSUP-16731', summary: 'Grant Salesforce access to Galadriel White', assignee: 'Gandalf Grey', team: 'cse' },
  { key: 'ENG-9415', summary: 'Update Create slack webhook for a Slack App (Airbrake) Admin Doc', assignee: 'Gandalf Grey', team: 'cse' },
  // Desktop - Eowyn Rider
  { key: 'ENGSUP-16597', summary: 'Slack channel additions for vendor_channel_political_shared', assignee: 'Eowyn Rider', team: 'desktop' },
  { key: 'ENGSUP-16328', summary: 'Send Hardware to Haldir March', assignee: 'Eowyn Rider', team: 'desktop' },
  { key: 'ENGSUP-16493', summary: 'Order Hardware for Celeborn Grey', assignee: 'Eowyn Rider', team: 'desktop' },
  // Desktop - Faramir Guard
  { key: 'ENG-9406', summary: 'Update the version provider for Terraform', assignee: 'Faramir Guard', team: 'desktop' },
  { key: 'ENGSUP-16729', summary: 'Move airbrake slack integration channels', assignee: 'Faramir Guard', team: 'desktop' },
  { key: 'ENGSUP-16571', summary: 'Desk Issue Fix', assignee: 'Faramir Guard', team: 'desktop' },
  { key: 'ENGSUP-16118', summary: 'MediaRadar access inquiry', assignee: 'Faramir Guard', team: 'desktop' },
  { key: 'ENGSUP-15876', summary: 'Navan/Okta login issue on phone', assignee: 'Faramir Guard', team: 'desktop' },
  // Security - Gimli Stone
  { key: 'ENG-9058', summary: 'Default apps for first deployment', assignee: 'Gimli Stone', team: 'security' },
];

const slackMessages = [
  // CSE - Aragorn King
  { author: 'Aragorn King', authorTeam: 'cse', channel: '#eng-infra', date: '2026-03-10', content: 'Working on Jira automation for Applicant card auto-fill from Open Position Story fields. Updated JetBrains Audit list and Slack workflow.' },
  { author: 'Aragorn King', authorTeam: 'cse', channel: '#eng-platform', date: '2026-03-11', content: 'Webhook from Make running: when Applicant card moves to Code Challenge swim lane, fires off and creates the GitHub repo.' },
  { author: 'Aragorn King', authorTeam: 'cse', channel: '#eng-general', date: '2026-03-12', content: 'Identified Pathmatics as manual-provisioning app. Handled Okta access. Flagged Claude needs purchase approval review.' },
  { author: 'Aragorn King', authorTeam: 'cse', channel: '#eng-platform', date: '2026-03-13', content: 'Coached team to send Employee KB docs to users for common requests instead of hand-holding.' },
  { author: 'Aragorn King', authorTeam: 'cse', channel: '#eng-infra', date: '2026-03-14', content: 'Secondary email audit: only ~3 accounts found missing secondary emails from Rockstar export.' },
  // Desktop - Faramir Guard
  { author: 'Faramir Guard', authorTeam: 'desktop', channel: '#eng-platform', date: '2026-03-11', content: 'Confirmed zero-touch deployments successful: no problems reported, computers confirmed up to date.' },
  { author: 'Faramir Guard', authorTeam: 'desktop', channel: '#eng-platform', date: '2026-03-13', content: 'Raised Jamf issue: returned computers losing Return status in system name; reissued computers reverting username back to computer name.' },
  { author: 'Faramir Guard', authorTeam: 'desktop', channel: '#eng-general', date: '2026-03-10', content: 'Multiple access provisioning requests handled: GoDaddy, Bitwarden, Versapay, Zoom webinar, Salesloft/Salesforce routing.' },
  // Desktop - Eowyn Rider
  { author: 'Eowyn Rider', authorTeam: 'desktop', channel: '#eng-platform', date: '2026-03-11', content: 'Identified Jamf naming issue: system names for returned MacBooks reverting to original user name. Suspected automation overwriting manual changes.' },
  { author: 'Eowyn Rider', authorTeam: 'desktop', channel: '#eng-platform', date: '2026-03-12', content: 'Druva storage metrics: Allocated=220.43TB, Data Protected=164.03TB, Total Storage Used=211.22TB.' },
  { author: 'Eowyn Rider', authorTeam: 'desktop', channel: '#eng-platform', date: '2026-03-13', content: 'Root-cause analysis on Jamf naming: Okta repopulating old user and location info on manual setup/reissue. Need procedure for returned systems.' },
  // Security - Gimli Stone
  { author: 'Gimli Stone', authorTeam: 'security', channel: '#eng-platform', date: '2026-03-10', content: 'Completed Druva fixes — got user back to working order. Orbstack/Druva interaction was root cause.' },
  { author: 'Gimli Stone', authorTeam: 'security', channel: '#eng-platform', date: '2026-03-13', content: 'Officially closed Druva issue. Updated notes. Root cause documented: Orbstack symlink folders, separate Druva profile blocks data.img.' },
  // Security - Legolas Wood
  { author: 'Legolas Wood', authorTeam: 'security', channel: '#eng-general', date: '2026-03-11', content: 'Recommended creating second OpenAI account for dev use case, isolating from production AutoPilot endpoint.' },
  { author: 'Legolas Wood', authorTeam: 'security', channel: '#eng-platform', date: '2026-03-13', content: 'Shared product epic template from Confluence for potential adaptation to DW projects.' },
];

const confluencePages = [
  { title: 'Reconnect NetSuite to Trelica (Regenerate Consumer Key & Secret)', author: 'Gandalf Grey', space: 'DW', lastModified: '2026-03-13' },
  { title: 'Create slack webhook for a Slack App (Airbrake)', author: 'Gandalf Grey', space: 'DW', lastModified: '2026-03-12' },
  { title: 'SASE Perimeter 81 Deployment', author: 'Gimli Stone', space: 'DW', lastModified: '2026-03-10' },
];

const meetingMetadata = [
  { title: 'Weekly Terraform Checkin + Backlog Refinement (JAMF+Okta)', date: '2026-03-11', attendees: ['team'] },
  { title: 'Simpli.fi DW Corporate Systems Engineer Interview - Peregrin Took', date: '2026-03-11', attendees: ['Peregrin Took'] },
  { title: 'Simpli.fi DW Corporate Systems Engineer Interview - Meriadoc Brand', date: '2026-03-11', attendees: ['Meriadoc Brand'] },
  { title: 'Simpli.fi DW Corporate Systems Engineer Interview - Elrond Half', date: '2026-03-13', attendees: ['Elrond Half'] },
  { title: 'AI Governance Working Group', date: '2026-03-12', attendees: ['cross-team'] },
  { title: 'Standup: Terraform-JamfPro', date: '2026-03-12', attendees: ['keshon.bowman', 'geoffrey', 'kennethd', 'daniel.sherr'] },
  { title: 'Digital Workplace Standup', date: '2026-03-12', attendees: ['full-team'] },
];

const previousNotes = `### Executive Summary

Digital Workplace operations remained stable this week with no employee-impacting disruptions. The Mac Zero-Touch Deployment v3 process was validated for production and used successfully for initial new-hire onboarding, and Okta Terraform coverage expanded with new production imports and an initial drift detection alert. Identity lifecycle operations remained steady. Overall risk posture remains unchanged heading into next week.

### Team Notes

#### Corporate Systems Engineering

Terraform-based identity management continued to expand in both coverage and operational maturity.

- Imported and normalized contractor and core organizational group definitions into the Terraform production environment.
- Implemented Terraform management for the termed-user attribute with prevent-destroy safeguards to guard against accidental deletions.
- Completed design doc for Okta Terraform drift detection; an initial GitHub Actions-based implementation generated its first drift detection alert on March 12. Finalizing scheduled automation.
- Configured seamless.ai SSO 2.0.
- Routine identity lifecycle operations continued, including a large contractor offboarding batch and SaaS integration maintenance.

One open CSE role. Reposted as remote; monitoring candidate pipeline.

#### Desktop Support

Normal operational activity with steady onboarding and offboarding throughput. Hardware was provisioned and shipped for two new hires and retrieved from three departures. No employee-impacting trends this week.

#### Security (Platform & Endpoint)

ZTD and Terraform progress continued alongside endpoint platform improvements.

- Validated the 2026 Mac Zero-Touch Deployment (v3) process for production readiness and successfully onboarded new hires through the updated workflow.
- Standardized the macOS device naming convention from Sifi-[Dept]-[Serial] to SiFi-[Serial], eliminating orphaned records in CommVault and CrowdStrike when employees change departments.
- Finalized the first-deployment application manifest (Zoom, Slack, Okta Verify, Falcon, Chrome, Google Drive, Perimeter81).
- Continued importing JamfPro resources into Terraform/Terragrunt while refining dependency ordering and project structure.

Offer for the open Security Engineer role was withdrawn after the candidate requested to not provide a response until April - with no explanation. Search continues.`;

// =============================================================================
// Step 2: Curation — group raw data into team-based structure for narration
// =============================================================================

// Inline curation since lib/digest-curation.js doesn't exist yet
function curateForWeeklySummary({ jiraTickets, slackMessages, confluencePages, meetingMetadata }) {
  const teams = {
    cse: { name: 'Corporate Systems Engineering', members: {}, jiraCount: 0 },
    desktop: { name: 'Desktop Support', members: {}, jiraCount: 0 },
    security: { name: 'Security (Platform & Endpoint)', members: {}, jiraCount: 0 },
  };

  // Group Jira tickets by team and assignee
  for (const ticket of jiraTickets) {
    const team = teams[ticket.team];
    if (!team) continue;
    if (!team.members[ticket.assignee]) {
      team.members[ticket.assignee] = { jira: [], slack: [] };
    }
    team.members[ticket.assignee].jira.push(ticket);
    team.jiraCount++;
  }

  // Group Slack messages by team and author
  for (const msg of slackMessages) {
    const team = teams[msg.authorTeam];
    if (!team) continue;
    if (!team.members[msg.author]) {
      team.members[msg.author] = { jira: [], slack: [] };
    }
    team.members[msg.author].slack.push(msg);
  }

  // Classify Jira tickets into categories
  function classifyTickets(tickets) {
    const terraform = tickets.filter(t =>
      /terraform|drift|import|normalize/i.test(t.summary)
    );
    const accessProvisioning = tickets.filter(t =>
      /access|okta|permission|salesforce|liveramp|pathmatics|versapay|mediaradar|navan/i.test(t.summary) &&
      !terraform.includes(t)
    );
    const hardware = tickets.filter(t =>
      /hardware|send|order|desk/i.test(t.summary)
    );
    const other = tickets.filter(t =>
      !terraform.includes(t) && !accessProvisioning.includes(t) && !hardware.includes(t)
    );
    return { terraform, accessProvisioning, hardware, other };
  }

  // Build curated output per team
  const curated = {};
  for (const [teamKey, team] of Object.entries(teams)) {
    const allJira = Object.values(team.members).flatMap(m => m.jira);
    const allSlack = Object.values(team.members).flatMap(m => m.slack);
    const classified = classifyTickets(allJira);

    curated[teamKey] = {
      name: team.name,
      jiraResolved: allJira.length,
      categories: classified,
      narrativeSlack: allSlack,
      members: Object.keys(team.members),
    };
  }

  // Interview activity from meetings
  const interviews = meetingMetadata.filter(m =>
    /interview/i.test(m.title)
  );

  // Other notable meetings
  const notableMeetings = meetingMetadata.filter(m =>
    !(/interview/i.test(m.title))
  );

  return {
    weekOf: '2026-03-10',
    teams: curated,
    confluencePages,
    interviews,
    notableMeetings,
  };
}

// =============================================================================
// Step 3: Narration — call AI with the curated data
// =============================================================================

const WEEKLY_SUMMARY_SYSTEM = `You are drafting the Digital Workplace section of Monday Morning Meeting notes for a VP of IT.

FORMAT:
- Start with "### Executive Summary" (2-4 sentences, no bullet points)
- Then "### Team Notes" with subsections for each team:
  - "#### Corporate Systems Engineering"
  - "#### Desktop Support"
  - "#### Security (Platform & Endpoint)"
- Each team section: 1-2 paragraph narrative + bullet points for specific accomplishments
- End each team section with hiring status if relevant

CONTENT RULES — Include ONLY:
- Capability advancement (new automation, new IaC coverage, new SSO, new processes)
- Validation/correctness work that prevented future problems
- Risk reduction (naming convention changes, prevent-destroy safeguards)
- Hiring status with pipeline details (always last line for CSE and Security)

CONTENT RULES — Exclude (strictly):
- Ticket counts (never mention how many tickets were resolved)
- Individual employee names (never — say "the team" or use role/team names)
- Dollar amounts, incident blow-by-blow, sprint/velocity metrics
- Meeting counts, vendor negotiations, future commitments with specific dates
- Screenshots, links, embedded content, ticket keys (DWDEV-xxxx, DWS-xxxxx)

ALWAYS KTLO — Never surface these. They are invisible daily operations:
- User/application access provisioning and deprovisioning (Okta, Salesforce, Jira, etc.) — whether 1 request or 50, this is daily routine. NEVER list individual access requests. NEVER summarize them as a count. Just omit.
- Password resets, MFA enrollment, login troubleshooting
- Hardware ordering, shipping, receiving, desk setup — unless a fleet-wide lifecycle event
- Slack channel management, workspace changes
- Routine onboarding/offboarding task execution
- Confluence documentation updates for existing procedures
- Storage metrics, backup status checks (unless a notable anomaly)

COMPRESSION — The restraint IS the style:
- Maximum 5 bullets per team section. If you have more, you are too detailed.
- Desktop Support is almost always ONE SENTENCE with ZERO bullets. Only add bullets for facts a VP would want.
- Each bullet must describe a CAPABILITY ADVANCEMENT — something new. If it is not new capability, new automation, new coverage, or new process, it is not a bullet.
- Compress related signals into one bullet. Three Terraform tickets about the same attribute = one bullet.
- If in doubt whether something is notable or KTLO, it is KTLO. Omit it.
- "Routine identity lifecycle operations continued" is the MAXIMUM acknowledgment of KTLO. Usually, say nothing.

VOCABULARY:
- "remained stable" / "no employee-impacting disruptions" — exec summary opener
- "risk posture remains unchanged" — exec summary closer
- "Normal operational activity" — Desktop Support default
- "operational maturity", "validated", "continued", "expanded", "implemented", "configured", "standardized"
- Tone: calm, factual, resolution-oriented. Executive audience.

THREE QUESTIONS the section answers for a scanning executive:
1. Is anything broken or at risk? (Executive Summary — almost always "no")
2. What capability advanced this week? (Team Notes — 2-5 bullets per team MAX)
3. Where are we on hiring? (Last line of CSE and Security)

The notes should be exactly as long as the content warrants. Do not pad. Do not cut for brevity. If only one capability advanced, write one bullet. If five advanced, write five.`;

async function narrateWeeklySummary(curatedData) {
  const client = ai.getClient();
  if (!client) {
    console.error('ERROR: AI client unavailable. Cannot generate narration.');
    console.error('Ensure ANTHROPIC_API_KEY is set or Claude Code keychain credentials exist.');
    process.exit(1);
  }

  const userMessage = `Here is the curated data for the week of ${curatedData.weekOf}:

TEAM DATA:
${JSON.stringify(curatedData.teams, null, 2)}

CONFLUENCE DOCUMENTATION UPDATES:
${JSON.stringify(curatedData.confluencePages, null, 2)}

INTERVIEWS CONDUCTED: ${curatedData.interviews.length} candidate interviews for the open CSE role

NOTABLE MEETINGS:
${JSON.stringify(curatedData.notableMeetings, null, 2)}

PREVIOUS WEEK'S NOTES (for tone/format reference):
${previousNotes}

Please draft this week's Monday Morning Meeting notes following the same format and tone as the previous week's notes.`;

  try {
    const response = await client.messages.create({
      model: process.env.SPIKE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: WEEKLY_SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0]?.text;
    const modelUsed = process.env.SPIKE_MODEL || 'claude-sonnet-4-6';
    console.error(`[narration] model=${modelUsed} input_tokens=${response.usage?.input_tokens} output_tokens=${response.usage?.output_tokens}`);
    return text || null;
  } catch (err) {
    console.error('Narration failed:', err.message);
    return null;
  }
}

// =============================================================================
// Step 4 & 5: Run the pipeline and print results
// =============================================================================

async function main() {
  console.log('=== WEEKLY SUMMARY SPIKE TEST ===');
  console.log(`Week of: March 10-14, 2026`);
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log('');

  // Step 2: Curate
  console.log('--- Curating data...');
  const curated = curateForWeeklySummary({ jiraTickets, slackMessages, confluencePages, meetingMetadata });

  console.log(`  CSE: ${curated.teams.cse.jiraResolved} tickets, ${curated.teams.cse.narrativeSlack.length} slack messages`);
  console.log(`  Desktop: ${curated.teams.desktop.jiraResolved} tickets, ${curated.teams.desktop.narrativeSlack.length} slack messages`);
  console.log(`  Security: ${curated.teams.security.jiraResolved} tickets, ${curated.teams.security.narrativeSlack.length} slack messages`);
  console.log(`  Interviews: ${curated.interviews.length}`);
  console.log(`  Confluence updates: ${curated.confluencePages.length}`);
  console.log('');

  // Step 3: Narrate
  console.log('--- Generating narration via AI...');
  const draft = await narrateWeeklySummary(curated);

  if (!draft) {
    console.error('FATAL: Narration returned null. Exiting.');
    process.exit(1);
  }

  // Step 4: Print the generated draft
  console.log('');
  console.log('=== GENERATED DRAFT ===');
  console.log('');
  console.log(draft);

  // Step 5: Print the actual notes for comparison
  console.log('');
  console.log('=== ACTUAL NOTES ===');
  console.log('');
  console.log(previousNotes);

  // Step 6: Simple comparison summary
  console.log('');
  console.log('=== COMPARISON ===');
  console.log('');

  const draftLines = draft.split('\n').filter(l => l.trim());
  const actualLines = previousNotes.split('\n').filter(l => l.trim());

  console.log(`Generated: ${draftLines.length} non-empty lines, ${draft.length} chars`);
  console.log(`Actual: ${actualLines.length} non-empty lines, ${previousNotes.length} chars`);

  // Check structural similarity
  const draftSections = draft.match(/^###+ .+$/gm) || [];
  const actualSections = previousNotes.match(/^###+ .+$/gm) || [];
  console.log('');
  console.log('Generated sections:');
  for (const s of draftSections) console.log(`  ${s}`);
  console.log('');
  console.log('Actual sections:');
  for (const s of actualSections) console.log(`  ${s}`);

  // Check for key themes mentioned in both
  const themes = [
    'Terraform',
    'drift detection',
    'zero-touch',
    'ZTD',
    'identity lifecycle',
    'hardware',
    'Jamf',
    'Druva',
    'interview',
    'hiring',
    'Confluence',
    'Perimeter 81',
    'naming convention',
  ];

  console.log('');
  console.log('Theme coverage:');
  for (const theme of themes) {
    const inDraft = draft.toLowerCase().includes(theme.toLowerCase());
    const inActual = previousNotes.toLowerCase().includes(theme.toLowerCase());
    const status = inDraft && inActual ? 'BOTH' :
                   inDraft ? 'DRAFT ONLY' :
                   inActual ? 'ACTUAL ONLY' :
                   'NEITHER';
    console.log(`  ${theme}: ${status}`);
  }

  console.log('');
  console.log('=== SPIKE COMPLETE ===');
}

main().catch(err => {
  console.error('Spike test failed:', err);
  process.exit(1);
});
