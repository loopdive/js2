---
id: 6422
title: "`Array.from(new Uint8Array(<host ArrayBuffer>))` traps with `illegal cast`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
// untyped .js half; `buf` is a host ArrayBuffer (crypto.subtle.sign's result)
export function arrayFromView(buf) {
  return Array.from(new Uint8Array(buf)).length;
}
```

Compiled code **traps**: `illegal cast`. Node answers 32.

A trap is worse than a wrong answer — it takes the whole module down, and an
unobserved one inside a host promise zeroes an entire dogfood file.

## What is and is not implicated

Measured in one run on `cf82f78d6d` (2026-09-12), all through the same untyped
two-file fixture:

| form                                                   | result         |
| ------------------------------------------------------ | -------------- |
| `new Uint8Array(hostAb).length`                        | 32 — correct   |
| reading the view's bytes by index                       | correct        |
| `Math.max(...new Uint8Array(hostAb))`                   | correct        |
| `Array.from(new Uint8Array(hostAb))`                    | **illegal cast** |

So the buffer-backed view is built correctly and is indexable; it is
`Array.from` over it that casts to the wrong carrier. `new Uint8Array(buffer)`
produces a shared-backing `$__ta_view` STRUCT rather than one of the plain
`$Vec`s (the distinction #5150 had to add to `isViewRefTestInstrs`), and the
`Array.from` lowering most likely `ref.cast`s its argument to a `$Vec`
unconditionally. That is the first thing to check.

## Acceptance criteria

1. `Array.from(new Uint8Array(hostAb))` answers the buffer's byte length with
   equal contents, and does not trap.
2. Anti-vacuity: `Array.from` over a plain array, over a compiled
   `new Uint8Array([…])` carrier, and over a host typed array all keep working.
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent (as a TRAP, so assert the trap) and passing with the fix.
4. A/B over the 17 dogfood suites at one HEAD.
5. Standalone lane status recorded — the `$__ta_view` carrier exists there too,
   so check whether the trap reproduces without a JS host.

## Provenance

Found while closing
[#5370](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5370-typed-array-carrier-host-boundary-fidelity),
in the probe that also produced
[#6421](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6421-spread-into-static-builtin-drops-arguments).
Neither #5370 nor #6421 touches this path.

## Dispatch

Model: **opus**. One trap, one likely cast site, but the fix has to distinguish
the two TypedArray carriers rather than widening the cast.

## Implementation Plan

**Diagnosis (measured on 23a0ddaa26, 2026-09-12, probe under `.tmp/p6422`).** The issue's `$__ta_view` hypothesis is the wrong arm. In the JS-host lane `new Uint8Array(buf)` with an untyped `buf` never builds a `$__ta_view`: `hostTaBufferArgSymName` (src/codegen/expressions/new-super.ts ~L960) answers `"dynamic"` for an `any` arg, so `emitHostTaBufferConstruct` constructs a REAL host `Uint8Array` via `__construct_closure` and returns **externref** (the WAT shows `__hta_ctor_*`/`__hta_argv_*` locals, `call __construct_closure`). Then the `Array.from(arr)` array-copy fast path in src/codegen/expressions/call-builtin-static.ts (~L1405–1474, the `resolveArrayInfo(ctx, argTsType)` arm, locals `__arrfrom_src_*`) trusts the CHECKER type `Uint8Array` → `$Vec`, calls `compileExpression(ctx, fctx, expr.arguments[0])` with no hint, gets externref back, and `local.set`s it into a `ref null $Vec` local. That is a validation mismatch which `repairStructTypeMismatches` (src/codegen/fixups.ts ~L189/L271) silently papers over with `any.convert_extern; ref.cast_null $Vec` — the host object is not a WasmGC struct, so the cast traps. Standalone: `new Uint8Array(buf)` builds a genuine vec/`$__ta_view`, `Array.from` goes through `__array_from_native` — measured 32, no trap, no change needed.

**Fix — one site, transactional (order-preserving):** in the array-copy arm of call-builtin-static.ts, wrap the arg compile in the file's existing `snapshotSpeculative`/`rollbackSpeculative` pattern (already used for the native-string and native-generator probes ~L1290–1330). After `const t = compileExpression(...)`, commit the `array.copy` lowering ONLY when `t` is `ref`/`ref_null` with `typeIdx === vecTypeIdx`; otherwise roll back and fall through to the host `__array_from` fallback (~L1554), which already handles a host typed array correctly (the `arrayFromHostTa(ta)` control proves it). Do NOT widen the cast, and do not add a static `hostTaBufferArgSymName`-only gate: the compiled-type check also covers `const v = new Uint8Array(buf); Array.from(v)` where `inferTaViewType` (src/codegen/statements/variables.ts ~L1180–1205) already made `v` an externref local. Keep every arm above this one (string, generator, Set, Map) untouched and keep the `noJsHost` native-`Array.from` arm below byte-identical; the new guard is a no-op in standalone because `t` IS the vec there.

**Probe first:** re-run `tsx .tmp/p6422/run.mts` (host) and `tsx .tmp/p6422s/run.mts` (standalone) before and after; expected after: every host case prints 32/96/3/4/2/32, standalone unchanged.

**Regression test:** `tests/issue-6422-array-from-host-typed-array-view.test.ts`, mirroring the #5370 harness (compileProject `allowJs`, `target: "gc"`, `platform: "web"`, `deferTopLevelInit`, `buildCompiledImports`+`wrapExports`). Untyped `mod.js` exports `arrayFromView(buf)`, `arrayFromBoundView(buf)` (`const v = new Uint8Array(buf); return Array.from(v).length`), `arrayFromViewSum(buf)`; `entry.ts` wraps them through `any`. Assert length 32 and byte sum for a host `new ArrayBuffer(32)` filled with 3 (parent fails with `RuntimeError: illegal cast` — note that in the test header). Anti-vacuity controls in the same file: `Array.from([1,2,3])` → 3, `Array.from(new Uint8Array([1,2,3,4]))` → 4 (must still take the `array.copy` fast path — assert the emitted WAT for that function contains `array.copy`), and `Array.from(<host Uint8Array via any param>)` → 2.

**Dogfood expectation (anchors: webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono 259/324):** the defect was found by a probe, not a suite; expect all 17 flat. hono (crypto.subtle → `Uint8Array` → `Array.from`) is the only plausible mover and only upward. Run the A/B at one HEAD and record it; any downward move is a real finding. Standalone lane: record "no trap on parent, unchanged after" with the p6422s numbers. Gates: `check-loc-budget`/`check-func-budget` — the arm is inside an already-large function, so grant in this issue's frontmatter if the ratchet trips.

## Dispatch

Model: **opus** — one pinned site with a proven rollback idiom, but the fix must be transactional (roll back the compiled argument, not cast it) and keep four other `Array.from` arms and the standalone lane byte-identical, which needs judgment beyond a mechanical edit.
