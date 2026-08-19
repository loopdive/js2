---
id: 4556
title: "ES5 standalone: Array builtins + annexB built-ins residual (62 rows, 2026-08-19 census)"
status: in-progress
sprint: current
created: 2026-08-19
updated: 2026-08-19
assignee: ttraenkler/es5-standalone-push
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen, runtime
es_edition: 5
language_feature: arrays
goal: es5
related: [4163, 4492, 4491, 3772, 4426, 4555]
origin: "2026-08-19 standalone ES5 census against baselines-repo test262-standalone-current.jsonl (48,735 entries, fetched 04:52). Lane 'array' of an 8-way fan-out."
---

# #4556 — ES5 standalone Array + annexB built-ins residual

## Census (2026-08-19)

Standalone ES5 is **8,506 / 9,029 (94.2 %)**, leaving **523 non-passes**
(495 `fail`, 24 `compile_error`, 4 `compile_timeout`), classified with the
authoritative `scripts/generate-editions.ts` classifier over the fresh
standalone baseline.

This issue owns the **62-row** slice under:

- `built-ins/Array/**`
- `annexB/built-ins/**` (`escape`, `unescape`, `Date.prototype.setYear`/
  `getYear`, the annexB `RegExp` escape forms)

## Signature histogram (top rows)

| rows | signature |
| ---: | --- |
| 5 | `Expected a TypeError to be thrown but no exception was thrown at all` |
| 5 | `TypeError: Cannot access property on null or undefined` |
| 4 | `newArr.length Expected SameValue(«N», «N»)` |
| 3 | `x.toString() must return X` |
| 3 | `The value of y[N] is expected to be N Expected SameValue(«undefined», «N»)` |
| 2 | `Expected SameValue(«null», «X»)` |
| 2 | `Code unit: N Expected SameValue(«undefined», «X»)` |

Long tail, no dominant cluster — see #4555 for the same observation across the
whole 523-row corpus.

Two annexB rows fail with `Test262Error: escape should be an own property` /
`unescape should be an own property`, i.e. the global is not installed at all in
standalone; and `TypeError: Unsupported dynamic regular expression pattern`
appears in the annexB RegExp escape tests. Those are explicit standalone gaps
rather than semantic drift.

## Reproduction

The `--standalone` flag is load-bearing; without it you measure the JS-host
lane (84.8 %), a different corpus.

```bash
npx tsx .tmp/t262.mts --standalone built-ins/Array/prototype/concat/S15.4.4.4_A2_T1.js
node .tmp/t262run.mjs --standalone .tmp/lane-tests.txt 3
```

## Acceptance criteria

- Net increase in standalone ES5 passes across the 62-row lane, measured
  before/after with the same runner.
- Regression guard (`551` locally-verified-passing standalone ES5 tests) stays
  at 551/551.
- No test-name/path special-casing; no edits to the runner's skip logic
  (`shouldSkip`, `HANGING_TESTS`).

## Relationship to existing issues

- #3772 (`es5-filter-result-array`, `in-review`) is a narrow slice of this area.
- #4426 (`es5-standalone-array-length-toprimitive-fixes`, `done`) already landed
  the `length`/ToPrimitive fixes; the rows here are what survived it.
- #4492 owns builtin-prototype methods on exotic receivers, which overlaps the
  `Array.prototype` rows — coordinate before touching shared receiver paths.

## 2026-08-19 FINAL — lane 1 → 22 of 62, `target=standalone`

Branch `es5-array`, commits `cdc21bd`, `8ec5b21`, `0a04426`. Clean tree.
**Guard 551/551 → 551/551.** 15 files, +671/−147, 4 new subsystem modules
(`array-carrier-brand.ts`, `annexb-escape-call.ts`, `tonumber-symbol-throw.ts`,
plus additions to `array-nonindex-key.ts` / `array-holes.ts`). No budget
allowances needed — every god-file touched shrank.

### Eight root causes

| # | rows | defect |
| --- | ---: | --- |
| 1 | +3 | **`Array.isArray` answered `true` for ANY GC ref** (`call-builtin-static.ts:635`). It decided on `argWasmType.kind === "ref"`; in standalone every non-primitive IS a GC ref, so `Array.isArray("abc")`, `({0:12,length:2})`, `new Date(0)` were all `true`. Now decided on the array carrier, sharing exclusion rules with the runtime `__extern_is_array` fill so the static and dynamic arms cannot disagree. |
| 2 | +2 | **`__extern_length`'s open-`$Object` arm did `__unbox_number`, not ToNumber** (`object-runtime-enumeration.ts:474`). §7.1.20 ToLength runs ToNumber, and ToNumber of an object runs the observable ToPrimitive walk — so a `length` accessor returning `{toString(){…}}` answered NaN → 0 (zero iterations) and a **throwing** `toString` never threw. |
| 3 | +4 | **A borrowed HOF with a provably non-callable callback emitted NOTHING.** `Array.prototype.every.call(obj, null)` fell out of the array-like path into `calls.ts`'s refuse-loud `reportError`, which is non-sticky and is discarded by the expression unwind (the #4076 "refuse-loud is not loud" finding) — so no TypeError **and** the observable `length` getter never ran. Now §23.1.3 order: read `length`, then throw. |
| 4 | +2 | zero-arg `escape()` / `unescape()` were gated out by `arguments.length >= 1` and fell to a host import standalone lacks, answering `""` instead of ToString(undefined). |
| 5 | +5 | **A constant element key that IS an index but isn't spelled as a number had no i32 lowering and silently compiled to `0`** — read AND write. `a["1"]`, `a[new Number(2)]`, `a[new String("2")]` all read element 0. #4247 routed constant NON-index keys and let index keys "fall through to the untouched vec path" — right for a numeric literal, wrong for these. |
| 6 | +3 | **`<Builtin>.prototype.isPrototypeOf(V)` TRAPPED** — the receiver compiled to a null ref, so an uncatchable "Cannot access property on null or undefined" where the spec wants `true`. §20.1.3.3 with `O = <Ctor>.prototype` is exactly what `V instanceof <Ctor>` answers, which standalone answers natively. `Object` deliberately excluded — its `__isPrototypeOf` chain walk is strictly more faithful. |
| 7 | +1 | `join` stringified `undefined`/`null` elements instead of `""`. §23.1.3.18 step 4.b tests "undefined or null" BEFORE ToString; the fold tested only the `$Hole` sentinel, so `[0, undefined, null, 3].join()` gave `"0,undefined,null,3"`. |
| 8 | +1 | ToNumber(Symbol) did not throw in the Date setters — `new Date(0).setYear(Symbol())` quietly produced year 101. |

Fixes 1, 6, 7, 8 are lane-agnostic and apply outside `built-ins/Array`; 6 touches
shared receiver dispatch (`builtin-prototype-brand.ts`), the overlap flagged with
#4492.

### Remaining 40, bucketed

**Blocked (3)** — `RegExp-leading-escape-BMP`, `RegExp-trailing-escape-BMP`,
`filter/15.4.4.20-5-7`: all need the QuickJS eval provider (unbuildable locally,
see #4163).

**Spun out to its own issue:** bucket **I (2)** — `toLocaleString/A3_T1` and
`toString/A1_T4` emit **invalid Wasm** (`CompileError: type error in fallthru[0]`).
That is a broken module, not a semantics gap → **#4560**.

**Fixable-later, with sketches:**

- **A (4)** — a builtin-prototype member override is invisible to builtin member
  reads. A *documented* boundary in `proto-index-store.ts`. Sketch: when
  `ctx.protoNamedDirty`, have the builtin member-call arms consult
  `__protoidx_get_r`, gated on the pre-scan flag so clean modules stay
  byte-identical.
- **B (5)** — inherited `Array.prototype[N]` / `Object.prototype[N]` indices
  invisible to array reads and methods. Same store, index side, same boundary.
- **H (8)** — borrowed HOF over an array-like: element/prototype visibility and
  mid-loop mutation. Counts are off by one in **both** directions, so the loop is
  snapshotting HasProperty rather than re-checking per index.
- **E (3) — array `length` is a SIGNED i32.** `emitArraySetLengthValidation`
  (`array-length-define.ts:517`) ends in `i32.trunc_sat_f64_s` — that is ToInt32,
  but §10.4.2.4 step 3 is **ToUint32**. Flip to `_u` AND make the matching
  `.length` READ `f64.convert_i32_u`. Identical encoding for every length < 2³¹,
  so it cannot regress a working case. **Deliberately not landed**: the lane could
  not locate every length-read site, and an unpaired flip turns 4294967295 into −1.
- **F (3)** — huge index writes trap; needs E plus a sparse representation.
- **C (2)** — `x.concat = Array.prototype.concat; x.concat(…)` traps; only the
  `.call` spelling is recognised by `compileArrayPrototypeCall`.
- **D (2)** — mixed-element concat keeps the receiver's f64 carrier, so object
  arguments box to NaN. A minimal probe traps `illegal cast`, so it is worse than
  the row text suggests.
- **J (2)** — `escape`/`unescape` `prop-desc`: the functions work, they are just
  not reachable as own properties of a reified global `this`.
- **G (1)** — holes in an f64-backed vec; a numeric carrier has no hole
  representation.
- **K (1)** — a builtin ctor does not inherit from `Function.prototype`
  (#1907/#1888 S6-b).
- **L (1)** — a NON-constant element key needs runtime ToPropertyKey; fix 5
  covers compile-time-constant keys only.
- **M (1)** — the `arguments` object shares the `__vec_externref` carrier with
  `any[]`, so `isArray` answers `true`. Needs a distinct carrier or brand bit;
  blast radius judged too large for one row.
- **N (1)** — "Unsupported dynamic regular expression pattern".
- **O (1) — not a compiler bug in the obvious place.** `"a".substr(0, NaN)` is
  correctly `""`; the *test's own reference implementation* goes wrong because a
  NaN element read back out of an f64 vec makes its `length === undefined` branch
  fire. The real defect is undefined-vs-NaN in the numeric carrier — same family
  as G.
