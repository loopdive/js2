---
id: 7055
title: "ir: a class nested in a function body fails the compile — prepared implicit constructor without an installed support pair / class method without an exact source slot"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: classes
goal: ir-full-coverage
related: [7014, 3522, 4576, 4679, 2818, 1702]
requested_by: ttraenkler/wave15-traps-ce
---

# #7055 — nested classes hard-fail the compile on the prepared-class route

Found by the [#7014](7014-issue-tests-detector-red-since-july.md) backlog
triage (traps/CE slice). Ordinary programs that declare a class INSIDE a
function body no longer compile (default JS-host target):

```ts
export function test(): number { { const C = class { m(): number { return 9; } }; return new C().m(); } }
// Internal error compiling class expression: prepared implicit constructor C_new has no exact installed support pair

export function test(): number { { let s = 99; class C { m(s: number): number { return s; } } return new C().m(15); } }
// Codegen error: direct declaration compiler omitted skipped class member UnitIds: …class-instance-method…

export function test(): string { class C { m(): string { return typeof this; } } return new C().m(); }
// IR path failed for test: ir/integration: own class method …/ m has no exact source slot
```

Red tests: `issue-2818` × 2, `issue-1702-strict-this` × 2.

## Bisect

- `issue-2818` (both shapes): first bad **d0a39cfd85** — PR #4576
  `claude/ir-3522-class-family` (2026-08-15), last good d6329d8a64.
- `issue-1702` (both shapes): first bad **ff99f2e739** — PR #4679
  `codex/4586-standalone-timer-shim-cutover` (2026-08-21), last good bf8b9390fe.
  (The first error printed by the test, "'this' implicitly has type 'any'", is a
  downgraded TS-2683 WARNING; the error that fails the compile is the
  integration one above.)

## Evidence (2818 shape 1, measured)

In `skipPreparedClassConstructorBody` (`src/codegen/class-bodies.ts`) the
implicit-constructor unit IS in `routing.skipImplicitConstructorUnitIds` (the
preparer claimed it) and `nestedFamilyOk` is true, but at that point
`C_init` and `C_new` have EMPTY bodies and
`programAbiClassCallables.functionForUnit(unitId) !== initFunc` — the prepared
route skipped the direct bodies without having installed its own pair.

## Implementation plan

1. Reproduce each shape with `compile(src)`; dump
   `ctx.irPlanningIdentityContext` / `routing.skipImplicitConstructorUnitIds` /
   the prepared component's installed functions at the
   `skipPreparedClassConstructorBody` call.
2. Find why the nested component's support pair is not installed before the
   containing function's class-body compile: compare the d6329d8a64 vs
   d0a39cfd85 routing for the same source (`git diff d6329d8a64 d0a39cfd85 --
   src/codegen/class-bodies.ts src/codegen/prepared-class-body-cutover.ts
   src/ir/`).
3. Either install the pair before the skip decision, or — if the nested
   class's preparation was demoted after the skip set was frozen — drop the unit
   from `skipImplicitConstructorUnitIds` on demotion so the direct compiler
   emits the bodies (typed demotion, not the `throw new Error`).
4. Same audit for the "omitted skipped class member UnitIds" and "has no exact
   source slot" checks (class METHOD units, #4679).
5. Acceptance: `issue-2818` and `issue-1702-strict-this` fully green on both
   lanes; `issue-3522-nested-class-static` / `issue-4259` no worse; IR fallback
   gate unchanged or lower.
