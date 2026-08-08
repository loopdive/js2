---
id: 2200
title: "Annex B B.3.3 block-level function declaration hoisting — outer binding created/initialized incorrectly (~186 test262 fails)"
status: in-progress
sprint: current
created: 2026-06-19
updated: 2026-08-08
phase1: done
phase2_rework: 2552
has_impl_plan: true
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, scoping
language_feature: block-scoped-functions
goal: es5
related: [1642]
loc-budget-allow:
  # The `installLoopCtx` slot-mutation helper (B1) and the catch-ObjectPattern
  # minimal slice (B2 layer 2) both land in the interpreter emitter. The spec's
  # arithmetic assumed the 7-site idiom collapse (-15) would cover the helper,
  # but the helper plus its load-bearing "never index-store a reused slot"
  # rationale is 25 lines on its own. Both changes are subsystem-local: this
  # file IS the interpreter's emit driver, there is no separate module the
  # control-stack install/catch-lowering could move to without splitting the
  # scope stack from its only consumer.
  - src/interp/emitter.ts
test262_bucket: annexb-block-fn-hoisting
test262_count: 186
es_edition: annexb
origin: "2026-06-19 sprint-64 standalone failure mining: annexB/language/function-code (91) + annexB/language/global-code (95) fail the B.3.3 outer-binding hoisting contract. Also fails identically in JS-host (203 fail / 107 pass), so it is a host-agnostic scoping bug."
---

# #2200 — Annex B B.3.3 block-level function declaration hoisting

## Problem

ECMA-262 **Annex B.3.3** ("Changes to FunctionDeclarationInstantiation /
GlobalDeclarationInstantiation / EvalDeclarationInstantiation") governs the
web-compat semantics of a `FunctionDeclaration` nested inside a _block_ (not a
function body). The spec creates an _additional, var-scoped_ outer binding for
the block-local function name, but **only when** doing so "would not produce any
Early Errors" — e.g. a colliding `let`/`const`/parameter binding in the
enclosing scope cancels the Annex B hoist.

The compiler currently hoists block-level function declarations to the
enclosing function/global scope **unconditionally**, ignoring the Annex B
guard conditions. Two observable failures result:

1. **Outer binding created when it must not be** — when a `let`/`const`/param
   shadow (or the B.3.3 "would produce an early error" condition) should block
   the hoist, the compiler still exposes `f` in the outer scope, so a
   `ReferenceError` that the spec mandates does not throw.
2. **Outer binding initialized too eagerly** — even when the outer binding _is_
   created, B.3.3 requires it to start **uninitialized** (`typeof f ===
"undefined"`, reading `f` before the block executes throws `ReferenceError`),
   then become initialized to the function value **only after** the block's
   inner `function` declaration is evaluated. The compiler initializes it at
   function entry.

This is a pure scoping/hoisting bug — **independent of standalone mode** (it
fails identically in JS-host: 203 fail / 107 pass) and independent of the
standalone builtin-prototype / value-rep epics.

## Spec

- §B.3.3.1 Changes to FunctionDeclarationInstantiation:
  https://tc39.es/ecma262/#sec-web-compat-functiondeclarationinstantiation
- §B.3.3.2 Changes to GlobalDeclarationInstantiation:
  https://tc39.es/ecma262/#sec-web-compat-globaldeclarationinstantiation
- §B.3.3.3 Changes to EvalDeclarationInstantiation (eval cases are out of scope —
  eval is a deferred/skipped feature).

The guard (FunctionDeclarationInstantiation step, paraphrased): for each block-
nested function name `F`, create a var-scoped outer binding **iff** replacing
the `FunctionDeclaration` with a `var F` would not produce an early error
(i.e. no lexical `let`/`const`/class binding for `F` in an intervening scope)
**and** `F` is not a parameter name.

## Minimal repro

```js
// (A) let-shadow cancels the Annex B outer binding (B.3.3 guard).
(function () {
  // Outer `f` must NOT be created — a `let f` shadow lives between.
  let threw = false;
  try {
    f;
  } catch (e) {
    threw = e instanceof ReferenceError;
  }
  // assert threw === true   (compiler: f is wrongly visible → no throw)
  {
    let f = 123;
    {
      function f() {} // block-level fn decl, but `let f` blocks the hoist
    }
  }
  return threw ? 1 : 0;
})();
```

```js
// (B) outer binding starts uninitialized, becomes the fn value after the block.
(function () {
  // `f` exists (var-scoped) but is uninitialized here.
  const before = typeof f; // must be "undefined" (binding uninitialized)
  {
    function f() {
      return 42;
    }
  } // after this block, outer f === the function
  const after = typeof f; // must be "function"
  return before === "undefined" && after === "function" ? 1 : 0;
})();
```

## Failing test262 cluster

- `test/annexB/language/function-code/*` — **91** fail/CE. Dominant assertion:
  `assert.throws(ReferenceError, function() { f; }, 'An initialized binding is not created prior to evaluation')`.
  Representative files:
  - `annexB/language/function-code/if-stmt-else-decl-func-skip-early-err-for-of.js`
  - `annexB/language/function-code/if-decl-no-else-func-skip-dft-param.js`
  - `annexB/language/function-code/if-decl-else-stmt-func-skip-early-err-for-in.js`
- `test/annexB/language/global-code/*` — **95** fail/CE. Same B.3.3 contract at
  global scope. Representative files:
  - `annexB/language/global-code/if-decl-no-else-global-skip-early-err-try.js`
  - `annexB/language/global-code/switch-case-global-no-skip-try.js`
  - `annexB/language/global-code/switch-case-global-update.js`

Total addressable: **~186** (eval-code B.3.3 variants excluded — eval is deferred).

## Approach (sketch — dev to confirm against codegen)

In FunctionDeclarationInstantiation / GlobalDeclarationInstantiation hoisting
(the pass that collects block-nested `FunctionDeclaration`s and lifts them to
the enclosing scope):

1. Apply the **B.3.3 guard**: skip the outer var-binding when a lexical
   (`let`/`const`/class) binding for the name exists in an intervening scope, or
   the name is a parameter. This makes case (A) throw the spec `ReferenceError`.
2. Make the hoisted outer binding **uninitialized at entry** (TDZ-like for the
   var-scoped Annex B binding), and emit the _initialization-to-function-value_
   at the point the inner block-level declaration is evaluated, not at function
   entry. This fixes case (B).

`for-of` IteratorClose-on-throw (#1642) is a sibling iteration-semantics lane —
do **not** scope-creep into it.

## Acceptance criteria

- [ ] Repro (A): outer `f` read throws `ReferenceError` when a `let`/`const`/param
      shadow cancels the Annex B hoist.
- [ ] Repro (B): outer binding reads `typeof === "undefined"` before the block,
      `"function"` after.
- [ ] `>= 120` of the ~186 `annexB/language/{function-code,global-code}` tests
      flip to pass (standalone shard). Stretch: `>= 160`.
- [ ] No regression in non-Annex-B function/block scoping
      (`language/statements/function`, `language/statements/block`) on the
      standalone shard or in JS-host.
- [ ] A focused `tests/issue-2200-*.test.ts` covering repros (A) and (B) in both
      sloppy and strict mode (strict mode disables the Annex B hoist entirely —
      no outer binding — which is its own assertion).

## Root-cause analysis (2026-06-19, sd1)

Both repros confirmed failing on current main (standalone, returns 0 not 1).
Traced the binding flow:

**There is NO Annex B handling at all** — a block-nested `function f(){}` is
compiled by the SAME path as a direct function-body declaration
(`compileNestedFunctionDeclaration`, `statements.ts:218`), which registers `f`
in the **module-global `ctx.funcMap`**. Identifier resolution then finds it
unconditionally:

- `src/codegen/expressions/identifiers.ts:766` — `const funcRefIdx =
ctx.funcMap.get(name)` resolves ANY function name as a value, regardless of
  the lexical scope it was declared in. So the outer `(f as any)` read in case A
  finds the block-nested `f` and does NOT throw (the `let f` shadow is never
  consulted).
- There is no uninitialized-then-initialized var-binding lifecycle for the Annex
  B outer binding (case B): the function is simply globally present from the
  start, so `typeof f` is `"function"` everywhere, never `"undefined"`.

`hoistFunctionDeclarations` (`statements/nested-declarations.ts:832`) only runs
on **direct** function-body statements; `hoistVarDeclarations` /
`walkStmtForVars` (`index.ts:12093/12246`) descend into blocks but only for
`var`, never lifting block-nested function names. So the "outer binding" is not a
deliberate Annex B hoist — it is an accident of `funcMap` being module-global.

### Why this is larger than the "medium" sketch — needs an architect spec

A spec-correct B.3.3 requires changing the **function-binding model**, not a
localized patch:

1. **Scope the visibility of a block-nested function name** so it does NOT leak
   into the module-global `funcMap` lookup at outer read sites — the resolver at
   `identifiers.ts:766` would need a lexical-scope-aware lookup (today it is a
   flat global map). This is the crux and touches the hottest identifier path.
2. **Apply the B.3.3 guard** (no intervening `let`/`const`/class binding for the
   name; name is not a parameter) to decide whether to create the var-scoped
   outer binding at all (case A).
3. **Model the outer binding lifecycle** as a var that is _uninitialized_ at
   function/global entry and assigned the function value only when the inner
   block-level declaration executes (case B) — i.e. a TDZ-like var local plus a
   deferred init at the declaration's textual position.

Each of (1)–(3) interacts with the existing `funcMap` / closure / hoisting
machinery, and (1) in particular risks regressing the broad
`language/statements/function` + `language/statements/block` suites if done
without a designed approach. Recommend routing to `/architect-spec` for a
binding-model design before dev implementation, rather than a tail-risk inline
scoping change. sd1 flagged this at the analysis boundary instead of
half-building it.

## Implementation Plan (2026-06-19, architect)

### Design summary — DON'T touch the hot funcMap lookup; intercept the read instead

sd1's root-cause is exact: a block-nested `function f(){}` is compiled by
`compileNestedFunctionDeclaration` (`statements/nested-declarations.ts:160`) and
registered in module-global `ctx.funcMap`, then read as a value at
`expressions/identifiers.ts:766` (`ctx.funcMap.get(name)`), a flat lookup with no
lexical-scope awareness. The instinct is to make that lookup scope-aware — but
that is the hottest identifier path and the highest regression risk.

**Key architectural finding that avoids touching it:** `compileIdentifier`
(`identifiers.ts:482`) resolves names in a fixed order, and **`localMap`
(line 499, with its `tdzFlagLocals` TDZ check at 502–511) and `moduleGlobals`
(line 592, with `tdzGlobals` at 596) are both consulted BEFORE the funcMap
function-ref-as-value branch at line 766.** So if the Annex B _outer binding_ is
materialised as a real var-binding (a function-local with a `tdzFlagLocals` entry,
or — at global scope — a module global with a `tdzGlobals` entry), the read is
intercepted by the earlier branch and the funcMap lookup at 766 is **never reached
for that name**. The block-local function itself stays in `funcMap` and keeps
working for _calls inside the block_ and for the post-declaration assignment.

This converts the problem from "make the hottest lookup scope-aware" (tail-risk)
into "model the Annex B outer var-binding using the existing TDZ-var machinery"
(`hoistLetConstWithTdz` / `emitLocalTdzCheck` / `emitLocalTdzInit`, the same
mechanism that already powers `let`/`const` TDZ). The hot funcMap path is
**unchanged**, which is the regression-mitigation crux.

Both the function-code case (91 fails) and the global-code case (95 fails) funnel
through the **same** machinery: the module-init body (`__module_init`, built in
`declarations.ts:3959 compileModuleInitBody`) is itself a normal `FunctionContext`
with a `localMap`, and top-level `Block`/`if`/`try`/`switch`/loop statements are
pushed to `ctx.moduleInitStatements` (`declarations.ts:3519-3537`) and compiled in
source order via `compileStatement`. So **the global-code Annex B outer binding can
be a function-local of `__module_init`** exactly like the function-code case — no
separate module-global code path is required. (`var x` at global scope is already
modelled this way; this just extends it to Annex B function names.) This unifies
the two clusters under one implementation.

### B.3.3 semantics being implemented (ECMA-262 §B.3.3.1 / §B.3.3.2)

- §B.3.3.1 Changes to FunctionDeclarationInstantiation:
  https://tc39.es/ecma262/#sec-web-compat-functiondeclarationinstantiation
- §B.3.3.2 Changes to GlobalDeclarationInstantiation:
  https://tc39.es/ecma262/#sec-web-compat-globaldeclarationinstantiation

Paraphrased for a block-nested `FunctionDeclaration` named `F` in **sloppy** code,
whose nearest enclosing function/global scope is `S`:

1. **Eligibility (the case-A guard).** Create the additional var-scoped binding for
   `F` in `S` **only if** "replacing the `FunctionDeclaration` with `var F`" would
   produce **no Early Error** — i.e. there is no lexically-declared
   (`let`/`const`/`class`) binding for `F` in any scope between `F`'s block and `S`
   (inclusive of `S`'s lexical bindings), **and** `F` is not a formal-parameter
   name of `S`. If ineligible, **no** outer binding is created; reading `F` in `S`
   outside the block hits whatever `S` actually declares (the `let`/`const` in TDZ
   → ReferenceError, or nothing → ReferenceError). sd1 has a **validated static
   detector** for this (`cancels=true`); reuse it verbatim.
2. **Lifecycle when eligible (case B).** The var-scoped binding for `F` in `S` is
   created at entry but **uninitialised** (`undefined` is the _value_, but per the
   FunctionDeclarationInstantiation/var semantics a `var` binding is initialised to
   `undefined` — see the subtlety note below). At the **point the block-level
   `FunctionDeclaration` is evaluated** (its textual position, when control reaches
   the block), the spec performs `SetMutableBinding(F, fobj)` on the **function-level
   outer** binding — i.e. the outer `F` becomes the function object _only after_ the
   block runs.
3. **Strict mode disables Annex B entirely** — no outer binding is ever created;
   the block function is purely block-scoped (`typeof f` outside the block is
   `"undefined"`, but via the genuinely-absent binding, and there is no
   post-block assignment to an outer name).

**Subtlety — `typeof f` "undefined" before the block (repro B).** Strictly, a
plain `var f` is initialised to `undefined` at entry (so `typeof f` is
`"undefined"` because the _value_ is `undefined`, not because the binding is in
TDZ). But the test262 function-code cluster's dominant assertion is
`assert.throws(ReferenceError, function() { f; }, 'An initialized binding is not
created prior to evaluation')` — i.e. several of these tests want a **ReferenceError
on read before the block**, which is the TDZ behaviour, not the `undefined`-value
behaviour. The distinction is per-test: the _function-code_ skip-tests want a
binding that is **absent/TDZ before the block** (read → ReferenceError) and present
after; the _repro B_ in this issue wants `typeof f === "undefined"` before. **Both
are satisfied by a single mechanism: model the outer binding as a TDZ var** (a
local + a `__tdz_f` flag, flag=0 at entry, flag=1 after the block's declaration
runs). A _direct read_ of `f` before the block emits `emitLocalTdzCheck` →
ReferenceError (satisfies the function-code cluster). A `typeof f` before the block
is special-cased to return `"undefined"` when the flag is 0 (satisfies repro B and
ES `typeof`-on-uninitialised… see the note in Phase 2 below). This is exactly how
`let`/`const` TDZ + `typeof` already interact, so we are reusing a proven pairing.

### Phased rollout (case-A guard first — it is independently shippable)

**Phase 1 (case A — the cancellation guard). ~Half the cluster, lowest risk.**
Make an _ineligible_ block-nested function name **not** resolve as an outer value.
Today the bug is that `funcMap.get(name)` finds it unconditionally. Phase 1 does
NOT add an outer binding at all — it _suppresses_ the accidental outer visibility
when sd1's detector says `cancels=true`, so the existing `let`/`const` TDZ binding
(or the genuine ReferenceError fallback) takes over.

**Phase 2 (case B — the uninitialised-then-init lifecycle).** For _eligible_
block-nested functions, create the TDZ outer var-binding, mark it initialised at
the declaration's textual position, and special-case `typeof`.

Phase 1 is dev-implementable and lands the case-A ReferenceError tests on its own.
Phase 2 builds on Phase 1's plumbing. Ship them as two PRs; Phase 1 is the floor.

---

### Phase 1 — case-A cancellation guard

**Goal:** when a block-nested `function F` is _ineligible_ for the Annex B outer
binding (intervening lexical shadow or param), a read of `F` in the enclosing scope
outside the block must NOT resolve via `funcMap`.

**File: `src/codegen/statements/nested-declarations.ts`**

- Build a per-`fctx` set `ctx`-or-`fctx`-scoped, call it **`annexBCancelled: Set<string>`**
  (store on `fctx`, since it is scope-local; add the optional field to
  `FunctionContext` in `src/codegen/context/types.ts`). Populate it during
  `hoistFunctionDeclarations` (`nested-declarations.ts:832`): when the recursion
  descends into a block-like structure (the `ts.isBlock` / `if` / `try` / loop /
  switch / labeled branches at lines 954–1005) and finds a `FunctionDeclaration`,
  run **sd1's `cancels` detector** for that name against the enclosing `fctx` scope.
  - The current recursion lifts **every** block-nested function into `funcMap`
    unconditionally (it calls `compileNestedFunctionDeclaration`, line 929, for
    block-nested decls reached through the recursion). For Phase 1, when
    `cancels===true`: still compile the function body (the block-local binding must
    work for in-block calls), but record `name` in `fctx.annexBCancelled` so the
    outer read site can refuse to resolve it as an outer value.
  - **Important scoping nuance:** the detector must distinguish "direct function-body
    declaration" (a top-level statement of the function body — NOT block-nested, must
    keep current unconditional hoist) from "block-nested declaration" (reached via the
    block recursion). The recursion structure already separates these: the _direct_
    decls are handled in the first `for` loop pass at lines 917–950 over the function
    body's own `stmts`; the _block-nested_ ones are reached via the recursive descent
    at 954–1005. Only the latter are Annex B candidates. Tag candidacy at the
    descent boundary so a direct decl is never marked cancelled.

**File: `src/codegen/expressions/identifiers.ts`**

- At the function-ref-as-value branch (line 766, `const funcRefIdx =
ctx.funcMap.get(name)`), add a guard **before** the `if (funcRefIdx !== undefined
&& …)` block at line 778: if `fctx.annexBCancelled?.has(name)` AND the read site is
  lexically _outside_ the declaring block (use the TS checker / node position: the
  identifier's position is not within the block that contains the
  `FunctionDeclaration`), skip the funcMap-as-value resolution and fall through to
  the undeclared-identifier path (lines 820+), which already emits a proper
  `ReferenceError` instance for a name with no in-scope value binding.
  - **Do not** broadly disable funcMap resolution for the name — calls/reads _inside_
    the block must still resolve. The position check ("is this read inside the
    declaring block?") is what keeps the block-local binding intact. sd1's detector
    already computes the block boundary; expose the block node so the read site can
    test containment, or precompute the set of "cancelled outer read positions" during
    hoist and check membership here (cheaper than a per-read AST walk).
  - This guard is a single `Set.has` + a position/containment check, gated on the
    (normally empty) `annexBCancelled` set — **zero cost** for the overwhelming
    majority of modules that have no cancelled Annex B functions, which is what keeps
    `language/statements/{function,block}` byte-identical.

**Wasm IR (Phase 1):** none new — the read simply routes to the existing
`emitThrowReferenceError` / undeclared-identifier emission at `identifiers.ts:826+`.

---

### Phase 2 — case-B uninitialised-then-init lifecycle (eligible functions)

**Goal:** for an _eligible_ block-nested `function F`, the enclosing scope gets a
var-binding for `F` that is in TDZ before the block and holds the function value
after.

**File: `src/codegen/statements/nested-declarations.ts` (in `hoistFunctionDeclarations`)**

- For an _eligible_ block-nested decl (detector `cancels===false`), during the
  hoist pass **pre-allocate the outer binding as a TDZ var** in the enclosing
  `fctx`, mirroring `ensureLetConstBindingPatternTdzFlags`
  (`index.ts:12151`) and `hoistLetConstWithTdz`:
  - `allocLocal(fctx, F, externref)` if not already present (the function value as a
    closure is an externref/closure-struct ref — match the type
    `emitCachedFuncClosureAccess` returns; externref is the safe widening).
  - `allocLocal(fctx, `\__tdz_${F}`, { kind: "i32" })` and register it in
    `fctx.tdzFlagLocals.set(F, flagIdx)` — flag starts 0 (uninitialised) by Wasm
    zero-init.
  - Record `F` in a new `fctx.annexBOuterBindings: Set<string>` so the
    declaration-site init (below) and the `typeof` special-case can detect it.

**File: `src/codegen/statements.ts` (in `compileStatement`'s `isFunctionDeclaration`
branch, lines 218–236) — the textual-position init.**

- When `compileStatement` reaches the block-nested `function F` declaration **in
  source order** (control flow now at the block), after the function is compiled,
  emit the **outer-binding initialisation**: materialise the function value (reuse
  `emitCachedFuncClosureAccess(ctx, fctx, F, funcIdx)` / `emitFuncRefAsClosure`,
  `closures.ts:4179/3298`), `local.set` it into the outer binding's local, and set
  the TDZ flag to 1:
  ```
  ;; outer-binding init at the block-level FunctionDeclaration's textual position
  <emit closure value for F>      ;; emitCachedFuncClosureAccess result on stack
  local.set $F_outer              ;; the allocLocal'd outer binding
  i32.const 1
  local.set $__tdz_F              ;; mark the Annex B outer binding initialised
  ```

  - Gate on `fctx.annexBOuterBindings?.has(F)` so non-Annex-B function decls are
    untouched (byte-identical).
  - Because the declaration is inside a block, this init runs only when control
    reaches the block — exactly the spec's "after the block executes" timing. If the
    block is never entered (`if(false){ function f(){} }`), the flag stays 0 and the
    outer `f` correctly remains uninitialised → `typeof f === "undefined"`, direct
    read → ReferenceError. This is precisely the family of
    `if-decl-*-skip-*`/`switch-case-*-no-skip` test262 names.

**File: `src/codegen/expressions/identifiers.ts` (read site).**

- No new code needed for the _direct read_: once `F` is in `localMap` with a
  `tdzFlagLocals` entry, the existing branch at lines 499–511 emits
  `emitLocalTdzCheck` (or static throw / skip) automatically. `analyzeTdzAccess`
  (called at line 504) already decides check-vs-throw-vs-skip from positions, and a
  read textually before the block → "throw"; a read after → "check" (flag may be 0
  if the block didn't run) → runtime ReferenceError if uninitialised. This is the
  correct B.3.3 behaviour and it falls out of the existing machinery for free.

**File: `src/codegen/typeof-delete.ts` (the `typeof F` special-case).**

- `compileTypeofExpression` (`typeof-delete.ts:787`) currently const-folds `typeof
F` to `"function"` via `staticTypeofForType` (line 863) because the TS checker
  reports `F`'s symbol as a function type (it models the hoist). For an Annex B
  outer binding this is wrong before the block runs. Add a check **before** the
  static-fold at line 860–866: if the operand is a bare identifier `F` with
  `fctx.annexBOuterBindings?.has(F)` (and `fctx.tdzFlagLocals?.has(F)`), emit a
  runtime branch on the TDZ flag instead of folding:
  ```
  local.get $__tdz_F
  if (result <string>)         ;; flag set ⇒ initialised
    <string const "function">
  else
    <string const "undefined"> ;; uninitialised ⇒ typeof is "undefined"
  end
  ```
  Use `compileStringLiteral(ctx, fctx, "function")` / `"undefined"` for the two arms
  (matches the rest of this file). This is the one place the checker's hoisted view
  must be overridden; gate it strictly on `annexBOuterBindings` membership so all
  other `typeof` paths are byte-identical.

**Wasm IR (Phase 2):** the two snippets above (declaration-site init + `typeof`
flag branch) plus the reused `emitLocalTdzCheck` IR (already exists,
`identifiers.ts:104`).

---

### Edge cases (both phases)

- **Direct (function-body-top-level) function decls are NOT Annex B** — they keep
  the current unconditional hoist. Only declarations reached through the _block_
  recursion are candidates. Verify the detector never marks a direct decl.
- **Strict mode** — Annex B is disabled. Detect strictness (module code is always
  strict; a `"use strict"` directive in the function/global body, or an enclosing
  strict scope). When strict: do not create the outer binding and do not mark
  cancelled — the block function is purely block-scoped. test262 has explicit
  strict-mode `function-code` variants asserting _no_ outer binding; treat strict as
  "skip the whole Annex B path." (sd1's detector should already gate on strictness;
  confirm.)
- **Name collides with a real `var F` in the enclosing scope** — then the outer
  binding already exists as a normal var; the block function's declaration-site init
  should still write the function value into it (B.3.3 shares the single var
  binding). Don't double-allocate: if `localMap.has(F)` from `hoistVarDeclarations`,
  reuse that local and only add the textual-position assignment + flag (the var is
  already non-TDZ `undefined` at entry, so `typeof` is `"undefined"` via value, and a
  direct pre-block read returns `undefined` not ReferenceError — which is the correct
  behaviour when an explicit `var F` co-exists).
- **Multiple block-nested decls of the same name** in sibling blocks — each block's
  declaration-site init writes the outer binding when its block runs; last-block-wins
  by execution order, which matches spec (each `SetMutableBinding`).
- **Eligible decl inside a never-entered block** (`if(false)`, unreached `switch`
  case) — flag stays 0; outer `F` stays uninitialised. Covered by the lifecycle.
- **`for`/`while` block-nested decl** — the hoist recursion already descends into
  loop bodies (lines 980–993). The outer binding is allocated once; the init runs
  each iteration (idempotent: re-sets the same closure + flag).
- **Nested intervening blocks** — the detector must scan _all_ scopes between the
  declaring block and the enclosing function/global for a lexical shadow, not just
  the immediate parent. sd1's detector reportedly does this ("intervening" shadow);
  confirm it walks the full chain.
- **`funcMap` value-read inside the block stays intact** — the Phase 1 guard is
  position-scoped to _outside_ the block; calls/reads of `F` inside its own block
  resolve normally.

### Regression-mitigation & validation strategy

The design's central regression defense is **not touching the hot
`identifiers.ts:766` funcMap lookup** and gating every new branch on a
normally-empty per-`fctx` set (`annexBCancelled` / `annexBOuterBindings`). A module
with no cancelled/eligible Annex B function emits byte-identical Wasm. Concretely:

- **Before pushing, the dev must run (scoped, local) and confirm no diff vs. main on:**
  - `tests/equivalence.test.ts` (full) — the primary guard for general function/
    block/closure codegen.
  - A scoped test262 run (via the dev's normal scoped harness) over
    `language/statements/function`, `language/statements/block`,
    `language/expressions/function`, and `language/statements/{if,switch,for,try}` —
    these are the suites most exposed to hoisting/scoping changes. Expect **zero
    regressions** in these; any flip here is a real bug, not noise.
  - The new focused `tests/issue-2200-*.test.ts` (repros A and B, sloppy + strict).
- **Byte-identical check (recommended):** compile a few representative
  non-Annex-B fixtures (a plain nested `function`, a recursive sibling pair, a
  closure-capturing nested function) with the branch present and confirm the emitted
  Wasm is unchanged — proves the gating sets are truly inert when empty.
- **CI is the conformance authority** — the dev does NOT run full test262 locally.
  The acceptance bar is `>=120` of the ~186 `annexB/language/{function-code,
global-code}` flipping to pass with **no regression** in the function/block
  suites. If Phase 1 alone lands the case-A ReferenceError subset cleanly, ship it
  and let Phase 2 take the case-B `typeof`/lifecycle subset.

### Exact change list

| Phase | File                                             | Function / line                                             | Change                                                                                                                                               |
| ----- | ------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| both  | `src/codegen/context/types.ts`                   | `FunctionContext`                                           | add optional `annexBCancelled?: Set<string>` and `annexBOuterBindings?: Set<string>`                                                                 |
| 1     | `src/codegen/statements/nested-declarations.ts`  | `hoistFunctionDeclarations` (832; block recursion 954–1005) | run sd1's `cancels` detector for block-nested decls; on cancel, record name in `fctx.annexBCancelled` (still compile body)                           |
| 1     | `src/codegen/expressions/identifiers.ts`         | before funcMap-as-value branch (~778)                       | skip funcMap resolution for `annexBCancelled` names read _outside_ the declaring block → fall to ReferenceError path (826+)                          |
| 2     | `src/codegen/statements/nested-declarations.ts`  | `hoistFunctionDeclarations`                                 | for _eligible_ block-nested decls, pre-allocate outer TDZ var (`allocLocal` + `__tdz_${F}` flag in `tdzFlagLocals`); record in `annexBOuterBindings` |
| 2     | `src/codegen/statements.ts`                      | `compileStatement` `isFunctionDeclaration` (218–236)        | at textual position, `local.set` outer binding to the closure value + set `__tdz_${F}` flag to 1 (gated on `annexBOuterBindings`)                    |
| 2     | `src/codegen/typeof-delete.ts`                   | `compileTypeofExpression` (787; before static fold 860–866) | for `annexBOuterBindings` identifier operand, emit `if $__tdz_F → "function" else "undefined"` instead of const-folding                              |
| both  | `tests/issue-2200-annexb-block-fn-hoist.test.ts` | new                                                         | repros A + B in sloppy + strict mode                                                                                                                 |

### Handoff

sd1 holds the implementation claim and owns the validated case-A `cancels`
detector + root-cause. This plan deliberately builds on that detector and does NOT
re-derive it. Open question for sd1 to confirm against the detector: (a) does it
walk the _full_ intervening scope chain (not just the immediate parent) for the
lexical shadow; (b) does it already gate on strict mode; (c) can it expose the
declaring-block node (or a position range) so the Phase-1 read-site containment
check is cheap. If the detector already returns the block boundary, Phase 1 is a
~30-line wiring change.

**Dev-vs-senior call:** Phase 1 is **dev-implementable** (single gated guard on an
existing path, plus reuse of the detector). Phase 2 touches the TDZ-var lifecycle
and `typeof` const-folding — still dev-scoped since it reuses
`hoistLetConstWithTdz`/`emitLocalTdzCheck`/`emitCachedFuncClosureAccess` rather than
inventing machinery, but it warrants careful review of the declaration-site init
ordering (must run after the function compiles, before any post-block read). If sd1
prefers, Phase 2 can go to senior-dev; Phase 1 is comfortably a developer task.

## Phase 2 DONE (2026-06-19, sen-1) — typeof outer-binding resolution bypass fixed

sd1 landed Phase 2's plumbing (TDZ-var outer binding + decl-site init + case-A) on
`issue-2200-annexb-phase2`; 4/5 sub-behaviours worked. The remaining bug: `typeof F`
AFTER the block returned `"undefined"` not `"function"`, even though the decl-site
init set the TDZ flag (traced outer=1 flag=2). sd1 correctly flagged a
"resolution-path bypass" of the `annexBOuterBindings` typeof guard.

**Precise root cause (traced):** the bypass is the **undeclared-identifier branch**
in `compileTypeofExpression` (`typeof-delete.ts`), which runs BEFORE the Annex-B
guard. For an Annex B outer binding, the TS checker reports the operand's symbol
with **no `valueDeclaration`** at the reference site (the outer binding is
synthetic — only the block-scoped `FunctionDeclaration` is a real decl), so
`hasValueDecl === false` and that branch const-folds `typeof F` → `"undefined"`
and returns — never reaching the later guard. (`declare const f` ambient gives the
symbol a value-decl, so it skipped the early branch and worked — confirming the
path.)

**Fix:** extract the runtime TDZ-flag branch into a shared
`emitAnnexBTypeofFlagBranch(ctx, fctx, name)` helper and call it at the TOP of the
undeclared-identifier branch (before the `!hasValueDecl` const-fold), gated on
`fctx.annexBOuterBindings`. The late guard now also delegates to the same helper
(no duplicated logic). One file: `src/codegen/typeof-delete.ts`.

**Verified** (`tests/issue-2200-annexb-block-fn-hoist.test.ts`, Phase 2 block):
`typeof f` after block → `"function"`; `if(false){…} typeof f` → `"undefined"`;
genuinely-undeclared → `"undefined"`; normal fn-decl typeof → `"function"`; plain
numeric local → `"number"`. No regression across typeof-extended / typeof-comparison
/ typeof-narrowing / symbol-typeof / var-hoisting-scope / if-branch-block-scope +
the full Phase 1 suite. `tsc --noEmit` clean.

## Phase 2 PARKED — full-gate test262 regression (-1180), NOT locally reproducible (2026-06-19, sen-1)

The typeof-resolution fix (above) is correct in isolation, but the **full CI
test262-regression gate on PR #1769 flagged -1180 net pass (1411 regressions,
231 improvements)** — a wide regression the local Phase-2/typeof/scope tests did
NOT catch. Phase 1 (#1764, the ~93-test floor) is merged and stands alone, so the
floor is banked regardless; Phase 2 is parked here for a focused follow-up.

**Regression profile (gate bucket output, baseline e6cf3a7, signature
`d57ce880bc38ea96`):**

- categories: `wasm_compile: 625`, `null_deref: 593`, `type_error: 143`, other 41.
- top buckets (each >50): `Array/prototype/{some 115, every 113, filter 109,
map 93, forEach 86, reduceRight 69, reduce 58}`, `language/statements/
{function/dstr 88, generators/dstr 88, async-generator/dstr 52}`.

**Why it is genuinely Phase 2 (not drift):** PR #1767 ran its regression gate
against the SAME fresh baseline seconds apart and was clean (+21, signature
`f310311519813a1c`, 3 files). So the -1180 is specific to #1769's 4-file Phase 2
delta (`context/types.ts`, `statements.ts`, `nested-declarations.ts`,
`typeof-delete.ts` — array-methods.ts is byte-identical to main).

**Why it could not be fixed quickly:** the regression does NOT reproduce in
targeted local compiles (standalone OR host) of realistic shapes —
`Array.prototype.some/map/forEach` + a block-nested helper, block-fn read only
in-block, function-with-block-fn+locals all compile and run correctly locally.
The failures live in test262's specific harness/strict-mode shapes (the gate's
default runner config) that the local `compileToWasm` helper doesn't replicate.
The `null_deref`/`wasm_compile` categories across hot-path Array methods point to
the Phase 2 **TDZ-var allocation in `hoistFunctionDeclarations`**
(`annexBBlockNestedEligible` → `allocLocal(funcName)` + `__tdz_` flag) perturbing
local-index layout / leaving an uninitialised externref outer-binding local that a
shared path reads — but the exact trigger needs the full test262 harness to
reproduce, i.e. a local test262 slice run over the flagged buckets.

**Recommendation (per tech-lead's pre-authorised fallback):** ship Phase-1-only
(already merged), close/draft PR #1769, and rework Phase 2 as a follow-up that
(a) reproduces against a LOCAL test262 slice over the flagged buckets before
re-attempting, and (b) narrows `annexBBlockNestedEligible` / the outer-binding
allocation so it cannot perturb functions that merely CONTAIN a block-nested
helper (the dominant test262 harness shape). The typeof-resolution fix
(`emitAnnexBTypeofFlagBranch` at the top of the undeclared-identifier branch) is
correct and should be preserved for the rework.

## Status: Phase-1-only (2026-06-19) — Phase 2 deferred to #2552

Per tech-lead decision after the #1769 -1180 gate fail: **Phase 1 (#1764, ~93-test
floor) is merged and stands alone; Phase 2 is deferred** to a focused rework
tracked as **#2552** (narrow the TDZ-var allocation so it cannot perturb
hot-path codegen; reproduce against a local test262 slice first; preserve the
correct typeof-resolution fix). PR #1769 lands **docs-only** (the Phase-2 source
was reverted to origin/main so it carries ZERO source change — Phase 1 is already
on main via #1764); it records the deferral and creates the #2552 rework issue.
#2200 stays `in-progress` (Phase-1 shipped, Phase-2 → #2552).

---

## Measured evidence — the "eval blocker" is mostly this issue (2026-07-25, #3631 partition)

Partitioning the ES5 `eval`-dependent failures re-attributes the large majority
of them to **this** issue rather than to eval.

Baseline: `loopdive/js2wasm-baselines` `test262-current.jsonl`, fetched
2026-07-25 18:21. Population = ES5-classified (post-#3626 classifier),
`eval`-dependent (`*/eval-code/` ∪ `built-ins/eval` ∪ source matches `eval(`),
host lane: **775 tests, 484 not passing**.

| bucket                                         | tests   | share      |
| ---------------------------------------------- | ------- | ---------- |
| `annexB/language/eval-code/*` (**this issue**) | **380** | **78.5 %** |
| everything else                                | 104     | 21.5 %     |

Every one of the 380 carries a **constant** eval string that the folder reaches
and then deliberately declines, on the `funcDeclNeedsDynamicEvalPath` guard —
i.e. precisely because the body contains a block/if/switch-nested
`FunctionDeclaration` whose B.3.3 dual-binding semantics the splice does not
implement. Static bail-reason breakdown of the 380: 204 `direct-const |
FunctionDeclaration`, 112 `indirect-const | FunctionDeclaration`, 64 with an
additional `FunctionExpression`/`ForIn`/`ForOf` node.

Lane split for the whole `annexB/language/eval-code` directory (469 tests):

| lane                   | pass    | rate      |
| ---------------------- | ------- | --------- |
| host                   | 89 /469 | 19 %      |
| standalone (host-free) | 1 /469  | **0.2 %** |

Within the host lane the family splits by where the `assert` call sits:

| shape                                        | pass     | rate       |
| -------------------------------------------- | -------- | ---------- |
| `assert` **inside** the eval string (masked) | 0 / 144  | 0 %        |
| `assert` **outside** the eval string         | 89 / 325 | **27.4 %** |

The masked half is blocked earlier by #3633 (module bindings invisible to
`__extern_eval`) and cannot be scored against B.3.3 until that lands. Treat
27.4 % as the honest post-unmasking predictor, **not** 100 %.

**Consequence for sizing:** the ES5 `eval` programme is not worth ~484 tests to
eval work. It is worth ~104 to eval work and ~380 to this issue plus #3633.

---

## Implementation Plan — interpreter-tier eval-code slice (arch, 2026-08-08)

**Scope guard (load-bearing, #2552):** every change below is confined to the
INTERPRETER tier (`src/interp/`). No AOT hot-path rework — the last AOT B.3.3
attempt (#1769) cost **−1180** net and was reverted. Where a failure's root
cause is AOT-side, it is documented as a follow-up here, NOT specced for
implementation.

### 0. Where the lever actually stands (measured 2026-08-08 — the task framing was stale)

The B.3.3.3 core (init / update / cancellation / function-in-if, direct and
indirect) is **already implemented and passing on current main**. The framing
numbers ("473/816, annexB 469-led") predate #4137's fixes (WeakMap-miss +
catch-parameter Environment Record, +40), #4182 (+16 in eval-code via live
global block-fn bindings), and the acorn/harness work.

Authoritative baseline: `test262-standalone-current.jsonl` in
`loopdive/js2wasm-baselines`, rows stamped **2026-08-08 06:14Z**, fetched
fresh (the default host-lane `test262-current.jsonl` is the WRONG lane for
this issue — it shows 296 fails because the host `__extern_eval` splice bails
on `funcDeclNeedsDynamicEvalPath`; do not diagnose from it):

| population | pass |
| --- | --- |
| `language/eval-code/` + `annexB/language/eval-code/` (816) | **745** |
| `annexB/language/eval-code/` (469) | **442** |

E1 (node, pinned-acorn, `runScript`) probes confirm the semantics core:
`init`/`update`/`skip`(lexical cancel)/`if-arm`/`if-else-arm`/`switch`/
`typeof-init`/`if-false`(never-entered)/`no-skip-try`(simple catch param
exempt)/`two-blocks`(last-wins) all produce spec-correct values.

### (a) Baseline failure buckets — 27 files, three buckets, ZERO hangs

| bucket | count | files (examples) | error |
| --- | ---: | --- | --- |
| **B1 update** — second declaration in a `switch` after a popped same-name scope | **2** | `direct/func-switch-case-eval-func-existing-block-fn-update.js`, `direct/func-switch-dflt-eval-func-existing-block-fn-update.js` | `Expected SameValue(«"first declaration"», «"second declaration"»)` |
| **B2 cancellation** — destructuring `catch ({f})` family | **24** | all `*-skip-early-err-try.js` (16 direct + 8 indirect), e.g. `direct/func-block-decl-eval-func-skip-early-err-try.js`, `indirect/global-switch-case-eval-global-skip-early-err-try.js` | `SyntaxError: NaN` (compiled-acorn raises at parse — #4194) |
| **B3 singleton** — `$262.evalScript` global-lexical persistence | **1** | `direct/script-decl-lex-no-collision.js` | `Expected SameValue(«function () { [native code] }», «1»)` |

**Hang family (c-answer): retired.** Zero timeout rows in the annexB
eval-code standalone baseline; the old ~100-file function-in-if hang family
(#2928 E6 finding 2) does not reproduce — if-arm forms are measured correct
(E1 probe + real-file `skip-early-err-switch` pass). The 4 `compile_timeout`
rows visible for this directory are in the HOST-lane jsonl only. The single
standalone eval-code timeout (`language/eval-code/indirect/var-env-var-strict.js`,
strict-rerun) is not annexB and not this issue.

Instrument note: per-file reproduction used the faithful worker path —
`CompilerPool(1, "unified")` + `assembleOriginalHarness` +
`runTest(src, { originalHarness: true, target: "standalone", … }, 30_000)` —
after `TEST262_FULL_RUNTIME_EVAL=1` provider build. Validated against the
published baseline on 13 files: 5 fail-repros exact-match, 8 pass controls.
**Trap:** bare `runTest` without `originalHarness: true` yields
`compile_error: no test export` / divergent verdicts on harness files — do
not diagnose from it.

### (b1) B1 root cause — control-stack slot reuse is a silent no-op in the provider-compiled emitter

Evidence chain (every step measured):

1. E1 node (`runScript`) and node-level `executeDirectEval` (with sidecar
   cells) both produce "second declaration" — **the TS logic is correct**.
2. Standalone bisect through the real provider (synthesized test262-format
   cases, faithful worker path):

   | case (eval string shape) | verdict |
   | --- | --- |
   | A `{ function f(){first} }` then `switch … case: function f(){second}` | **FAIL** (got first) |
   | B plain switch | pass |
   | C block then block, same name | pass |
   | D popped block binds *other* name `q`, then switch | pass |
   | E popped `{ let f }`, then switch fn `f` | **FAIL** (updated stays undefined — wrongly cancelled) |
   | F block then if-arm decl | pass |
   | G switch then switch | pass |
   | H popped var-only block (no lexical env) then switch | pass |
   | I popped `{ let q }`, then switch with **`break`** | **FAIL** — `interp/emitter: unsupported in Phase 1: break with no matching target` (emit-time!) |
   | J switch with break, no popped scope | pass |

3. Mechanism: `FunctionEmitter` tracks active scopes in the class-field
   vector `loops` with a logical top pointer `loopTop` (physical slots are
   never popped; they are REUSED via
   `if (this.loopTop < this.loops.length) this.loops[this.loopTop] = ctx; else this.loops.push(ctx)`).
   Under the **provider self-compile** the index-store branch is a silent
   no-op: the stale popped scope stays visible at its slot (A: stale
   `{label: LEXICAL_SCOPE_LABEL, continues:["f"]}` makes
   `cancelsAnnexBVarBinding("f")` return true during `emitSwitch`'s
   eligibility scan → `annexBFunctionNames` stays empty → the B.3.3.3.b
   `SetMutableBinding` (`BUILTIN_ASSIGN_OUTER_NAME`) is never emitted), and
   the NEW ctx is invisible (I: `findLoop` cannot see the switch's break
   target → emit-time `UnsupportedNodeError`). Case I proves this is a
   **latent bug beyond the 2 annexB files**: any `break`/`continue`/labeled
   target whose ctx lands in a reused slot inside eval'd / `Function`-built
   code is broken.
4. Why `emitBlock` shapes don't trip it: `emitBlock` computes annexB
   eligibility BEFORE pushing anything (loopTop still excludes the stale
   slot); `emitSwitch` computes eligibility AFTER `pushLoop(null,false)`
   (the break-target ctx) — the first slot-reuse in the sequence.
5. **Caveat for the follow-up compiler issue:** a minimal ordinary-compile
   repro of the idiom (small class, `items: Ctx[]` field, push/pop/reuse)
   does NOT reproduce — `ret 0`, correct. The defect is specific to the
   provider-pipeline compile of the emitter (`build-runtime-eval-provider.mjs`
   concatenates `src/interp/*` and compiles that). Whoever takes the compiler
   issue must A/B against the provider build, not a toy module.

### (b1) B1 fix — in-place slot mutation, one helper, seven call sites (VERIFIED)

**File: `src/interp/emitter.ts`** (all line numbers = current main):

Add one private helper (insert immediately before `pushLoop`, ~line 1178;
keep the file's self-compile-safe idioms — plain method, indexed access, no
destructuring, no multiline typed arrows):

```ts
/** Install a loop/scope context at the top of the control stack.
 * Physical slots are never popped, only logically released via `loopTop`.
 * Slot REUSE must not use an index-store (`this.loops[i] = ctx`) — that
 * store is a silent no-op under the provider self-compile (#<new-issue>),
 * leaving the stale popped scope visible to `scopeBindsName`/`findLoop`.
 * Instead, mutate the resident slot object's fields in place and return
 * THE SLOT (callers patch `breaks` markers through the returned ctx, so
 * returning a detached object would break break/continue patching). */
private installLoopCtx(ctx: LoopCtx): LoopCtx {
  if (this.loopTop < this.loops.length) {
    const slot = this.loops[this.loopTop]!;
    slot.label = ctx.label;
    slot.breaks = ctx.breaks;
    slot.continues = ctx.continues;
    slot.isLoop = ctx.isLoop;
    this.loopTop += 1;
    return slot;
  }
  this.loops.push(ctx);
  this.loopTop += 1;
  return ctx;
}
```

Replace the 3-line idiom at ALL SEVEN sites with `this.installLoopCtx(X);`:

| site | lines | ctx var |
| --- | --- | --- |
| `emitBlock` | 536–538 | `scopeCtx` |
| `emitWith` | 576–578 | `scopeCtx` |
| `emitFor` (lexical init) | 770–772 | `scopeCtx` |
| `emitForInOf` (lexical binding) | 855–857 | `scopeCtx` |
| `emitSwitch` (CaseBlock env) | 962–964 | `scopeCtx` |
| `emitTry` (catch scope) | 1070–1072 | `catchScope` |
| `pushLoop` | 1187–1189 | `ctx` — **must become `return this.installLoopCtx(ctx);`** |

Why in-place field mutation is safe where the index-store is not (argue this
in the PR, it is the design's crux): (i) array-element READS demonstrably
return the canonical resident object (the corrupted scans read the stale
object — that IS an element read); (ii) object field writes are pervasive and
reliable under self-compile (e.g. `emitConditionalStatement` builds synthetic
nodes by field assignment and the if-arm forms pass standalone); (iii) no
caller holds a popped ctx after `popLoop` — all `patchTargetMarker` calls on
a ctx complete before the next push (audited: emitWhile/DoWhile/For/ForInOf/
Switch/Labeled all patch then pop within the same emit function).

**Verified A/B (2026-08-08, this worktree, patch applied → provider rebuilt →
reverted):** cases A, E, I flip to pass; B/C/D/F/G/H/J stay pass; real files
`func-switch-case-…` and `func-switch-dflt-…-existing-block-fn-update.js`
flip to **pass**; 8 real-file controls (block-decl existing-block-fn-update,
switch-case update/init, indirect switch-case existing-block-fn-update +
update, no-skip-try, skip-early-err-switch, switch-case-decl-nostrict) all
stay pass. E1 probe matrix unchanged. `tsc --noEmit` clean.

Wasm IR: none — the fix changes which bytecode the emitter emits only in the
previously-corrupted cases (the missing `BUILTIN_ASSIGN_OUTER_NAME` sequence
reappears); no new opcodes, no compiler change.

### (b2) B2 — the 24 `skip-early-err-try`: interpreter layers 2+3 (specced), AOT layer 1 (prerequisite, NOT here)

Shape: eval'd `try { throw {}; } catch ({ f }) {{ function f() {} }}` with
asserts inside the eval string. Three independent layers (per #4194/W14, all
still true on current main — re-verified):

- **Layer 1 (AOT, #4194 — OUT of scope here):** standalone instances have no
  expando substrate, so compiled-acorn's `copyNode` (`for (var prop in node)`)
  returns a blank node and the parser RAISES on object-pattern shorthand —
  the `SyntaxError: NaN` seen today. Until #4194 lands, interpreter-only work
  flips **zero** of the 24. Do not count them in this PR's expected delta and
  do not reimplement #4194 in `src/interp`.
- **Layer 2 (interpreter, specced):** `emitTry` (~line 1052–1055) throws
  `UnsupportedNodeError("catch destructuring (ObjectPattern)")`. Implement a
  **minimal slice**: `ObjectPattern` CatchParameter with non-computed keys
  and `Identifier` values (covers shorthand `{ f }` and `{ a: b }` — the only
  shapes in the 24). Keep the refusal for defaults/rest/nesting/ArrayPattern.
  Lowering, replacing the `s.handler.param.type !== "Identifier"` throw:
  1. Collect `boundNames` + `keyNames` by walking `param.properties`
     (`prop.computed` → refuse; `prop.value.type !== "Identifier"` → refuse;
     bind `prop.value.name`, read key `prop.key.name`).
  2. Push the lexical env with `boundNames` — **label
     `LEXICAL_SCOPE_LABEL`, NOT `SIMPLE_CATCH_SCOPE_LABEL`** (that IS layer
     3: B.3.5 exempts only `CatchParameter: BindingIdentifier`; a
     destructuring parameter must CANCEL B.3.3's synthetic var, and the plain
     label makes `cancelsAnnexBVarBinding` count it with zero extra code).
  3. For each i: `Ldar handlerReg` → `GetProp keyNames[i]` →
     `initializeName(boundNames[i])` (TDZ cells, so initialize not store —
     mirror the existing simple-param `initializeName` at 1075–1076).
- **Layer 3b (collectors — REQUIRED with layer 2, currently unreachable):**
  the plan/hoist collectors descend into catch bodies ignoring the parameter
  entirely, which is correct ONLY for the exempt simple param. Once layer 2
  makes destructuring reachable, the eligibility side must cancel too:
  - `src/interp/eval-environment.ts`, `collectNestedVarDeclarations`
    TryStatement arm (~202–207): when `statement.handler.param` exists and is
    NOT an `Identifier`, append its bound names to `lexicalAncestors` for the
    `handler.body` descent (→ the name never enters `blockFunctionNames`, so
    `preparePersistentEvalBindings`/`prepareEvalEnvironment` create no
    synthetic var cell — B.3.3.3 "would produce an early error" satisfied).
  - `src/interp/emitter.ts`, `collectNestedVarHoist` TryStatement arm
    (~370–373): same append for the handler descent (keeps function-body
    `hoistedVars` and script preflight consistent).
  - For a SIMPLE `Identifier` param, keep NOT appending — that is the B.3.5
    exemption and `*-no-skip-try` (passing today) is the regression control.

E1 acceptance for layers 2+3 (node-acorn parses the shorthand fine, so this
is testable NOW, before #4194): `before = typeof f; try { throw {}; } catch
({ f }) {{ function f() {} }} after = typeof f;` → both `"undefined"`, and a
bare `f` read after → ReferenceError. Control: same with `catch (f)` →
`after === "function"` (unchanged). Add these to `tests/interp/` (E1 lane).

### (b3) B3 singleton — defer, documented follow-up (cross-boundary)

`direct/script-decl-lex-no-collision.js`: `eval('if (true) { function
test262Fn() {} }')` then `$262.evalScript('let test262Fn = 1;')`, assert
(AOT-side) `test262Fn === 1`. Two gaps compound: (1) `runScript`/evalScript
puts script-level lexical declarations in a throwaway declarative env
(`prepareEvalEnvironment` → `declarativeWithBindings(...)`, discarded after
the run) instead of persisting them in the realm's canonical global lexical
cells (`RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY` carrier, the #4182 seam);
(2) even persisted, the ASSERTING READ is compiled AOT and resolves the
global-object property, not the runtime lexical cell — an AOT read-path
change, out of interpreter scope (#2552 guard). 1 file; matches W14's
"remaining 9 are `$262.evalScript` interpreter-side" family on the
global-code lever. File as its own follow-up issue; do not chase here.

### (d) Edge cases (verified where marked)

- **Strict eval gets NONE of this** — annexB is gated on `!this.strictMode`
  at all three emitter sites (511, 945, 291) and strict eval takes the
  private varEnv path (`prepareEvalEnvironment` 612–617). The B1 fix and B2
  layers change nothing inside those gates; the `skip-early-err` templates
  are `noStrict`-flagged so the strict rerun never runs them.
- **Indirect vs direct**: both route through the same emitter → the B1 fix
  covers both (indirect controls verified). The sidecar
  (`executeDirectEval` cells) is untouched.
- **Nested blocks / redeclaration across sibling scopes**: last-executed-wins
  via repeated `SetMutableBinding` — verified (C, G, two-blocks).
- **Never-entered block** (`if(false){…}`): binding stays undefined —
  verified (if-false probe).
- **Simple catch param** must remain B.3.5-exempt (`SIMPLE_CATCH_SCOPE_LABEL`
  split, #4137) — `*-no-skip-try` is the canary.
- **installLoopCtx must overwrite ALL FOUR fields** — a partial write leaves
  `label`/`continues` from the popped scope and reproduces the bug shape; and
  `pushLoop` must return the SLOT object (loop emitters patch
  `ctx.breaks[1]/[2]` through the returned reference) — case I is the
  regression test for getting this wrong.
- **E1 cannot see B1** — the defect only exists in the provider-compiled
  emitter. Any regression test for B1 must run the standalone lane (lever run
  or worker-path probe); node-lane `tests/interp` tests are necessary but not
  sufficient.

### (e) Verification — commands and expected counts

Build order (NOT optional; the provider cache key folds in `src/interp`
sources — rebuild after EVERY interp change):

```bash
./node_modules/.bin/esbuild src/index.ts  --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
./node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
NODE_OPTIONS=--max-old-space-size=3072 node scripts/build-runtime-eval-provider.mjs
```

Lever run (covers `direct/` AND the `indirect/` no-regression slice — the
filter includes both):

```bash
TEST262_PATH_FILTER=annexB/language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

Expected: **442 → 444 of 469** (B1's two files; measured, not projected).
The 24 `skip-early-err-try` stay `SyntaxError: NaN` until #4194 lands (then
expected → 468/469 with layers 2+3 in place); the singleton stays. Indirect
slice: 159/160 → 159/160 (its only failures are in the 24). Watch for BONUS
flips outside annexB from the break/continue corollary (case I class) in
`language/eval-code/` and `built-ins/eval` — report them, they are upside.
Also run the E1 differential harness (`npm test -- tests/interp/`) — must be
flat.

### (f) Risks and collisions

- **#4137 (in-progress, `ttraenkler/L3-annexb-hoisting`) owns
  `src/interp/emitter.ts` + `eval-environment.ts` edits** and this spec's B1
  rewrites the `emitTry` catch-scope push it added. Run
  `node scripts/pre-dispatch-gate.mjs 2200` and check the claim ref before
  dispatch; if #4137's lane is active in the file, predecessor-stack on its
  branch. Its remaining arm (the `SyntaxError: NaN` message channel) is
  codegen-side — semantic overlap is low, textual conflict risk is real.
- **#2928 Phase 2** owns emitter feature growth; layer 2 (catch
  destructuring) is a Phase-2 item implemented here as a minimal slice — if a
  Phase-2 lane is active on destructuring, hand layer 2 to it and keep only
  B1 + layer 3b in this PR.
- **#4194** is the B2 gate; it carries a recorded **−5** hazard on the
  adjacent `Object.keys` widening — do not bundle.
- The B1 fix touches every control-flow emit path in the interpreter;
  regression surface = all eval'd control flow. Mitigation is the A–J matrix,
  8 real-file controls, the full 469 lever, and the E1 differential harness —
  all listed above, all already exercised once in this worktree.
- `emitter.ts` LOC: the helper (+17) is offset by the idiom collapse (−14
  across 7 sites); no new `loc-budget-allow` expected.

### Follow-ups to file (via `claim-issue.mjs --allocate`, not hand-picked)

1. **Compiler: provider self-compile silently drops index-store slot reuse in
   class-field object vectors** — repro = eval strings A/E/I through the
   FULL provider (the minimal ordinary-compile probe does NOT reproduce;
   state that in the issue so the taker A/Bs against
   `build-runtime-eval-provider.mjs`). Until fixed, `src/interp` must avoid
   the idiom (the B1 helper is the workaround and the grep pattern
   `loops\[this\.loopTop\] =` should stay at zero).
2. **evalScript/global script lexical persistence** (B3) — realm-level
   lexical cells + the AOT read seam (#4182's carrier). 1 file here, plus the
   ~9-file `$262.evalScript` family on the global-code lever (W14).

---

## Implementation — interpreter-tier eval-code slice (dev, 2026-08-08)

Implements the spec section above. Three commits, `src/interp/` only (no AOT /
codegen changes — the #2552 hazard).

### B1 — `installLoopCtx` (spec §b1)

`src/interp/emitter.ts`: one private helper, in-place field mutation of the
resident control-stack slot (all four fields, returns THE SLOT), replacing the
3-line index-store push idiom at all seven install sites — `emitBlock`,
`emitWith`, `emitFor`, `emitForInOf`, `emitSwitch`, `emitTry` (catch scope) and
`pushLoop`. `grep 'loops\[this\.loopTop\] ='` is now zero, which is the
invariant that keeps the provider-self-compile defect out of the interpreter.

### B2 layers 2 + 3b — catch `ObjectPattern` minimal slice (spec §b2)

- `emitTry` accepts a CatchParameter `ObjectPattern` with **non-computed
  Identifier keys and Identifier values** (`{ f }`, `{ a: b }`). Defaults,
  rest, nesting and `ArrayPattern` keep the `UnsupportedNodeError` refusal.
  The lexical env is pushed with **`LEXICAL_SCOPE_LABEL`, not
  `SIMPLE_CATCH_SCOPE_LABEL`** — B.3.5 exempts only
  `CatchParameter : BindingIdentifier`, so a destructuring parameter must
  CANCEL B.3.3's synthetic var, and the plain label makes
  `cancelsAnnexBVarBinding` count it with no extra code.
- The plan/hoist collectors (`collectNestedVarDeclarations` in
  `eval-environment.ts`, `collectNestedVarHoist` in `emitter.ts`) append a
  NON-Identifier catch parameter's bound names to `lexicalAncestors` for the
  handler descent. A simple Identifier parameter keeps NOT appending — that is
  the B.3.5 exemption, and `*-no-skip-try` is its regression control.

**Expected verdict flips from B2: ZERO**, and that is by design. The 24
`*-skip-early-err-try` files stay `SyntaxError: NaN` until **#4194** lands
(standalone instances have no expando substrate, so compiled-acorn's `copyNode`
returns a blank node and the parser raises on object-pattern shorthand before
any of this code runs). Acceptance for B2 is therefore the node-lane E1 test
`tests/interp/annexb-catch-destructuring.test.ts`, which is measurable today.

### B3 — deferred, not attempted

`direct/script-decl-lex-no-collision.js` is left failing. Per spec §b3 it needs
BOTH realm-level lexical persistence for `$262.evalScript` AND an AOT read-path
change, and the AOT half is out of scope here (#2552). Recorded as follow-up 2
below.

## Follow-ups to file — TODO (ids NOT yet allocated)

`node scripts/claim-issue.mjs --allocate` **refused** in this sandbox: the
open-PR id scan could not reach `gh` (3 attempts), so the tool exited **6** with
*"Nothing was reserved. Fix gh auth and re-run, or pass `--allow-unscanned` to
reserve anyway."* Passing `--allow-unscanned` would have reserved an id that was
never checked against in-flight PRs, so nothing was reserved and **no id was
hand-picked**. Both follow-ups are recorded here in full; whoever has working
`gh` should allocate an id and move each section into its own issue file.

### TODO follow-up 1 — compiler: the provider self-compile silently drops index-store slot reuse

**Symptom.** In a class with a growable object-vector field and a logical top
pointer, the slot-reuse store `this.items[this.top] = ctx` is a **silent
no-op** when the class is compiled through
`scripts/build-runtime-eval-provider.mjs`. Reads of that element keep returning
the STALE object; the new object is invisible. No error, no diagnostic — the
program simply behaves as if the assignment never executed.

**Why it matters beyond #2200.** In the interpreter emitter this corrupted (a)
Annex B B.3.3 eligibility (`cancelsAnnexBVarBinding` read a popped scope's
binding names and cancelled a live declaration) and (b) `break`/`continue`
target resolution (`findLoop` could not see a target installed in a reused
slot, producing an emit-time `UnsupportedNodeError: break with no matching
target`). (b) affects ANY eval'd / `Function`-built code with a
break/continue/labeled target after a popped lexical scope, not just the two
annexB files that motivated the fix.

**Reproduction — the caveat that makes or breaks this issue.** A minimal
ordinary-compile probe of the idiom (small class, `items: Ctx[]` field,
push/pop/reuse) does **NOT** reproduce; it returns the correct result. The
defect is specific to the PROVIDER-pipeline compile, which concatenates
`src/interp/*` and compiles that unit. **A/B against
`build-runtime-eval-provider.mjs`, not a toy module.** The measured repro is
the eval-string bisect A/E/I from spec §b1 run through the full provider via
the faithful worker path (`CompilerPool(1, "unified")` +
`assembleOriginalHarness` + `runTest(..., { originalHarness: true, target:
"standalone" })`).

**Until it is fixed**, `src/interp` must avoid the idiom. The `installLoopCtx`
helper is the workaround, and the grep pattern `loops\[this\.loopTop\] =` must
stay at zero in `src/interp/emitter.ts`.

**Re-measured 2026-08-08 (#4194 lane) — still reproduces, and the compile
OPTIONS are now eliminated as the variable.** #4194 built the instance expando
substrate (`__extern_set` declared-field write-through + expando bag), which was
the plausible candidate for the same root cause; it is **not** — the defect is
unchanged after it.

The re-measurement also produced the self-contained repro this follow-up was
missing. Append the idiom's minimal shape to the REAL provider source and
compile that unit with `RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS`
(`.tmp/probe-4194/slot-reuse-2200.mjs`, ~220 s) — **no revert of
`installLoopCtx` required, and none was made**:

| canary, inside the provider unit | correct | measured |
| --- | ---: | ---: |
| A `push("first"); pop(); push("second"); topLabel()` | 1 | **2** (stale slot) |
| I `findLabel("target")` visible ∧ `findLabel("popped")` gone | 11 | **0** (new ctx invisible AND the stale one still found) |
| E reused slot must not expose the popped ctx's mutable array | 1 | **2** (stale) |

The control (`slot-reuse-toy.mjs`) runs the **identical** canaries as a toy
unit, once plainly and once **under the provider's own compile options**, and
answers **1 / 11 / 1 — correct, both times**. So the options are not the
variable: it is a property of the 462 KB concatenated provider **UNIT**, which
points at something degrading with unit size or cross-module type resolution
rather than at a flag. That is where the next lane should start.

### TODO follow-up 2 — `evalScript` / global-script lexical persistence (B3)

`direct/script-decl-lex-no-collision.js`: `eval('if (true) { function
test262Fn() {} }')` then `$262.evalScript('let test262Fn = 1;')`, then an
AOT-compiled assert that `test262Fn === 1`. Two gaps compound:

1. `runScript`/`evalScript` puts script-level lexical declarations in a
   throwaway declarative env (`prepareEvalEnvironment` →
   `declarativeWithBindings(...)`, discarded after the run) instead of
   persisting them in the realm's canonical global lexical cells (the
   `RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY` carrier — the #4182 seam).
2. Even once persisted, the asserting READ is compiled AOT and resolves the
   global-object property rather than the runtime lexical cell. That is an AOT
   read-path change and is deliberately out of interpreter scope (#2552).

Worth 1 file on this lever plus the ~9-file `$262.evalScript` family on the
global-code lever (W14).

## Test Results (dev, 2026-08-08)

Build order per spec §e (both esbuild bundles → `build-runtime-eval-provider.mjs`
after EVERY `src/interp` change — the provider cache key folds those sources).

### Lever: `annexB/language/eval-code/`, standalone, `TEST262_FULL_RUNTIME_EVAL=1`

| build | pass / 469 | indirect | fail→pass | pass→fail |
| --- | --- | --- | --- | --- |
| baseline (`test262-standalone-current.jsonl`, fetched fresh) | 442 | 152 / 160 | — | — |
| B1 only | **444** | 152 / 160 | the 2 `func-switch-{case,dflt}-eval-func-existing-block-fn-update` | **0** |
| B1 + B2 (final) | **444** | 152 / 160 | same 2 | **0** |

B2 moves ZERO verdicts, exactly as specced — file-for-file identical to the B1
run. Remaining 25 failures: 24 × `SyntaxError: NaN` (the `*-skip-early-err-try`
family, gated on #4194) + 1 × the B3 `script-decl-lex-no-collision` singleton.

Note: the spec's "indirect slice 159/160" is off by seven — the fetched
baseline has indirect at **152/160**, and 160 − 152 = 8 is exactly the indirect
half of the 24-file `skip-early-err-try` bucket the spec itself counts. 152/160
is the number to hold flat; it did.

`pnpm run test:262` could not be used: it takes a machine-global lock
(`/tmp/js2wasm-test262.lock`) that another lane held throughout. The runs above
use the same faithful worker path the vitest runner uses —
`CompilerPool(1, "unified")` + `assembleOriginalHarness` + `runTest(..., {
originalHarness: true, target: "standalone" }, 30_000)` — walking every `.js`
under the subtree and writing per-file verdicts, which also gives exact
fail→pass / pass→fail lists rather than a bare total.

### A–J bisect matrix (spec §b1), through the full provider

All ten pass on the final build. **A, E, I flip** (they were the specced
failures); B, C, D, F, G, H, J stay pass. Case I —
`{ let q = 1; } switch (1) { case 1: …; break; … }` — is the regression test for
`installLoopCtx` returning the SLOT and overwriting all four fields; getting
either wrong resurfaces `break with no matching target` at emit time.

Real-file controls, all still pass: `func-block-decl-eval-func-existing-block-fn-update`,
`func-block-decl-eval-func-no-skip-try`, `func-block-decl-eval-func-skip-early-err-switch`,
`indirect/global-switch-case-eval-global-existing-block-fn-update`.

### Bonus scan outside annexB — NONE found

`language/eval-code/` (347) and `built-ins/eval/` (10) were swept for the
case-I break/continue corollary. Result: **no flips attributable to this
change.** Two apparent `pass→fail` in `language/eval-code`
(`direct/strict-caller-global.js`, `indirect/parse-failure-2.js`) were an
artifact of the ad-hoc runner, which marked `phase: runtime` negatives as
early-error negatives; `tests/test262-shared.ts` sets `isNegative` only for
`parse`/`early`/`resolution`. Both pass once the runner matches. One apparent
`fail→pass` (`direct/cptn-nrml-empty-do-while.js`) was A/B'd against a provider
rebuilt from the pre-change `src/interp`: it passes there too, so it is
baseline drift, not a win from this change.

### Node lane

- `npx vitest run tests/interp/` — **204 passed** (196 before + 8 new). Flat.
- `tests/interp/annexb-catch-destructuring.test.ts` — 6 of its 8 assertions
  fail on pre-B2 `main` and pass after, including the differential against the
  host for all four catch-parameter shapes.
- `npx tsc --noEmit` clean. `check:loc-budget` / `check:func-budget` green
  (emitter growth covered by this file's `loc-budget-allow`).
