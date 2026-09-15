---
id: 6474
title: "Linked test262 harness: the binding prelude's import makes the body a module, changing var scoping"
status: ready
sprint: current
created: 2026-09-14
updated: 2026-09-15
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

- [ ] A linked body's top-level `var` is script-global: visible to a closure
      created before the declaration, and to `with`-introduced declarations.
- [ ] `arguments` in a linked sloppy body behaves as it does in the honest lane.
- [ ] `language/statements/with` reaches 12/12 linked-vs-honest agreement on the
      first 12 rows.
- [ ] The honest lane is byte-identical (the option is opt-in).

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
