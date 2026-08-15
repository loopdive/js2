---
id: 4456
title: "Same-named nested function declarations in different scopes alias to ONE closure value (R8 of #4437 — correctness bug)"
status: done
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
completed: 2026-08-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: function-declarations
goal: standalone-gap
related: [4437, 3123, 3316, 4133, 4134, 2976, 3419]
# (#3102) The fix's logic all lives in the new subsystem module
# `src/codegen/nested-function-name-scope.ts`, and the shadow stack is held in a
# module-private WeakMap specifically so `context/types.ts` does NOT grow (it is
# back at its baseline 3831 exactly). What remains here is irreducible wiring:
# the two shadow calls have to sit AT the hoist gates they correct, and the
# scope wrapper has to sit around the body compile it delimits. +36 lines.
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
# (#3400) Two genuine +10/+16 growths, both irreducible wiring: the shadow
# calls must sit AT the hoist gates they correct, and the try/finally must
# bracket the body compile it delimits.
#
# The third is a RENAME, not new code, and the numbers are measured, not
# asserted: on base `compileNestedFunctionDeclaration` was 1053 lines; it is now
# a 13-line scope wrapper plus `…InScope` holding the identical 1053-line body.
# The gate sees the new key cross the 300-LOC threshold and reports "+753"
# because the old key vanished. Real delta: zero new code — and the exported
# entry point went 1053 → 13.
func-budget-allow:
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
---
# #4456 — nested same-name function declarations alias

READ FIRST: #4437's issue file R8 (the repro: two functions each declaring a
nested `function inner(){...}` with different bodies — both outer functions
return the SAME closure value, and calls run the wrong body).

## Root cause — NOT the closure-mint keying

The issue as filed suspected the closure mint (`nestedFnClosureArtifacts` /
`__fn_closure_<name>`, by analogy with `ensureMethodClosureSingleton`). That
was measured and is **wrong**, and the correction matters because fixing the
mint would have produced a *more convincing* wrong answer rather than a right
one.

Disassembling the base module for the R8 repro shows exactly **one**
`(func $inner …)` and one `$__fn_tramp_inner_cached`. There is only one closure
because there is only one **function**. `ensureFuncClosureSingleton` has
disambiguated by call TARGET (walking `<name>$1`, `<name>$2`, …) since #4133,
so the mint was already per-target; it had nothing to disambiguate.

The real defect is one scope up: **`ctx.funcMap` — and the ~dozen side tables
keyed alongside it — is a flat, permanent, bare-name namespace**, while a
nested `function` declaration is a *lexically scoped* binding. The hoist gate
in `statements/nested-declarations.ts`

```ts
if (!ctx.funcMap.has(funcName) || reservedEntry) { … compile … }
```

reads "already compiled" for the second declaration and **skips it entirely**.
`Q`'s `inner` was never compiled, so `Q` returned `P`'s function.

The decisive evidence that this was never about closures: the shape where
**neither declaration escapes its scope** —

```js
function P() { function inner() { return 5; } return inner(); }
function Q() { function inner() { return 7; } return inner(); }
```

— mints no closure at all and *still* returned `5, 5` on base.

### Why the capturing case looked healthy

A capturing nested function receives its captures as leading **parameters**, so
two same-named declarations whose bodies are `return a` in frames holding
`a = 1` and `a = 2` yield the right answers from ONE shared physical function.
Measured on base: that shape "passed", while `return a * 10` / `return a + 10`
failed identically to the non-capturing case. **"Case B passes" must not be
read as "captures are safe"** — every probe below therefore uses bodies that
differ by more than the capture.

## The fix

New module `src/codegen/nested-function-name-scope.ts` — lexical scoping for
the bare-name function namespaces, in three parts:

1. **Shadow** (`shadowNestedFuncName`, called from the two hoist gates in
   `statements/nested-declarations.ts` — the Phase-0 capturing-sibling
   reservation and the compile loop). When a body's hoist claims a name already
   owned by a *different* declaration, the previous registration is pushed onto
   a module-private per-context stack and the name is freed across the whole family
   (`funcMap`, `funcMapOwnerDecl`, `nestedFuncCaptures`, `funcOptionalParams`,
   `funcRestParams`, `closureMap`, `functionNameMap`, `nestedFnClosureArtifacts`,
   `funcUsesArguments`, `asyncFunctions`, `generatorFunctions`,
   `preRegisteredBodyless`, `hoistFailedFuncs`). That family list is the one the
   Annex B distinct-body path (`statements.ts`) already vetted for exactly this
   "compile a distinct body under a temporarily-freed name" purpose.
2. **Restore** (`endNestedFunctionNameScope`) at the end of the enclosing body's
   compilation — `compileNestedFunctionDeclaration` (wrapped in a try/finally
   around a new `…InScope` inner) and both `compileFunctionBody` body-compile
   arms in `function-body.ts`. Unwind is LIFO.
3. Nothing else. Callers that do not open a scope degrade to the pre-#4456
   behaviour for their names — sound partial adoption, no crash, no invalid
   module.

The stack lives in a `WeakMap<CodegenContext, …>` inside the new module rather
than as a `CodegenContext` field: nothing outside the module may touch it, and
it keeps `context/types.ts` (3,831 lines, under the #3102 budget) at exactly its
baseline. The lookup runs once per function-like body. Byte-identity over the
100-file control sample was re-measured after that refactor and is unchanged
(200/200).

### Order-preservation / ABI constraints honoured

- **Closure-capture ABI (#3123) and the hoist-time seed (#3316):** untouched.
  The shadow moves NAMES only; it never touches `ctx.mod.functions`, funcidx
  assignment, capture lowering, or the leading-capture parameter layout. Both
  suites' failures are byte-for-byte the same base and fixed (below).
- **`ctx.funcClosureGlobals` / `__fn_tramp_<name>_cached` are deliberately NOT
  in the saved family.** `ensureFuncClosureSingleton` owns that namespace and
  resolves it per call target. Freeing the cache global while leaving the
  trampoline in `funcMap` would present that helper with a HALF-registered
  pair, which it correctly refuses (`return null`) — turning a working closure
  read into a declined one.
- **Funcidx stability / `addUnionImports`:** unaffected. Every reference emitted
  while a shadow is live was already resolved to a raw index; restoring a name
  cannot retarget an emitted `call`.
- **`__`-prefixed names are excluded**, so a user declaration can never displace
  `__box_number` and friends mid-emission.

## Shape-variant alias matrix (base → fixed)

Bodies are distinguishable throughout; `12` means "both scopes ran their own
body". Probes: `.tmp/probe-4456.mts`, `.tmp/probe2-4456.mts`,
`.tmp/probe3-4456.mts`; pinned permanently in `tests/issue-4456.test.ts`.

| # | shape | base | fixed |
|---|-------|------|-------|
| A2 | R8 repro, identity + bodies | `100` (aliased, both ran `5`) | `123` ✅ |
| J | direct call, no closure minted | `11` | `12` ✅ |
| B2 | both capture, bodies differ beyond the capture | `10` | `12` ✅ |
| N2 / N3 | one captures one not, both orders | `10` | `12` ✅ |
| I2 | same name, different arity | `10` | `12` ✅ |
| P2 | each recurses into itself | `10` | `12` ✅ |
| Q2 | inside loop bodies | `10` | `12` ✅ |
| R2 | three levels of nesting each | `10` | `12` ✅ |
| S2 | inner shadows an OUTER same-named one; outer must survive | `10` | `12` ✅ |
| F | nested at different depths | `111` | `12` ✅ |
| H | three same-named declarations | `211` (all aliased) | `124` ✅ |
| K | object-literal method owners | `111` | `12` ✅ |
| U2 | top-level function owners | `10` | `12` ✅ |
| V2 | arrow owners | `10` | `12` ✅ |
| X2 | top-level owner vs nested owner | `10` | `12` ✅ |
| C2 / D2 | same-frame: two blocks / if-else (#3419, Annex B) | `12` | `12` (control) |
| E2 | same-named function EXPRESSIONS | `12` | `12` (control) |
| L / T2 | different names / identical bodies | `12` | `12` (control) |
| O | `.name` on both | `11` | `11` (control) |
| **Y2 / G** | **nested shadows a CONSTANT-FOLDABLE top-level one** | `10` | `10` ❌ residual |
| **W2** | **class-method owners** | `10` | `10` ❌ residual |

## Population — measured, not estimated

TS-parser scan (`.tmp/scan-4456.mts`; grep is useless here, the predicate is
"same name, different enclosing function-like scope"):

- **test262 corpus: 18 / 53,575 files (0.03 %)** carry the shape, all with at
  least one declaration nested inside a function. 13 of the 18 are under
  `staging/**`, which the runner **skips** as proposal scope; of the 3 that
  run, all fail for unrelated prior reasons (`arguments is not defined`;
  param-vs-function-declaration binding precedence in `S10.2.1_A4_T*`).
  **Realized test262 delta from this fix today: ~0 tests.**
- **test262 harness: 2 / 43**, and this is where the amplification would be:
  `typeCoercion.js` has **12** different `testPrimitiveValue` bodies and
  `temporalHelpers.js` **5** different `check` bodies + 2 `CustomError`. But
  `typeCoercion.js` has **0 linkers** in the current checkout (legacy), and
  `temporalHelpers.js`'s **2,809** linkers are Temporal tests that fail earlier
  on `Temporal is not defined`. So that amplification is latent, not realized —
  it becomes real the moment Temporal lands.
- **Real-world JS: 2 / 9** files in `node_modules/typescript/lib` (including
  `typescript.js` and `_tsc.js`). The shape is ordinary in bundled code
  (`function next`, `function done`, `function inner`), which is where the
  value of this fix actually sits: dogfood / npm-compat correctness, not the
  conformance number.

## Controls (all run by me on this branch)

| control | result |
|---|---|
| Closure-heavy stride sample, 100 test262 files × {gc, standalone}, sha256 of the emitted binary | **200 / 200 byte-identical** base vs fixed |
| Same hashing over the 18 shape-carrying files | **29 / 36 pairs differ** — the change lands on exactly the scanned population and nowhere else (this is what makes the byte-identity control non-vacuous) |
| Capture-ABI suites #3123, #3316, plus #2976, #3419, #4133 ×2, #4134 | 5 failures, **identical base and fixed** (`#2976` ×2, `#3123` ×1, `#3316` ×2 — all pre-existing); 39 pass |
| fn-family pins #4436 / #4437 / #4440 / #4442 / #4443 | **81 / 81 pass** |
| Equivalence suite, all 212 files (chunked; the full suite OOMs in this container) | 24 failures, **`diff` of the base and fixed FAIL lists is empty** |
| `check:ir-fallbacks`, `check:oracle-ratchet`, `check:issue-ids:against-main`, `biome lint` on changed files, `typecheck` | all green |

## Residuals (pinned as `it.fails` in `tests/issue-4456.test.ts`)

1. **A nested declaration shadowing a same-named *constant-foldable* top-level
   one** (`Y2`/`G`). Owner: **`src/ir/from-ast.ts`** direct-call binding
   resolution (`cx.scope.get(calleeName)` + the "exact AST-site plan"), which is
   bare-name keyed and selects the top-level unit;
   `src/ir/passes/inline-small.ts` then inlines its constant body (it resolves
   by `unitId`, so it is a victim, not the cause). Narrow and diagnosable: the
   scope fix **does** emit the inner function — disassembly shows `$inner_53` —
   and with a *non-constant* top-level `inner` the same source lowers to a
   correct `return_call $inner_54`. Deserves its own issue against the IR
   front-end.
2. **Class-method owners** (`W2`). Owner: `src/codegen/class-bodies.ts` never
   calls `hoistFunctionDeclarations` for method/accessor/ctor bodies at all (it
   hoists only vars and let/const), so the #4456 shadow gate — which lives in
   the hoist — never runs there. Independently observable and *not* caused by
   this issue: a **forward** call to a nested declaration inside a method does
   not resolve either (`class C { m() { return inner(); function inner(){…} } }`
   lowers to a null read). The right fix is "method bodies must hoist function
   declarations", a separate change with its own blast radius; bolting a scope
   onto ~6 member-body compile sites without that hoist would not fix the shape.
3. **Pre-existing, out of scope:** a single nested declaration returns the SAME
   closure value across two activations of its owner (`M`: `P() === P()` is
   `true`, JS says `false`). That is #2976's deliberate module-level
   `nestedFnClosureArtifacts` dedupe, not this defect.

Both (1) and (2) were **unchanged** base → fixed, so neither is a regression.
