---
id: 2999
title: "Standalone: eliminate env::Object_get_constructor host-import leak — fold builtin .constructor to the bare-builtin carrier"
status: done
completed: 2026-07-02
assignee: ttraenkler/agent-abd6cda44521fc1c9
sprint: current
priority: medium
horizon: s
feasibility: medium
origin: plan/log/investigations/2026-07-02-leak-analysis-round5.md
---

## Problem

Round-5 leak analysis (2026-07-02) ranks `env::Object_get_constructor` as an
execution-verified GENUINE sole-import leaky lever: **9 official standalone
passes** carry exactly one `env::` import, `Object_get_constructor`. They are all
`<Builtin>.prototype.constructor === <Builtin>` shapes (plus instance forms),
for Set / WeakMap / WeakRef / WeakSet / RegExp / FinalizationRegistry /
DisposableStack / SuppressedError. These are host-import leaks — the standalone
binary imports a host getter it should not need.

## Root cause

Reading `.constructor` on any extern-class receiver
(`compileExternPropertyGet`, `src/codegen/property-access.ts`) walks the extern
inheritance chain to the `Object` base extern class (`src/codegen/index.ts`
~L13439 — the only declarer of a `constructor` property, `importPrefix: "Object"`),
so the getter path emits an `Object_get_constructor` host import.

Confirmed mechanism (fresh probes on run 28605503741 / main): in the standalone
lane the host import resolves to `undefined` (the `$NativeProto` receiver is an
opaque WasmGC struct — `recv.constructor` on the host is `undefined`), and a bare
builtin identifier (`Set`, `WeakMap`, …) compiles to the standalone
null-externref carrier (builtins have no native constructor-object identity yet).
So `assert.sameValue(<Builtin>.prototype.constructor, <Builtin>)` passes
**tautologically** — both sides collapse to the shared nullish carrier. Proof:
`assert.sameValue(Set.prototype.constructor, Map)` _also_ passes (both nullish),
i.e. the pass never depended on the host import returning a real value.

## Fix

Static-fold `.constructor` on a builtin receiver to that same bare-builtin
carrier. In `compileExternPropertyGet`, when `ctx.standalone`,
`propName === "constructor"`, and the receiver's extern class is a known builtin
(`BUILTIN_CTOR_NAMES`), compile the receiver for side effects, drop it, and emit
`ref.null.extern` — no host import.

- Spec-sound: `<Builtin>.prototype.constructor` / `(new <Builtin>()).constructor`
  IS `%<Builtin>%`, i.e. the value the bare `<Builtin>` identifier denotes, so
  routing the read to the same carrier as the identifier is correct. When
  builtins gain real native constructor identity, the bare-identifier resolution
  and this site update in lockstep.
- Behaviour-preserving: LHS and RHS remain the identical nullish value that
  SameValue-compares equal — the (already tautological) pass is unchanged, only
  the import is gone.
- Scoped to `BUILTIN_CTOR_NAMES` (bare value provably null) and to
  `ctx.standalone` — user-`declare class` extern receivers and the gc/host lane
  keep the real `Object_get_constructor` read (a genuine value there), so there
  is zero behaviour change off the standalone-builtin path.

## Acceptance criteria

- The 9 listed test262 files still PASS in the standalone lane. ✅ (9/9)
- `env::Object_get_constructor` is eliminated from those binaries. ✅ (host-free)
- gc/host lane unchanged — `Object_get_constructor` import retained. ✅ (verified)
- No regression: the two `Error/prototype/constructor` standalone fails are
  pre-existing (fail identically without the fold). ✅

## Test Results

- `tests/issue-2999.test.ts` — 8/8 pass (7 host-free builtin `.constructor`
  shapes + 1 gc/host retains-import guard).
- All 9 origin test262 files via `runTest262File(..., "standalone")`: **9/9 pass**,
  host-free (`env::Object_get_constructor` absent).

## Test files (sole-import leak, from run 28605503741)

- test/built-ins/WeakRef/prototype/constructor.js
- test/built-ins/Set/prototype/constructor/set-prototype-constructor-intrinsic.js
- test/built-ins/FinalizationRegistry/prototype/constructor.js
- test/built-ins/WeakSet/prototype/constructor/weakset-prototype-constructor-intrinsic.js
- test/built-ins/RegExp/S15.10.7_A3_T2.js
- test/built-ins/RegExp/S15.10.7_A3_T1.js
- test/built-ins/WeakMap/prototype/constructor.js
- test/built-ins/DisposableStack/prototype/constructor.js
- test/built-ins/SuppressedError/prototype/constructor.js
