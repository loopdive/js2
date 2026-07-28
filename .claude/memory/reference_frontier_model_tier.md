---
name: reference_frontier_model_tier
description: "`model: frontier` on a task means dispatch on a frontier-tier model — Claude 5 Fable (claude-fable-5) or GPT-5.6 Sol (gpt-5.6-sol) — reserved for the hardest codegen/architecture work"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
  modified: 2026-07-19T20:27:16.225Z
---

When a task is tagged **`model: frontier`** (or `[FRONTIER]` in the subject),
dispatch it on a **frontier-tier model**, not the everyday dev model. Frontier
translates to **either** of:

- **Claude 5 Fable** — model id `claude-fable-5` (the top Claude 5 model; note it
  hit a per-model credit limit on 2026-07-19, so it may be temporarily
  unavailable — fall back to Sol).
- **GPT-5.6 Sol** — model id `gpt-5.6-sol` (aka "sol").

Use frontier ONLY for genuinely hard work — deep/novel codegen, cross-cutting
architecture, or problems where a weaker model would thrash (e.g. **Proxy on
standalone #1472**, the closure-member-dispatch/native-string codegen
#3418/#3472, hard oracle/verdict design). Everyday dev tasks stay on the normal
tier (Sonnet 5 `claude-sonnet-5`, or the fast `fable` lane when it has credits;
Opus 4.8 `claude-opus-4-8` for senior-dev conflict/CI work).

Dispatch mapping: an agent spawn for a `model: frontier` task passes
`model: "fable"` (→ claude-fable-5) or the Sol model, per availability. If
claude-fable-5 is credit-limited, route to `gpt-5.6-sol`. Related:
[[feedback_devs_default_opus]] (everyday tier), [[feedback_sonnet_for_sprint_loop]].
