---
id: 6474
title: "Linked test262 harness: the binding prelude's import makes the body a module, changing var scoping"
status: done
assignee: ttraenkler/senior-dev
# (2026-09-15) The fix is one opt-in option threaded end to end, so the growth
# lands in the four files the option must pass through — three of them god-files
# by definition (the public option barrel, the codegen driver that owns
# `ctx.sourceIsModule`, and the codegen options interface). Most of the added
# lines are the WHY comments this issue exists to record: the module goal was
# forced silently, and the next reader has to be able to see that `sourceIsModule`
# is now entry-derived under an opt-in flag and why both switches had to flip.
loc-budget-allow:
  - src/index.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/index.ts::generateMultiModule
sprint: current
created: 2026-09-14
updated: 2026-09-15
completed: 2026-09-15
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: test262-runner
language_feature: modules
goal: test262-conformance
depends_on: [3451]
related: [3451, 2527]
# NOTE: id reserved 2026-09-14 with pr_scan="degraded" — the open-PR scan could
# not reach `gh` from this container, so the id is verified against upstream
# `main` and the assignment ref but NOT against in-flight PRs. The required
# `check:issue-ids:against-main` gate is the backstop.
---

# #6474 — the linked-harness prelude turns every test body into an ES module

## Problem

#3451 slice 3 binds harness names into a test body with a prelude:

```js
import { __h_assert } from "./__js2wasm_harness_stub";
var assert = __h_assert();
```

That `import` makes the body an **ES module**. Test262 scripts are **scripts**:
a top-level `var` is a property of the global object and is visible to code that
never saw the declaration. In a module it is module-scoped.

Measured 2026-09-14 (`language/statements/with`, 12 rows, linked vs honest at
the same commit): 2 verdict differences, both this. `12.10-0-1.js` is the clean
one —

```js
var o = {};
var f = function () { return foo; };   // captures `foo` before it exists
with (o) { var foo = "12.10-0-1"; }
assert.sameValue(f(), "12.10-0-1");
```

Honest: pass. Linked: `Expected SameValue(«null», «"12.10-0-1"»)`.

**It is not a provider or substrate defect.** Reproduced with NO provider at
all: the honest whole-assembly source plus a dummy `import { __g } from
"./__stub"; var __u = __g;` fails identically. The import alone does it.

The same root cause produces `arguments is not defined` and `x is not defined`
rows in the `for-of` sample, and (2026-09-15) `built-ins/Array/prototype/map/15.4.4.19-5-21.js`
(`var global = this; … this === global` — top-level `this` is `undefined` under
the module goal), previously listed as a singleton in #3451's table.

## What a fix has to provide

A way to give a compiled **script** compilation unit bindings that resolve to a
linked provider's exports, without an `import` declaration in the source. The
existing `inferModuleStrictArguments: false` option is the precedent: it already
decouples one module-goal consequence (strictness) from the presence of an
import, so the shape of the answer is likely a sibling option that keeps the
**var-scoping and `arguments`** semantics of a script too, or a codegen-level
binding injection that never touches the source's goal symbol.

## Acceptance criteria

- [x] A linked body's top-level `var` is script-global: visible to a closure
      created before the declaration, and to `with`-introduced declarations.
- [x] `arguments` in a linked sloppy body behaves as it does in the honest lane.
- [x] `language/statements/with` reaches 12/12 linked-vs-honest agreement on the
      first 12 rows.
- [~] The honest lane is byte-identical (the option is opt-in) — true for P1/P2,
      NOT for the P3 residual fix; measured honest delta +1 / −0. See
      "Implementation (2026-09-15, Opus lane)".

## Implementation Plan (2026-09-15, Fable lane; implementation: Opus, AFTER #6477 lands — both edit `compileHarnessLinkedBody`)

### What actually makes the body a module (two switches, not one)

1. The entry's `import { … } from "./__js2wasm_harness_stub"` sets the parser's
   `externalModuleIndicator`; `declarations.ts:2376` and the single-file path
   (`index.ts:5200`) read it.
2. **The multi-file path ignores the file and forces it anyway:**
   `src/codegen/index.ts:10608` — `ctx.sourceIsModule = true` with the comment
   "Multi-file compilation is linked through import/export module records".
   `src/codegen/extern-declarations.ts:706` restates the same assumption ("All
   multi-file inputs are modules, so no cross-file script-global sharing has to
   be modelled"). Removing the `import` alone therefore changes nothing on the
   linked lane; the plan has to flip both.

`ctx.sourceIsModule` readers that carry the script semantics this issue needs
(all found by grep, 2026-09-15): `expressions/identifier-module-storage.ts:185,
200, 240` (var storage — the 12.10-0-1 capture-before-declaration row),
`expressions/unresolvable-assign.ts:85` (undeclared assignment → global-object
property, the "x is not defined" rows), `expressions/this-keyword.ts:86/98` +
`helpers/sloppy-this-global.ts:247` (top-level `this`), `literals.ts:1832`,
`global-environment.ts:85/833`, `expressions/runtime-eval-provider.ts:518`,
`index.ts:9960`. `arguments is not defined` comes from the module-goal early
error / identifier path on `var arguments` — verify it is the same switch by
running the row after step P2 below.

### Fix — opt-in script-goal entry for `compileMulti`; default byte-identical

**P1 — bind harness names without an `import`.**
`src/test262-harness-provider.ts` `harnessBindingPrelude` (~L400): when the row
is NOT a `flags: [module]` test, emit the stub as a GLOBAL ambient declaration
file (no `export` ⇒ the stub itself is a script, and every getter is an ambient
global):

```ts
declare function __h_assert_0879(): any;   // one per referenced getter
```

and the prelude becomes only `var assert = __h_assert_0879();` (plus the
`"use strict";` line for the strict variant). The entry then has no import and
no `externalModuleIndicator`. Keep the current import form for `flags:
[module]` rows — a module test must stay a module. `preludeLines` must still be
right (error-line mapping).

The getter call must still lower to a **provider import**, not `env.global_*`:
a source-level `declare function` is registered by
`src/codegen/extern-declarations.ts` ~L826 ("Top-level declare function stubs —
registered as Wasm imports"). Find that block's `addImport(ctx, "env", …)` and
consult `ctx.linkedPackageBindings.get(name)` first, exactly like `register()`
in `src/codegen/registry/imports.ts:2379`
(`addImport(ctx, linked?.module ?? "env", linked?.field ?? name, …)`), and
make sure the `funcMap` alias the block creates points at the imported index so
`__h_x()` is a direct `call`. The signature is `() -> anyref/externref` as the
import form already produces (compare the `.wat` of one body before/after —
the getter's import type must be identical).

**P2 — let the multi-file path honour a script entry.** Add
`CompileOptions.entryScriptGoal?: boolean` (document next to
`inferModuleStrictArguments`, `src/index.ts:648`; thread through
`src/compiler.ts:829-851` like `linkedPackageBindings`). In
`src/codegen/index.ts:10608`:

```ts
ctx.sourceIsModule = options?.entryScriptGoal
  ? (multiAst.entryFile as { externalModuleIndicator?: ts.Node }).externalModuleIndicator !== undefined
  : true;
```

Set it from `compileHarnessLinkedBody` only. Every other `compileMulti` /
`compileProject` caller keeps `true` ⇒ byte-identical. Then audit the
`extern-declarations.ts:706` `topLevelBindings` per-file exclusion: with a
script entry the harness getters live in the stub file and the body's own
`var assert` is in the entry — the per-file scoping still holds, so this should
need no change; state the reasoning in the issue after checking one body.

**P3 — `recordSourceGlobalEnvironment` (index.ts:10873)** already runs for every
multi-file source, so `globalObjectVarBindings` is populated; confirm the
host-lane (`emitScriptGlobalVarBindings` is standalone-only) reads for a
top-level `var` go through `identifier-module-storage.ts:240`'s
`!ctx.sourceIsModule` arm once P2 is on. If 12.10-0-1 still fails after P1+P2,
the residual is in the `with`-scope write path (`S12.10_A3.11_T3`, listed
separately in #3451's table) — report, do not chase.

### Order and validation

1. Before-state: `TEST262_ORACLE_MODE=linked` vs honest on
   `language/statements/with` (first 12 rows) and the two `arguments` rows
   (`language/expressions/class/elements/{private-,}indirect-eval-contains-arguments.js`)
   via the worker protocol in `plan/issues/3451-…md` ("Re-measured 2026-09-15").
2. P1 alone (still `sourceIsModule = true`): expect no verdict change — record
   it; that is the measurement that justifies P2.
3. P2; rebuild `scripts/compiler-bundle.mjs` + `scripts/runtime-bundle.mjs`
   before measuring.
4. New test `tests/issue-6474-linked-script-goal.test.ts`: (a) the 12.10-0-1
   body passes linked; (b) `var arguments = 1; assert.sameValue(arguments, 1)`
   passes linked; (c) a `flags: [module]` row still compiles as a module
   (prelude keeps `import`); (d) byte-identity control: `compileMulti` of a
   two-file module graph WITHOUT `entryScriptGoal` is byte-identical to main.
5. `tests/issue-3451-*`, `issue-6475-*`, `issue-6476-*`, `issue-6477-*`,
   `tests/multi-file*`, equivalence gate.

### Acceptance (from the criteria above, made measurable)

- [ ] `language/statements/with` first 12 rows: 12/12 linked-vs-honest agreement.
- [ ] Both `arguments` rows flip to agreement.
- [ ] Honest lane byte-identical; `compileMulti` default byte-identical (control test).
- [ ] New row in the #3451 measurement table.

## Implementation (2026-09-15, Opus lane)

### What was implemented

P1 and P2 exactly as planned, plus one unplanned **P3** the measurement forced
(below).

**P1 — bind the harness names without an `import`.**
`harnessBindingPrelude` takes a fourth argument, `moduleGoal` (default `true`,
so the existing callers and `tests/issue-3451-harness-provider.test.ts` are
unchanged). When it is `false` the stub loses its `export` — a `.ts` file with
no import and no export is a **script**, so each `declare function __h_x(): any;`
is an ambient GLOBAL — and the prelude shrinks to the `var` bindings alone. The
entry therefore has no `externalModuleIndicator`. `preludeLines` is derived from
the prelude text, so error-line mapping follows automatically (asserted: the
script form is exactly one line shorter).

`compileHarnessLinkedBody` reads the module-goal signal from
`options.inferModuleStrictArguments`, which the runner already passes as an
explicit per-row boolean (`isModuleGoal` in `tests/test262-shared.ts`) — `true`
only for a `flags: [module]` row. No second option that could disagree with it.

**The plan's "make the `declare function` path consult
`ctx.linkedPackageBindings`" was already done** and needed no edit:
`src/codegen/extern-declarations.ts` routes both its branches through
`registerAmbientParseImport` (`src/codegen/ambient-parse-import.ts`), whose first
two lines are the `linked?.module ?? …` / `linked?.field ?? …` lookup the plan
asked for. Verified by the getters still resolving to the provider after the
import was dropped (the `map/15.4.4.19-5-21` row flips on P1 ALONE, which cannot
happen if the getter fell back to `env.*`).

**P2 — `CompileOptions.entryScriptGoal`.** Documented next to
`inferModuleStrictArguments` (`src/index.ts`), threaded through `src/compiler.ts`
into `CodegenOptions`, and read at `src/codegen/index.ts` where
`generateMultiModule` used to write `ctx.sourceIsModule = true` unconditionally.
Set only by `compileHarnessLinkedBody`. A module entry still yields the module
goal, which is what keeps a `flags: [module]` row correct.

**P3 (unplanned, forced by the wide measurement) — the runtime-eval global
mirror created a NON-writable global var binding.**
`emitRuntimeEvalGlobalBindingPushBody` defines each script `var` on the global
object with writable/enumerable deliberately UNSPECIFIED, so a program's own
attribute change survives a later mirror refresh. On the FIRST definition,
though, "unspecified" means **false** (§10.1.6.3 / the runtime's `applyFlag`),
so the binding was minted `{writable: false, enumerable: false,
configurable: false}` — and the next refresh, carrying a new value into a
non-writable property, threw `Cannot redefine property: <name>` out of
`__module_init`. §9.1.1.4.16 CreateGlobalVarBinding says
`{writable: true, enumerable: true, configurable: false}`, so the old behaviour
was simply wrong; it had just never fired, because the property normally already
exists by the time the first push runs. The script goal removed that accident
for the linked lane. Fix: a new flag **bit 6 (`0x40`)** on
`__defineProperty_value` meaning "apply the spec defaults on CREATION only" —
`src/runtime.ts` fills in `writable`/`enumerable` when `!_hasOwn(obj, prop)` and
changes nothing on a refresh. Emitted for the host lane only, so standalone/WASI
(which decode the flag word in wasm and whose quickjs canary the existing
attributes are load-bearing for) are byte-identical.

### Measurements

All runs: real worker protocol — `runTest262Chunk(0, 1)` in a gitignored
`tests/probe-6474.test.ts`, `COMPILER_POOL_SIZE=1`, `TEST262_PATH_FILTER_FILE`,
`TEST262_ORACLE_MODE=linked` vs unset for honest, both lanes at the same commit,
bundles rebuilt (`build:runtime-bundle` + `build:compiler-bundle`) before every
measurement.

**A. The 15 target rows** (`language/statements/with` first 12 + the two
`class/elements/{,private-}indirect-eval-contains-arguments` rows +
`built-ins/Array/prototype/map/15.4.4.19-5-21.js`). Honest is **15/15 pass**
throughout, so linked pass-count IS linked-vs-honest agreement:

| stage | linked agreement | remaining differences |
| --- | --- | --- |
| before | **10 / 15** | `map/15.4.4.19-5-21` (`Cannot convert object to primitive value`), `with/12.10-0-3` (`dereferencing a null pointer [in __module_init()]`), `with/12.10-0-1` (`SameValue(«null», «"12.10-0-1"»)`), both `arguments is not defined` rows |
| **P1 alone** (`sourceIsModule` still forced `true`) | **11 / 15** | the four above minus `map/15.4.4.19-5-21` |
| P1 + P2 | **15 / 15** | — |
| P1 + P2 + P3 | **15 / 15** | — |

P1 alone moving exactly one row is the measurement that justifies P2: dropping
the `import` fixes the top-level-`this` row (the parser-goal half) and nothing
else, because `generateMultiModule` still forced the module goal for var
scoping, `arguments` and the `with`-scope write.

**B. Regression sample — 471 rows**, every 5th file (sorted) of the five
tractable #3451 sample dirs (`language/statements/for-of`,
`built-ins/Array/prototype/map`, `built-ins/Object/defineProperty`,
`built-ins/Promise/prototype/then`, `language/statements/with`;
`language/expressions/class` excluded — the six dirs are 6,413 files):

| lane | before | after | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| linked, P1+P2 only | 278 / 471 | 286 / 471 | **2** | 10 |
| linked, P1+P2+P3 | 278 / 471 | **289 / 471** | **0** | **11** |
| honest (P3's blast radius) | 370 / 471 | **371 / 471** | **0** | 1 (`with/S12.10_A1.11_T2.js`) |

The two P1+P2 regressions were `with/S12.10_A1.2_T4.js` and
`with/S12.10_A1.3_T4.js`, both `Cannot redefine property: myObj` — the P3 defect
above. P3 removes them and fixes one more linked row and one honest row.

### Deviations from the plan

1. **The plan's `extern-declarations.ts` edit was unnecessary** — the lookup it
   asks for already exists in `registerAmbientParseImport`. Recorded rather than
   re-implemented.
2. **P3 is new work the plan did not anticipate, and it makes the honest lane
   NOT byte-identical.** That is deliberate and measured: the change is
   host-lane-only, spec-correct (§9.1.1.4.16), and moves the honest lane
   **+1 / −0** on the 471-row sample. The acceptance box below is annotated
   accordingly. `compileMulti`'s default is still byte-identical — asserted as a
   test, not asserted by inspection.
3. **P3's audit item** (the `extern-declarations.ts:706` `topLevelBindings`
   per-file exclusion) needs no change, as the plan suspected: that exclusion is
   about **lib-referenced** ambient names, and it is keyed per source file. The
   harness stub declares its getters in its own file and the body's `var assert`
   lives in the entry, so the two never meet; the `libReferencedNames` filter is
   not even consulted for a user file. Confirmed by the getters still lowering
   to provider imports.

### Tests

`tests/issue-6474-linked-script-goal.test.ts` (7 cases): the 12.10-0-1 body
passes linked; sloppy `var arguments`; top-level `this` is the global object;
the prelude drops the import for a script row and keeps it for a module row
(with the stub's `export` and the `preludeLines` delta and equal bindings);
a `flags: [module]` row still compiles with the import form; the P3 bit-6
semantics (creation vs refresh); and the byte-identity control — `compileMulti`
of a two-file module graph is byte-identical with and without
`entryScriptGoal`.

Suites run green: `issue-6474-*` (7), `issue-3451-*` (17 across 3 files),
`issue-6475-*`, `issue-6476-*`, `issue-6477-*`, `tests/multi-file*` — 49 tests
over 8 files. `node scripts/equivalence-gate.mjs`: "No new equivalence
regressions" (22 known failures unchanged). Gates all exit 0: loc, func,
coercion-sites, oracle-ratchet, dead-exports, host-import-policy, typecheck,
lint.

### Acceptance

- [x] `language/statements/with` first 12 rows: **12/12** linked-vs-honest agreement.
- [x] Both `arguments` rows flip to agreement.
- [x] A linked body's top-level `var` is script-global; `arguments` matches the honest lane.
- [x] `compileMulti` default byte-identical — asserted in the new test file.
- [~] Honest lane byte-identical — **no, deliberately**: P3 changes the host-lane
      runtime-eval mirror's CREATION attributes. Measured honest delta on the
      471-row sample: **+1 / −0**. Everything in P1/P2 is opt-in and leaves the
      honest lane untouched; only P3 crosses over, and it had to, because the
      defect it fixes is a real spec violation the script goal merely exposed.
- [x] New row in the #3451 measurement table.

### CORRECTION (2026-09-15) — every number above was taken on a broken base; re-measured

The base carried a bug fixed after this work started: #6477's
`instantiateTest262Module` ran the deferred `__module_init()` unconditionally,
but the sharded worker already calls it itself (#3123), so **every linked row in
the worker ran module init TWICE**. Commit `1c8b440a74` makes the call opt-in
(`runDeferredInit: true`, passed by the in-process callers only) and is
cherry-picked onto this branch; `tests/issue-6474-linked-script-goal.test.ts`
passes it too. **All worker measurements were re-run on the corrected base.**
The numbers in the section above are superseded by these; they are kept only
because the P1-alone/P2 ordering conclusion is unchanged under both.

**A. The 15 target rows.** Honest 15/15 pass throughout.

| stage | linked agreement |
| --- | --- |
| before | **10 / 15** |
| P1 alone (import dropped, `sourceIsModule` still forced `true`) | **11 / 15** |
| P1 + P2 + P3 | **15 / 15** |

Identical to the pre-correction run — the double init did not touch these rows —
so the conclusion stands: dropping the `import` alone buys exactly the
top-level-`this` row, and P2 is what buys the other four.

**B. Regression sample — the same 471 rows.**

| lane | before | after | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| linked | 348 / 471 | **361 / 471** | **2** | **15** |
| honest | 370 / 471 | **371 / 471** | **0** | 1 (`with/S12.10_A1.11_T2.js`) |

(The corrected base is worth +70 linked rows on its own — 278 → 348 — which is
why the deltas differ from the section above.)

**The two remaining linked regressions are NOT the P3 class and NOT fixed by
it** — reproduced in isolation with P3 reverted, so P1/P2 own them:

| row | message |
| --- | --- |
| `built-ins/Object/defineProperty/15.2.3.6-4-258.js` | `0 descriptor should be enumerable; 0 descriptor should be writable; 0 descriptor should be configurable` |
| `built-ins/Object/defineProperty/15.2.3.6-3-185.js` | `Invalid descriptor field: label` |

Both are `verifyProperty` on a CONSUMER-minted value read from the PROVIDER —
`arrObj = [100]` by array index in the first, the descriptor literal itself in
the second. That is #6482's class verbatim (the provider's `arr[name]` lowers to
in-wasm vec access against its OWN types, misses the `ref.test`, and answers a
default; no host-side redirect can see it). The script goal moved these two
values from module globals to global-object properties, which is enough to route
the read down that broken path — it exposes #6482 on two more rows rather than
introducing a new mechanism. Net on the sample is **+13 linked, +1 honest, and
the two known-class rows**; recorded here and belonging to #6482, not chased.

Also re-verified on the corrected base: honest 0 pass→fail, so P3's
non-byte-identical honest-lane change is still strictly an improvement.
