---
id: 6631
title: "standalone: a mixed-primitive array literal boxes every element as the #1888 tag-5 lie, breaking typeof"
slug: 6631-mixed-array-element-typeof-tag
status: done
completed: 2026-09-18
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
parent: 5383
goal: standalone-gap
assignee: ttraenkler/senior-dev
created: 2026-09-18
loc-budget-allow:
  # 2026-09-18 (#6631, S45b) — the fix is a single per-call-site substitution
  #   in `emitVecToVecBody` (type-coercion.ts): route the externref -> $AnyValue
  #   vec-element widen through `ensureAnyFromExternHelper` (the existing #3055
  #   classifier) instead of the generic `coerceType` -> `boxToAny` default,
  #   scoped to exactly the heterogeneous-primitive-union array-literal widen.
  #   No new file; the mechanism it calls already exists in any-helpers.ts.
  - src/codegen/type-coercion.ts
---

> Claim-ref contention (2026-09-18, heavy fleet load): `claim-issue.mjs 6631
> ttraenkler/senior-dev --branch issue-5383-standalone-temporal-s45b` failed 3x
> with exit 5 (nothing written — "push rejected… someone else moved the ref")
> even at `CLAIM_MAX_RETRIES=30`. `--check 6631` read UNASSIGNED before this
> work started. Re-attempt before merge; if 6631 collides on `main`, renumber
> per the #6602 precedent above and note it here.

## Problem (S45 finding, S45b fix)

Under `--target standalone` (native strings), an array literal that mixes a
string with a non-string primitive corrupts the `$AnyValue` **tag** of every
element — not just the visibly-wrong one:

```ts
const row = ["x", 1976];
typeof row[1]; // "string" — WRONG, should be "number"
"" + row[1]; // "1976" — the VALUE survived; only the tag was wrong
```

S45's reduction (`.tmp/s45/probe10.mts`, carried into this branch's
`.tmp/s45b/probe10.mts`) narrowed this to a single-module repro and named the
two Temporal test262 files it explains:
`test/built-ins/Temporal/PlainDate/from/argument-object-valid.js` and
`…/argument-string.js`, both failing with `SameValue(«null», «undefined»)`
inside `TemporalHelpers.assertPlainDate` after the corruption travels through
`for (const [input, ...expected] of tests)` destructuring + spread.

## Root cause

`row`'s checker type is `(string | number)[]` — TypeScript's default array
inference for a mixed-primitive literal without `as const`. `resolveWasmType`
(`src/codegen/index.ts`, the `tsType.isUnion()` arm,
`isHeterogeneousPrimitiveUnion`) maps that union to a `$AnyValue`-element vec.
The array LITERAL itself constructs a vec of **raw externref** elements (each
boxed by its own static type — `__box_number` for `1976`, a native-string cast
for `"x"`; `src/codegen/literals.ts`'s string-first / non-string-elem widening
guards, ~5544/~5794). Binding `row` to its declared type then WIDENS that
raw-externref vec into the `$AnyValue`-element vec via
`emitVecToVecBody` (`src/codegen/type-coercion.ts`), whose per-element
coercion called the generic `coerceType(externref, $AnyValue)` →
`boxToAny` (`src/codegen/value-tags.ts`).

`boxToAny`'s externref arm, under the `undefinedSingleton` regime (always
active in standalone), calls `__any_box_extern_s1`
(`src/codegen/any-boxing-helpers.ts`) — a **deliberately partial** classifier:
it only honestly recovers `null` (tag 0) and the `UNDEF_F64`-sentinel
`$BoxedNumber` (tag 1, "undefined"). Every OTHER externref — including an
utterly ordinary `$BoxedNumber` holding `1976`, or a `$BoxedBoolean` — falls to
its documented fallback: the #1888 "box the externref as tag-5 string" lie.
That default is intentional there (its own comment records a −788/−794
standalone-pass regression from a prior attempt to make it universally
honest), so **`boxToAny`'s shared default must not change**.

#3055 already solved the identical problem for the `===`/`==` operand seam
(`src/codegen/coercion-engine.ts`'s `emitAnyEqOperands`) by calling
`ensureAnyFromExternHelper(ctx)` (`src/codegen/any-helpers.ts:520`,
`__any_from_extern`) **at that one call site** instead of going through
`boxToAny`. That helper classifies `$BoxedNumber`/i31 → tag 3, `$BoxedBoolean`
→ tag 4, BEFORE falling back to tag 5 — even in its non-`forceHonest` mode — so
it recovers every tag the array-literal widen can produce.

## Fix

`emitVecToVecBody` (`src/codegen/type-coercion.ts`, the per-element copy loop
used for every vec→vec projection, not just array literals): when the source
element is a raw `externref` and the destination vec's element type is
`$AnyValue` (`isAnyValue(dstVec.elemType, ctx)`), call
`ensureAnyFromExternHelper(ctx)` directly instead of the generic `coerceType`.

```ts
} else if (
  needsCoerce &&
  srcKind === "externref" &&
  isAnyValue(dstVec.elemType, ctx) &&
  ensureAnyFromExternHelper(ctx) !== undefined
) {
  fctx.body.push({ op: "call", funcIdx: ensureAnyFromExternHelper(ctx)! });
} else if (needsCoerce) {
  coerceType(ctx, fctx, readElemType, dstVec.elemType);
}
```

**Scoping, matching #3055's own per-site discipline (do NOT flip the global
default):**

- `ensureAnyFromExternHelper` returns `undefined` when
  `ctx.targetProfile.semanticProviders !== "native-first"` — i.e. it is a
  no-op for `gc`/js-host targets, so this arm can never fire there and that
  lane stays byte-identical (confirmed: the `--target gc` control in the
  witness test below reaches the SAME `coerceType` path as before this PR).
- The substitution is scoped to `emitVecToVecBody`'s externref→`$AnyValue`
  element widen specifically (gated on `srcKind === "externref"` AND
  `isAnyValue(dstVec.elemType, ctx)`) — every other `coerceType` call site
  in the compiler (including the ones `boxToAny`'s own tag-5 default still
  serves) is untouched.
- `boxToAny`'s externref arm and `__any_box_extern_s1` are **not edited** —
  the −788/−794 regression risk lives entirely in that shared default, and
  this fix never reaches it for the corrected code path.

## Witness — `tests/issue-6631-mixed-array-element-typeof-tag.test.ts`

9 tests (single-module `compileMulti` + `instantiateLinkedProject`, no
harness): 5 fix-witnessing (fail on base, pass on fix — `typeof` on the number
element, the string element, the boolean element, a for-of destructure +
spread rest element, and the `typeof === "number"` strict-eq control), 4
controls that already passed on base and still pass on fix (all-string array,
all-number array, the raw string-concat value check, and `--target gc`
byte-identity). Base-revert (file-copy A/B, `.tmp/s45b/type-coercion.{base,fix}.ts`)
confirmed 5/9 failing on base, 4/9 passing (the controls) — exactly the
predicted split.

```
npx vitest run --maxWorkers=2 tests/issue-6631-mixed-array-element-typeof-tag.test.ts
# 9 passed (9) on fix; 5 failed / 4 passed on base revert
```

## Real-corpus proof

Two named Temporal rows, base vs fix:

- `test/built-ins/Temporal/PlainDate/from/argument-object-valid.js`
- `test/built-ins/Temporal/PlainDate/from/argument-string.js`

(see `## S45/S45b findings` on #5383 for the run output and the criterion-4
four-family / must-not-move battery against the S44b NEW-base TSVs.)
