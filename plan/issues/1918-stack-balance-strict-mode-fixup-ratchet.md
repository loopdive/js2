---
id: 1918
title: "Stack-balance strict mode + fixup ratchet — stop silently patching emitter bugs into wrong runtime values"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1918 — Stack-balance strict mode + fixup ratchet

## Problem

`src/codegen/stack-balance.ts` (2,524 LOC) is a partial reimplementation of
the Wasm validator used to **repair** the emitter's own output. Every repair
it applies is a masked emitter bug, and some repairs are *silently lossy*:

- Wrong-typed branch values are patched with `drop; f64.const 0` or
  `drop; ref.null` (`stack-balance.ts:709-755`) — a compile-time bug becomes
  a silently wrong runtime value.
- `fixBranch` appends drops/defaults for arity mismatches (`:773+`).
- Heuristic inference: `fixCallArgTypesInBody` admits it "only handles the
  common case where the argument-producing instruction is directly before
  the call" (`:1306-1310`); interleaved control flow defeats it silently.
- The pass **returns fixup counts that are computed and then discarded**
  (`src/codegen/index.ts:1571`). Nothing reports, gates, or ratchets them.
- Test coverage of the safety net itself: 176 lines / 10 e2e tests for a
  2,524-line pass; 36 issue files reference stack-balance — it is a
  recurring defect locus.

## Proposed approach

Phase 1 (S — instrumentation):
1. Thread fixup events out of `stackBalance` with location info (function
   name, op offset, fixup kind, from→to types).
2. `JS2WASM_STRICT_BALANCE=1` promotes each fixup to a located warning;
   `=error` makes it fail the compile (for CI experiments / new code).
3. Record per-corpus fixup totals (playground examples — same corpus as
   `check:ir-fallbacks`) into a baseline JSON.

Phase 2 (M — burn-down):
4. CI gate: fail when any fixup bucket **grows** (same ratchet mechanics as
   `scripts/check-ir-fallbacks.ts`, `--update-on-decrease` mode).
5. Fix the top buckets at the emitter; when a fixup kind hits zero, its
   repair arm becomes `throw` (strict by construction).

## Acceptance criteria

- Fixup counts visible per compile (debug) and per corpus (CI artifact).
- `scripts/stack-balance-baseline.json` ratchet wired into ci.yml quality job.
- At least the lossy `drop; const-default` branch arms are warning-visible.

## Source

Compiler quality review 2026-06. Direct child of #1858 (fail-loud audit).
Related: #1917 (the lossy arms it instruments), #1921.
