---
id: 1945
title: "Test262 oracle precision — runner discards expected error types and strips undefined-asserts, inflating the headline number"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: compiler-internals
goal: conformance
---
# #1945 — Test262 oracle precision

## Problem

The test262 runner deliberately weakens its oracle in three ways
(`tests/test262-runner.ts`), so the 71.6% headline is an upper bound and
whole bug classes are structurally untestable:

1. `assert.throws(ErrorType, fn)` is rewritten to `assert_throws(fn)` —
   **the expected error type is discarded** (`test262-runner.ts:643-652`).
   Throwing *any* error passes; wrong-error-type bugs (TypeError vs
   RangeError) are invisible. (Parse/early-phase negatives DO check
   `expectedErrorType` — runtime throws are the gap.)
2. `assert.sameValue(x, undefined)` calls are **stripped entirely**
   (`test262-runner.ts:835-923`, "stripped undefined assert").
3. `throw new Error(...)` is regex-replaced with `return 0;`
   (`test262-runner.ts:631-639`).

These were pragmatic bootstrapping rewrites; the compiler has outgrown some
of them (error classes, `undefined` returns, and exceptions all work today
in many configurations).

## Proposed approach

Incremental, measured re-tightening — each step quantified on a full
dashboard run before promotion (expect the pass count to DROP; that drop is
honesty, not regression — coordinate messaging with the PO):

1. `assert_throws` with constructor check where the expected type is a known
   global error class (`TypeError`, `RangeError`, …): compare
   `e instanceof X` host-side (js-host lane) or via the error-tag payload
   (standalone). Land behind `TEST262_STRICT_THROWS=1`; flip default once
   the delta is triaged into real bug buckets.
2. Stop stripping `sameValue(x, undefined)` where the compiled module can
   represent undefined returns (probe-classify, like other runner rewrites).
3. Re-audit the `throw new Error → return 0` rewrite list — narrow to the
   specific harness patterns that still need it.
4. Track the deltas as new failure buckets so the PO can mint issues from
   them (`/harvest-errors`).

## Acceptance criteria

- Strict-throws mode exists and a dashboard run quantifies the delta.
- Runner rewrites are each gated/classified rather than unconditional.
- A "oracle strictness" note on the dashboard explains the number's basis.

## Source

Compiler quality review 2026-06. Related: #1853 (stability bucket), PO
coordination required (headline number will move).
