---
id: 1524
title: "test262 harness: TypedArray `ctors` fixture not visible in resizable-buffer tests"
status: done
assignee: sendev-1524
created: 2026-05-20
updated: 2026-07-05
completed: 2026-07-05
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: test-runner
language_feature: test262-harness, typed-array
sprint: Backlog
es_edition: n/a
test262_category: built-ins/Array/prototype, built-ins/TypedArray
test262_count: 259
related: []
---
# #1524 — `ctors` fixture not exposed in resizable-buffer test262 tests

## Problem

202 test262 tests fail with `ctors is not defined`. All of them are
resizable-ArrayBuffer iteration tests for `Array.prototype.*` /
`TypedArray.prototype.*`, which include the shared harness file
`resizableArrayBufferUtils.js`. That helper declares a top-level
`var ctors = [...]` listing the typed-array constructors to iterate
over. Our test262 runner appears to either:

1. fail to inline the helper into the compiled module,
2. inline it but lose the `var` binding because of unified-module
   scoping, or
3. compile the helper, but mark `ctors` as an unresolved external
   when the test body references it.

## Failing test examples

- `test/built-ins/Array/prototype/every/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/findIndex/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/findLastIndex/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/forEach/resizable-buffer-grow-mid-iteration.js`
- `test/built-ins/Array/prototype/indexOf/coerced-searchelement-fromindex-shrink.js`

Error (all identical):

```
L49:3 ctors is not defined
```

## Investigation hints

- `harness/resizableArrayBufferUtils.js` in the test262 worktree —
  inspect what the file declares.
- Compare with how `assert.js` / `sta.js` are included. They appear to
  reach test bodies fine (other top-level decls work).
- The fact that line `49` / `41` is consistent across hundreds of
  tests suggests the helper compiles but its top-level `var` does not
  reach the test export scope.

## Acceptance criteria

- The 5 example tests above compile and execute at least to their
  first assertion (pass or assertion-fail, not `ctors is not defined`).
- No new compile errors elsewhere.

## Estimated impact

**202 test262 fails** unblocked — many will still fail downstream on
resizable-buffer semantics, but converting CE → assertion fail makes
the underlying gaps visible for follow-up.

## Harvest update — 2026-06-19 (run `e9579720`, dated 2026-06-18)

Default-lane cascade grew **202 → 227**. The `resizableArrayBufferUtils.js`
include (`defines: [floatCtors, ctors, MyBigInt64Array,
CreateResizableArrayBuffer, …]`) still never binds its fixtures, so downstream
references throw `ReferenceError`: `ctors is not defined` ×175,
`floatArrayConstructors` ×21, `nonClampedIntArrayConstructors` ×18,
`floatCtors` ×5, `typedArrayConstructors` ×8 (plus `byteConversionValues` ×17
from `byteConversion.js`). Root cause unchanged. Still `backlog`; recorded
count bumped to 227.

## Harvest update — 2026-07-03 (default run `20260703-092808`, standalone run confirmed fresh via `runs/index.json`)

Confirmed cross-lane — same root cause fires in **both** test262 lanes:

- **Default lane: 259** fails, `ctors is not defined` still the dominant
  signature (`ReferenceError`), same `resizableArrayBufferUtils.js`
  top-level-`var` scoping gap.
- **Standalone lane: 175** fails, same signature
  (`built-ins/TypedArrayConstructors/ctors/buffer-arg/*`,
  `built-ins/Atomics/*`, `built-ins/Array/prototype/fill/resizable-buffer.js`
  among the samples) — confirms the harness-scoping bug is orthogonal to
  the standalone/host-import substrate work, i.e. fixing it here benefits
  both lanes independently.

Root cause and fix scope unchanged from the 2026-06-19 update. Recorded
count bumped to 259 (default); still `feasibility: easy`, still `backlog`.
Flagging as a good candidate for promotion to `sprint: current` — cheap,
well-scoped, and now confirmed to unblock **259 + 175 = 434** combined
test262 fails across both lanes (PO call, not made here).

## Resolution — 2026-07-05 (measure-first, sendev-1524)

**The harvest mis-characterized this as a single uniform "easy: provide the
global" win.** Measured on current `upstream/main` (b8dc61ba3), the 259-fail
bucket is really three sub-buckets with very different feasibility:

1. **Resizable `ctors` / `floatCtors` (~180, the DOMINANT sub-bucket) — NOT
   easy, deliberately NOT shipped.** These are the `built-ins/{Array,TypedArray}
   /**/resizable-buffer-*.js` tests. Providing `ctors` gets past the
   `ReferenceError`, but the harness helper `CreateRabForTest` then does
   `new ctor(rab)` where `ctor` is a *dynamic* constructor variable and `rab`
   is an untyped (`any`/externref) resizable ArrayBuffer. That fails **Wasm
   validation inside the helper function** (`call[0] expected type (ref null 2),
   found externref`), turning every one of the ~180 `fail`s into a
   `compile_error` with **zero** new passes — a lateral move that would also
   risk tripping the `single bucket >50` regression gate. Root cause is a real
   codegen gap: **dynamic `new <ctorVar>(<resizable-buffer>)` + resizable
   ArrayBuffer semantics** (`new ArrayBuffer(n, {maxByteLength})` / `.resize()`
   are recognized member names but have no native bodies yet — see
   `src/codegen/array-object-proto.ts` ARRAYBUFFER_PROTO_METHODS, "degrade to a
   catchable TypeError until per-member native bodies land"). **Split out as a
   follow-up** (needs #2940-class dispatch + resizable-buffer support, not a
   harness shim).

2. **`byteConversionValues` (~17) — genuinely easy, SHIPPED.** Ported the
   `byteConversionValues.js` fixture (values + per-type expected arrays) as a
   preamble shim gated on the include. Flips the fill/map/set conversion tests
   and several TypedArrayConstructors internals + DataView set-values tests.

3. **`typedArrayConstructors` / `floatArrayConstructors` /
   `nonClampedIntArrayConstructors` / `intArrayConstructors` (~47) — SHIPPED
   the constant-list shim.** These constants live in `testTypedArray.js` (the
   runner previously shimmed only the `testWith*` wrapper *functions*, not the
   bare arrays). Providing them flips the Atomics `validate-arraytype-*` tests
   to pass and unblocks the rest to reach the **#2940** harness-wrapper vacuity
   fix (they currently land on `vacuous: harness-wrapper callback never
   executed (#2940)` rather than the ReferenceError — same non-pass status, no
   regression, but on the critical path to #2940).

**Measured net delta** (83 tests referencing the target globals, run through
the real runner, before vs after): **0 → 18 passes, zero regressions.** The
18: 7 Atomics `validate-arraytype`, 5 TypedArray fill/map/set conversion, 3
TypedArrayConstructors internals conversion, 2 DataView set-values, 1 harness
self-test.

**Byte-inertness:** all three shims are gated on `includes.includes(<file>.js)`
plus a body-reference regex, so any program (test or non-test) that does not
declare the include keeps a byte-identical preamble.

**Fix location:** `tests/test262-runner.ts` `buildPreamble` — two new
include-gated shim blocks (`needsTypedArrayCtorArrays`,
`needsByteConversionValues`) + their gate computations, cache-key entries, and
call-site args. No compiler/`src` change.

The remaining ~180 resizable-`ctors` tests stay open under a **follow-up**
(dynamic-ctor-over-resizable-buffer codegen), which is where the bulk of the
259 (and the #2940 downstream vacuous cluster's resizable slice) actually live.

**Harvest 2026-07-05 re-confirm:** still 259 default-lane `is not defined`
records (`ctors` / `floatArrayConstructors` / `byteConversionValues` /
`nonAtomicsFriendlyTypedArrayConstructors`), and this fixture gap is
additionally the upstream root cause of the **1,496** default-lane
"vacuous harness-wrapper" fails filed under #2940 (the harness helper throws
before the assertion callback runs). Blast radius is materially larger than
the recorded 434. Reiterating: cheap, `feasibility: easy`, high-leverage —
strongest single non-substrate default-lane candidate for `sprint: current`.

---

## Harvest note — 2026-08-11 (symptom moved, family still failing → see #4364)

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260811-103533` (gitHash `9268d5a5`).

`ctors is not defined` is **gone** — that part of the fix holds. But the same
test family now fails one layer later, at dependency injection:

```
No dependency provided for extern class "ctor"      (172 records)
```

**224 official failures** total across 9 distinct extern-class names, dominated
by callback parameters (`ctor`, `TA`, `sourceCtor`, `targetCtor`,
`badArrayType`, `nonSharedArrayType`) rather than globals. Directory profile
matches this issue's family: `built-ins/TypedArray/prototype` (91),
`built-ins/Array/prototype` (68).

Original scope was 202 tests; the successor bucket is 224. Filed as **#4364**.
