---
id: 7639
title: "Make a module's top-level functions eval-live only when that module contains a direct eval"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
goal: core-semantics
related: [7530, 6956]
---

# #7639 — eval liveness only in modules that contain a direct eval

## Problem

From the review of [#7530](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7530-same-named-reassigned-functions-share-global) (RV-PR7569, 2026-11-28).
`registerReassignedFunctionGlobals` (`src/codegen/index.ts`) makes a top-level function eval-live (it gets a
`__mod_<name>` live-binding global, and its calls go through it) whenever the program as a whole has an unknown
dynamic source (`runtimeEvalPlan.unknownDynamicSource`). That rule is graph-wide.

In a `compileMulti` or `compileProject` program, a module's own top-level bindings are visible only to a
**direct** `eval` inside that module. Indirect eval and `Function` constructor code run at global scope, so
they cannot rebind a module's functions. A module without a direct eval therefore needs no eval-live functions.

The review names this as the main driver of #7530's lodash-es cost: `compileProject(lodash.js)` grew +1.9 % (gc)
and +2.0 % (standalone) in bytes, and each module's same-named function now pays for its own live value. That
attribution is the reviewer's; it has not been measured separately.

## Acceptance criteria

- A module's top-level function becomes eval-live only when that module contains a direct `eval` that can reach
  it. Script sources (global code) keep today's rule.
- #7530's EV1–EV4 rows (`tests/issue-7530-same-named-reassigned-functions.test.ts`) still pass.
- Measured: lodash-es bytes and compile time before and after (median of three), on gc and standalone.
- Single-file Script output stays byte-identical. The ES5 test262 IR gate shows no pass → not-pass.
