---
id: 6480
title: "standalone: a nullable vec element is asserted non-null at every array-HOF callback boundary"
slug: 6480-standalone-nullable-vec-element-callback-param
status: done
completed: 2026-09-13
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
parent: 5383
goal: standalone-gap
assignee: ttraenkler/dev-5383-s15
created: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (#6480, S15) — the nullable-element callback arm is wired at
  #   the array-HOF call sites (+16) and callback-param nullability flows
  #   through closure lowering (+10); the mechanism itself lives in
  #   src/codegen/array-hof-nullable-elem-param.ts.
  - src/codegen/array-methods.ts
  - src/codegen/closures.ts
---

> **Issue id reserved?** NO. `scripts/claim-issue.mjs --allocate` exits **6**
> (`open-PR id scan DEGRADED — gh offline/unauthenticated`) for the whole of
> this session; GitHub pushes are refused with HTTP 403 for every lane. The id
> **6480** was taken from `--allocate --dry-run --no-pr-scan` (which reported
> #6474, already consumed unreserved by the S14 slice) plus one. It is
> therefore **unreserved** and has not been checked against in-flight PRs.

## Problem

Standalone `RegExp.prototype.exec` returns a `$__regexp_match_vec` — a WasmGC
subtype of the **nullable** native-string vec, where an unmatched capture group
is stored as a **null native string** (`native-regex.ts`
`ensureRegexMatchVecType`: element type `{kind:"ref_null", typeIdx: anyStr}`;
`regexp-standalone.ts` `emitRegexExecArrayCall` documents this as "the
compiler's `undefined` for nullable native string slots").

TypeScript's own `lib.d.ts` types that array as `RegExpExecArray extends
Array<string>` — i.e. **non-null** `string` elements. So for

```js
const m = /^(a)?(b)$/.exec("b");        // m = ["b", undefined, "b"]
m.every((e, i) => i < 2 || true);       // TRAP: dereferencing a null pointer
```

`computeClosureWrapperSig` resolves the callback's first parameter from the
checker (`string` → `{kind:"ref", typeIdx: anyStr}`), and
`buildClosureCallInstrs` then coerces the loaded element
`{kind:"ref_null", …}` → `{kind:"ref", …}`, which is a bare `ref.as_non_null`.
On the `undefined` capture that traps.

`map` is the ONE array HOF that does not trap, because it already installs
`ctx.arrayMapCallbackFirstParamOverride = elemType` around the callback compile
(#4527/#5319). Every other HOF that goes through `setupArrayCallback`
(`every` / `some` / `filter` / `forEach` / `find*` / `reduce` / `flatMap` / …)
does not, and traps.

### Why this gates the Temporal lane (#5383)

`@js-temporal/polyfill`'s `ToTemporalDuration` (minified `sn`) parses a
duration STRING with

```js
const t = Ye.exec(e);
if (!t) throw new RangeError(`invalid duration: ${e}`);
if (t.every((e, t) => t < 2 || void 0 === e)) throw new RangeError(…);
```

`Ye` has optional groups, so the match array always carries nulls, and the
`every` is the first thing that touches them. Every string-argument Duration
entry point therefore traps in `sn()` — which is the largest remaining failure
bucket in the S14 three-family sample (16 Duration rows + 6
ZonedDateTime/prototype rows).

## Acceptance criteria

1. `m.every((e, i) => …)` / `forEach` / `join`-free HOFs over a RegExp match
   result do not trap, and an unmatched group presents as `undefined` inside the
   callback (`void 0 === e` is `true`).
2. `Temporal.Duration.from("P1Y").years === 1` under `--target standalone` with
   the linked provider.
3. The three-family linked sample improves over S14's 199/360 with **0**
   non-vacuous `pass→fail`.
4. `gc` lane byte-identical on a fixed corpus.
5. No new host imports; `__temporal_*` leaks stay 0.

## Implementation Plan

**Root fix, one mechanism, narrowest possible predicate.**

The defect is a *nullability lie*: the checker's element type is the non-null
twin of the vec's real element type. Fix it exactly where the lie enters — the
closure wrapper signature — and only when it IS that lie:

1. `src/codegen/context/types.ts` — add
   `arrayHofNullableElemParamOverride?: ValType`, a sibling of the existing
   `arrayMapCallbackFirstParamOverride`.
2. New module `src/codegen/array-hof-nullable-elem-param.ts` (classified in
   `scripts/compiler-boundaries.json`) owning:
   - `nullableElemParamOverrideFor(elemType, paramIndex)` — returns
     `{elemType, paramIndex}` only when `elemType` is `ref_null`, else
     `undefined`;
   - `applyNullableElemParamOverride(resolved, override, runtimeIndex)` —
     returns the override's type **only** at `override.paramIndex`, and only
     when `resolved` is `{kind:"ref", typeIdx: X}` against an override
     `{kind:"ref_null", typeIdx: X}` (the exact non-null twin). Every other
     pair is left alone, so the emitted bytes cannot move for any shape that is
     not the lie.
3. `src/codegen/closures.ts` `computeClosureWrapperSig` — consult (2) for every
   parameter, **after** `resolveWasmType`, and only when the existing
   `arrayMapCallbackFirstParamOverride` did not already fire. `map`'s
   unconditional override keeps its exact current behaviour.
4. `src/codegen/array-methods.ts` `setupArrayCallback` — set/restore the new
   context field around the callback compile. Because every HOF arm funnels
   through `setupArrayCallback`, this is one edit for the whole family.
   `setupArrayCallback` has no `elemType` parameter today; thread it through
   (all call sites already have `elemType` in scope), together with the
   **element parameter index**.

### Why the override carries a parameter INDEX (S15 correction, measured)

The first cut pinned parameter **0** unconditionally. That is right for the
predicate family `(element, index, array)` and **wrong for `reduce` /
`reduceRight`**, whose callback is `(accumulator, element, index, array)` —
parameter 0 is the accumulator. Measured on the reduction, that cut fixed 7 of
8 arms and left `reduce` answering `!dereferencing a null pointer`; pinning
parameter 0 there would also have re-typed the accumulator, which is a
different value entirely. Carrying the index with the type is what lets one
mechanism cover both callback shapes, and it is why the witness asserts
`reduce`/`reduceRight` explicitly.

Downstream effects considered:

- **Stack balance**: the change removes instructions (`ref.as_non_null`), never
  adds; arity at `call_ref` is unchanged because only a param's *type* moves,
  `ref_null T <: ref T`'s supertype direction is the safe one for a parameter.
- **Index shifting**: no new imports, no new funcs minted at a point that could
  shift indices — `computeClosureWrapperSig` is pure and the wrapper type is
  registered through the same `getOrCreateFuncRefWrapperTypes` path.
- **#2939 pre-scan divergence**: `ensureFuncValueWrappersRegistered` calls
  `computeClosureWrapperSig` without the override set, so a pre-registered
  wrapper can differ from the compiled one. That hazard already exists verbatim
  for `map`'s override; this change does not widen it beyond the
  nullable-element case.
- **Speculative rollback**: none taken; the change emits no speculative body.

`join` over an element that is `undefined` traps independently of this
(`["x", undefined].join("|")`) — written down in `## Residuals`, not fixed here.

## Outcome (S15, measured 2026-09-13 on this branch)

Everything below was measured on THIS tree: base by file-copy revert of the
three edited sources (captured at the first edit, `.tmp/s15base/`), branch =
the committed state. Same worktree, same quickjs artifacts, fresh
`JS2WASM_TEMPORAL_CACHE` + pre-warm STAMP per label (`cacheHit=false` on both).

### The reduction, `--target standalone`, ONE module, no link

| receiver / HOF | base | S15 |
| --- | --- | --- |
| `m.every((e, i) => i < 2 \|\| true)` | `!dereferencing a null pointer` | `true` |
| `m.every((e, i) => i < 2 \|\| undefined === e)` | trap | `false` |
| `m.some((e) => undefined === e)` | trap | `true` |
| `m.filter((e) => undefined !== e).length` | trap | `2` |
| `m.forEach` counting `undefined` | trap | `1` |
| `m.find((e) => undefined === e)` | trap | `undefined` |
| `m.findIndex((e) => undefined === e)` | trap | `1` |
| `m.findLast` / `m.findLastIndex` | trap | `undefined` / `1` |
| `m.reduce((a, e) => a + (undefined === e), 0)` | trap | `1` |
| `m.reduceRight(…)` | trap | `1` |
| `m.map(…)` (control) | `"S,u,S"` | `"S,u,S"` |
| `m[1]` index read (control) | `"u"` | `"u"` |
| `["x","y"].every(…)`, `[1,2,3].every/reduce/filter` (controls) | correct | correct |

`m` is `/^(a)?(b)$/.exec("b")` = `["b", undefined, "b"]`.

### Three-family linked sample, 120 rows each, sequential

| family | rows | base pass | **S15 pass** | fail | CE | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 78 | 78 | 41 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 49 | **51** | 66 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 72 | 72 | 46 | 2 | **0** |
| **total** | **360** | **199** | **201** | **153** | **6** | **0** |

`fail→pass`: 2 (`Duration/from/argument-string-fractional-with-zero-subparts.js`,
`Duration/from/argument-string-is-infinity.js`). `__temporal_*` leaks: **0** in
all six TSVs. The base column reproduces S14's 199/360 exactly, which is what
makes this a self-consistent before/after rather than a comparison across runs.

**The `sn()` bucket is GONE and that is the finding, not the +2.** All 22
`dereferencing a null pointer in sn()` rows (16 Duration + 6 ZonedDateTime)
stopped trapping at the `every`. Eighteen of them now trap ONE step further
into the SAME function, at `__str_flatten` — a different defect (see
`## Residuals`). So this slice removed the first of two blockers in `sn`; the
row count moves properly only when the second one goes too.

### Must-not-move, and nothing moved

`built-ins/Array/prototype/{map,filter,forEach,reduce,reduceRight,every,some,findIndex}`,
15 rows each = 120, `--target standalone`, base by file-copy revert on this
tree: **54 pass / 66 fail on BOTH**, **0 flips**, 0 pass→fail. Fifteen per
directory rather than "the first 120 files" on purpose — the alphabetical
first-120 never reaches `reduce`, which is the arm whose element parameter is
index 1.

### Order preservation

- 42 modules (`website/playground/examples/**` + `tests/fixtures/**`) ×
  {gc, standalone} = 84 artifacts: **84/84 sha256-identical**, both lanes.
- A targeted 14-shape corpus supplies the positive control: **all 14 `gc`
  artifacts identical**; on standalone exactly the five nullable-element HOF
  shapes move — plus one CONTROL, see the honest correction below.

### Correction to this issue's own claim (measured, 2026-09-13)

The plan said "no other callback shape can move a byte". That is **too
strong**, and the targeted byte A/B is what caught it: `["x","y"].every(…)`
also moves on standalone, because a plain string array's element type there is
ALREADY `ref_null $anyStr` (array holes), so the predicate fires for it too.
The accurate statement is: **the override fires for every receiver whose real
element type is nullable while the checker called it non-null** — which is the
correct generalisation, not a leak. Number-element and object-element arrays do
not move; the `gc` lane does not move at all; and the 120-row must-not-move
sample plus the controls in the witness are the behavioural evidence that the
widening is inert (the emitted bytes differ by a removed `ref.as_non_null`,
which can only remove a trap, never add one).

## Residuals (measured, not fixed in this slice)

- **THE NEXT BLOCKER, and it is the same 18 rows: TRUTHINESS of a null native
  string traps.** Reduced (`--target standalone`, one module, no link, match
  `t` from a regexp with optional groups, `t[4]` unmatched):

  | probe | answer |
  | --- | --- |
  | `t[4] ? "T" : "F"` | `!dereferencing a null pointer` |
  | `t[4] \|\| "fallback"` | trap |
  | `Boolean(t[4] ?? t[6])` (both null) | trap |
  | `Boolean(t[4])` (explicit call) | `"false"` — correct |
  | `Boolean(t[4] ?? "x")` (result non-null) | `"true"` — correct |
  | `"" + t[4]` | `"undefined"` — correct |
  | `let a = null; Boolean(a ?? null)` (no native string) | `"false"` — correct |

  So the explicit `Boolean(…)` call is null-aware and the implicit truthiness
  lowering is not. The polyfill's `sn` hits it at
  `if (d ?? h ?? u ?? l) throw …` — `__str_flatten` at `sn` L315/L354 in the
  linked traces. This is the next slice's target and it is worth more than this
  one was: 13 Duration + 5 ZonedDateTime rows in the three-family sample sit on
  it today.
- `Array.prototype.join` / `Array.prototype.toString` trap on an `undefined`
  element (`["x", undefined].join("|")` → `dereferencing a null pointer`;
  `["x", null].join("|")` → `"x|"`, correct). Independent of RegExp.
- `typeof m[i]` answers `"string"` for an unmatched group; the spec answer is
  `"undefined"`. A null native string is `undefined` in value comparisons
  (`m[1] === undefined` is `true`) and in concatenation (`"" + m[1]` is
  `"undefined"`), so only the `typeof` lowering is out of step.
- `instanceof` across the provider link with a dynamic RHS answers `false`
  (`__closure_proto_of`'s class arm does not vivify the lazy `__proto_<C>`) —
  #5383 S11's residual, still open.
