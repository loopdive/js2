---
id: 2200
title: "Annex B B.3.3 block-level function declaration hoisting — outer binding created/initialized incorrectly (~186 test262 fails)"
status: in-progress
assignee: ttraenkler/dev-1769
sprint: 64
created: 2026-06-19
updated: 2026-06-19
phase1: done
phase2_rework: 2552
has_impl_plan: true
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, scoping
language_feature: block-scoped-functions
goal: spec-completeness
related: [1642]
test262_bucket: annexb-block-fn-hoisting
test262_count: 186
es_edition: annexb
origin: "2026-06-19 sprint-64 standalone failure mining: annexB/language/function-code (91) + annexB/language/global-code (95) fail the B.3.3 outer-binding hoisting contract. Also fails identically in JS-host (203 fail / 107 pass), so it is a host-agnostic scoping bug."
---

# #2200 — Annex B B.3.3 block-level function declaration hoisting

## Problem

ECMA-262 **Annex B.3.3** ("Changes to FunctionDeclarationInstantiation /
GlobalDeclarationInstantiation / EvalDeclarationInstantiation") governs the
web-compat semantics of a `FunctionDeclaration` nested inside a *block* (not a
function body). The spec creates an *additional, var-scoped* outer binding for
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
2. **Outer binding initialized too eagerly** — even when the outer binding *is*
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
(function() {
  // Outer `f` must NOT be created — a `let f` shadow lives between.
  let threw = false;
  try { f; } catch (e) { threw = e instanceof ReferenceError; }
  // assert threw === true   (compiler: f is wrongly visible → no throw)
  {
    let f = 123;
    {
      function f() {}   // block-level fn decl, but `let f` blocks the hoist
    }
  }
  return threw ? 1 : 0;
})();
```

```js
// (B) outer binding starts uninitialized, becomes the fn value after the block.
(function() {
  // `f` exists (var-scoped) but is uninitialized here.
  const before = typeof f;          // must be "undefined" (binding uninitialized)
  { function f() { return 42; } }   // after this block, outer f === the function
  const after = typeof f;           // must be "function"
  return (before === "undefined" && after === "function") ? 1 : 0;
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
   var-scoped Annex B binding), and emit the *initialization-to-function-value*
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
3. **Model the outer binding lifecycle** as a var that is *uninitialized* at
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
function-ref-as-value branch at line 766.** So if the Annex B *outer binding* is
materialised as a real var-binding (a function-local with a `tdzFlagLocals` entry,
or — at global scope — a module global with a `tdzGlobals` entry), the read is
intercepted by the earlier branch and the funcMap lookup at 766 is **never reached
for that name**. The block-local function itself stays in `funcMap` and keeps
working for *calls inside the block* and for the post-declaration assignment.

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
   created at entry but **uninitialised** (`undefined` is the *value*, but per the
   FunctionDeclarationInstantiation/var semantics a `var` binding is initialised to
   `undefined` — see the subtlety note below). At the **point the block-level
   `FunctionDeclaration` is evaluated** (its textual position, when control reaches
   the block), the spec performs `SetMutableBinding(F, fobj)` on the **function-level
   outer** binding — i.e. the outer `F` becomes the function object *only after* the
   block runs.
3. **Strict mode disables Annex B entirely** — no outer binding is ever created;
   the block function is purely block-scoped (`typeof f` outside the block is
   `"undefined"`, but via the genuinely-absent binding, and there is no
   post-block assignment to an outer name).

**Subtlety — `typeof f` "undefined" before the block (repro B).** Strictly, a
plain `var f` is initialised to `undefined` at entry (so `typeof f` is
`"undefined"` because the *value* is `undefined`, not because the binding is in
TDZ). But the test262 function-code cluster's dominant assertion is
`assert.throws(ReferenceError, function() { f; }, 'An initialized binding is not
created prior to evaluation')` — i.e. several of these tests want a **ReferenceError
on read before the block**, which is the TDZ behaviour, not the `undefined`-value
behaviour. The distinction is per-test: the *function-code* skip-tests want a
binding that is **absent/TDZ before the block** (read → ReferenceError) and present
after; the *repro B* in this issue wants `typeof f === "undefined"` before. **Both
are satisfied by a single mechanism: model the outer binding as a TDZ var** (a
local + a `__tdz_f` flag, flag=0 at entry, flag=1 after the block's declaration
runs). A *direct read* of `f` before the block emits `emitLocalTdzCheck` →
ReferenceError (satisfies the function-code cluster). A `typeof f` before the block
is special-cased to return `"undefined"` when the flag is 0 (satisfies repro B and
ES `typeof`-on-uninitialised… see the note in Phase 2 below). This is exactly how
`let`/`const` TDZ + `typeof` already interact, so we are reusing a proven pairing.

### Phased rollout (case-A guard first — it is independently shippable)

**Phase 1 (case A — the cancellation guard). ~Half the cluster, lowest risk.**
Make an *ineligible* block-nested function name **not** resolve as an outer value.
Today the bug is that `funcMap.get(name)` finds it unconditionally. Phase 1 does
NOT add an outer binding at all — it *suppresses* the accidental outer visibility
when sd1's detector says `cancels=true`, so the existing `let`/`const` TDZ binding
(or the genuine ReferenceError fallback) takes over.

**Phase 2 (case B — the uninitialised-then-init lifecycle).** For *eligible*
block-nested functions, create the TDZ outer var-binding, mark it initialised at
the declaration's textual position, and special-case `typeof`.

Phase 1 is dev-implementable and lands the case-A ReferenceError tests on its own.
Phase 2 builds on Phase 1's plumbing. Ship them as two PRs; Phase 1 is the floor.

---

### Phase 1 — case-A cancellation guard

**Goal:** when a block-nested `function F` is *ineligible* for the Annex B outer
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
    block recursion). The recursion structure already separates these: the *direct*
    decls are handled in the first `for` loop pass at lines 917–950 over the function
    body's own `stmts`; the *block-nested* ones are reached via the recursive descent
    at 954–1005. Only the latter are Annex B candidates. Tag candidacy at the
    descent boundary so a direct decl is never marked cancelled.

**File: `src/codegen/expressions/identifiers.ts`**

- At the function-ref-as-value branch (line 766, `const funcRefIdx =
  ctx.funcMap.get(name)`), add a guard **before** the `if (funcRefIdx !== undefined
  && …)` block at line 778: if `fctx.annexBCancelled?.has(name)` AND the read site is
  lexically *outside* the declaring block (use the TS checker / node position: the
  identifier's position is not within the block that contains the
  `FunctionDeclaration`), skip the funcMap-as-value resolution and fall through to
  the undeclared-identifier path (lines 820+), which already emits a proper
  `ReferenceError` instance for a name with no in-scope value binding.
  - **Do not** broadly disable funcMap resolution for the name — calls/reads *inside*
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

**Goal:** for an *eligible* block-nested `function F`, the enclosing scope gets a
var-binding for `F` that is in TDZ before the block and holds the function value
after.

**File: `src/codegen/statements/nested-declarations.ts` (in `hoistFunctionDeclarations`)**

- For an *eligible* block-nested decl (detector `cancels===false`), during the
  hoist pass **pre-allocate the outer binding as a TDZ var** in the enclosing
  `fctx`, mirroring `ensureLetConstBindingPatternTdzFlags`
  (`index.ts:12151`) and `hoistLetConstWithTdz`:
  - `allocLocal(fctx, F, externref)` if not already present (the function value as a
    closure is an externref/closure-struct ref — match the type
    `emitCachedFuncClosureAccess` returns; externref is the safe widening).
  - `allocLocal(fctx, `__tdz_${F}`, { kind: "i32" })` and register it in
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

- No new code needed for the *direct read*: once `F` is in `localMap` with a
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
  the current unconditional hoist. Only declarations reached through the *block*
  recursion are candidates. Verify the detector never marks a direct decl.
- **Strict mode** — Annex B is disabled. Detect strictness (module code is always
  strict; a `"use strict"` directive in the function/global body, or an enclosing
  strict scope). When strict: do not create the outer binding and do not mark
  cancelled — the block function is purely block-scoped. test262 has explicit
  strict-mode `function-code` variants asserting *no* outer binding; treat strict as
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
- **Nested intervening blocks** — the detector must scan *all* scopes between the
  declaring block and the enclosing function/global for a lexical shadow, not just
  the immediate parent. sd1's detector reportedly does this ("intervening" shadow);
  confirm it walks the full chain.
- **`funcMap` value-read inside the block stays intact** — the Phase 1 guard is
  position-scoped to *outside* the block; calls/reads of `F` inside its own block
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

| Phase | File | Function / line | Change |
|-------|------|-----------------|--------|
| both | `src/codegen/context/types.ts` | `FunctionContext` | add optional `annexBCancelled?: Set<string>` and `annexBOuterBindings?: Set<string>` |
| 1 | `src/codegen/statements/nested-declarations.ts` | `hoistFunctionDeclarations` (832; block recursion 954–1005) | run sd1's `cancels` detector for block-nested decls; on cancel, record name in `fctx.annexBCancelled` (still compile body) |
| 1 | `src/codegen/expressions/identifiers.ts` | before funcMap-as-value branch (~778) | skip funcMap resolution for `annexBCancelled` names read *outside* the declaring block → fall to ReferenceError path (826+) |
| 2 | `src/codegen/statements/nested-declarations.ts` | `hoistFunctionDeclarations` | for *eligible* block-nested decls, pre-allocate outer TDZ var (`allocLocal` + `__tdz_${F}` flag in `tdzFlagLocals`); record in `annexBOuterBindings` |
| 2 | `src/codegen/statements.ts` | `compileStatement` `isFunctionDeclaration` (218–236) | at textual position, `local.set` outer binding to the closure value + set `__tdz_${F}` flag to 1 (gated on `annexBOuterBindings`) |
| 2 | `src/codegen/typeof-delete.ts` | `compileTypeofExpression` (787; before static fold 860–866) | for `annexBOuterBindings` identifier operand, emit `if $__tdz_F → "function" else "undefined"` instead of const-folding |
| both | `tests/issue-2200-annexb-block-fn-hoist.test.ts` | new | repros A + B in sloppy + strict mode |

### Handoff

sd1 holds the implementation claim and owns the validated case-A `cancels`
detector + root-cause. This plan deliberately builds on that detector and does NOT
re-derive it. Open question for sd1 to confirm against the detector: (a) does it
walk the *full* intervening scope chain (not just the immediate parent) for the
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
