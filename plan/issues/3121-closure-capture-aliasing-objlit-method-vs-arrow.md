---
id: 3121
title: "Closure capture aliasing: object-literal method writes a hoisted GLOBAL while a sibling arrow reads a ref-cell — same captured local, two stores"
status: done
created: 2026-07-09
completed: 2026-07-09
reporter: fable-2978
assignee: ttraenkler/fable-3121
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [2978, 2980]
sprint: current
horizon: m
---

# Closure capture aliasing: obj-literal method vs arrow disagree on a captured local's storage

## Problem

When a **function-local** variable is captured BOTH by an object-literal method
and by a sibling closure (arrow), the two lowerings pick **different storage**:
the object-literal method's body writes a **hoisted module global**, while the
arrow reads a **closure env ref-cell**. Writes through one are invisible to the
other — silent wrong results.

Minimal repro (verified on main @7b8ade85c7a58, `--target standalone`, also
wrong on gc-host):

```ts
export function test(): number {
  var c = 0;
  const o = {
    inc() {
      c += 1;
    },
  };
  const f = () => c;
  o.inc();
  o.inc();
  return f() * 10 + c; // expected 22 — returns 0
}
```

WAT evidence (from the #2978 investigation, canonical test262 file
`AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
wrapped by the runner): the iterator's `return()` method increments
`$global$16` (`global.set (f64.add (global.get $global$16) 1)`), while the
async arrow reads `returnCount` via `struct.get $44 0` on a captured ref-cell
param. Two stores, one variable.

## Impact

- Blocks the FULL pass of `for-await-next-rejected-promise-close.js` on the
  widened-carrier standalone lane: after #2978's fix the rejection routing and
  IteratorClose are spec-correct (`e === "reject"` passes, `return()` runs),
  but the test's `returnCount` assert reads the stale cell → `fail` instead of
  `pass`. The same wrapped-in-`test()` harness shape (locals captured by both
  an obj-literal method and the `asyncTest` arrow) is common across the
  AsyncFromSyncIteratorPrototype / for-await families — fixing this converts
  a cluster, not one file.
- Generic correctness hazard for any module mixing obj-literal methods and
  closures over the same function-local mutable state.

## Where to look

- The escape/hoist analysis that promotes captured locals to module globals for
  object-literal METHOD bodies (declarations/literals lowering) vs the ref-cell
  capture used by arrow/function closures (`closures.ts`). The fix is to make
  both consumers agree on ONE store per binding — presumably the ref-cell
  (globals can't be per-invocation).
- Note top-level (module-scope) `var`s do NOT alias — both lower to the same
  module global; the bug is specific to **function-local** captures (the
  test262 runner wraps every test body in `function test()`, so the harness
  hits the local case pervasively).

## Acceptance

- The repro returns 22 on gc-host, standalone, and wasi.
- `for-await-next-rejected-promise-close.js` passes on the widened-carrier
  standalone lane (with #2978 landed) — verify with
  `JS2WASM_ASYNC_CARRIER_WIDEN=1` via `runTest262File(..., "standalone")`.
- 0 test262 regressions.

## Root cause (fable-3121, 2026-07-09)

The two lowerings were never *designed* to disagree — a fallback subverted the
promotion contract:

1. `promoteAccessorCapturesToGlobals` (`src/codegen/closures.ts`) promotes a
   local captured by an object-literal method/accessor to a mutable module
   global (`__captured_<name>`), copies the current value in, registers it in
   `ctx.capturedGlobals`, and **deletes the name from `fctx.localMap`** — the
   contract being that every later reference in the enclosing function
   (identifiers.ts / assignment.ts / unary-updates.ts all check
   `capturedBoxGlobals`/`capturedGlobals` on a localMap miss) resolves through
   the global, keeping the method and the function on ONE store.
2. `compileArrowAsClosure`'s capture collection, on a localMap miss, ran the
   **#1177 block-shadow fallback**: rescan `fctx.locals` BY NAME and resurrect
   the slot. That fallback exists for block-scoped `let/const` slots whose
   localMap entries are *temporarily* deleted by the shadow manager — but it
   cannot distinguish those from slots *permanently orphaned* by promotion.
   The arrow resurrected the dead local, classified it mutable (the method's
   `c += 1` is a textual write in the outer body scan), boxed the STALE slot
   into a fresh ref cell, and **rebound localMap to the box** — so the arrow
   AND all subsequent outer references read a second store the method's
   global-routed writes never touch. Three stores total (orphaned local,
   `__captured_c` global, fresh cell); reads returned the stale snapshot.

Note the opposite ordering (arrow first, literal second) already worked: the
arrow boxes the live local, and the promotion's #3039/#2029 arm detects
`fctx.boxedCaptures` and promotes the BOX (`capturedBoxGlobals`), so the
method derefs the same cell.

## Fix (PR #2836)

Make the promotion visible to the capture collector, per-fctx:

- `FunctionContext.promotedCaptureNames?: Set<string>` (`context/types.ts`) —
  recorded by `promoteAccessorCapturesToGlobals` at the exact point it deletes
  the localMap entry.
- `compileArrowAsClosure` checks it BEFORE the #1177 rescan: a promoted name
  is skipped entirely (not captured into the env struct), so the lifted body's
  reads/writes fall through to `ctx.capturedGlobals` — the same store as the
  method body and the enclosing function's own post-promotion references.
  Per-fctx scoping means an unrelated same-named local in another function
  still takes the #1177 rescan unchanged.

Chose "converge on the promoted global" over "convert methods to ref-cells"
because (a) the global is already the store for the method body AND the
enclosing function's post-promotion code — the arrow was the only defector;
(b) the read/write resolution paths for it already exist on every consumer;
(c) re-plumbing method bodies onto ref cells (per-invocation correctness for
escaping closures) is a much larger change with the same single-invocation
semantics — tracked by the existing promotion-strategy limitation, not this
bug. `compileArrowAsCallback` and the nested-fn-decl path have NO rescan
fallback (they skip on localMap miss → already resolve via the global), so
only `compileArrowAsClosure` needed the guard.

## Test Results (fable-3121, 2026-07-09)

- Repro returns 22 on gc-host, standalone, AND wasi (was 0 on all three).
- Reverse direction (method reads / arrow writes), arrow-first ordering, and
  outer-write-between orderings all coherent — 10/10 cases in
  `tests/issue-3121-objlit-method-closure-capture-aliasing.test.ts`.
- Cluster sweep (1,272 files: `AsyncFromSyncIteratorPrototype/**` +
  `language/statements/for-await-of/**`) vs the v2 baseline, default lane:
  **+2 converts, 0 regressions** (`next/absent-value-not-passed.js`,
  `return/absent-value-not-passed.js` — the exact harness shape: obj-literal
  iterator methods bumping counters the trailing asserts read).
- `scripts/prove-emit-identity.mjs`: **byte-identical** on all 39
  (file,target) corpus emits vs main — zero collateral on code not hitting the
  promotion+rescan combo.
- The canonical `for-await-next-rejected-promise-close.js` full pass on the
  widen lane needs #2978's rejection routing (PR #2833, currently parked on a
  merge conflict) — that PR compounds with this fix on its next
  merge-of-main; verified here that the aliasing half no longer blocks it
  (see the harness-shape regression case).
