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
related: [2963]
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

## Honest-accounting caveat — these 9 pass via a null≡null tautology, NOT constructor-identity correctness

**Read this before merging.** This PR is a clean **host-import elimination**, not a
correctness fix — and the two must not be conflated. Documenting the distinction
explicitly, in the discipline the team established around the #2463 vacuity work.

**What is genuinely fixed:** the `env::Object_get_constructor` host import is gone
from these 9 standalone binaries. That is real and valid on its own — a standalone
binary should not import a host getter it does not need.

**What is NOT fixed (and this PR neither claims nor changes it):** real builtin
constructor / prototype **object identity**. The 9 tests pass because BOTH sides of
each `assert.sameValue(<Builtin>.prototype.constructor, <Builtin>)` collapse to the
**same null-ish externref carrier** in standalone mode — the LHS `.constructor`
read and the RHS bare-builtin identifier are each `ref.null.extern`, so
`sameValue(null, null)` is trivially `true`. The comparison never exercises a real
constructor object; it is a **null≡null tautology**. The predecessor's own
cross-check proves it: `assert.sameValue(Set.prototype.constructor, Map)` —
comparing against the **wrong** builtin — **also passes**. A genuine
constructor-identity implementation would make that cross-check FAIL.

**This is "coincidental wrongness", a distinct (and subtler) class than vacuity.**
The #2463 vacuity problem is *dead code* — a callback body that never executes; an
inject-throw execution-proof catches it. This is different: the code **does
execute** (the round-5 inject-throw probe correctly labels
`Object_get_constructor` **GENUINE**, i.e. non-vacuous), it just returns an
**incorrect value** (null) that happens to equal another equally-incorrect value
(null). An execution-proof / inject-throw check would **NOT** flag it — the body
runs. So "GENUINE" in the round-5 table means "not vacuous", **not** "value-correct".

**The fold is still the right change** — it is behaviour-preserving (LHS and RHS
remain the identical null carrier the pre-fix path already produced) and removes a
dead import. When builtins gain real native constructor identity, the
bare-identifier resolution and this `.constructor` fold site update in lockstep
(both stop being null), so the fold does not entrench the gap — it tracks it.

**Substrate that actually closes the gap:** #2963 (*Reify builtins as first-class
values*, with stable per-module identity — "the same builtin reference must yield
the same object"). Once builtins carry a real reified constructor/prototype object,
these 9 assertions pass on genuine identity and the cross-check
(`...constructor === Map`) correctly fails. The round-5 investigation
(`plan/log/investigations/2026-07-02-leak-analysis-round5.md`, recommendations
§2 + §3) groups this with the sibling identity-substrate leak tails
(`__iterator` 9 + `Object_get_constructor` 9 + `Object_set_constructor` 5 +
`__new_Object` 5 ≈ 28 tests) — the same "no reified builtin
constructor/prototype/intrinsic identity" root cause. A single consolidated
issue for that ~28-test tail is not yet filed on `main`; #2963 is the substrate
that subsumes it.

## Broader-pattern sweep (2026-07-02, follow-up)

Checked whether other currently-passing standalone tests rely on the same
null≡null coincidence for `.constructor` / builtin-identity comparisons:

- **test262 population:** ~55 `built-ins/**` files combine `.prototype.constructor`
  with `assert.sameValue`; the 9 fixed here are the **sole-`env::`-import** subset.
  The rest (TypedArray ctors, GeneratorFunction, Array/Object/Number/String, …)
  follow the identical `<Builtin>.prototype.constructor === <Builtin>` shape, so
  any of them that currently pass in standalone pass by the **same** null≡null
  coincidence — this is a **substrate-wide** property of builtins lacking reified
  identity, not unique to these 9. It is exactly what #2963 addresses.
- **The coincidence is bounded, not blanket.** A direct probe of raw `===`
  comparisons between builtin identifiers in compiled standalone code returned
  `false` (e.g. `Set === Map`, and even `Set === Set`, evaluate to `0`), i.e. the
  tautology is **specific to the `assert.sameValue` harness path** where both
  operands become the null carrier — it is NOT a general "every builtin comparison
  is true". Critically, because test262 only asserts spec-**true** facts, the
  coincidence inflates *hollow* passes of otherwise-correct assertions; it does
  **not** turn any *incorrect* assertion into a false pass.
- **Conclusion:** the pattern is real and broader than these 9, but it is (a)
  already tracked by #2963, (b) not created or worsened by this PR (the fold only
  removes a dead import), and (c) bounded to the sameValue-null path. No new
  regression risk; no separate issue needed beyond #2963.
