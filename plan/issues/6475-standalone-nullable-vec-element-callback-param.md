---
id: 6475
title: "standalone: a nullable vec element is asserted non-null at every array-HOF callback boundary"
slug: 6475-standalone-nullable-vec-element-callback-param
status: in-progress
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
  # 2026-09-13 (#6475, S15) — the nullable-element callback arm is wired at
  #   the array-HOF call sites (+16) and callback-param nullability flows
  #   through closure lowering (+10); the mechanism itself lives in
  #   src/codegen/array-hof-nullable-elem-param.ts.
  - src/codegen/array-methods.ts
  - src/codegen/closures.ts
---

> **Issue id reserved?** NO. `scripts/claim-issue.mjs --allocate` exits **6**
> (`open-PR id scan DEGRADED — gh offline/unauthenticated`) for the whole of
> this session; GitHub pushes are refused with HTTP 403 for every lane. The id
> **6475** was taken from `--allocate --dry-run --no-pr-scan` (which reported
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
   - `nullableElemParamOverrideFor(elemType)` — returns `elemType` only when it
     is `ref_null`, else `undefined`;
   - `applyNullableElemParamOverride(resolved, override)` — returns the
     override **only** when `resolved` is `{kind:"ref", typeIdx: X}` and the
     override is `{kind:"ref_null", typeIdx: X}` (the exact non-null twin).
     Every other pair is left alone, so the emitted bytes cannot move for any
     shape that is not the lie.
3. `src/codegen/closures.ts` `computeClosureWrapperSig` — consult (2) for
   parameter 0, **after** `resolveWasmType`, and only when the existing
   `arrayMapCallbackFirstParamOverride` did not already fire. `map`'s
   unconditional override keeps its exact current behaviour.
4. `src/codegen/array-methods.ts` `setupArrayCallback` — set/restore the new
   context field around the callback compile. Because every HOF arm funnels
   through `setupArrayCallback`, this is one edit for the whole family.
   `setupArrayCallback` has no `elemType` parameter today; thread it through
   (all call sites already have `elemType` in scope).

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

## Residuals (measured, not fixed in this slice)

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
