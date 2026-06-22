---
name: feedback_dev_silence_protocol
description: Devs send milestone pings during active work but no idle/CI-wait polls; agents terminate after PR
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
The old "no idle messages ever" rule was designed to stop ping-loops while agents waited for CI. Since agents now **terminate after opening a PR** (they no longer sit idle waiting for CI), the risk of ping-loops is gone — and alive signals during active work are actually useful so the tech lead knows agents haven't crashed or gotten stuck.

**Why:** Over-suppression caused agents in S51 to stay silent even after catastrophic CI results. And without CI-wait idle pings (because agents terminate), there's no loop to prevent.

**What devs must NOT send:**
- `idle_notification` pings
- Polling "CI is still pending / just checking in" messages

**What devs SHOULD send (brief milestone pings during active work):**
- "Reproduced #N — root cause confirmed at `src/foo.ts:42`. Implementing fix." 
- "Fix implemented, running equiv tests."
- "PR #N open — terminating."

**What devs MUST send (immediately, no waiting):**
1. Claiming a task: include queue count
2. TaskList empty after merge
3. CI landed → ESCALATE: message immediately with criterion + values
4. Blocked >30 min: include what was tried
5. Direct question from tech lead: always reply once

**How to apply:** One-liner progress updates at key moments (reproduced → fixed → PR open). No multi-paragraph status reports. No pings when literally nothing changed.

**Tech lead behavior (corrected 2026-06-21, s64):** Acknowledge milestone
pings briefly. But an **idle ping is a STATE signal, not noise to ignore** —
"silence breaks the loop" is false (pings are timer-driven by the agent's idle
state, not replies; they keep coming regardless of whether you answer). Always
**resolve the state**: stale/crossing-in-flight → ignore; idle + work →
TaskList task with `owner` pinned (agents are TaskList-driven, not
SendMessage-driven); idle + no work → `shutdown_request`. Going quiet at an
idle agent just lets it loop and burn a slot. Full rule:
[[feedback_idle_notification_silence]].
