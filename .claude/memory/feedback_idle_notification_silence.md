---
name: idle_notification_silence
description: Ignore idle_notification pings, but do respond to brief milestone pings from active agents
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Agents now terminate after opening a PR, so the old CI-wait ping-loop problem is gone.

**Ignore:** `{"type":"idle_notification",...}` messages — still discarded, agents should never send these.

**Respond briefly to:** one-line milestone pings from active agents ("reproduced", "fix done", "PR #N open"). A quick acknowledgment ("got it, keep going") keeps the agent unblocked without creating a loop.

**How to apply:** Milestone pings = respond once with a brief ack. Idle/CI-polling pings = ignore. The distinction: milestone pings carry new information (state change); idle pings carry no new information.
