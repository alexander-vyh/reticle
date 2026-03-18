# Email Digest Quality — Stop Training the User to Ignore Reticle

> **Epic:** TBD (will create after skeleton validation)

## 1. Problem Statement `[PENDING SKELETON]`

> **"What changes in the world?"**

Today, Reticle's email digest and end-of-day summary are actively harmful. The user
sees 50+ items marked `[critical]` that include Squarespace renewals, PagerDuty
analytics, Google Apps Script failures, and newsletter subscriptions — none of which
are critical. The end-of-day summary reports "Carrying 601 to tomorrow" every day,
a number that never decreases because conversations never close.

The user has learned to ignore Reticle's Slack messages. This is the worst failure
mode for a trust surface: the instrument is noisier than the inbox it's supposed to
triage.

After this ships: the digest contains 3-8 items that genuinely need attention.
Everything else is either auto-resolved, expired, or grouped into a single "N items
aging out" line. The user reads the digest and acts on it, or reads it and confirms
nothing needs action — both are success states. Ignoring it is not.

## 2. Non-Goals (minimum 3) `[PENDING SKELETON]`

1. **Not redesigning the Gmail monitor's real-time triage.** The filter rules, AI
   triage, and urgent/batch split stay as-is. The problem is in what happens AFTER
   triage: conversation tracking, priority escalation, and digest presentation. This
   locks in: emails that should be filtered at triage time but aren't will still leak
   through. Fixing triage rules is a separate increment.

2. **Not building an email UI in the tray app.** The digest is a Slack message, not
   a management surface. The user acts on email in Gmail, not in Reticle. This locks
   in: Reticle can tell you what needs attention, but you still go to Gmail to act.

3. **Not implementing email threading or conversation grouping.** 10 emails from the
   same Jira ticket thread are 10 separate conversations today. Grouping them is a
   significant data model change (thread detection, parent/child linking). This locks
   in: the conversation count will remain inflated until threading ships in a future
   increment. The fix here is to stop surfacing stale conversations, not to merge them.

4. **Not changing the digest narration AI.** The narration prompt and model stay
   the same. The problem is the input to narration (50+ critical items), not the
   narration itself. This locks in: if the filtered input is still bad, the narration
   will still be bad.

## 3. Riskiest Assumption `[PENDING SKELETON]`

> **"I am betting that auto-expiring conversations after a configurable window
> (default 7 days of inactivity) will not cause the user to miss a real obligation.
> I will know I'm wrong when the user discovers a dropped ball that Reticle silently
> expired."**

**Rejected alternative:** Never auto-expire — require explicit user resolution for
every conversation. Rejected because: with 601 active conversations, manual
resolution is not a realistic workflow. The user will never clear the backlog, and
the carry-forward number will only grow. The current system already silently drops
things by making everything look critical — at least auto-expiry is honest about it.

**Per-assumption probes:**

1. *What changes if false?* If auto-expiry causes missed obligations, add a
   "recently expired" section to the digest showing what was expired in the last
   24h. The user can scan it once and re-open anything that matters. This is strictly
   better than the current state where nothing expires and everything is critical.

2. *How quickly would we discover it?* Within the first week. The user will either
   notice something missing from the digest that should have been there, or they
   won't — in which case the assumption holds.

3. *Can we test before writing code?* Yes — query the conversations table for items
   older than 7 days, manually review 20 of them, and check if any represent real
   obligations. If >2 of 20 are real, the window is too short. Takes 10 minutes.

## 4. Walking Skeleton `[PENDING SKELETON]`

**What it is:** Add conversation auto-expiry, decouple priority from age, cap the
digest collection window, and link email archive to conversation resolution.

**What it tests:** Whether a filtered, time-bounded digest with 3-8 items is
actionable — meaning the user reads it and either acts or confirms nothing needs
action.

**What done looks like:** The daily digest Slack message contains fewer than 10
items. None are newsletters, receipts, or automated notifications older than 3 days.
The end-of-day summary says "Carrying N" where N < 30. The user does not ignore it.

**Continuation gate:**
- **Validated** → proceed to triage rule improvements, digest narration tuning
- **Invalidated** → the collection window is wrong, or auto-expiry is too aggressive.
  Adjust thresholds and re-test.

### Skeleton Task 1: Decouple priority from age + auto-expire conversations (45 min)

**Priority reform:** Change `collectFollowups()` priority logic. Age determines
*staleness*, not *criticality*. Priority comes from the original triage signal:

| Original triage | Fresh (<24h) | Aging (1-3d) | Stale (3-7d) | Expired (>7d) |
|----------------|-------------|-------------|------------|-------------|
| VIP / urgent keyword | critical | critical | high | auto-expire |
| AI-triaged important | high | high | normal | auto-expire |
| Normal email | normal | normal | low | auto-expire |
| Batch / demoted | low | low | suppress | auto-expire |

**Auto-expire:** Add `expireStaleConversations(db, { maxAgeDays = 7 })` — sets
`state = 'expired'` on conversations where `last_activity < now - maxAgeDays` AND
`state = 'active'`. Run at the start of each digest collection cycle.

**Archive → resolve linkage:** When `gmail-monitor.js` archives or deletes an email,
also call `resolveConversation()` for that email's conversation. Currently archiving
only touches Gmail — the conversation record stays active forever.

### Skeleton Task 2: Cap digest collection + suppress noise categories (30 min)

**Collection window:** `collectFollowups()` and `collectEmail()` only query
conversations with `last_activity` within the last 7 days. Older items are expired
by Task 1 and don't appear.

**Category suppression:** Emails that were auto-archived by hardcoded rules should
never create conversations in the first place. Add a guard in
`trackEmailConversation()`: if the email was archived by a rule (not AI-triaged,
not urgent), skip conversation tracking entirely. The email is handled — there is
no conversation to follow up on.

**Digest item cap:** If after filtering there are still >15 items, group the
lowest-priority items into a single summary line:
`"+ N lower-priority items (oldest: Xd)"`. Never dump 50 raw items.

### Skeleton Task 3: Backfill — expire existing stale conversations (15 min)

Run `expireStaleConversations()` against the live DB to clear the 601-item backlog.
Verify the next digest contains <15 items and the EOD summary shows "Carrying N"
where N < 30.

## 5. Proof of Delivery `[PENDING SKELETON]`

> "I will know this is worth continuing when **the daily digest Slack message
> contains fewer than 10 items, the end-of-day summary says 'Carrying N' where
> N < 30**, after I build the auto-expiry, priority reform, and collection cap
> and run them for 3 days of real email, AND **the user has not discovered a
> dropped obligation that was auto-expired**."

Not "when the code is deployed." Not "when the tests pass." When the Slack message
is short enough to read and accurate enough to trust.

## 6. Anti-Metrics `[PENDING SKELETON]`

Even if the digest is shorter, it has **failed** if:

- **A real obligation expires silently.** If someone important sent an email that
  needed a response, and it expired after 7 days without the user seeing it in any
  digest, the system failed. Mitigation: "recently expired" section in weekly digest.

- **The user still ignores the digest.** If the message is shorter but still
  untrustworthy (wrong priorities, missing context), the user will ignore it again.
  The number of items isn't the metric — whether the user acts on it is.

- **Carry-forward count creeps back up.** If N grows back to 100+ within a month,
  the expiry window is too long or new conversation creation is too aggressive.
  Monitor the carry-forward trend weekly.

- **Narration fails more often on the smaller input.** The narration prompt was
  tuned for large item sets. If it produces worse output on 5 items than 50, the
  prompt needs adjustment.

## 7. Future Increments `[PLACEHOLDER]`

Not designed yet. Addressed after learning from the skeleton.

1. **Action-dispatch model** — transform the digest from a read-only summary into
   an interactive control surface. Three layers:

   **Layer 1: Coded tools via Gateway endpoints.** Slack Block Kit action buttons
   that trigger predefined operations: approve, renew, delegate-to-person, snooze-N-days,
   archive-and-resolve. These are fast, reliable, deterministic — no AI in the loop.
   Example: Navan expense approval → [Approve] button → Gateway calls Navan API.
   Example: "Delegate to Ken" → creates a task in org-memory, sends Ken a Slack DM.

   **Layer 2: Claude agent dispatch for complex/novel actions.** When no coded tool
   exists, the user can trigger an AI agent from a Slack button. The agent executes
   with guardrails (user initiates, result returns for confirmation before sending).
   Example: "Draft a response" → agent reads the email thread, drafts a reply,
   posts it back to Slack for review before sending.

   **Layer 3: Pluggable tool framework (long-term).** As coded tools accumulate,
   extract a common dispatch interface. Langchain or similar orchestration when the
   tool count warrants it. Coded tools and AI agents sit behind the same interface.

   **Key constraint:** Nothing fires without explicit user direction. Reticle surfaces
   the action buttons; the user pulls the trigger. "Instrument that can dispatch"
   not "agent that acts autonomously."

   Done when 3+ email categories have working action buttons and the user resolves
   items from Slack without opening Gmail.

2. **Email classification by action type** — upgrade triage from binary
   (urgent/batch) to categorical: archive (no action), inform (weekly digest only),
   decide (surface with deadline + action buttons), delegate (route to person's
   entity, offer one-tap delegation). Renewal notices ("you will be charged in 15
   days") classified as "decide" with extracted deadline — distinct from receipts
   ("your invoice is ready") which are "archive."

   Done when renewal notices surface as action items with deadlines and receipts
   are silently archived.

3. **Gmail triage rule improvements** — expand hardcoded filters, improve AI triage
   prompt, add user feedback loop for triage quality. Done when <5% of archived
   emails should have been surfaced.

4. **Email thread grouping** — detect and merge conversations from the same email
   thread. Done when 10 Jira notification emails appear as 1 conversation, not 10.

5. **Digest narration tuning** — adjust the narration prompt for smaller, higher-
   quality item sets. Done when the user prefers the narrated version over raw items.

6. **Weekly "expired" review** — add a section to the weekly digest showing what was
   auto-expired, so the user can spot-check for missed obligations. Done when the
   user trusts auto-expiry enough to not manually check.

---

## Liveness Test

> "Given your riskiest assumption, what happens if it's false and you don't
> discover it for two weeks?"

If auto-expiry drops a real obligation and the user doesn't notice for two weeks:
someone expected a response that never came, credibility eroded, and the user only
discovers it when the other person follows up. This is bad but **strictly better
than today**, where the same obligation is buried in 50 "critical" items and ignored
anyway. The current system already drops obligations — it just does it by drowning
them in noise instead of explicitly expiring them.

Mitigation: the weekly digest (future increment 4) includes a "recently expired"
section. The user reviews it once a week. Two-week blind spots shrink to one-week.
