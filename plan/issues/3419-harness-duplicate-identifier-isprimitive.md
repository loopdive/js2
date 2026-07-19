---
id: 3419
title: "Concatenated harness: duplicate function decl (isPrimitive) errors instead of last-wins — blocks ~2k tests both lanes"
status: done
created: 2026-07-18
completed: 2026-07-18
assignee: ttraenkler/fable-5
priority: high
feasibility: medium
task_type: bugfix
area: compiler-early-errors
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3370, 3417, 3188]
# Small, site-required growth: last-wins skips must live in the exact
# registration/body/hoist loops they gate; the counter gate is one predicate
# call. The reusable analysis went to loop-analysis.ts (non-god file).
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/loops.ts
  - src/compiler.ts
---

# #3419 — duplicate top-level function declaration in concatenated harness is a hard error

## Problem

The literal-harness assembler (`tests/test262-original-harness.ts`) concatenates
includes + runtime-shim + `assert.js` + `sta.js` + test body into ONE compilation
unit. `assert.js:104` defines `function isPrimitive(value)` and
`testTypedArray.js:66` ALSO defines `function isPrimitive(val)` (NOT
propertyHelper.js — corrected census). Every test with
`includes: [testTypedArray.js]` therefore carries a duplicate top-level function
declaration — legal JS (var-scoped, last-wins) that the compiler rejected as a
hard `Duplicate identifier 'isPrimitive'` early error.

Measured on the 2026-07-18 baseline (oracle v8): **2,050** rows with
`error_signature: other:L#:## Duplicate identifier 'isPrimitive'` — the #2
compile-error bucket in the host lane.

## Root cause (verified 2026-07-18)

`checkDuplicateLexicalDeclarations` (`src/compiler/early-errors/duplicates.ts`)
treated a `FunctionDeclaration` as a **lexical** binding in every statement list,
including Script top level. Per spec that is wrong in exactly the places the
harness needs:

- **Script top level** — §16.1.1: the duplicate-entries rule applies to
  LexicallyDeclaredNames of ScriptBody = TopLevelLexicallyDeclaredNames (§8.2.8),
  which EXCLUDES HoistableDeclarations. Duplicate top-level `function f(){}` is
  legal, strict or sloppy; GlobalDeclarationInstantiation (§16.1.7) instantiates
  the LAST definition per name.
- **Function-body / class-static-block top level** — §10.2.11 / §15.7.1: same
  TopLevel\* semantics; FunctionDeclarationInstantiation (§10.2.11 step 14) walks
  declarations in reverse keeping only the last per name.
- **Module top level** — §16.2.1.1: function declarations ARE lexical; duplicates
  stay SyntaxErrors (guarded by `language/module-code/early-dup-top-function*.js`).
- **Nested Block** — §14.2.1 lexical, but Annex B §B.3.2.1 lifts the rule in
  sloppy mode when every binding for the name is a **plain** FunctionDeclaration
  (async/generator kinds are NOT covered by B.3.2.1 — guarded by the
  `block-scope/syntax/redeclaration/*` matrix).

Two further layers surfaced once the early error was fixed (both fixed in the
same PR):

1. **Codegen was first-wins for nested duplicates.** The hoist pass
   (`hoistFunctionDeclarations`, `src/codegen/statements/nested-declarations.ts`)
   compiled the FIRST sibling declaration into the funcMap slot and skipped the
   rest. Top level was accidentally last-wins (funcMap overwrite) but registered
   a dead stub WasmFunction per shadowed duplicate and compiled the shadowed body
   against the survivor's signature. Both paths now SKIP shadowed duplicates
   (only the last declaration per name is instantiated — spec-faithful, since an
   earlier duplicate is never observable).
2. **`var` loop-counter i32 promotion is unsound under redeclaration**
   (`testWithAllTypedArrayConstructors` has `for (var i = 0; …)` AND
   `for (var i = arr.length - 1; i >= 0; --i)` in one function). `var`
   redeclarations share ONE function-scoped Wasm local; promoting one loop's `i`
   to i32 while another head re-initializes it with an f64 expression emitted
   type-mismatched ops against the same local → invalid wasm
   (`f64.ge[0] expected type f64, found local.get of type i32`). New gate
   `varCounterRedeclarationBlocksI32` (`src/codegen/statements/loop-analysis.ts`)
   keeps the counter f64 whenever any other `var <name>` in the var scope is not
   the identical promotable counter shape. Reduced repro: `.tmp` probe returned
   invalid wasm on main, returns 20 (correct) after.
3. **Runner sandbox lacked the TypedArray cluster.** `SANDBOX_GLOBAL_NAMES`
   (`tests/test262-runner.ts`) had no Int8Array/…/ArrayBuffer/DataView/BigInt, so
   `Object.getPrototypeOf(Int8Array)` → `__extern_get(globalThis, "Int8Array")`
   → undefined → TypeError in `testTypedArray.js` module init. Added the cluster
   (same vm realm as the rest of the sandbox).

## Implementation

- `src/compiler/early-errors/duplicates.ts` — rewrote
  `checkDuplicateLexicalDeclarations` with var-scoped-function semantics +
  Annex B §B.3.2.1 tolerance; var-scoped function names still conflict with
  genuinely lexical names in both orders (§16.1.1 LexicallyDeclaredNames ∩
  VarDeclaredNames). `isFunctionBodyBlock` now includes class static blocks.
- `src/compiler/early-errors/context.ts` + `index.ts` + `node-checks.ts` +
  `src/compiler.ts` — threaded a `moduleGoal` flag: the test262 runner passes
  `inferModuleStrictArguments` as an EXPLICIT boolean (`true` exactly for
  `flags: [module]` tests, whose sources often have no syntactic import/export);
  product compiles leave it undefined and rely on `ts.isExternalModule`.
- `src/codegen/statements/nested-declarations.ts` — last-wins skip in the hoist
  pass (Phase 0 reservation + compile loop).
- `src/codegen/declarations.ts` — last-wins skip in top-level registration and
  body-compile loops (no more dead stubs / transient mis-signature compiles).
- `src/codegen/statements/loop-analysis.ts` + `loops.ts` —
  `varCounterRedeclarationBlocksI32` gate on the i32 counter promotion.
- `tests/test262-runner.ts` — TypedArray-cluster sandbox globals.

## Verification

- Reduced probes: top-level dup → last-wins (WAT-verified); fn-body dup →
  last-wins (returns 20); strict top-level dup legal; `let f` + `function f`
  still errors; sloppy block dup-fn legal (Annex B); strict block dup-fn errors;
  async-fn block dup still errors.
- Guard sweep, MY worktree vs baseline: 121 files
  (block-scope/syntax/redeclaration + module-code/early-dup-_ +
  global-code/script-decl-_) → **0 status changes**; 173 files (annexB
  statements/function + switch/syntax/redeclaration) → **0 status changes**.
- Bucket A/B (40-file deterministic sample of the 2,050): main = 40×
  compile_error → branch = 5 pass + 35 fail (34 of them on the NEXT root cause,
  see follow-up below). Extrapolated immediate recovery ≈ 250 passes, plus the
  whole bucket becomes reachable for the follow-up fix.

## Follow-up filed

The dominant residual (34/40 of the sample):
`TypeError: Function.prototype.bind called on non-callable in
testWithAllTypedArrayConstructors`. Verified shape: a **top-level function
declaration** referenced as a VALUE in an array literal
(`[makePassthrough, makeArray, makeArrayLike]`) reads back — **inside a nested
function, via an aliased binding** — as a value whose `typeof` is "function" but
whose host-side receiver is non-callable, so `argFactory.bind(undefined, ctor)`
throws. Function-EXPRESSION elements (`makeIterable`) survive (k3 ok in the
per-element probe; k0-2/k4-7 ERR). Reading the same array at TOP level works.
So the loss is specific to declaration-closure array elements crossing the
host boundary through the dynamic element-read path in a nested-function
context. Worth ~1,800 further tests. See #3432.
