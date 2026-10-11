---
id: 6820
title: "codegen-linear: three `tests/issue-3500*` cases produce a linear binary that fails `WebAssembly.validate` while the result says `success: true`; the linear signature pre-seed still has a bare `catch {}`"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen-linear
language_feature: n/a
goal: correctness
related: [6793, 6776, 3500]
requested_by: ttraenkler/claude-review
origin: "measured by the #6793 implementation (2026-10-02) after surfacing build-stage throws; left for its either-way follow-up and not re-measured by the filer"
---
# #6820 — the linear lane still has two silent-failure paths

## Problem

#6776 made an engine-rejected binary a compile failure on the gc lane, and
#6793 made the linear build stage surface compiler throws. Two paths remain:

1. The #6793 implementation's parity corpus found three cases in
   `tests/issue-3500*.test.ts` where the linear backend emits a binary that
   `WebAssembly.validate` rejects, yet `compile()` returns `success: true`
   (the validation step of #6776 is not applied to the linear output, or is
   applied before the final section rewrite).
2. The linear signature pre-seed pass still wraps its work in `catch {}`:
   a throw there is swallowed and the function is compiled with a guessed
   signature.

## Correction

1. Run the #6776 validation on the final linear binary (same `validateBinary`
   option, same error → `success: false` with the engine's message).
2. Replace the bare `catch {}` with the #6793 build-stage policy: rethrow, or
   at minimum push a `warnings` entry naming the function and the thrown
   message so the demotion is visible.

## Acceptance

- The three issue-3500 cases report `success: false` with the validator's
  message (or compile to valid binaries if the root cause is fixed instead).
- `grep -n "catch {}" src/codegen-linear/` returns nothing; a test asserts
  the warning when the pre-seed throws.
