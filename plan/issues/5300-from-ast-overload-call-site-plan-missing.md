---
id: 5300
title: "from-ast: a direct call to an overloaded function has no exact AST-site plan — demotes `call-graph-closure` / `[unpatched-slot]` (the fifth masked issue-3519 test)"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [5262, 3519, 3521, 3518]
requested_by: ttraenkler/orchestrator
---

# Re-diagnosed while un-masking #5262

PR #5530 ([#5262](5262-ir-outcome-accounting-precedence-masks-root-cause.md))
restored four of the five skipped `issue-3519` tests. The fifth —
`counts only executable overload implementations…` — is **not** an accounting
failure. Re-measured with the accounting fix applied it fails on

```
ir/from-ast: direct call to "overloaded" has no exact AST-site plan in run
→ [unpatched-slot]
```

Source: `src/ir/from-ast.ts:6520-6526`. The direct-call lowering requires
`cx.directCalls.get(expr)` to hold a plan for the exact call-site node; when
the callee is a TypeScript **overloaded** function (one or more overload
signatures plus one implementation), the call-graph planner records the plan
against a different node (or against the implementation declaration's
signature rather than the resolved overload), so the site lookup misses and
the unit demotes with `call-graph-closure`. The test's skip comment was
rewritten in place in #5530 to name this cause so the next reader is not sent
back to #5262.

First step for the implementer: establish **which** of the two mechanisms
it is — plan keyed on the wrong node, or plan never created for overloaded
callees — by dumping `cx.directCalls` keys for the fixture; the fix differs.

## Acceptance criteria

1. The fifth `issue-3519` test un-skipped and green; its cause recorded as
   measured (which mechanism).
2. `check:ir-fallbacks`: the `call-graph-closure` unintended bucket must not
   grow; if the planner change moves any playground file, record the per-file
   delta with `--verbose`.
3. Byte identity for programs with no overloaded callees (per-row sha256 on the
   dogfood corpus, both lanes); pinned test red on base; equivalence shards
   clean by name.
4. `check:ir-only` READY not regressed.

## Conflict surface

`src/ir/from-ast.ts` (direct-call lowering) and the call-graph planner that
fills `directCalls` (find via `directCalls` writers in `src/ir/`). Disjoint
from the R2 accounting files.
