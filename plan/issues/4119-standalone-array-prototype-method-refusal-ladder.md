---
id: 4119
title: "standalone: `Array.prototype.<m>` refuses in value position (265) and `Object.prototype.toString` is unimplemented (76) — 341 files behind two adjacent refusal sites in array-object-proto.ts"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES5
language_feature: array-methods
goal: standalone-mode
umbrella: 2860
related: [3571, 1888, 3180, 3170, 3169, 2860, 2501]
test262_fail: 341
origin: "2026-08-03 harvest of loopdive/js2wasm-baselines test262-standalone-current.jsonl, commit 8dac2d70 (2026-08-02T23:08:27Z) = js2 main c480fb66, 30759/43489 host"
---

# #4119 — the standalone `Array.prototype` refusal ladder: 341 files, two emitter lines

## TL;DR

Two **loud, explicit** `emitThrowTypeError` refusals that sit 16 lines apart in
`src/codegen/array-object-proto.ts` account for **341 official standalone
failures**. Neither is sized or owned by any existing issue — the exact strings
appear **zero** times across all 3,467 files in `plan/issues/`.

| refusal | emitter | files | dominant member |
| --- | --- | ---: | --- |
| `<X>.prototype.<m> is not yet callable as a value in --target standalone` | `src/codegen/array-object-proto.ts:715` | **265** | `Array.prototype.map` = 144 |
| `<X>.prototype.<m> is not yet implemented in --target standalone` | `src/codegen/array-object-proto.ts:699` | **76** | `Object.prototype.toString` = 76 |

Denominator: 16,746 non-pass official standalone rows (43,486 official files,
26,740 pass). 341 / 16,746 = **2.0 %** of the standalone failure mass.

## Bucket 1 — method reference in value position (265)

Every one of the 265 has receiver prototype `Array.prototype`; 35 distinct
methods. `map` alone is 144, i.e. **54 %** of the bucket.

```
144  Array.prototype.map
 12  Array.prototype.lastIndexOf
 11  Array.prototype.indexOf
  7  Array.prototype.splice
  6  Array.prototype.toSpliced / forEach / some / every  (6 each)
  5  Array.prototype.toReversed / concat
  4  Array.prototype.push / reduce / toSorted / filter
 ... 21 more methods, ≤4 each
```

Sample paths:

```
test/built-ins/Array/prototype/sort/call-with-primitive.js
test/built-ins/Array/prototype/toSpliced/this-value-boolean.js
test/built-ins/Array/prototype/forEach/15.4.4.18-1-3.js
test/built-ins/Array/prototype/map/15.4.4.19-1-5.js
test/built-ins/Array/prototype/with/length-decreased-while-iterating.js
```

The refusal fires when the method is **named without being immediately
called** — `Array.prototype.map` as an operand (passed, stored, `.call`-ed
through a saved reference, or compared). The direct-call form
`arr.map(cb)` is already lowered natively; only reification is missing.

## Bucket 2 — `Object.prototype.toString` unimplemented (76)

72 of 76 sit under `test/built-ins/Array/prototype/` — the ES5
`S15.4.4.10_A*` (`slice`) and `S15.4.4.12_A*` (`splice`) families, which do
`Object.prototype.toString.call(x)` to assert the result is `[object Array]`.

```
test/built-ins/Array/prototype/splice/S15.4.4.12_A2.1_T5.js
test/built-ins/Array/prototype/slice/S15.4.4.10_A2_T6.js
test/built-ins/Array/prototype/slice/S15.4.4.10_A1.2_T4.js
```

**#2501 is `done`** and claimed `Object.prototype.toString [object X]` including
"standalone CE (~151 test262)". This 76 is a *different mode* — not a compile
error and not a wrong tag, but an explicit runtime refusal from the
`array-object-proto` ladder. Either #2501's fix does not reach this call shape
or it regressed; **verify against #2501's own repro before scoping**.

## Why this is not #3571 / #1888 / #3180

- **#3571** (`ready`, "builtin objects not reified as values") was re-scoped on
  2026-08-01 to **217 files** and its measured mechanism is
  `Function.prototype.call/apply/bind` re-dispatch surfacing as
  `Cannot convert undefined or null to object`. That signature is a **separate
  312-row bucket** in this same baseline. Disjoint signature, disjoint size.
- **#1888** is the prototype-vtable / built-ins-as-static-globals substrate —
  the *enabler*, not this refusal's sizing.
- **#3180** (`ready`) enumerates six residual Array-HOF mechanisms, all
  **receiver-shape** mechanisms (array-like receivers, expando receivers,
  `arguments` fidelity, thisArg, ToPrimitive lengths). None is
  "method-as-value"; the string does not appear in it.
- **#3170** (`done`) did land method-as-value for `indexOf`/`lastIndexOf`/
  `includes` — yet 23 `indexOf`/`lastIndexOf` rows still refuse here, so
  either the fix is partial or a second site was missed. That is the cheapest
  entry point into this issue.

## Acceptance criteria

- [ ] `Array.prototype.<m>` in value position lowers to a callable value in
      `--target standalone` for the closed set the direct-call path already
      supports; the `array-object-proto.ts:715` refusal is unreachable for
      those members.
- [ ] `Object.prototype.toString.call(x)` returns the correct `[object X]` tag
      in standalone for arrays and array-likes; the `:699` refusal no longer
      fires for `Object.prototype.toString`.
- [ ] Re-measure both signatures against a fresh
      `test262-standalone-current.jsonl`; report the delta with denominators.
      Target: both buckets → 0 refusals (the tests may still fail for other
      reasons; count refusals, not passes).
- [ ] If any sub-bucket turns out to be owned by #3170 or #2501, close it here
      and record which, rather than double-fixing.

## Reproduction

```bash
node scripts/fetch-baseline-jsonl.mjs --force
# then filter test262-standalone-current.jsonl on scope_official && status!=pass
#   /is not yet callable as a value in --target standalone/   -> 265
#   /Object\.prototype\.toString is not yet implemented/       -> 76
```
