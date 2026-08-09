---
id: 3573
title: "standalone: Set/Map.forEach non-callable guard + Symbol.matchAll table-drift"
status: done
completed: 2026-07-24
created: 2026-07-24
updated: 2026-07-24
priority: medium
feasibility: easy
task_type: conformance
area: codegen
language_feature: collections
goal: standalone
sprint: 76
horizon: s
assignee: ttraenkler/dev-mapset-opus
related: [2162, 1907, 3571]
loc-budget-allow:
  - src/codegen/map-runtime.ts
---

# standalone: Set/Map.forEach non-callable guard + Symbol.matchAll table-drift

Two small, independent standalone residuals harvested from the
Map/Set/WeakMap/WeakSet/Symbol lane measurement (2026-07-24).

## (1) `Set`/`Map`.prototype.forEach with a non-callable literal argument

The native forEach path (`tryCompileNativeCollectionForEach`, map-runtime.ts)
only handles Wasm-closure callbacks. A statically non-callable **literal**
argument — `s.forEach(null)` / `undefined` / a number / boolean / string —
failed the `willBeClosure` check and fell through to the host
`Set_forEach`/`Map_forEach` import, which a pure-Wasm engine can't satisfy →
`compile_error` under `--target standalone`.

Spec 24.1.3.5 / 24.2.3.6: *"If IsCallable(callbackfn) is false, throw a
TypeError."* Fix: when the callback is a clearly non-callable literal, emit a
native `TypeError` (real instance, so `assert.throws(TypeError, …)` catches it)
instead of falling through. A dynamic value (variable / call result) still
routes to the general path — only literals are statically decided, so no false
positives.

### Measured flip (real runner, `--target standalone`, 0 regressions)

`built-ins/Set/prototype/forEach/` — **+5 pass** (per-file, all
`reached_test=true`, `vacuous=false`):
`callback-not-callable-{null,undefined,number,boolean,string}.js`. No Map
forEach test was leaking (Map already covered those), but the guard applies to
both. Zero pass→non-pass regressions.

## (2) `Symbol.matchAll` value-read table drift

`builtin-value-read.ts`'s `WELL_KNOWN_SYMBOLS` mirror (used by
`hasNativeBuiltinConstantHandler`) was missing `matchAll` (id 15 in the
`literals.ts` source of truth). Its absence made `Symbol.matchAll` value reads
refuse under standalone (`#1907` refusal) even though the downstream constant
emitter supports it. Restored `matchAll: 15`.

This is a **correctness / drift fix with 0 immediate pass-flip**: the one CE
test (`Symbol/matchAll/prop-desc.js`) is blocked by the shared
`Function.prototype.call/apply/bind` uncurryThis path (#3571), so it moves
`compile_error → fail` (neutral for `host_free_pass`) rather than to pass. It
flips green once #3571 lands. Carried because a real table-drift correction is
worth fixing regardless.

## Acceptance criteria

- [x] `Set/Map.prototype.forEach(<non-callable literal>)` throws a native
  `TypeError`, host-import-free, under standalone.
- [x] `forEach(<closure>)` unaffected (regression guard).
- [x] `Symbol.matchAll` value read compiles host-free under standalone.
- [x] Measured non-negative flip on the real runner (+5, 0 regressions).

## Notes

Final contained slice of the lane. Everything else measured is substrate:
set-like `.size` getter/method dispatch (#2580), `Set.prototype.entries`
reified iterator (#1664), and the dominant `Function.prototype.call/bind`
uncurryThis blocker (#3571). Lane is measured-exhausted after this.
