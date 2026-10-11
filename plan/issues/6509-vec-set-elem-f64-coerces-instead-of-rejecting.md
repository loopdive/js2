---
id: 6509
title: "__vec_set_elem's f64 arm coerces a non-number to NaN and reports success, so the sidecar fallback never fires"
status: ready
sprint: current
created: 2026-09-18
updated: 2026-09-18
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
language_feature: arrays
goal: core-semantics
related: [6482, 4491, 3251]
---

# #6509 — a string stored into an f64-backed array silently becomes NaN

## Repro (one module, no linked edge, no host involved)

```js
var arr = [100];
arr[0] = "s";
String(arr[0]); // "NaN"   — should be "s"
```

A number-only array literal mints the **f64 carrier**, and both the compiled
store and the host store coerce whatever they are given. There is no boundary in
this repro: it reproduces single-module, in-wasm, in the honest lane.

## Where

`__vec_set_elem`'s f64 arm (`src/codegen/vec-access-exports.ts`, the
`collectVecMutationEntries` mutator family). Instrumented from the host side
during #6482 round 6:

```
[vset] 0 val: unlikelyValue result: 1
```

`result: 1` is the setter reporting **success** for a string. That is the whole
defect: both writers that reach it — `_trySetWasmVecElement` (via `_safeSet`)
and `_vecDefineOwnProperty` — already have a correct fallback for a value the
carrier cannot hold (`_sidecarSet`, and the successful path deletes any stale
sidecar entry so the two can never disagree). Neither fallback can ever run,
because the setter never says no.

## Why it matters beyond the repro

It blocks the last two rows of the #6482 descriptor bucket,
`Object/defineProperties/15.2.3.7-6-a-247` and
`Object/defineProperty/15.2.3.6-4-258`, both failing
`0 descriptor should be writable`. propertyHelper's `isWritable` stores the
string `"unlikelyValue"` into the receiver and asks whether the read comes back
equal; on an f64 vec the store is silently lost, the read returns the old
number, and a perfectly writable element is reported non-writable.

Those two rows are the visible symptom, not the scope. Any program that assigns
a non-number into an array the compiler typed as f64 loses the value.

## The fix, and why it is not a one-liner

Make the f64 arm **reject** (return 0) instead of coercing, so the existing
sidecar fallbacks take over and the read paths that already prefer a sidecar
entry serve the right value.

Blast radius — every caller of `__vec_set_elem`, all of which currently rely on
"the setter always succeeds":

- `_trySetWasmVecElement` → `_safeSet`, i.e. every host-side `obj[key] = v` on a
  vec (`__extern_set` / `__extern_set_strict`);
- `_vecDefineOwnProperty`'s value application;
- `__unwrap_for_wasm`'s vec-mirror **writeback** replay, which treats a
  non-`1` result as a hard failure and ROLLS BACK every element it already
  wrote (`if (vecSet(...) !== 1) throw`);
- `applyWithVecMirrorWriteback` in `src/runtime/vec-mirror-writeback.ts`;
- the compiled in-wasm store path, which is a separate lowering and would still
  coerce — so a fix on the host side alone leaves host writes and in-wasm writes
  disagreeing about the same index, which is arguably worse than the current
  uniform wrongness.

That last point is the reason this is `feasibility: hard`: the honest fix has to
cover **both** the host setter and the compiled indexed-assignment lane, or
decide deliberately that an f64-typed array is not allowed to hold a
non-number and make the compiled lane refuse loudly instead of silently.

## Acceptance criteria

- [ ] `var arr = [100]; arr[0] = "s"; arr[0] === "s"` in the honest lane.
- [ ] `15.2.3.7-6-a-247` and `15.2.3.6-4-258` pass in the linked lane.
- [ ] The mirror-writeback rollback path is not tripped by an ordinary
      non-number store (it must route to the sidecar, not unwind).
- [ ] Host writes and compiled in-wasm writes agree on the same index
      afterwards — a measured case, not an argument.
- [ ] No regression on the `Object/defineProperty/15.2.3.6-4-*` slice or the
      for-in / keys / assign slice, both lanes.

## Notes

Filed out of #6482 round 7, where the brief assumed this was a cross-module
write-representability problem. It is not: measured, the write never crosses a
module edge and `_decoderExportsFor` has nothing to do with it. A
decoder-resolving + read-override prototype was written and measured during that
round — it flips **0** rows, because the write never fails — and was reverted
unshipped. Do not rebuild it.
