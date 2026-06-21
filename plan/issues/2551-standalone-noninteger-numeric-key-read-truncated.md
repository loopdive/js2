---
id: 2551
title: "standalone: computed non-integer numeric-key READ truncates the index (o[1.5] reads key \"1\")"
status: done
sprint: Backlog
goal: standalone-conformance
feasibility: easy
assignee: ttraenkler/dev-2042
completed: 2026-06-20
---

## Problem

In `--target standalone`, a computed READ with a **non-integer numeric literal**
index reads from the wrong property key:

```ts
const o: any = {};
o[1.5] = 4;
return o[1.5]; // → 0 (should be 4)
```

The **store** is correct: `o[1.5] = 4` keys the value under the canonical decimal
string `"1.5"` (verified: `o["1.5"]` reads it back). The **read** truncates `1.5`
to the integer `1`, stringifies that to `"1"`, and looks up `"1"` — which misses,
returning `0`.

Confirmed via probes (all on clean `origin/main` HEAD 0df91ffa3):

| expression | before | after fix |
|---|---|---|
| `o[1.5]=4; o[1.5]` | 0 | 4 |
| `{"1.5":4}; o[1.5]` | 0 | 4 |
| `o["1.5"]=4; o[1.5]` | 0 | 4 |
| `o["1"]=9; o[1.5]` | 9 (wrong alias) | 0 |
| `o[3]=7; o[3]` (integer) | 7 | 7 |
| `Object.values(o)[1]` ($ObjVec) | 20 | 20 |

This was surfaced by the pre-existing failing assertion in
`tests/issue-2042.test.ts` — `"non-integer numeric key uses canonical decimal
string"` (`o[1.5]=4; return o[1.5]` expected 4, got 0). The assertion was
**correct**; the codegen was wrong.

## Root cause

`src/codegen/property-access.ts` `compileElementAccessBody` routes a *provably
numeric* index on a standalone externref through `__extern_get_idx(v, f64)`
(#2166 PR-C2). For an array-like `$Object`, `__extern_get_idx`'s `$Object` arm is
supposed to delegate to `__extern_get(v, ToString(idx))` with the **canonical
decimal** key. But the arm truncated first:

`src/codegen/object-runtime.ts` `buildExternGetIdxBody` (and a dead duplicate of
the same arm inline in `ensureObjectRuntime`):

```
{ op: "local.get", index: 1 },   // idx (f64), e.g. 1.5
{ op: "f64.trunc" },             // → 1.0   ← BUG
{ op: "call", funcIdx: number_toString },  // "1" instead of "1.5"
{ op: "call", funcIdx: __extern_get },     // __extern_get(o, "1") → miss
```

`ToPropertyKey` of a numeric index is `ToString(idx)` (ECMA-262 §7.1.19
ToPropertyKey → §7.1.17 ToString → §6.1.6.1.20 Number::toString) — **no
truncation**. The `f64.trunc` is correct for *positional* `$ObjVec`/typed-vec
reads (those use a separate `i32.trunc_sat_f64_s` to index the backing array),
but it is wrong for the string-keyed `$Object` delegation, where the index must
stringify to its full canonical decimal to match how the store (`__extern_set` →
`__to_property_key` → `number_toString(__unbox_number(key))`) keyed it.

## Fix

Drop the `f64.trunc` from the `$Object` array-like arm in `buildExternGetIdxBody`
(`src/codegen/object-runtime.ts`). `number_toString` is canonical
`Number::toString`, so an integer index still yields `"3"` (positional/array
reads unregressed), while `1.5` now yields `"1.5"` and matches the store.

Also removed a dead, never-referenced duplicate of the same arm
(`const objIdxArm` built inline at the `__extern_get_idx` registration site — the
body is built by `buildExternGetIdxBody`, so the inline copy was unused and
carried a second buggy `f64.trunc`).

Net: `src/codegen/object-runtime.ts` −24/+12 lines.

## Tests

- `tests/issue-2551.test.ts` (new) — 7 cases: non-integer round-trip (numeric,
  literal-key, string-key store), the non-aliasing guard (`o["1"]` must NOT be
  read by `o[1.5]`), integer-read no-regression, integer-literal-key read,
  `$ObjVec` positional read no-regression. All pass.
- `tests/issue-2042.test.ts` — the previously-failing `"non-integer numeric key
  uses canonical decimal string"` assertion now passes; all 14 pass.

## CI coverage gap (noted for follow-up)

`tests/issue-NNN.test.ts` files are **NOT run by the required CI gates** — the
`quality` job (ci.yml) and the test262-sharded gates do not invoke the per-issue
vitest suites, so a red `issue-2042.test.ts` (and `issue-2036.test.ts`, see
below) sat green in CI on `main`. This is why a real codegen bug went unnoticed.

Separately observed while validating: `tests/issue-2036.test.ts` has **5
pre-existing failures** on clean `origin/main` (`#2036 S6 step 1 — borrowed
search/result-building methods refuse loudly in standalone`: `indexOf`,
`lastIndexOf`, `includes`, `reduce`, `reduceRight` no longer compile-error). Same
CI-coverage gap; unrelated to this fix (the failures reproduce with this change
reverted). Flagged to the tech lead for a separate triage — these assert a
*refusal* that no longer happens, so either the feature was implemented and the
tests are stale, or a refusal regressed silently.

## Spec references

- ECMA-262 §7.1.19 ToPropertyKey
- ECMA-262 §7.1.17 ToString
- ECMA-262 §6.1.6.1.20 Number::toString ( x, radix )
