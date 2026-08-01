---
name: feedback_be_concise
description: "Be concise — user-facing reports and agent dispatch messages both ran far too long during the 2026-07-31 session"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-31T10:48:56.371Z
---

Asked directly on 2026-07-31: **"Please remember to be more concise."**

**What was too long:**

- **User-facing status reports** — multi-section write-ups with tables, bolded
  sub-findings and methodology asides, when 3–5 sentences would carry the result.
- **SendMessage dispatches to agents** — 400+ word briefs restating context the
  agent already had, plus praise paragraphs and generalised lessons.

**Why:** the user is orchestrating, not reading a report. They want the answer,
the decision, and what changed — not the reasoning that produced it unless they
ask.

**How to apply:**

- Lead with the answer or the decision. Detail only if asked.
- Status updates: what landed, what's next, what needs them. Usually ≤5 sentences.
- Agent messages: the instruction, the constraint, the acceptance bar. Skip
  restating their own findings back to them, skip the praise paragraph, skip
  generalised lessons unless they change the task.
- Tables only when comparing ≥3 things on ≥2 dimensions.
- One correction stated once. Don't re-explain an error already acknowledged.

**Do NOT sacrifice:** measured numbers with denominators, stated uncertainty,
and corrections of my own earlier claims. Conciseness is about cutting
restatement and commentary, never about dropping evidence or hedges that carry
information. See [[feedback_measure_never_extrapolate]].
