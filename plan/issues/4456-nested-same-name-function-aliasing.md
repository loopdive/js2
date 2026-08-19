---
id: 4456
title: "Same-named nested function declarations in different scopes alias to ONE closure value (R8 of #4437 — correctness bug)"
status: done
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
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

> **Residual (1) still fails, but its MECHANISM changed with the follow-up
> narrowing below** — the gate now declines on an owner-less incumbent, so
> `B`'s `inner` is no longer compiled at all. Counted from the emitted binary:
> **2** occurrences of `inner` on the first cut, **1** after the narrowing (the
> pre-#4456 count). The observable answer is identical in both, which is why
> the `it.fails` pin held through both cuts. The description above is the
> first-cut mechanism; see the corrected note in `tests/issue-4456.test.ts`.

## Merge-group regressions (2026-08-15)

PR #4572 was green at PR level and **failed the `merge_group` re-validation**
with 9 host-lane (gc target) test262 entries reported as regressed. This
section records what each one actually was.

### Attribution — A/B, all on the host/gc lane, in one worktree

Five source states were compared on the same tree
(`.claude/worktrees/agent-a3cab5d54ed4eef60`, base `d6329d8a6`):

| state | what it is |
| ----- | ---------- |
| `PRE4572` | **every** `src/` file reverted to `9e17d34f3`, the commit before the #4572 merge |
| `BASE` | current tree with only the three #4456 files reverted |
| `NO4460` | current tree with only #4460's two files reverted (#4572 shipped **both** issues) |
| `MAIN` | current tree, i.e. #4456 exactly as shipped |
| `NARROW` | current tree + the narrowed gate (this follow-up) |

| # | test262 entry | PRE4572 | BASE | NO4460 | MAIN | NARROW | verdict |
| - | ------------- | ------- | ---- | ------ | ---- | ------ | ------- |
| 1 | `annexB/…/eval-code/direct/var-env-lower-lex-catch-non-strict.js` | PASS | PASS | PASS | **COMPILE_ERROR** | PASS | **MINE — fixed** |
| 2 | `annexB/…/function-code/block-decl-nested-blocks-with-fun-decl.js` | PASS | PASS | PASS | **FAIL** (got 2, want 1) | PASS | **MINE — fixed** |
| 3 | `language/expressions/object/dstr/meth-dflt-obj-ptrn-empty.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 4 | `…/dstr/gen-meth-dflt-obj-ptrn-empty.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 5 | `…/dstr/async-gen-meth-dflt-obj-ptrn-empty.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 6 | `language/statements/class/elements/super-access-inside-a-private-method.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 7 | `language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 8 | `language/expressions/new/spread-obj-manipulate-outter-obj-in-getter.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 9 | `language/expressions/super/call-spread-obj-manipulate-outter-obj-in-getter.js` | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |
| 10 | `language/statements/class/elements/private-method-get-and-call.js` (also cited) | FAIL | FAIL | FAIL | FAIL | FAIL | not mine |

**Two of the nine are #4456's; the other seven fail identically with the entire
`src/` tree reverted to the commit before #4572 merged.** They are therefore not
attributable to #4456, nor to #4460 (its two files were reverted independently —
column `NO4460` — and nothing moved). Whatever made CI call them `pass` at the
merge base, this tree does not reproduce a pass for them in any source state;
they need their own triage against the baseline, not a fix here.

### A trap in the A/B harness, worth writing down

The first pass of this A/B called
`runTest262File(file, cat, 15000, "gc")` to select the host/gc lane. **There is
no `"gc"` lane.** The parameter is typed `target?: "standalone"`, and a truthy
value flows into the compile options as `{ target: "gc" }` *and* turns off
`deferTopLevelInit` (`tests/test262-runner.ts` L3728 / L4219 / L4636). The
result was 8 of 10 files failing with `TypeError: sameValue is not a function`
— a harness artifact that looks exactly like a broad real regression, and that
reproduced identically in *every* source state, which is what gave it away. The
host/gc lane is `target === undefined`. Both #1 and #2 above read as
already-broken-at-base under the bad driver.

### Root cause, and why the fix is two clauses rather than one

The shadow mechanism is push-on-hoist / pop-at-end-of-body. The first cut fired
it whenever a name was live in `funcMap` under anything other than this exact
declaration, which is too broad in two independent directions:

1. **Same function frame.** Two declarations of one name in the same body have
   no boundary *between* them at which to restore, so the shadow stays live for
   the rest of the body and the Annex B §B.3.3 / #3419 machinery that already
   resolves same-frame duplicates is handed a namespace it does not expect. In
   #2 it let a deliberately NOT-Annex-B-applicable inner block declaration take
   `g`'s var-scoped `f`; in #1 the eval-inline path hoists each synthesized
   declaration into the current frame, so shadows accumulated with nothing to
   restore them and a later call resolved to a scoped-away index.
2. **Owner-less incumbent.** A top-level declaration, an import, or a
   synthesized helper carries no `funcMapOwnerDecl` record (#4133's
   convention), and the first cut read "no record ⇒ different owner ⇒ shadow",
   deleting a registration no scope on the stack would put back.

The fix requires the incumbent to (a) carry an owner record and (b) live in a
genuinely different enclosing function-like scope from `decl`; anything
undeterminable declines. **Neither clause subsumes the other** — measured by
running each alone:

| reproduction | scope clause alone | owner clause alone | both |
| ------------ | ------------------ | ------------------ | ---- |
| `block-decl-nested-blocks-with-fun-decl.js` | PASS | FAIL | PASS |
| `var-env-lower-lex-catch-non-strict.js` | PASS | COMPILE_ERROR | PASS |
| `function err(){}` + `eval('async function* err(){}')` | COMPILE_ERROR | PASS | PASS |

The third row is the smallest reproduction of the `funcIdx=undefined` CE and is
reachable only through clause (2), which is why both stay.

Declining is **absent-not-wrong**: it restores the exact pre-#4456 lowering for
the declined shapes. The cross-frame shapes #4456 exists to fix are untouched —
that is the whole alias matrix in `tests/issue-4456.test.ts`, all still green.

### What changed

- `src/codegen/nested-function-name-scope.ts` — `nestedFuncDeclNeedsShadow`
  narrowed as above; new `enclosingFunctionScope` walk (same walk as
  `call-identifier.ts`'s `isOutOfScopeNestedBinding`, deliberately kept in
  step). `nested-declarations.ts` and `function-body.ts` are **unchanged** from
  the shipped PR — the defect was entirely in the predicate.
- `tests/issue-4456.test.ts` — three new pins, each verified to FAIL against
  the shipped predicate and pass with the narrowing, plus one control that
  passes on both (labelled as such, since a "pin" that never reproduced is not
  a pin). The Annex-B-applicable sibling-block shape is asserted
  last-executed-wins, per B.3.3, not "healed". Residual (1)'s explanation
  corrected to match the state it is now pinned against.

### Controls

| control | result |
| ------- | ------ |
| `tests/issue-4456.test.ts` (21 tests, incl. the full alias matrix) | all pass; the 3 new pins fail on the shipped predicate |
| fn-family pins: `issue-4436`, `4437`, `4440`, `4442`, `4456`, `4460` | 93 pass; `issue-4442`'s 6 failures are a runtime-eval-provider cache fault that reproduces identically on `BASE` — pre-existing |
| byte-identity stride: 60 closure-heavy test262 files with **no** same-named nested declarations, compiled and sha256'd | **60/60 byte-identical to `origin/main`**, 0 compile errors |
| the 10-file A/B table above | 2 fixed, 8 unchanged, 0 newly broken |

Sample selection for the stride is deterministic (`.tmp/pick-stride.mts`): every
test262 file under nine function/closure-heavy directories declaring ≥2 nested
function-likes, minus any file containing two same-named function declarations
(0 such files in the population), strided to 60.

## Third cut — the same-frame decline was too broad (2026-08-15, PR #4586)

The narrowing above **landed on `main`** and then failed the merged-state
regression gate with a content-current baseline (run 31901836342): **net −22**,
24 pass→fail against the 2 heals. `ecd8135ad` is an ancestor of `origin/main`,
so `main` carried the regression live until this cut.

### The regressed family, and why the second cut broke it

All 24 are `annexB/language/eval-code/{direct,indirect}/…-existing-fn-no-init.js`
— 8 statement shapes × {`eval-func`, `eval-global`} × {direct, indirect}. Each
eval'd body is, in essence:

```js
init = f;{ function f() { return "inner declaration"; } }function f() { return "outer declaration"; }
```

`init = f` is evaluated **before** the block, so per B.3.3.3 it must capture the
**top-of-frame** declaration: a block-level declaration is a §B.3.3 web-compat
candidate that assigns the var-scoped binding only *when its block is
evaluated*, and the `no-init` in the family name is precisely the case where the
binding already exists and is therefore not re-initialised. Expected
`"outer declaration"`; the second cut gave `"inner declaration"`.

The second cut declined for the entire same-frame case, which handed the name to
whichever declaration the legacy flat path left holding it — the block one.

### What the predicate actually sees (measured, not assumed)

Instrumenting the predicate settled two things that guesswork had backwards:

| shape | newcomer `decl` | incumbent | frames |
| ----- | --------------- | --------- | ------ |
| the 24-family | `FunctionDeclaration@SourceFile` (top-of-frame) | `FunctionDeclaration@Block` | same |
| `var-env-lower-lex-catch` (heal #1) | `@SourceFile` | `@SourceFile` | "same" only after the eval fix below |
| `block-decl-nested-blocks` (heal #2) | `@Block` | `@Block` | same |
| cross-frame `P`/`Q` (#4456 proper) | `@Block` | `@Block` | different |

1. **The orientation is the reverse of the obvious one.** The block-level
   declaration is hoisted FIRST and is the *incumbent*; the top-of-frame one
   arrives as the *newcomer*. So the rule cannot be "protect a top-of-frame
   incumbent" — it has to let a top-of-frame **newcomer displace** a block-level
   incumbent. Written the other way round it fixes nothing.
2. **Every `eval` call is parsed into its OWN synthetic `SourceFile`.** The four
   evals in `var-env-lower-lex-catch` produce four distinct `<eval>.ts` nodes.
   Comparing scope-node identity therefore read them as *cross-frame* and
   re-shadowed — the `funcIdx=undefined` CE came straight back on the first
   attempt at this cut. `sameFrame` now treats two eval `SourceFile`s as one
   frame (conservative: two evals in genuinely different host frames also read
   as same-frame, which is the pre-#4456 lowering, i.e. absent-not-wrong).

### The rule

Owner clause first (unchanged, still load-bearing on its own), then:

- **different frames ⇒ SHADOW** — #4456 proper;
- **same frame ⇒ SHADOW only if the newcomer is top-of-frame and the incumbent
  is not.** Directional, so the top-of-frame declaration wins at hoist in either
  encounter order: block-then-top shadows; top-then-block declines and the
  pre-existing "already registered, skip" gate leaves it in place.
- both block-level ⇒ decline (heal #2, and B.3.3's own applicability machinery
  owns the answer); both top-of-frame ⇒ decline (heal #1's CE).

### Results

| control | result |
| ------- | ------ |
| the 24-file family | **24/24 pass** (0/24 on the second cut) |
| heal #1 `var-env-lower-lex-catch-non-strict` (CE) | pass |
| heal #2 `block-decl-nested-blocks-with-fun-decl` | pass |
| **whole `annexB/language` subtree, 845 files**, vs current `main` | **499 → 523: +24 heals, 0 regressions** |
| `tests/issue-4456.test.ts` | 30/30; the 9 new corner pins all fail on the second cut |
| byte-identity stride, 60 closure-heavy files | 60/60 byte-identical to current `origin/main` |
| `typecheck`, `biome lint`, `check:oracle-ratchet`, `prettier` | green |

### A reduction that does NOT stand in for the family — stated because it is a trap

The 9 corner pins added to `tests/issue-4456.test.ts` are reductions of the
family shape, and they are **not equivalent to it**:

| revision | the 24 family files | the reductions |
| -------- | ------------------- | -------------- |
| pre-#4456 base | PASS | wrong |
| first cut (shipped) | PASS | wrong |
| second cut | FAIL | wrong |
| this cut | PASS | right |

A hand reduction of this shape is *harder* than the family — wrong on every
earlier revision, including the two where the family passed. Module-level vs
in-function placement, `deferTopLevelInit`, and string / numeric /
non-constant-foldable bodies were each tried and none closed the gap; the
remaining difference is the test262 wrapper's harness prelude, which registers a
large number of top-level functions before the test body and so changes the
hoist environment the predicate sees. The pins are kept — each is a shape this
cut genuinely fixes — but the family's regression guard is the test262 lane,
and the pins say so in their own comment. Treating them as the family's pin
would have been a false measurement.
