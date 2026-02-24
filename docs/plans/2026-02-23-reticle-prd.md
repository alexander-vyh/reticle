# Product Requirements Document (PRD)

## Product Name
**Reticle**

---

## 1. Executive Summary

Reticle is a personal work-alignment system designed to help a capable individual maintain intent, follow through on commitments, and act earlier and more effectively while operating in a dynamic professional environment.

Reticle does not optimize productivity, motivate behavior, or automate decisions. Instead, it extends awareness, preserves continuity, and supports accountability **only where authority has been explicitly delegated**.

Reticle's core value is preventing avoidable drift: missed follow-ups, delayed feedback, forgotten intent, and credibility erosion that occur not because of lack of competence or care, but because human attention does not scale with complexity.

---

## 2. Foundational Product Axioms

These axioms are binding. All product decisions must be consistent with them.

### Axiom 1: Reticle exists to help the primary user first

> "First it has to help me."

Reticle is designed from lived use, not personas or market abstractions.
Secondary users may only be added if they do not dilute usefulness for the primary user.

---

### Axiom 2: The goal is credibility and follow-through, not productivity theater

> "More regular feedback; faster responses; never having to say 'oops, I forgot' or 'sorry, I meant to get back to you yesterday.'"

Success is measured by reduced credibility leaks and tighter follow-through, not task volume or engagement metrics.

---

### Axiom 3: Reticle should see more than the user can, but speak less than it could

> "It should monitor more channels than I can and surface things I don't even know about yet."

Observation may be broad. Surfacing must be narrow.
Silence is the default success state.

---

### Axiom 4: Reticle must not rely on *others'* private information

> "No private communications."

Clarification:
- Reticle **may** access the user's private data (DMs, private channels, private email).
- Reticle **must not** use administrative or elevated access to read communications that are private *to other people*.
- Reticle must never surprise the user with how it knows something.

---

### Axiom 5: Dismissal is always possible unless explicitly revoked

> "You should be able to tell it to go away — unless you've told it not to let you get away with that."

Persistence requires explicit delegation.
Enforcement is rare, scoped, and revocable.

---

### Axiom 6: Tone must be calm, factual, and resolution-oriented

> "Chiding isn't going to help; resolution will."

Encouragement means clarity and next steps, not praise or scolding.

---

### Axiom 7: Reticle is longitudinal, not momentary

> "It's not just about today."

Patterns matter more than events.
Future outcomes matter more than immediate efficiency.

---

### Axiom 8: Accountability must be evidence-based and research-grounded

> "It should reference relevant research and remind me when I have to do my job."

Reticle may reference established models and research, but must calibrate claims and avoid over-certainty.

---

## 3. Problem Statement

Capable professionals experience repeated failure modes unrelated to skill or effort:

- intent decay across context switches
- delayed or missed follow-ups
- feedback delivered too late
- important topics deferred repeatedly
- gradual credibility erosion

Existing tools manage execution, not **alignment over time**.

---

## 4. Goals and Non-Goals

### 4.1 Goals

- Reduce missed or delayed follow-ups
- Improve timeliness and regularity of feedback
- Preserve professional credibility
- Extend awareness beyond individual attention limits
- Improve outcomes over time

### 4.2 Non-Goals

Reticle is not:
- a motivational system
- a habit builder
- a performance evaluator
- a surveillance tool
- a workflow orchestrator
- a conversational persona
- an autonomous agent

---

## 5. Target User

### Primary User
- Senior IC or people manager
- High cognitive load
- Values clarity, credibility, and follow-through
- Dislikes nagging, gamification, or performative productivity tools

---

## 6. Product Identity

**Reticle is an instrument for maintaining alignment while moving through complexity.**

It shows deviation.
It preserves reference.
It does not decide or command.

---

## 7. Information Scope and Privacy

### 7.1 Allowed Data Sources

- The user's:
  - private Slack DMs
  - private Slack channels
  - private email
  - calendar
  - meetings
- Shared or public work artifacts the user has access to

### 7.2 Explicitly Disallowed

- Admin-level access to read others' private communications
- Hidden or undisclosed data sources
- Emotional inference or psychological profiling
- Performance labeling

**Rule:** Reticle may observe broadly within the user's legitimate access, but must conclude narrowly.

---

## 8. Core Product Surfaces

### 8.1 Periodic Digest

Purpose: reflection, pattern awareness, improvement over time.

Characteristics:
- low frequency
- high signal
- pattern-based
- actionable

---

### 8.2 Pre-Meeting Brief

Purpose: prevent omission and support effective intervention.

Characteristics:
- just-in-time
- context-specific
- minimal

---

### 8.3 Hygiene Reminders

Purpose: prevent credibility leaks.

Examples:
- unreplied emails today
- explicit follow-ups not completed

Characteristics:
- factual
- dismissible
- batchable

---

### 8.4 Priority Interrupts (VIP)

Purpose: immediate awareness for explicitly designated senders.

Characteristics:
- explicit opt-in
- rare
- calm language

---

## 9. System Behavior Model

### 9.1 Core States

For any item, Reticle operates in one of four states:

1. **Observing** -- default, silent
2. **Holding** -- explicit intent or commitment exists
3. **Surfacing** -- awareness presented
4. **Enforcing** -- rare, explicit, protected commitments

Most items never enter Enforcement.

---

## 10. Auto-Capture vs Confirmation

### Auto-Capture Allowed
- explicit commitments by the user
- hygiene obligations
- VIP messages

### Confirmation Required
- interpreted action items
- suggested follow-ups
- ambiguous intent

### Never Auto-Captured
- pattern insights
- ambiguity detection
- feedback signals

---

## 11. Meetings and Transcription

### Role
- memory substrate
- evidence source
- not a primary UI

### Allowed
- detect explicit commitments
- detect omission of planned topics
- detect repeated deferral
- support recall

### Prohibited
- tone analysis
- stylistic critique
- automatic task creation from interpretation
- default transcript surfacing

---

## 12. Intent Integrity and Ambiguity Detection

### Intent Omission
Surfaced when:
- intent was explicit
- meeting occurred
- topic did not arise

### Ambiguity
Surfaced only when grounded in outcomes:
- divergent interpretations
- repeated clarification
- inconsistent restatement

Reticle flags **possible misalignment**, not "confusion."

---

## 13. Evidence and Explainability

Every surfaced item must explain:
- what was observed
- why it surfaced now
- what authority permits it
- what happens if ignored

Claims are calibrated:
- observations are direct
- interpretations are tentative
- research is cited, not asserted

---

## 14. Success Metrics

### Positive Signals
- fewer delayed replies
- fewer missed follow-ups
- earlier feedback conversations
- reduced apology language
- increased perceived reliability

### Anti-Metrics
- user feels nagged
- notifications broadly disabled
- loss of trust
- surprise surfacing

---

## 15. Constraints and Guardrails

- consent precedes authority
- silence is preferred to false positives
- trust is the primary asset
- language precision evolves through use
- expansion must preserve instrumental identity

---

## 16. Open Questions (Intentionally Deferred)

- digest cadence
- authority protection UI
- research surfacing format
- expansion beyond primary user
- agentic behavior boundaries

---

## 17. Summary

Reticle exists to help a capable individual remain aligned while conditions change.

It is quiet, disciplined, evidence-based, and persistent only where invited.

Anything that compromises trust, autonomy, or credibility is out of scope.
