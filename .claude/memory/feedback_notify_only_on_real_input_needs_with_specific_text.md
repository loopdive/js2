---
name: feedback_notify_only_on_real_input_needs_with_specific_text
description: "Only notify when the user genuinely must decide something, and the notification must carry the specific question. The contentless \"Claude is waiting for your input\" is suppressed."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T11:39:40.153Z
---

**Notify only when the user really has to give input, and put the actual question in the
message.** Stated 2026-07-25: they were getting a stream of "Claude is waiting for your
input" on ntfy and could not tell which ones mattered.

**Why:** a contentless notification carries zero information — the user cannot tell from it
whether anything is needed, so it trains them to ignore the whole channel. Then the one that
does matter gets missed. The cost of a notification is that it pulls attention out of a
meeting or dinner; that cost is only worth paying when there is something to act on.

**How to apply:**
- **Gate on CONTENT, not on the fact that a turn ended.** Turn-end is not an event worth a push.
- When you genuinely need a decision, send it via the **`PushNotification`** tool with the
  specific question — e.g. "land the de-inflation now or wait for a fresh window?" — not
  "waiting for input". Keep under 200 chars, lead with what they'd act on.
- Do NOT notify for routine progress, for finishing something they are clearly watching, or
  for agent idle/CI-wait chatter.
- Prefer ending a turn with a clear completion statement over an open-ended "let me know",
  which invites a pointless notification.

**Implemented in `/workspace/.claude/hooks/notify-gate.sh`** (the `Notification` hook): a
rule suppresses `waiting for (your|user) input` / `awaiting input`. Verified by matching
against real message shapes — the generic prompt is dropped while these still deliver:
permission prompts (they name the tool), explicit `PushNotification` messages, and any
message containing a real question or result.

That hook also already suppresses agent idle / CI-wait chatter, defers 5 min while the user
is active (cancelled if they submit a prompt), and fires immediately after 5 min idle.
`NTFY_URL=disabled` turns the channel off entirely — note it exits BEFORE any matching
logic, so it is useless for testing the filters; test the regex directly instead.

Related: [[feedback_reduce_notification_noise]], [[feedback_idle_notification_silence]],
[[feedback_sendmessage_discipline]], [[feedback_dont_ask_continue]].
