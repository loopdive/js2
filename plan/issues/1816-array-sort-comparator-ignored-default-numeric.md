---
id: 1816
title: "Array.prototype.sort ignores user comparator; default sort numeric not lexicographic (residual #1361)"
status: done
created: 2026-06-04
updated: 2026-06-05
completed: 2026-06-05
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
parent: 1361
---
# #1816 — `Array.prototype.sort` ignores comparator + wrong default order

Residual of #1361 (marked done, sprint 51): the comparator is still ignored.

## Symptom
- `[3,1,2].sort((a,b)=>b-a)` → `[1,2,3]` (comparator dropped).
- `[10,9,1].sort()` → `[1,9,10]` instead of `[1,10,9]` (default must ToString-compare).

## Location
`src/codegen/array-methods.ts:5781-5816` validates a statically-non-callable
comparator (throws) but otherwise calls `ensureTimsortHelper`
(`src/codegen/timsort.ts`), which takes no comparator and hard-codes
`i32.lt_s`/`f64.lt`. The only test asserts "doesn't throw," masking it.

## Spec
ECMAScript §23.1.3.30 / SortIndexedProperties / CompareArrayElements.

## Fix
Thread the comparator funcref/closure into the sort and invoke via `call_ref`;
in the no-arg case compare by ToString (UTF-16 code units). Add a test that
asserts the resulting order, not just no-throw.

## Resolution (2026-06-04)

`tryCompileComparatorSort` in `src/codegen/array-methods.ts`: when `sort` is
called with a comparator that compiles to a Wasm closure (inline arrow, function
expression, or named-function reference), the receiver is sorted with an in-place
**stable insertion sort** that invokes the comparator closure via `call_ref` at
every comparison, using the spec ordering `comparator(a,b) > 0 ⇒ a sorts after b`
(§23.1.3.30 / CompareArrayElements). The comparator-call convention matches the
other array-method `call_ref` sites: push `__self` (the closure struct) first,
then the two coerced element args, then re-fetch the funcref from struct field 0
and `call_ref`; the f64/typed result is coerced to f64 and compared `> 0`.
A comparator that is not a compilable closure falls back to the prior numeric
Timsort (no error, no regression).

**Scoped to the comparator half.** Two related items are deliberately NOT in this
PR and remain follow-ups:
- **Default no-arg ToString sort** — `[10,9,1].sort()` still uses the numeric
  Timsort (returns `[1,9,10]`, spec wants `[1,10,9]`). Switching the default to
  ToString-compare for numeric WasmGC arrays changes existing-passing behaviour
  and carries broad test262 regression risk; carved to a separate change.
- **`toSorted(cmp)`** (`compileArrayToSorted`) shares the comparator-ignored
  defect and is a parallel follow-up; this issue is specifically about `sort`.

## Test Results (2026-06-04)

`tests/issue-1816.test.ts` (9 tests, all pass): descending/ascending comparator
order, larger-array descending, f64 comparator, named-function comparator,
stability (equal comparator keys preserve input order), in-place return of the
receiver, single/equal-element arrays, and the unchanged numeric default no-arg
sort. Existing `tests/issue-1361.test.ts` (7, comparator non-callable validation)
and `tests/issue-1461.test.ts` (27, array methods) remain green. Verified across
inline-arrow, named-function, and stored-const comparators (the const case falls
back to the default sort — a pre-existing shared closure-resolution limitation
that affects `filter`/`map` identically, not a regression).

## Residual resolved — default no-arg ToString sort (2026-06-05)

The carved-out default-sort half is now implemented (standalone/WASI track).
`tryCompileDefaultLexSort` in `src/codegen/array-methods.ts`: when `sort` is
called with **no comparator** on a numeric (`i32`/`f64`) array in native-strings
mode (standalone/WASI), the default path no longer routes to the numeric
Timsort. Instead it implements §23.1.3.30 SortCompare with `comparefn` undefined:
each element is converted to a String via `number_toString` (ToString) into a
parallel native-string key array, then an in-place **stable insertion sort**
reorders both the data and key arrays in lockstep, comparing keys via the native
`__str_compare` helper (UTF-16 code-unit lexicographic, -1/0/1). So
`[10,2,1].sort()` is now `[1,10,2]` ("1" < "10" < "2"), not the numeric
`[1,2,10]`. Both `number_toString` and `__str_compare` are *ensured* (emitted on
demand) from the sort path, so the fix applies even when the program never
otherwise stringifies a number.

`number_toString` returns externref-wrapped native strings; the key array stores
`ref $AnyString`, so each key is bridged via `any.convert_extern` + `ref.cast`.

**Still scoped out (unchanged):**
- **JS-host mode** (non-native-strings, `wasm:js-string` backend) keeps the
  numeric default — the host string API path is a separate follow-up; the gate
  is `ctx.nativeStrings`.
- **`toSorted()`** default ToString order (`compileArrayToSorted` still uses the
  numeric Timsort for the no-comparator case) — parallel follow-up.

### Test Results (residual, 2026-06-05)
`tests/issue-1816.test.ts` extended to 13 tests, all pass: the default no-arg
sort now asserts lexicographic order (`[10,2,1]` → `[1,10,2]`; leading-code-unit
ordering of `[3,20,100,1,11,2]` → `[1,100,11,2,20,3]`; negatives by string order;
single/empty unchanged) alongside the existing comparator-half tests, which
remain green (no regression to the comparator path).

