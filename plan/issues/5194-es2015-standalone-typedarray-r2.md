---
id: 5194
title: "ES2015 standalone typedarray — r2 residual pass (post-#5188 clustering)"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
---

# #5194 — typedarray r2: cluster and fix the 461 residual failures

## Problem

State after the 2026-08-29 session (wave 1 #5138 via PR #5179, second pass +49
via PR #5213, IterRec delegation + #1058 fix-forward #5188 via PR #5244),
measured on the #5244 tree (#5188 Results table): the 540-entry re-verified
target list `wp-typedarray-current-fails` stands at **58 pass / 461 fail /
21 compile_error**. Before #5188 the whole list was opaque (534/540 compile
errors); the residuals are now visible as ordinary conformance gaps and have
NOT yet been clustered.

Known residual defects recorded by the #5188 implementer (its Follow-ups):

- The delegation adopt-arm covers the canonical `$Vec` carrier only, not the
  vec-family carriers — part of the ~500-test TypedArray ctor-arg factory
  lever is still gated.
- Object-literal computed `@@iterator` delegation
  (`{ [Symbol.iterator]: function () { return src[Symbol.iterator](); } }`)
  still throws — different lowering from the post-hoc assignment form.
- Symbol-keyed method calls on plain objects return `undefined`
  (`obj[Symbol.iterator] = fn; obj[Symbol.iterator]()`).

## Implementation Plan

This issue was reserved for the aborted wave-8 planning stage; the r2 plan
still needs to be WRITTEN by a planning pass before implementation
(plan/implement split, project-lead order 2026-08-15).

- Step 0 — regenerate the residual list on current main. `.tmp/` lists are
  gitignored and absent in fresh clones: re-run the standalone probe
  (`runTest262File(abs, cat, 20000, "standalone")` per
  `tests/test262-runner.ts`) over `built-ins/TypedArray*` and record
  pass/fail/CE. Fresh worktrees need the `.test262-cache` symlink or
  quickjs-tier tests fail spuriously.
- Step 1 — cluster the failures by error signature into file:function root
  causes; write the cluster table INTO this file as the implementation plan
  (start from the three known defects above).
- Step 2 — implement per cluster (Opus implementer, isolated worktree),
  re-probe the list, spot-check lists stay green.
- Step 3 — five ratchet gates + equivalence gate per repo protocol.

## Acceptance criteria

- Cluster table with measured counts lands in this file before implementation.
- Net gain ≥ +150 on the regenerated typedarray residual list; compile_error
  count ≤ 10.
- Spot-check lists green; equivalence gate green; ratchet gates green.

## References

- #5138 (wave-1 plan + cluster method), #5188 (IterRec delegation + #1058
  fix-forward; Results table is the baseline for this issue).
- PRs: #5179, #5213, #5244.
