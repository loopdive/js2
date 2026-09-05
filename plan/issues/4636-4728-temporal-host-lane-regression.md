---
id: 4636
title: "host lane: PR #4728 regressed ~367 Temporal rows — name-keyed class-capture record collision (invalid global.set) + dynamic-ctor over-claim of host-ambient bases (Temporal is not defined)"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-23
updated: 2026-08-23
# The whole diff is the key-derivation helper + the per-declaration re-key at
# the two classMemberCaptureGlobals sites, plus the comment explaining WHY a
# name key is wrong there (five same-named sibling classes in temporalHelpers).
# The record logic itself is #4618's and stays where it is; there is no
# subsystem module for a 10-line key change to move to.
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  # +22: the host-ambient decline in resolvesToDynamicAnyCtorValue must sit
  # inside the same #4616 member-access arm it narrows — a separate module
  # cannot see the arm's claim order.
  - src/codegen/expressions/new-super.ts
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: classes
goal: standalone-gap
related: [4618, 4616, 4506]
origin: "2026-08-23 merge_group run 32621994030 on PR #4781: 367 host-lane regressions, bisected to main's PR #4728 (pure main fails, wave tip passes). Forward-fixed on the campaign branch."
---

# #4636 — #4728 Temporal host-lane regression forward-fix

> **Superseded on merge (2026-08-23, same day):** main's PR #4783 — from the
> #4728 authors — landed the SAME two fixes independently while this branch's
> version was in flight (their record key is the declaration NODE, with a
> type-match guard on the sync; their ctor-arm guard checks the immediate
> base). At the origin/main merge this branch adopted main's versions and
> dropped its own (the stacked duplicate guard was removed). This file stays
> as the record of the independent bisect/diagnosis and its verification.

## Root cause (bisected, both defects verified by single-file repro)

PR #4728 (curated npm-package fixes) landed two host-lane defects that
surfaced as 367 test262 regressions concentrated in `built-ins/Temporal`
(216 `wasm_compile` CompileErrors + ~150 `Temporal is not defined` fails):

1. **`ctx.classMemberCaptureGlobals` keyed by bare class name** (#4618's
   re-compile re-bind). `temporalHelpers.js` declares
   `class MySubclass extends construct` in **five different methods** — four
   capture `let called = 0` (f64), one `let called = false` (i32). The
   name-keyed record made the early-return re-bind sync the boolean frame's
   i32 local into the numeric frame's f64 global:
   `global.set expected f64, found i32` — invalid wasm, the entire
   `wasm_compile` bucket.
2. **`resolvesToDynamicAnyCtorValue`'s #4616 member-access arm over-claims
   host-ambient bases.** `new Temporal.PlainDateTime(...)` has an any-typed
   member (TS lib has no Temporal), so the arm routed it to the
   `__construct_closure` bridge — which compiles the bare `Temporal`
   identifier as a VALUE, and an identifier with no static binding lowers to
   a ReferenceError throw. Pre-#4728 the shape kept the legacy extern-new
   path that resolves the base from globalThis.

## Fix

- `nested-declarations.ts`: `classCaptureRecordKey(className, decl)` —
  per-declaration key (`name@pos`, stable across the two module-init compile
  passes). A same-named SIBLING class now finds no record (pre-#4618
  behavior for the aliased case); a genuine pass-2 re-compile of the same
  declaration still re-binds its own globals.
- `new-super.ts`: the member-access dynamic-ctor arm declines when the
  callee's base-most identifier has no static binding anywhere (no checker
  declaration, not a compiled class/function/module global/captured global)
  — that is a host-ambient global and belongs to the legacy extern-new path.

## Permanent repro references (#2093)

This is a RECORD issue — the shipped code is main's #4783, so the permanent
repros are the regressed conformance rows themselves, re-verified passing in
the host lane on this branch:

- `test262/test/built-ins/Temporal/PlainDateTime/prototype/withPlainTime/argument-string-calendar-annotation.js`
  (the `wasm_compile` class — the composed-module CompileError repro)
- `test262/test/built-ins/Temporal/PlainDateTime/prototype/toString/options-wrong-type.js`
  (the `Temporal is not defined` class)
- `test262/test/built-ins/Temporal/PlainDateTime/prototype/subtract/options-invalid.js`
- `test262/test/built-ins/Temporal/PlainMonthDay/prototype/with/options-invalid.js`
- `test262/test/built-ins/Temporal/ZonedDateTime/prototype/subtract/argument-singular-properties.js`

The #4783-side unit guard lives upstream with that PR (`tests/issue-4618-scoped-same-name-classes.test.ts`
covers the capture-record key mechanism on main).

## Test Results (own runs)

- Composed temporalHelpers module (the real 57KB harness+test unit):
  INVALID → **valid**; the rename-control (`called`→`calledX` in one method)
  was valid on both arms, isolating defect 1 to the name collision.
- The five regressed Temporal rows re-run in host lane
  (`withPlainTime/argument-string-calendar-annotation`,
  `toString/options-wrong-type`, `subtract/options-invalid`,
  `PlainMonthDay/with/options-invalid`,
  `ZonedDateTime/subtract/argument-singular-properties`): all **pass**.
- All 34 `issue-4616-*`/`issue-4618-*` suites (the fixes #4728 shipped):
  **62/62 green** — neither repair regresses what #4728 fixed.
- Wave pins (`issue-4506/4619/4621/4622`): 88 green.

## Residual

The bare-name aliasing of `structMap` for same-named nested class
DECLARATIONS (all five `MySubclass` share one struct entry; members of the
later four are never separately compiled) predates #4728 and is unchanged
here — the fix only stops the re-bind from writing across frames. A
representation follow-up would give nested class declarations scoped
synthetic names like class expressions already get.
