---
id: 3218
title: "standalone: ValidateTypedArray for native __ta_dyn_{fill,copyWithin,reverse} — WONT-FIX (verify-first: target tests already pass; residual is elsewhere)"
status: wont-fix
assignee: ttraenkler/opus-ta
sprint: 75
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: typed-arrays, detached-buffer, standalone
goal: host-independence
related: [3074, 2940, 2872, 3173, 3089]
umbrella: 2860
loc-budget-allow:
  - src/codegen/dataview-native.ts
created: 2026-07-13
origin: "2026-07-13 opus-ta verify-size under the #2940/#3074 harness-callback follow-up: the makeCtorArg TA family EXECUTES on standalone (vacuity fixed by #3074/#3087); the residual is a long tail of downstream semantic fails, the biggest clean sub-cluster being detached-buffer TypeError semantics. This slice lands the native-helper arm."
---

# #3218 — standalone ValidateTypedArray for the native TA mutating helpers

## Verify-size finding (opus-ta, 2026-07-13)

The #2940/#3074 harness-callback vacuity gate is **already fixed** on current
main (verified: the makeCtorArg TypedArray family executes host-free on
standalone — 33/120 sampled genuine pass, 3 vacuous = `nans.js` harness-fixture
gap [#1524], 84 genuine downstream semantic fails). The single largest clean
sub-cluster of those 84 is **detached-buffer TypeError semantics**.

Sizing across ALL `built-ins/TypedArray/prototype/**` tests using `$DETACHBUFFER`
(standalone lane, current main):

- **129 tests** use `$DETACHBUFFER` (all in the harness family).
- **201 tests** use resizable/growable buffers — a **separate, deeper rock**,
  explicitly banked (NOT bundled here).
- Of the 129: 21 already PASS, ~89 are entry-detach (`detached-buffer.js`),
  ~31 are mid-op detach (`coerced-*-detach.js`, `callbackfn-detachbuffer.js`).
- Entry-detach split ~45 non-BigInt / ~44 BigInt.

### Root cause

`$DETACHBUFFER(buf)` marks the standalone i32-byte buffer vec's `length` field
= `-1` (the #3173 detach sentinel). But the native mutating helpers
`__ta_dyn_fill` / `__ta_dyn_copywithin` / `__ta_dyn_reverse`
(`src/codegen/dataview-native.ts`) never run **ValidateTypedArray** (§23.2.4.1
step 6, IsDetachedBuffer → TypeError). Instead they read
`pushTaDynViewInBoundsLen` which clamps a detached view to effective length 0,
so `fill`/`reverse` silently **no-op** (return `this` — no TypeError), and
`copyWithin`'s source-range loop reads `view.buf[...]` on the now `-1`-length
vec → **`array.get` out of bounds trap** (a codegen-stability bug).

## Fix (this slice)

Add a shared `emitTaDynDetachedGuard(ctx, fctx, dvLocal, dynIdx)` at the **entry**
of each of the 3 native helpers (right after the `$__ta_dyn_view` is
materialized, before the length read / ToNumber coercion — spec order: step 6 is
before the algorithm). It extracts `dv.buf` (field 1) and reuses the existing
`emitDvDetachedCheck` (`buf == null || buf.length < 0` → throw the shared
catchable `TypeError`). Same funcIdx-capture ordering rule as the DataView
accessor helper (build the throw template + flush before any later funcIdx bake).

Standalone/WASI-gated (the helpers are `noJsHost`-only); the GC/host lane and
unrelated modules stay byte-identical (prove-emit-identity).

## Deliberately NOT bundled (banked scoped intel)

1. **Mid-op detach** (`coerced-*-detach.js`, `callbackfn-detachbuffer.js`): the
   buffer detaches DURING arg/element coercion (a `valueOf`/callback side
   effect), after the entry ValidateTypedArray. Needs per-step re-validation /
   count re-clamp — a distinct, harder change. copyWithin's mid-op OOB traps
   (`coerced-values-*-detached.js`) fall here.
2. **Resizable/growable buffers** (201 tests): separate deeper rock.
3. **BigInt-TA i64 codegen CE** (#3089, wont-fix): entry-detach BigInt variants
   whose i64 element read traps — the entry guard fires BEFORE the read, so some
   may flip; any residual CE is #3089, not this slice.

## Acceptance

- `built-ins/TypedArray/prototype/{fill,copyWithin,reverse}/detached-buffer.js`
  (+ BigInt variants where the guard suffices) throw a catchable TypeError
  standalone → PASS.
- Zero regressions vs the honest standalone baseline; `prove-emit-identity`
  byte-identical on unrelated modules; genuine-vs-vacuous flip breakdown reported.

## WONT-FIX — honest A/B measurement (opus-ta, 2026-07-13)

I implemented the guard (ValidateTypedArray detach check at the entry of
`__ta_dyn_{fill,copyWithin,reverse}`) and measured a **clean A/B on all 129
`$DETACHBUFFER` TA-prototype tests, standalone**, base `fc55833c` (pristine, in a
separate control worktree + separate vitest process) vs branch (with the guard):

```
BASE   fc55833c : 129 files, PASS=21
BRANCH +guard   : 129 files, PASS=21
diff = EMPTY  → ZERO flips, ZERO regressions
```

**The guard is a functional no-op.** Root cause of the null result: my
verify-size buckets were misread — `fill/detached-buffer.js` and
`copyWithin/detached-buffer.js` **already PASS on pristine main** (they were
always inside the 21). They throw the detach `TypeError` via a PRE-EXISTING path,
NOT `__ta_dyn_fill`/`__ta_dyn_copywithin` — so those methods never reach the
native helper on the detached path, and the entry guard I added is never the
deciding instruction. WAT-confirmed the guard is emitted and well-formed; it is
simply not on the runtime path these tests take.

The guard also does **not** fix the copyWithin OOB traps
(`coerced-values-*-detached.js`): those detach MID-operation (a `valueOf` side
effect during arg coercion), AFTER the entry check — so an entry-only guard
can't fire. Fixing them needs a mid-op count re-clamp (banked below).

**Reverted the code (not shipped).** Shipping a zero-yield change would add dead
codegen + regression surface for no conformance gain — the exact vacuity/inflation
trap the workflow punishes.

### Where the REAL residual lives (re-scoped — separate follow-ups)

- **41 NOTHROW-entry-detach** (`entries`, `join`, `keys`, `values`, `indexOf`,
  `lastIndexOf`, `includes`, `find*`, `some`, `reduce*`): these methods route
  through **scattered** dispatch sites (iterator helpers, string, array-methods,
  HOF-native) with **no shared chokepoint** — the ValidateTypedArray check would
  be a broad, hot-path, multi-site change (NOT a bounded slice). This is the
  actual high-count lever.
- **reverse dynamic-dispatch gap**: NO reverse test passes on the dynamic
  (`$__ta_dyn_view`) path (even `returns-original-object`/`reverses-values`).
  The arity-0 receiver is closure-captured (`struct.get $env 1`) and the
  `ref.test $__ta_dyn_view` two-arm appears to fall to the `__call_m_reverse_0`
  else-arm. Pre-existing, unrelated to detach.
- **BigInt-TA entry-detach (~36/44)**: fails with
  `TypeError: Cannot access property on null or undefined` — a BigInt-path
  null-deref/i64 gap (#3089 area), fires before/around the detach check.
- **mid-op detach re-validation (~31 + the copyWithin OOB traps)**: needs
  per-step re-clamp after arg/element coercion — a distinct, harder change.
- **resizable/growable buffers (201 tests)**: the separate deeper rock.
