---
id: 4430
title: "Bounded sparse `new Array(n)` + filter holes: standalone IR route emits a non-validating module (in-tree #4222 test failing)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
es_edition: 5
language_feature: array-holes
goal: standalone-gap
related: [4222, 4426]
origin: "2026-08-15 ES5-standalone session — tests/es5-array-new-filter-holes.test.ts case 'claims the bounded sparse route in standalone IR' fails WebAssembly.validate, reproduced identically at merge-base 63785cb."
---

# #4430 — bounded sparse route (standalone IR) emits a non-validating module

## Problem

The COMMITTED test `tests/es5-array-new-filter-holes.test.ts` case
"**claims the bounded sparse route in standalone IR**" (`#4222 —
representation and IR ownership` describe block) fails on current main:
`compile()` reports success but `WebAssembly.validate(result.binary)` is
false. A compile that hands back an invalid binary is strictly worse than a
compile error — the runner records it as CE with an opaque V8 message, and
in production it is a crash at instantiate.

Reproduced identically at merge-base `63785cb` (pre-existing; found during
the #4426 session's regression sweep).

## Implementation Plan

1. Reproduce: `npm test -- tests/es5-array-new-filter-holes.test.ts` — read
   the failing case's compile options in the test (it pins the IR/standalone
   route). Then get the REAL validation error: instantiate via
   `new WebAssembly.Module(result.binary)` in a probe and capture the V8
   message naming the function and instruction (`emitWat: true` on the same
   compile to read the body).
2. Suspect surface: the #4222 bounded-sparse lowering for `new Array(n)`
   holes on the IR path — `src/ir/` lowering for the array-holes route plus
   `src/codegen/expressions/new-indexed.ts` `holeyCarrier` branch
   (`getOrRegisterHoleyArrayType` / `ensureHoleyArrayNew`). Note the #4426
   session added a one-element branch ABOVE the `args.length === 1` length
   lowering in `new-indexed.ts` — confirm the failure predates it (it does —
   merge-base repro) but keep the branch in mind when reading the WAT.
3. Typical failure classes for this shape (check in order): a `struct.new`
   arg type vs holey-vec field mismatch; a `local.set` whose local was typed
   from the non-holey vec while the value is the holey type (sibling-cast
   hazard — same family as the #4426 length-set fix); an IR-emitted block
   type that disagrees with the legacy helper's result type.
4. Fix at the emission site; do not paper over with a stack-balance repair.
5. Verify: the whole `tests/es5-array-new-filter-holes.test.ts` file green;
   `tests/es5-standalone-array-filter.test.ts` green;
   `pnpm run check:ir-fallbacks` unchanged (no bucket growth); scoped
   standalone run over `built-ins/Array/prototype/filter` for collateral.

## Acceptance criteria

- All cases of `tests/es5-array-new-filter-holes.test.ts` pass (the module
  validates).
- No IR-fallback bucket growth; filter-adjacent suites stay green.
