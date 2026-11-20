---
id: 7380
title: "Prepared path: replace self-authentication (receipts, census, forgery pins, layout audits) with one validator"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: critical
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, backend
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Prepared path: one validator instead of self-authentication

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R3. Numbers below are from that report's section on question 3.

## Problem

The Prepared path re-proves, at many points, that its own in-memory plan was not altered: provider census, support
receipts, "complete source" hash pins, re-planning on use, and a layout audit on every `physicalIndex()` call. The
threat it models is another compiler module forging a plan object. No external input can do that.

Measured cost (see the report for commands and commits):

- Compile time through the strict Prepared entry: a 50-line string program took 436 s before the perf slice and 50 s
  after; 200 lines take 428 s (#7354 "Perf result", 2026-11-17). With the native realm one small program takes about
  18 s; 16 s of it is `PhysicalModuleReservations#verifyLayout` (#7354 "Realm join", 2026-11-19). A full ES5 run at
  18 s per file is about 45 CPU-hours.
- Measured 2026-11-19 on `claude/7354-o`: one object-literal program compiles in 13.0 s; with `#verifyLayout`
  returning at once in 0.60 s, with identical bytes. 80 % of the profile is under proof functions.
- About 38 % of the Prepared-only code (45,600 lines) is proof, by a hand sample (±15); of the last 10 merged
  Prepared PRs' 8,023 added lines, 1,183 were mechanism.
- `tests/issue-3518-runtime-program-relocation.test.ts` fails 298 of 298 on main unnoticed.
- Slice D1's first cut broke 150 receipt tests by moving a pass; PR #7268 needed five review rounds on forged plan
  objects; 9 of the 10 merged Prepared PRs record a NOT MET review round.
- Every new intrinsic edits closed lists and hash pins in several files (slice T, `js.value.to_boolean`: 17 files, a pinned list
  length and a pinned SHA-256 of the table text).

## To decide

- The invariants that must hold at each stage boundary (lowered IR, legalized IR, physical plan, emitted module),
  written once as a validator that runs in tests and CI, plus `WebAssembly.validate` and a differential run.
- Which existing checks are that validator already, and which only re-prove object identity or source hashes.
- Whether audits become a debug/CI flag or are deleted; what happens to the "complete source" SHA pins and the
  forgery tests (delete, or freeze as historical).
- Exhaustiveness of kind/intrinsic tables by a TypeScript `never` check instead of counted pins.

## Acceptance criteria

1. Compile time through the Prepared entry is linear in program size; the #7354 proving programs compile in under
   1 s each and a 200-line program in under 5 s, with the realm reserved.
2. Adding one intrinsic or value kind touches its definition, its provider and its tests; no hash or count pin.
3. A seeded set of invalid plans (wrong type, missing provider, out-of-range index) is rejected by the validator.
4. Prepared-path output bytes for the existing proving programs are unchanged.
5. Code quality: the validator is one module per stage; the removed machinery is deleted, not bypassed.
