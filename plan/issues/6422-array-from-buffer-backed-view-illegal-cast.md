---
id: 6422
title: "`Array.from(new Uint8Array(<host ArrayBuffer>))` traps with `illegal cast`"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-13
completed: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-13 — the trapping `local.set` into the `ref null $Vec` local is one
# statement inside `compileBuiltinStaticCall`'s array-copy arm, and making it
# transactional needs the probe/rollback pair plus a guarded block around the
# emission it already had. The carrier decision itself was moved OUT to the new
# `src/codegen/array-from-vec-carrier.ts`; what stays is the +14 lines of
# probe + comment that cannot leave the call site.
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
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

## Resolution

Fixed on `issue-6422`, measured on `7adc0a6e89` (2026-09-13).

**Mechanism.** The `Array.from` array-copy fast path
(`src/codegen/expressions/call-builtin-static.ts`, the
`resolveArrayInfo(ctx, argTsType)` arm) picked its carrier from the CHECKER
type: a declared or inferred `Uint8Array` resolves to a `$Vec`, so the arm
compiled the argument and `local.set` it into a `ref null $Vec` local without
ever looking at what the argument actually lowered to. `repairStructTypeMismatches`
silently repaired the resulting validation mismatch with
`any.convert_extern; ref.cast_null $Vec` — which **traps** at runtime, because
the value was not a `$Vec`.

**Both diagnoses in the plan hold, and the standalone half of it does not.**
Two distinct carriers reach that arm behind the same static `Uint8Array`:

| lane       | `new Uint8Array(buf)` builds                  | parent            |
| ---------- | --------------------------------------------- | ----------------- |
| JS host, untyped `buf` | a REAL host `Uint8Array` (externref) via `__construct_closure` | **illegal cast**  |
| both lanes, compiled `ArrayBuffer` | the shared-backing `$__ta_view` struct (#3054) | **illegal cast**  |

The plan recorded standalone as "measured 32, no trap, no change needed". It
traps there too — for the `$__ta_view` reason this issue's own text originally
guessed. Measured on the parent, `.tmp/p6422s`:
`Array.from(new Uint8Array(buf)).length` → `RuntimeError: illegal cast`.

**Fix.** One site, transactional, no widened cast. The argument is
probe-compiled under `snapshotSpeculative`; the new
`src/codegen/array-from-vec-carrier.ts` (`admitArrayFromVecCarrier`) decides
whether the produced value belongs in that `$Vec` local:

- already that vec → commit the `array.copy` lowering unchanged;
- a registered `$__ta_view` → **de-view** it first with #3054 B1's
  `emitTaViewToVec` (the same materialization the TypedArray prototype methods
  take), then commit — which keeps the fast path *and* the element values;
- anything else (a host externref, …) → `rollbackSpeculative` and fall through
  to the existing native / host `Array.from` fallback, which reads a host typed
  array correctly.

The de-view arm is load-bearing, not a nicety: routing a `$__ta_view` to the
fallback instead answers the right LENGTH with `NaN` ELEMENTS, because
`__extern_get_idx` has no `$__ta_view` arm (see Residuals).

**Probe, host lane (`.tmp/p6422`), parent → fix:**

| case                                        | parent         | fix |
| ------------------------------------------- | -------------- | --- |
| `viewLen(hostAb)`                           | 32             | 32  |
| `Array.from(new Uint8Array(hostAb)).length` | illegal cast   | 32  |
| …byte sum                                   | illegal cast   | 96  |
| `const v = new Uint8Array(buf); Array.from(v).length` | illegal cast | 32 |
| `Array.from([1,2,3])`                       | 3              | 3   |
| `Array.from(new Uint8Array([1,2,3,4]))`     | 4              | 4   |
| `Array.from(<host Uint8Array via any>)`     | 2              | 2   |

**Probe, standalone lane (`.tmp/p6422s`), parent → fix:** length
`illegal cast` → 32, sum `illegal cast` → 96; `Array.from([1,2,3])` 3 → 3,
`Array.from(new Uint8Array([1,2,3,4]))` sum 10 → 10.

**Regression test.** `tests/issue-6422-array-from-host-typed-array-view.test.ts`
— 12 cases, both lanes, untyped two-file fixture for the host half. On the
parent: **5 fail** (3 host + 2 standalone, all as `RuntimeError: illegal cast`),
**7 pass** (the anti-vacuity controls, including a WAT assertion that the
compiled-carrier case still emits `array.copy` — so a fix that merely routed
everything to the fallback would not pass). With the fix: 12/12.

**A/B, 17 dogfood suites at one HEAD (`7adc0a6e89`), base vs fix — every
suite FLAT:**

| suite | base | fix | | suite | base | fix |
| --- | --- | --- | --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | | uuid | 75/75 | 75/75 |
| three | 17/18 | 17/18 | | marked | 16/30 | 16/30 |
| clsx | 32/32 | 32/32 | | moment | 10/10 | 10/10 |
| cookie | 63740/63740 | 63740/63740 | | prettier | 108/151 | 108/151 |
| lodash | 59/62 | 59/62 | | jest | 335/356 | 335/356 |
| redux | 67/82 | 67/82 | | hono | 261/324 | 261/324 |
| axios | 208/231 | 208/231 | | stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 | | jsdom | 6/6 | 6/6 |
| styled-components | 9/9 | 9/9 | | | | |

Two of the anchors in the plan were stale against this HEAD and moved in BOTH
lanes, so they are not this change's doing: prettier 107 → **108** and hono
259 → **261**. The defect was found by a probe, not a suite, and no suite
exercises it.

**Gates.** loc/func/coercion/oracle-ratchet/dead-exports/dogfood-validation/
host-import-policy green; compiler-boundaries inventory green after classifying
the new module in `scripts/compiler-boundaries.json`. `tsc --noEmit` clean. The
loc/func growth (+15 / +14, the probe + rollback pair that cannot leave the call
site) is granted in this file's frontmatter.

**The first cut was narrowed after a merge-queue park — but the park was NOT
this change's regression. Correcting the record (2026-09-13).**

PR #5894 was auto-parked on the #2097 standalone host-free high-water floor
(`pass=35567`, mark `35686`, delta `-119`; run 34743292750). That was attributed
here to the first cut, which admitted only an exact
`typeIdx === vecTypeIdx` match and diverted every other WasmGC ref to the
fallback. **The attribution was wrong.** Two measurements settle it:

- After the predicate was relaxed, the very next merge group for this PR
  (57d135c8, run 34748482771) reported the **identical** `pass=35567`. A change
  that had cost standalone passes would have recovered some; it recovered
  exactly zero.
- The unrelated PR #5897 reported the byte-identical breach in its own merge
  group (run 34746428311): `pass=35567, mark=35742, delta=-175`. So did #5885,
  #5890, #5896 and #5899 in the same window. The measured standalone count sat
  at 35567 for **everyone** while main's high-water mark kept being promoted
  upward past it — main-side drift in the standalone shard, not this change.

The lesson is the one CLAUDE.md already states: a number read off an artifact
is not a measurement of your own change until you have compared it against a
control. The control here cost one API call — the same gate's numbers on a
concurrent, unrelated PR.

The relaxation stands on its own merits and was kept: a GC struct whose index
differs from the checker-derived vec is routinely cast-compatible with it, so
the repair's `ref.cast` succeeds there and the `array.copy` path was correct all
along. Being stricter than the trap requires was unjustified. The shipped
predicate diverts or materializes only the two carriers that provably trap
(non-GC value, `$__ta_view`) and leaves every other ref byte-identical to the
parent — strictly less divergence from base than the variant the A/B measured
flat, which is also why the dogfood A/B was not re-run after the relaxation: it
cannot uncover a divergence the measured, stricter variant did not already have.

**Residuals.**

- `__extern_get_idx` has no `$__ta_view` arm: a view reaching the generic
  array-like walk reads the right LENGTH (`__extern_length` handles it) and
  `NaN` for every element. Measured directly in standalone at the intermediate
  state of this change, before the de-view arm was added. It is dodged here,
  not fixed, and still bites any other consumer of that walk — filed as a
  follow-up.
- Only `Array.from` was audited. `Array.of`, the spread arms and the other
  `resolveArrayInfo` consumers pick their carrier from the checker type the same
  way; the issue's own table shows `Math.max(...view)` is fine, but no
  systematic sweep was done.
