---
id: 6942
title: "fnctor constructor twin hoists nested function declarations before `var` locals exist — a ctor local captured by a nested function reads as null/0 (Octane regexp)"
status: in-progress
assignee: ttraenkler/claude-session-c-octane-fnctor-twin-hoist-20261010
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: closures, function declarations, var hoisting, constructor functions
goal: core-semantics
related: [874, 4139, 2071, 4456, 1312]
requested_by: ttraenkler/claude-session-c-octane-fnctor-twin-hoist-20261010
---

# #6942 — `__fnctor_<C>_new` hoists nested functions with an empty `localMap`, so their captures are lost

Found by the Octane triage for [#874](https://js2wasm.loopdive.com/dashboard/issue.html?slug=874-benchmark-compare-all-js-to)
(Session C, 2026-10-10). Octane `regexp.js` fails on js2 (gc host AND
standalone) with

```
TypeError: Cannot access property on null or undefined at 139:24
```

at `sum += Exec(re0, s0[i]);` (`regexp.js:136`, inside `runBlock0`): the
closure-captured `s0` is `null`. Node runs the same program.

## Minimized repro (7 lines)

```js
function dead() { new C(); }                       // a `new C()` site compiled BEFORE C
function C() {
  var s0 = ['a', 'b'];
  function runAll() { return s0[0].length; }       // nested DECLARATION capturing a ctor `var`
  this.run = runAll;
}
export function run() { var b = new C(); return b.run(); }
```

| | result |
|---|---|
| node | `1` |
| js2 gc (`compile()` + `buildImports`/`instantiateWasm`) | throws `TypeError: Cannot access property on null or undefined at 4:30` |
| js2 standalone (`target: "standalone"`) | same TypeError (Wasm exception) |

Wrong-value variant (no throw, silently wrong):

```js
function dead() { new C(); }
function C() { var k = 42; function get() { return k; } this.get = get; }
export function run() { var b = new C(); return b.get(); }
```

node `42`, js2 gc `0`, js2 standalone `0`.

Trigger matrix (all measured on `origin/main` 01e4888aae, 2026-10-10, gc lane
unless noted; drivers in `.tmp/r*.js` of the triage worktree):

| variant | result |
|---|---|
| second `new C()` site in a function declared BEFORE `C` (never called, or called) | **FAIL** |
| same, nested fn declared before the `var` (Octane's `Exec` order) | **FAIL** |
| captured value is a number (`var k = 42`) | **FAIL** (reads 0) |
| second site declared AFTER `C` (`function C(){…} function dead(){ new C(); }`) | pass |
| second site is a plain call `C()` or a bare reference `var g = C` | pass |
| both sites in exported functions declared after `C` | pass |
| two `new C()` in ONE function | pass |
| method is a function EXPRESSION (`this.run = function(){ return s0[0].length }`) | pass |
| nested fn does not capture | pass |

So the condition is: `C` is a function-constructor (fnctor) with a nested
`FunctionDeclaration` that captures one of `C`'s own `var` locals, and some
`new C()` is compiled before `C`'s own declaration body is.

## Root cause (confirmed from the emitted WAT)

The fnctor constructor twin `__fnctor_<C>_new` is synthesized on demand at the
first `new C()` site (`src/codegen/expressions/new-super.ts`, the fnctor
lowering around L2700–2960, "legacy on-demand registration"). Its body prologue
(L2933–2952, the #2071 block) runs

```ts
hoistFunctionDeclarations(ctx, ctorFctx, body.statements);
```

with NO preceding `hoistVarDeclarations` / `hoistLetConstWithTdz`. The ordinary
function-body prologue (`src/codegen/function-body.ts` L858–875) runs
`hoistVarDeclarations` → `hoistLetConstWithTdz` →
`reifyCurrentDirectEvalBindings` → `hoistFunctionDeclarations`, in that order,
precisely so that nested declarations see the enclosing `var`s as locals.

Consequence chain:

1. `compileNestedFunctionDeclaration`
   (`src/codegen/statements/nested-declarations.ts`, capture collection ≈
   L1650–1700) decides captures via `fctx.localMap.get(name)`. In the twin's
   frame `s0` is not in `localMap` yet (its local is only allocated when the
   `var` statement compiles, after the hoist), so `s0` is **not** a capture.
2. `runAll` is registered in `ctx.funcMap` / `ctx.nestedFuncCaptures` with
   `captures = []` (L2376) and compiled; `s0` inside its body falls to the
   identifier "graceful" `ref.null.extern` fallback (identifiers.ts).
3. When `C`'s own declaration compiles later, its (correct) prologue finds
   `runAll` already in `funcMap` owned by the same declaration, so the hoist
   gate reuses it. Both `$C` and `$__fnctor_C_new` then mint the capture-less
   singleton closure (`__fn_tramp_runAll_cached`, `$bag = null`).

WAT evidence (same source, only the position of `function dead(){ new C(); }`
differs):

```
;; FAIL (dead before C):  (func $runAll (type (func (result externref)))
    ref.null extern  local.tee 0  ref.is_null  (if (then … throw 0))   ;; s0 := null
;; PASS (dead after C):   (func $runAll (param (ref null 2)) (result f64))   ;; s0 is a capture param
```

When `C` compiles first the correct plan is registered first and the twin
(compiled later) reuses it — hence the source-order dependence.

Status: **confirmed** for `var` and for `let` (`let s0 = ['a','b']` in the
7-line repro fails identically on gc and standalone — the missing
`hoistLetConstWithTdz` half). TDZ-flag loss in the twin is **suspected**, not
measured. `#4139` is a different defect in the same twin (the ctor's OWN
captures of sibling functions are not in the twin frame); this issue is about
the ctor body's nested declarations capturing the ctor's own locals.

## Implementation Plan

Owner note: these files are in Session A's WasmGC/shared-IR area; the
implementation is done by Session C at the project lead's direction. Exact
touch points so A can check overlap:

- `src/codegen/expressions/new-super.ts` — the fnctor twin body prologue
  (`hoistFunctionDeclarations(ctx, ctorFctx, body.statements)` inside the
  `beginNestedFunctionNameScope` block, ≈L2945–2952).
- (defensive, optional) `src/codegen/statements/nested-declarations.ts`
  `compileNestedFunctionDeclaration` capture collection (≈L1650–1700).
- Reference only: `src/codegen/function-body.ts` L858–875.

1. **Mirror the function-body prologue in the twin.** Before
   `hoistFunctionDeclarations`, call `hoistVarDeclarations(ctx, ctorFctx,
   body.statements)` and `hoistLetConstWithTdz(ctx, ctorFctx, body.statements)`
   (same order as function-body.ts; also `reifyCurrentDirectEvalBindings` if the
   twin can contain a direct `eval` — check how function-body.ts gates it).
   Both helpers already skip names present in `localMap` (params, `this`,
   `__self`, #4139 twin-capture spills), so param shadowing stays as it is.
   Spec: §10.2.11 FunctionDeclarationInstantiation instantiates `var` bindings
   (steps 27–28) and lexical bindings (step 34) before initializing function
   declarations (step 36), all in ONE environment — a nested function must
   close over the same binding the body later assigns.
2. **Do not change capture semantics elsewhere.** The fix is prologue order;
   `nestedFuncCaptures` registration (#1312 pre-registration) stays as is. If
   step 1 cannot be applied for some ctor shape, the defensive alternative is to
   make the capture collector allocate (`allocLocal`) a `var` the body declares
   (`findScopedVariableDeclaration(stmt, name)` ≠ undefined) when it is missing
   from `localMap`, rather than silently dropping the capture — a dropped
   capture is a miscompile, never a fallback.
3. **Order/semantics constraints:** the twin's existing prologue steps
   (`installFrameTrap`, capture params, `struct.new` + `__self`, `this`
   binding, `materializeFnctorTwinCaptures`, `arguments` materialization) must
   keep running BEFORE the new var/let hoists, so a user `var` named like a
   #4139 spill shadows it exactly as it would shadow a param. Host (gc) and
   standalone take the same path; `wasi` shares the standalone branch. Linear
   backend: not measured.

### Regression tests (through the public `compile()`, compared with node)

`tests/issue-6942-fnctor-twin-var-hoist.test.ts`, each case on gc AND
standalone (and linear if the harness supports it):

- the 7-line repro above → `1` (currently throws);
- the number variant → `42` (currently `0`);
- nested fn declared BEFORE the `var` (Octane `Exec`/`s0` order) → correct;
- `let s0 = …` instead of `var` → `1` (currently throws, same as `var`);
- **negative controls** (must already pass and keep passing): `C` declared
  before the second site; `this.run = function(){…}` expression form; nested fn
  without captures; a ctor whose param is named like a captured outer binding.

### Acceptance

- The Octane `regexp.js` benchmark (pinned Octane commit
  `570ad1ccfe86e3eecba0636c8f932ac08edec517`, driver shape from the #874
  probes: `base.js` + `regexp.js` + an exported `octane_run` that calls
  `RegExpSetup()`/`run()`) completes `octane_run(1)` on the gc host without
  the TypeError above and without `Error("Wrong checksum.")` (the benchmark's
  own checksum `1666109` is the oracle).
- No change in any test262 edition count (both ratchets green); the gc/standalone
  outputs for programs whose ctor has no nested capturing declarations stay
  byte-identical.

## Implementation Notes (2026-10-10, Session C — Claude Opus 5.5 High)

**Change.** `compileNewFunctionDeclaration` (`src/codegen/expressions/new-super.ts`)
now runs `hoistVarDeclarations` → `hoistLetConstWithTdz` before the existing
`beginNestedFunctionNameScope` + `hoistFunctionDeclarations` block, after every
other twin prologue step (frame trap, `__self`, `this`, #4139
`materializeFnctorTwinCaptures`, `arguments`). Both helpers skip names already
in `localMap`, so params / spills still shadow as before.
`reifyCurrentDirectEvalBindings` is not called: the twin never sets
`directEvalBindingNames`, so it would be a no-op. The #2071 comment was
condensed to cover both hoists so the LOC / function budgets do not grow (no
allowance needed).

**Why prologue order and not the capture collector.** The plan's step 1 applies
to every twin shape: `hoistVarDeclarations` allocates each body `var` before
`compileNestedFunctionDeclaration` reads `localMap`, so `s0`/`k` become real
captures and the twin registers the correct plan first. The optional defensive
change in `nested-declarations.ts` (step 2) was not needed.

**Measured (file-copy A/B against the plan-branch base).**
- `tests/issue-6942-fnctor-twin-var-hoist.test.ts` (9 programs × gc/standalone,
  compared with node): base 10 fail / 8 pass (the 4 negative controls pass on
  both) → head 18/18.
- Triage repros `r1…r32`: every case that differed from node now matches it
  (r12–r17, r23, r25, r26, r30–r32, r7*, r8). The only remaining mismatch is
  `r2` standalone (`undefined`), which is unrelated and unchanged.
- 41 related fnctor test files (#1312, #1712*, #2608, #2660*, #3927*, #3996*,
  #4155*, #4456, #4464, #4637, #5162, #6689, …): exact same pass/fail set on
  base and head (326 pass / 45 fail / 15 skip, all failures pre-existing).
- **Not byte-identical** for twins whose body declares `var`/`let`: locals are
  allocated in the prologue (index renumbering), and an externref `var` is
  initialised to `undefined` at entry — the same thing an ordinary function body
  does. Twins with no body bindings compile byte-identically.

**Octane `regexp.js` (acceptance not yet met).** Evidence:
`plan/log/6942-octane-regexp/status.txt`. The TypeError is gone on both lanes.
The run now fails with `Wrong checksum.` because of a **separate defect**:
`Math.random = <closure>` (base.js `BenchmarkSuite.ResetRNG`) is ignored on gc
and standalone — calls still reach the native RNG. With regexp.js's RNG routed
through a plain global, standalone reproduces node's checksum exactly (every
per-block sum matches). Status stays `in-progress` until that defect lands and
the full benchmark passes; it needs its own issue.
