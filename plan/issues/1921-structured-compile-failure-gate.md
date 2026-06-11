---
id: 1921
title: "Replace the 'Codegen error:' string-prefix compile-failure gate with structured severity"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
---
# #1921 — Structured compile-failure gate

## Problem

Whether a codegen diagnostic **fails the build** is decided by a string
prefix: `compiler.ts:731` bails only when a message
`startsWith("Codegen error:")`. The consequences:

- A plain `reportError(..., "Unsupported expression: X")`
  (`src/codegen/expressions.ts:1274`) pushes a severity-`"error"`
  diagnostic, the expression compiles to `null`, the stack balancer patches
  the hole with a default value (#1918), and `compileCore` still returns
  **`success: true`** (`compiler.ts:877`) with the wrong value baked in.
- 177 `reportError` sites; ~118 "Unsupported …" messages are on the soft
  path. Failing vs silently degrading depends on whether the author
  remembered the magic prefix.
- `generateModule` wraps the whole pipeline in one try/catch that flattens
  any exception into a single locationless "Codegen error"
  (`index.ts:1576-1578`).

`CodegenError` already has a `severity?` field (`context/errors.ts:29-36`) —
the gate just doesn't use it.

## Proposed approach

1. Gate on severity, not message text: any `severity: "error"` diagnostic ⇒
   `success: false`. Introduce `severity: "degrade"` for the (few,
   deliberate) cases where compile-with-fallback-value is intended, each with
   a tracking-issue reference (mirror the host-import allowlist discipline).
2. Sweep the 177 `reportError` sites: classify each as error vs degrade.
   Expect most "Unsupported …" sites to become hard errors; run test262
   sharded CI to quantify the conformance delta and whitelist deliberate
   degrades.
3. Preserve the exception catch-all but attach `lastKnownNode` position
   instead of locationless line 1.

## Acceptance criteria

- `git grep 'startsWith("Codegen error'` is empty; gate reads severity.
- An "Unsupported expression" input returns `success: false` (regression
  test) unless explicitly degrade-listed.
- test262 net impact reviewed and accepted in the PR (some currently-"passing"
  tests may legitimately flip to compile errors — that is the honest result).

## Source

Compiler quality review 2026-06. Direct child of #1858. Related: #1918,
#1853 (hard-error stability bucket).
