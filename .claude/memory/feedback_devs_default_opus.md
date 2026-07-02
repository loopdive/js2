---
name: feedback-devs-default-fable
description: Dev/senior/architect agents run on Fable when available (user directive 2026-07-02, supersedes the old opus default)
metadata:
  type: feedback
---

Devs, senior-devs, and architects run on **Fable** when the Fable model is available (user directive 2026-07-02: "make sure the devs run on fable"). The old default was opus.

**Why:** the repo's #2167 cluster proved a class of max-reasoning issues Opus was judged unable to do safely; with Fable available the budget is meant to be spent on it. Agent-def frontmatter (.claude/agents/*.md) was flipped model: opus → model: fable; ALSO pass model: "fable" explicitly on Agent spawns, because agent-def frontmatter overrides session-model inheritance — omitting the param does NOT inherit the session model when the def pins one (this is how a whole fleet silently ran Opus on 2026-07-02).

**How to apply:** on every Agent spawn for dev/senior/architect roles, set model: "fable" explicitly. If Fable is unavailable, fall back to opus and re-block the #2167-class issues rather than dispatching them.
