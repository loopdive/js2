---
id: 6453
title: "`__extern_get_idx` has no `$__ta_view` arm — a buffer-backed view reads NaN through every array-like walk"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

The standalone indexed read `__extern_get_idx(v, i)`
(`src/codegen/object-runtime-enumeration.ts` ~L710, body built by
`buildExternGetIdxBody`, per-element-kind arms appended at finalize by
`fillExternGetIdxVecArms`) recognises `$ObjVec`, the `__vec_<k>` carriers and
the array-like `$Object` (#2036). It does **not** recognise the shared-backing
`$__ta_view` struct that `new Uint8Array(<ArrayBuffer>)` builds (#3054), so it
takes the miss branch and answers `undefined` for every index.

Its sibling `__extern_length` **does** answer correctly for a view. The pair
therefore disagrees, and every consumer that walks an array-like as
`__extern_length` + `__extern_get_idx` reports the right length with `NaN`
elements — a wrong answer that looks like a populated array.

## Evidence

Measured 2026-09-13 on `7adc0a6e89`, standalone lane, at the intermediate state
of [#6422](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6422-array-from-buffer-backed-view-illegal-cast)
— after that fix stopped `Array.from` from trapping on a view but before it
learned to de-view one, so the view reached `__array_from_native`'s array-like
branch, which is exactly this walk:

```ts
const buf = new ArrayBuffer(32);
const fill = new Uint8Array(buf);
for (let i = 0; i < 32; i++) fill[i] = 3;
const a = Array.from(new Uint8Array(buf));
a.length; // 32   — correct (__extern_length)
a[0];     // NaN  — wrong, should be 3 (__extern_get_idx)
```

Controls in the same module: reading the view directly (`v[i]` in a loop) sums
to 96, and `Array.from(new Uint8Array([1,2,3,4]))` sums to 10 — so the view is
built and indexable, and the plain-vec arms are fine.

#6422 **dodges** this rather than fixing it: its `Array.from` arm de-views the
`$__ta_view` into a real vec with `emitTaViewToVec` before copying, so that one
caller never reaches the walk. Every other caller still does.

## Scope to check

`__extern_get_idx` is called from at least `array-from-native.ts`,
`iterator-native.ts`, `spread-arg-list.ts`, `hof-native.ts`,
`object-runtime.ts` (`Object.assign`'s copy loop, `Object.values`,
`__apply_closure`'s argument read) and `object-runtime-proxy.ts`
(`ownKeys`). Each of those over a buffer-backed view is a candidate for the
same silent `NaN`.

## Acceptance criteria

1. `__extern_get_idx` over a `$__ta_view` returns the view's element at that
   index (decoded per the view's element kind and signedness, honouring
   `byteOffset` and the auto-length `-1` sentinel — the same reads
   `pushTaViewEffectiveLen` / `emitTaViewElementGet` already do), and
   `undefined` out of bounds.
2. Anti-vacuity: `$ObjVec`, the `__vec_<k>` carriers and the array-like
   `$Object` arms keep their current answers, including the OOB-miss
   `undefined`.
3. A spread / `Object.values` / iterator-drain case over a buffer-backed view
   returns the bytes, not `NaN` — pick at least one caller other than
   `Array.from` and pin it.
4. Regression test under `tests/`, failing on the parent and passing with the
   fix.
5. A/B over the 17 dogfood suites at one HEAD.

## Provenance

Found while fixing
[#6422](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6422-array-from-buffer-backed-view-illegal-cast).
