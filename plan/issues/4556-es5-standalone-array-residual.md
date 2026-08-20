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

### CORRECTION to bucket E (2026-08-19) — the obstacle is sentinels, not discovery

The sketch above framed bucket E as "find every length-read site, then flip
`i32.trunc_sat_f64_s` → `_u` and pair the read". Having actually enumerated the
sites, that framing is **wrong in a way that would cause a silent regression**:

- There are **~9 vec-length read sites in `property-access-dispatch.ts` alone**.
- At least one of them (`~L2861`, the auto-length `$__ta_view` arm) reads a
  field-0 **`-1` sentinel**.

A blanket `_s` → `_u` flip turns that sentinel into **4294967295** — a silent
wrong answer, in a code path that has nothing to do with array `length`
semantics.

**The 551-row guard cannot catch this**, because signed and unsigned encode
identically for every value below 2³¹ and the sentinel case is not exercised by
the guard corpus. A green guard here is false reassurance.

So for whoever picks E up, step one is **"audit every field-0 reader for
sentinel values"**, not "find the read sites". Add a constructed probe at
4294967295 and at 2³¹ as the acceptance test, since the guard will not serve.

This is why the fix was deliberately not landed. Recorded so the next attempt
starts from the real obstacle rather than re-deriving it.

## 2026-08-19 — a REGRESSION that every gate passed, and what it means

`cdc21bd`'s constant-element-key lowering (fix 5) introduced a silent
wrong-answer bug in **ordinary array iteration**:

```js
var nums = [1, 2, 3];
var total = 0;
for (var i = 0; i < nums.length; i++) { total += nums[i]; }
// total === 3, not 6
```

`resolveConstantExpression` (`literals.ts`) folds a `let`/`var` binding to its
**initializer** — mutability be damned — and returns it as a *string* even for a
numeric one. `arrayIndexConstantKey` accepted a bare identifier and trusted that
fold, so `i` resolved to the key `"0"`, which **is** a valid array index, and
every iteration read `nums[0]`.

The fold is inert where it originally lived: `nonArrayIndexNumericKey` (#4247)
**declines** on an index-looking result, so the fold never becomes an answer
there. The new call site returned it as the answer.

Fixed in `6d185055` — literal arguments only, never an identifier, at the top
level or inside a `new Number(…)` / `new String(…)` wrapper. Every measured win
spells its key as a literal or a wrapper around one, so **nothing was lost:
lane stays 25/62**. The same restriction was applied to the `new Boolean(<c>)`
arm added by this lane, which had the identical hazard and had not yet bitten.
Pinned by `tests/issue-4556-array-index-key-mutable-binding.test.ts` (4 cases per
lane), verified to FAIL against the pre-fix resolver — a regression test that
cannot fail is not one.

Independently re-verified by the integrator: the repro fails at `cdc21bd` and
passes on the integration branch.

### Everything was green while the bug was in

| gate | reading |
| --- | --- |
| standalone conformance lane | 25/62 — **unchanged by the bug** |
| 551-row standalone guard | 551/551 — **unchanged by the bug** |
| `tsc --noEmit` | clean |
| LOC / function budget gates | clean |

The suite that caught it was `tests/issue-4394-mixed-array-literal-host.test.ts`
— a **GC-lane** suite.

**The lesson is sharper than "a corpus samples behaviour".** The defect sat in
lane-shared key resolution (`property-access.ts` and `assignment.ts` both call
it) while the entire verification loop was standalone-only. So it was: **the
corpus is one lane and the code is both.** A cross-lane unit suite was the only
thing positioned to see it. Any change to shared codegen needs the *other*
lane's suites run too, regardless of which lane the conformance target is.

(Separately, the same commit regressed 5 `String.prototype.split` rows found by
the integrator via the prototype-write corpus; `6d185055` fixes those too — same
root cause.)

### Unit suites, relative to merge base

81 suites over array / element-access / join / holes / delete / proto-brand /
global-function / Date, run in batches of 4 (the full set OOMs a vitest worker at
6 GB).

| | pass | fail | files |
| --- | ---: | ---: | ---: |
| base `f7df34f` | 868 | 69 | 81 |
| head `6d18505` | 876 | 69 | 82 |

69 pre-existing failures both sides, **0 broken**, +8 from the new test; the only
per-file difference is the new file. `tests/issue-4205-script-goal-global-object.test.ts`
OOMs on its own at 10 GB on base and head alike, so it is excluded from both
sides rather than counted.

## Bucket E — RETIRED, not deferred

The exhaustive read-site audit retires the `_s`→`_u` sketch rather than sizing it:

- **≥146 vec length read sites across 43 files** (counting only the
  `struct.get typeIdx:…vec…, fieldIdx: 0` spelling; `type-coercion.ts:1764`
  reads it as `fromTypeIdx`, so the true count is higher).
- **Only 17 convert to f64** — the "read `.length` as a JS number" case the
  sketch addressed. **129 consume the raw i32** as a loop bound, an
  `array.new_default` size, or an `array.copy` count.

So it is not a conversion-signedness fix. Storing ToUint32's bit pattern hands
**−1** to 129 sites that today receive a clamped 2147483647:
`array.new_default(-1)` traps, `i32.lt_s` loops zero times. Faithful lengths in
[2³¹, 2³²) need the field widened or sparse-only semantics above 2³¹ — a
representation change with 146+ consumers.

Measured divergence:

| assigned | read back | |
| --- | --- | --- |
| 2147483647 | 2147483647 | control, correct |
| 2147483648 | **2147483647** | first divergence |
| 4294967295 | **2147483647** | |

Side finding: putting all three assignments in **one** module hits
`compilation timeout (16.9 s)`. Three large-length writes exhaust the compile
budget — worth its own look, independent of E.

## 2026-08-19 — bucket A landed (`b58ed406`), 3 of 4 rows

**Lane 25/62 → 28/62.** Cleared on all four gates:

| gate | base | branch | |
| --- | --- | --- | --- |
| lane | 25/62 | **28/62** | +3 |
| 551-row guard | 551/551 | 551/551 | |
| prototype-write corpus, **isolated** | 120/121 | 120/121 | zero diff |
| unit suites, 83 files, **both lanes** | 868p / 69f | 882p / **69f** | 0 broken, +14 from 2 new suites |

(The corpus's single failure — `language/expressions/instanceof/primitive-prototype-with-primitive.js`,
QuickJS provider — is pre-existing on `main`. So the local corpus baseline is
**120/121**, quantified.)

### The fix

`__protoidx_has_r(recv, "<m>") ? apply the companion entry : the builtin` — a
two-arm runtime branch at the call site, following `emitDynViewMethodTwoArm`'s
discipline (the existing precedent for branching between two full lowerings of
one call).

**`has`, not get-and-test-nullish**: presence is the spec question, and an
override whose value is `undefined` must still shadow the builtin. What makes
`has` *exact* rather than approximate: under `protoNamedDirty` alone the
companion is seeded with **nothing** — seeding is driven by `protoMemberDirty`,
and a proto WRITE deliberately does not set it — so `has` means precisely "the
user overrode this member", never "this member exists".

Gated on standalone + `protoNamedDirty` (a pre-scan flag, so a non-overriding
module never builds the arm) + a whole-file scan for the write. Identifier
receivers only, since the else arm re-dispatches and so compiles the receiver
twice — same restriction and reason as the dyn-view two-arm.

### Measured boundary — the remaining consult-order problem, characterised

An **`any`-typed** receiver bypasses the array method path entirely and reaches
`__extern_method_call`, which is **inconsistent** there: it honours an override
for a member with **no** builtin arm (`join` on an `any` receiver picks it up
today) and ignores it for one that **has** an arm (`toString` does not). That
asymmetry is the sharpest available characterisation of what is left, and fixing
it is strictly larger than this call-site branch. Documented in the module and
the test rather than papered over.

The 4th bucket-A row (`S15.4.3_A1.1_T2`) is untouched: it is a call on the
**constructor object** with a Function-brand override, not an Array-instance
call.

### The unit test found a real hole, not a confirmation

The write-scan matched only the bare `Array.prototype.x = …` and silently
declined for `(Array.prototype as any).x = …` — the ordinary **TypeScript**
spelling. Both halves now unwrap the type-only wrappers. Without the test the arm
would have shipped working on test262's JS spelling and dead on TypeScript's.
