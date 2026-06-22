---
name: idle_notification_silence
description: "An idle ping is a STATE signal — resolve it (TaskList task / shutdown / recognize stale), never just stay silent"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

**Corrected 2026-06-21 (s64).** The old rule said "ignore idle_notification
pings; silence breaks the ping loop." That mechanism is **false**: idle pings
are **timer-driven by the agent's own idle state**, not replies to the lead —
so staying silent never breaks the loop. Observed all s64: agents
(carla/anita/bruno/sdev-reflect) kept pinging at intervals regardless of
whether the lead answered. The only things that stop the pings are **giving
the agent work or shutting it down**. Taken literally, "silence" silently
degrades into "don't *act* on idle agents" → idle agents burn slots and keep
pinging.

**An idle ping is a STATE CHECK. Always resolve the state — never just go
quiet:**
- **Stale / crossing-in-flight** (ping about a task you already reassigned) →
  ignore. This is the only correct "silence."
- **Genuinely idle + work exists** → create/refresh a **TaskList task with
  `owner` pinned**. NOT SendMessage, NOT silence. Agents are **TaskList-driven,
  not SendMessage-driven** (s64: SendMessage assignments were repeatedly
  ignored or misread — sdev-reflect read a #2036 assignment as a #2046
  re-confirm). See [[feedback_dispatch_against_upstream_not_stale_fork]].
- **Genuinely idle + no work** → `shutdown_request` immediately (drained agents
  burn pane/RAM slots and block new spawns; re-spawn when work appears).
- **Repeated identical idle pings after you've assigned work** → the agent may
  be **wedged** (pinging but not acting); re-issue via TaskList, or recognize
  it can't ack and let the lead-session end clear it.

**Why:** the goal is less *chatter*, not less *action*. Over-suppression in
S51 left agents silent after catastrophic CI; under-action in s64 left agents
idle-looping. Both are the same mistake — treating "don't reply" as the rule
instead of "resolve the state."

**Keep (the genuinely useful part):** don't send chatty "ack/thanks" replies,
and don't treat a single status ping as a summons. Milestone pings carrying new
info (reproduced / fixed / PR open / ESCALATE) still warrant a one-line
response or action. Related: [[feedback_dev_silence_protocol]],
[[feedback_sendmessage_discipline]].
