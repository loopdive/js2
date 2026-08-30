---
id: 5189
title: "21 test files with hand-rolled import objects rot on every import-surface change — 117 tests failing on main (string_constants, #4157), plus 2 genuine defect suspects"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: tests
related: [5172, 4157, 5164]
origin: "2026-08-29 comma-operator.test.ts rot triage (PR #5227) — the 5-row 'regression' was 3-week-old instantiation rot"
---

# #5189 — hand-rolled import objects: a 117-test rot class

## Problem

`tests/comma-operator.test.ts` failed 5/5 on main and framed the most recent
comma-related merge (#5164 / PR #5211) as the cause. Measurement (PR #5227)
proved otherwise: every failure was **instantiation** rot — the file's
hand-rolled import object (`env.console_log_*` only) lacks the
`string_constants` import that commit `6786454b4f` (#4157, constant boxing
hoisted to module globals, 2026-08-08) made mandatory for every module (even
literal-free modules import the pool carrying export names). Compilation
succeeded; instantiation threw; the test read as a comma bug.

Sweep of the idiom (hand-rolled imports, no `buildImports`) on main
`ddab1b0743`: **21 files, 18 failing, 120 failed / 55 passed (175 tests)** —
117 of the 120 are this identical rot. None of these files run in CI (not in
guard-suite.json, not issue-* changed-root selected), so the rot is invisible
until fix-on-touch arms one — at which point it frames whoever touched it
(the #5172 blind-spot class; this is its largest known instance).

## The 3 non-rot failures — genuine defect suspects, triage separately

- `tests/typed-array-basic.test.ts` — Float32Array/Uint16Array `Compile
  failed` (not an import problem).
- `tests/issue-328.test.ts` — array holes: `Compile failed` **plus one
  genuine wrong answer** (`expected 10 to be 15`) — a possible live
  array-holes miscompile on main; verify against Node and legacy before
  anything else.

## What to do

1. Sweep the 18 rotted files onto `buildImports(...)` (the fix pattern PR
   #5227 applied to comma-operator.test.ts), fix-on-touch: every touched file
   fully green. Batch in small PRs (2-4 files) to keep changed-root runtime
   bounded.
2. Triage the two suspect files as their own investigation: reproduce, A/B
   legacy vs IR vs Node, classify compile failures, and file/fix per finding
   (the issue-328 wrong answer first — a silent wrong answer outranks rot).
3. Feed the systemic gap back to #5172: CI never runs these files; the
   fix-on-touch ratchet is the only enforcement, and it fires at the wrong
   person. #5172 owns the selection-gap decision (guard-suite widening vs a
   scheduled full-root run).

## Acceptance criteria

- The 18 rotted files green under `buildImports` with fix-on-touch honored.
- Both suspect files dispositioned (fixed, or filed with runtime evidence).
- Ratchet gates chained bare before each commit.
