---
id: 7243
title: "IR prepared class components cannot carry the dynamic carrier ops (`box`, `__ir_dyn_call_box`, `dyn.construct`): members demote at `late-preparation-unsupported`"
status: ready
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7242, 7227, 7233, 5297, 7106, 2949, 3522, 3523]
assignee: "ttraenkler/c-lead"
# (2026-11-05) +5 lines in index.ts: two imports, the overlay-member set and
# its filter in `planIrFirstBodyRouting`, and the multi-source plan drop in
# `makeMultiIrSafeSelection`. The logic lives in ir-imported-call-planning.ts;
# these are the call sites.
loc-budget-allow:
  - src/codegen/index.ts
---

# #7243: the prepared class component has no Program ABI identity for dynamic ops

## Problem

A free function or module-init unit whose IR body uses the dynamic carrier
(`box`, `__ir_dyn_call_box`, `dyn.construct`, `dyn.to_number`, …) gets its
helper bindings named during dependency preparation
(`prepareDynamicInstructionSupportForUnits`, `src/ir/prepared-dynamic-support.ts`,
#5297) and seals as a prepared component. A **class member** body that does the
same does not: #7242 measured that minting the value plan for `new
Test262Error()` inside a class member makes the member's prepared class
component fail `resolve:late-preparation-unsupported` ("prepared component …
has incomplete dependencies"), because the component has no Program ABI
identity for those ops. The failure is per component, so it can demote sibling
members too. #7242 therefore made the selector refuse the construct inside class
bodies (`irSelfGuardedConstructorValue`, `src/codegen/ir-dynamic-construct.ts`).

What this blocks, measured on the harness-wrapped ledger (#7240, standalone):
- 3 class-member rows in the stride sample, and the 35 `extends Iterator`
  members whose body is `throw new Test262Error()` (#6583 notice 6655440988);
- every future class-member admission that needs a dynamic value: #7227's
  unannotated-JS-instance-return fallback (172 `extends Iterator` members once
  #7235 lands), dynamic parameters in methods, `this.#m(42)` with an untyped
  `#m` (#7233's second bucket).

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Reproduce and locate first.** Take a minimal class whose method body is
   `throw new Test262Error("x")` with the harness-style self-guarded
   `Test262Error` in the same file, on standalone. Temporarily let
   `irSelfGuardedConstructorValue` answer yes in a class body (do not commit
   that) and capture the exact `late-preparation-unsupported` failure list
   (`component.failures`: code + detail + bindingId). Then find where free
   functions get what the class member lacks. Candidates, in order:
   - `prepareDynamicInstructionSupportForUnits`: is the class-member terminal
     unit in `entries` at all, with `classMember: true`, and does the
     `functionObjects` / `native` / `carrierValType` gating pass for it?
   - `prepared-component-sealing.ts`: the class-member callable handle comes
     from `ctx.programAbiClassCallables.handleForUnit`; check whether the
     dynamic helper bindings (`__ir_dyn_call_box`, `box`, the construct
     driver) are planned into the **class** component scope the same way the
     source-callable scope plans them (`stagePreparedComponentBatch`,
     `callableImports` / `callableProviders`).
   - `derivePreparedComponentDependencies`: whether the class component's
     structural references include the dynamic helper symbols.

   Write the finding into this file and commit it before coding.
2. **Give the class component the same dynamic-helper identities a free
   function gets.** Reuse the existing planning path; do not add a second
   helper table. Whatever `prepareDynamicInstructionSupportForUnits` names for
   a source callable must be named for a class member through the same
   function, keyed by the class component. If the class-callable allocator
   (`program-abi-class-callable-planning.ts`) itself needs a change, **stop
   and report**: that file is in the Shepherd's in-flight getter repair
   (#6583 comment 6643828467) and must not be edited from this issue.
3. **Then let the selector admit the construct in class bodies again**: revert
   #7242's class-body refusal in `irSelfGuardedConstructorValue`, but only
   when step 2 is proven on the stride and the sibling-demotion risk is
   measured to be zero (route dump: no member loses IR).
4. **Do not touch**: `dynamicUsesAreMoveOnly`, async/generator lanes, the
   Shepherd's getter-callable files (`class-bodies.ts`,
   `closures/method-trampolines.ts`, `program-abi-class-callable-planning.ts`,
   `method-receiver-this.ts`, `property-access-exact-shapes.ts`; reading is
   fine), `scripts/*-baseline.json`.
5. **Never worse than legacy.** On gc, standalone and wasi, probe class
   members that: throw `new F()`; return `new F()`; use `new F()` as an
   `instanceof` operand; call a method on the result; mix an IR member that
   needs the dynamic op with legacy siblings (getter, async method); are
   static and instance; are called via `.call({})` on a foreign receiver (the
   #7235 shape — must be no worse than base).

## Acceptance criteria

- Wrapped ledger A/B (stride 40, standalone) in the PR body: class-member IR
  units rise (the 3 stride rows at least), `late-preparation-unsupported` does
  not rise, 0 invariants, `compileOk` not lower. Raw ledger A/B too.
- Route dump: no unit loses IR; name every unit that changes.
- Typed corpus byte-identical on gc, standalone and wasi, or every changed
  binary explained.
- test262 A/B on the route-changed files plus a sample, standalone: no test
  that passes on base fails on head.
- Test: `tests/equivalence/issue-7243-prepared-class-component-dynamic-ops.test.ts`
  asserting the IR route (`trackIrOutcomes`) for a class member with
  `throw new F()` / `return new F()`, and the node/base result on 3 lanes.

## Findings (step 1, 2026-11-05)

**Reproduced** (standalone, base `8442217690`, scratch patch: the planner also
mints S3c value plans for selected class-method owners, and
`irSelfGuardedConstructorValue` answers yes in a class body). Probe: a
harness-style self-guarded `Test262Error` (legacy: `message || ""` is
`logical-value-unsupported`) and `class A { m() { throw new Test262Error("x"); } }`.
`A_m` fails `resolve:late-preparation-unsupported` with exactly these
`component.failures`:

| code | detail |
| --- | --- |
| `implicit-support-reference-unavailable` | IR callable signature resolves backend callable/type support without a symbolic Program ABI ref |
| `foreign-source-unit` | unit-bound reference to `Test262Error`'s top-level-function unit, a non-candidate terminal (the cached function-value accessor executes support owned by its target, `recordFunctionValueAccessorOwner`) |
| `implicit-support-reference-unavailable` | IR dynamic carrier resolves backend type/helper support without a symbolic Program ABI ref |
| `unplanned-abi-binding` | `runtime\|__ir_dyn_call_box` has no Program ABI identity |
| `implicit-support-reference-unavailable` | `box` resolves dynamic carrier/helper support without an explicit symbolic ref |
| `implicit-support-reference-unavailable` | `dyn.construct` resolves dynamic carrier/helper support without an explicit symbolic ref |
| `unplanned-abi-binding` | class layout of `A` (normally staged by the batch; here the batch is refused because the other failures are not batchable) |

`prepareDynamicInstructionSupportForUnits` does see the member (`classMember:
true`, `functionObjects` true, native, externref carrier), names `box`, and
then blocks the whole terminal because it has no arm for `dyn.construct`.

**Where free functions get what class members lack: they do not get it.** The
same body as a free function (`function f(x) { if (x) throw new
Test262Error("x"); }`) never reaches the sealed prepared population at all:
`selectR2PreparedOwnerComponents` withdraws it at admission with
`function-value-reference` (`containsTopLevelFunctionValueReference`, an
unprepared top-level function value), and it compiles to IR on the unsealed
post-direct overlay (`compileIrPathFunctions` without
`sealPreparedComponents`), which needs no Program ABI identity for the dynamic
ops. Class members never run the R2 admission predicates ("their admission
never ran the R2 signature proofs"): a selected, preparable member always
enters the sealed population, so it must seal or demote. Even with
`dyn.construct` named, the `foreign-source-unit` edge stays: in the harness
`Test262Error` is legacy, so no sealed component may execute its value
accessor. Naming more helpers in the sealed lane therefore cannot admit these
members while `Test262Error` is legacy.

**Design (revised).** Give class members the free-function route, not a second
helper table: a selected member whose body carries an S3c self-guarded
constructor value plan is kept out of the sealed prepared class population and
stays on the post-direct overlay, exactly as the `function-value-reference`
withdrawal does for a free function. The overlay already compiles ordinary
members (the late-feature gate in `planIrFirstBodyRouting` keeps them there
today). Changes: `planIrImportedCalls` mints the S3c value plan for selected
class-method owners (value uses only; receiver and stored uses keep their base
route); `planIrFirstBodyRouting` leaves those members out of the prepared
`classIds`; `irSelfGuardedConstructorValue` drops the class-body refusal. Scratch
check: with both, `A_m` emits on the overlay and returns the node result on gc
and standalone. No Shepherd file changes.
