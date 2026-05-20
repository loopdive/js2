---
name: feedback_dev_silence_protocol
description: Devs must be silent during CI-wait and idle — no idle_notification messages to tech lead
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Silence = no `idle_notification` ping-loops. It does NOT mean suppress all communication when action is required.

**Why the distinction matters:** The rule was over-applied in S51, causing agents to stay silent even after CI landed with catastrophic regressions (net -264) — blocking the sprint instead of escalating. The silence rule kills polling noise, not legitimate signals.

**What devs must NOT send:**
- `idle_notification` pings
- Unprompted "I'm still waiting / CI pending / progress update" messages

**What devs MUST send (immediately, no waiting to be asked):**
1. Claiming a task: include queue count
2. TaskList empty after merge
3. CI landed → ESCALATE (ratio >10%, or net <0): message with criterion + values
4. CI landed → catastrophic failure (net <0 or >50 in single bucket): message immediately
5. Blocked >30 min: include what was tried
6. Direct question from tech lead: always reply once

**Tech lead behavior:** Ignore idle_notification pings. Always respond to genuine escalations. After fixing the silence rule, send corrective messages to agents who were blocked by it.
