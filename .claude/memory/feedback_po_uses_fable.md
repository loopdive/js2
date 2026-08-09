---
name: feedback-po-uses-fable
description: "Product Owner role should be dispatched with model fable, not the agent-def default"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

The Product Owner role (backlog grooming, issue creation, error-pattern harvests) should be
dispatched with `model: "fable"` explicitly, not left to whatever `product-owner.md`'s own
frontmatter defaults to.

**Why:** user directive (2026-07-16), extending the existing "devs default fable" directive
(2026-07-02, see [[feedback_devs_default_opus.md]] — despite its filename, that memory already
records the flip TO fable) to the PO role as well. Fable was set as the standing default in
place of Opus across the team.

**How to apply:** every `Agent({subagent_type: "product-owner", ...})` call should pass
`model: "fable"` explicitly, the same way dev/senior-dev dispatches already do. This includes
one-shot grooming/harvest subagents, not just standing PO teammates.
