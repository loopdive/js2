---
id: 3962
title: "feat(codegen): host-free `x instanceof <user function constructor>` — retire the `env::__instanceof_check` sole-import leak"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
goal: standalone-gap
assignee: ttraenkler/s78-sendev
created: 2026-08-01
completed: 2026-08-01
related: [2961, 2916, 1473, 1536c, 2660, 1472]
# +5 lines on identifiers.ts: ONE import and a four-line dispatch. All of the
# new logic (both membership arms, the safety argument, the spec citations)
# lives in the NEW subsystem module `src/codegen/native-user-instanceof.ts`;
# what remains in the god-file is the call that decides which path to take,
# which by definition has to sit at the dispatch site.
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
---

# #3962 — native `instanceof` for a plain user function constructor

## Problem

`x instanceof F`, where `F` is a plain function declared in the module, took
the fully-dynamic path (`emitDynamicInstanceOf`, `src/codegen/expressions/identifiers.ts`)
and emitted the `env::__instanceof_check` host import. Under `--target
standalone` that import is unsatisfiable, so the module cannot instantiate and
the #2961 leak guard refuses the test outright.

Note that **#2961 is the guard, not the bug** — it was working correctly. There
was no implementation issue for the underlying gap until this one.

## Population — a bound, not a floor

Standalone baseline `20260801-010858`, ≤ES5 scope (`es5id:` frontmatter),
denominator **8,115**:

- **99** rows cite `__instanceof_check`; **87** name it as their **SOLE** host
  import.
- In the ≤ES5 scope: **36 rows, all 36 sole leaks.**

Because every ≤ES5 row is a *sole* leak, 36 is a **complete bound** on what a
native implementation can flip in that scope — not an underestimate. (The
opposite was hypothesised, on the reasoning that `instanceof` is an assertion
primitive used all over test262 and so should flip tests far outside its own
directory. The sole-leak qualifier is what settles it: a row whose refusal
names other imports too will still be refused after this change.)

**RHS shape breakdown of the 36** (a file may use several):

| RHS | files |
| --- | ---: |
| `Test262Error` | **26** |
| `TypeError` | 15 (already native — #1473) |
| `Object` | 4 |
| `FACTORY` (a `Function(...)` result) | 4 |
| `OBJECT` | 3 |
| `MyFunct` / `Function` / `FAKEFACTORY` / `this` / comma-expressions | tail |

So the dominant shape is `e instanceof Test262Error` — the harness's own
top-level plain-function constructor — and the work is "handle a plain function
constructor whose prototype chain is statically reachable", not "implement
general reflective `instanceof`".

## Implementation

`src/codegen/native-user-instanceof.ts` (new). §7.3.20 OrdinaryHasInstance has
two host-free representations, so membership is the OR of two tests:

1. **Bespoke struct** — a fnctor whose body assigns `this.x = …` lowers to a
   dedicated `$__fnctor_<F>` WasmGC struct, so membership is an exact
   `ref.test` on that type index. Plain functions have no subtyping, so the
   test is precise.
2. **`$Object` with a real `[[Prototype]]`** — the #2660 S3a reconstruct lowers
   an approved `new F()` to `__object_create(F.prototype)`, seeding
   `$Object.$proto` from the **same** per-fnctor prototype global this module
   reads. Membership is then literally the spec's chain walk, which the native
   `__isPrototypeOf(proto, value)` helper (#1472 Phase C) already performs.

No new runtime code: both helpers already exist and are DEFINED (not imported)
in standalone. Type indices are rec-group / dead-elim stable and module globals
are append-only, so neither arm carries a funcidx-shift hazard. A primitive LHS
answers `0` without touching either arm (§7.3.20 step 3), and `ref.test` on a
null / non-matching `anyref` is `0`, so no arm can trap.

Scoped to **plain function constructors**: classes are declined (`ctx.classSet`)
because class instances carry richer identity — brands, builtin parents — that
these two arms do not model.

### Why a native answer here cannot regress a passing test

The same safety argument #2916 makes for `nativeBuiltinInstanceOfTypeIdxs`: the
branch runs **only** under `noJsHost`, where the operand shape it replaces
*always* leaked `__instanceof_check`. A leaking module cannot instantiate, so
every test reaching this path already fails. A native answer can only CONVERT a
failing test. The JS-host lane never enters the function and is byte-identical.

## Measurement

Paired per-file A/B in one process (kill switch `JS2WASM_NO_3962` read at
lowering time, **removed before commit**, probes re-verified after stripping),
rows appended per file. Denominator **36** — the complete ≤ES5 sole-leak
population.

| result | files | of 36 |
| --- | ---: | ---: |
| import count drops to **0** | **26** | 72 % |
| …of which pass on merits | **18** | 50 % |
| …of which fail for unrelated reasons | 8 | 22 % |
| still leaking (declined shapes) | 10 | 28 % |

**Verdict agreement: 36/36.** Every file returns the identical verdict with the
host `__instanceof_check` satisfied (base arm) and with the native lowering and
no imports at all (new arm). The native answer never disagrees with the JS host
on this population — the strongest correctness evidence available short of CI.

**Expected CI delta: +18 of 36.** This is a *derivation*, not a direct local
measurement, and the distinction matters. `runTest262File` — the local
instrument — does **not** apply the #2961 refusal; only the CI worker does
(`scripts/test262-worker.mjs`: `if (target === "standalone" &&
compileMetadata.imports?.length > 0) → compile_error`). So locally the host
import is satisfied and the tests already run on their merits, which is why the
local pass/fail A/B is **+0 / −0** and why that zero is *not* the flip count.
The derivation is: CI refuses all 36 today; after this change 26 emit no
imports, so the refusal cannot fire for them, and their real verdict — which
the local run does measure — is 18 pass / 8 fail.

**The 10 that still leak are correctly declined, not missed:**

- `S15.3.5.3_A3_T1/T2`, `S15.3.5.3_A2_T2/T5/T6` — `FACTORY = Function("…")`, a
  **dynamic `Function` constructor**, so there is no module-level function
  declaration to test against. Needs runtime-eval; out of scope.
- `S11.8.6_A6_T1` — RHS is `this`; `S11.8.6_A2.4_T1/T3` — RHS is a comma
  expression `(object = {}, Object)`; `S11.8.6_A2.1_T1` / `A6_T4` — RHS is
  `Object`. Non-identifier or builtin RHS; the fully-dynamic path keeps them.

All ten are inside `language/expressions/instanceof` itself.

## Acceptance criteria

- [x] `x instanceof <top-level plain function>` emits no host import in standalone
- [x] A fnctor instance IS an instance of its ctor; a cross-ctor test is false
- [x] A native engine error is NOT an instance of a user fnctor
- [x] Verdict agreement with the JS host over the whole gated population
- [x] Population enumerated with denominators; the sole-leak bound stated
- [x] Declined shapes enumerated with reasons rather than left unexplained
