---
name: feedback_devs_default_opus
description: "Dev and senior-dev agents default to opus per their agent definitions; don't downgrade to sonnet without explicit user instruction"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

`.claude/agents/developer.md` and `.claude/agents/senior-developer.md` declare `model: opus` in frontmatter. That's the team's deliberate default. The `[[feedback_sonnet_for_sprint_loop]]` rule applies ONLY to the tech-lead orchestration loop — not to dev or sendev spawns.

**Why:** Devs do complex compiler work (codegen, IR lowering, conflict resolution in src/) where opus's reasoning is worth the tokens. I extrapolated the tech-lead sonnet rule to devs unilaterally; user pushed back and had me respawn the 6 sonnet devs on opus.

**How to apply:** When spawning a dev or senior-dev via Agent, do NOT pass `model: "sonnet"`. Let the agent definition's opus default stand. Override to sonnet only when the user explicitly says so. Architects also default to opus — same rule.
