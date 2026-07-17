---
id: 3311
title: "G4 — `string[]` push/pop under standalone is a no-op: native-string vec carrier missing from `__vec_push`/`__vec_pop` mutEntries"
status: done
assignee: ttraenkler/senior-dev
created: 2026-07-16
completed: 2026-07-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, standalone
language_feature: arrays
goal: runtime-eval
sprint: current
parent: 2927
related: [2784, 2928, 1584]
---

# #3311 — G4: add the native-string vec carrier to `__vec_push` / `__vec_pop`

Slice **G4** of the #2928 `CallBuiltin` prerequisites
(`docs/architecture/runtime-eval-interpreter.md` §16; #2927 Part-2 audit gap 3).
A **soft** prerequisite of E5 (degrades to `undefined` until landed).

## Problem

The carrier-generic `__vec_push` / `__vec_pop` helpers (built in
`src/codegen/vec-access-exports.ts`; the `mutEntries` filter at line ~414 —
NOT index.ts as the #2927 audit note said) cover only the externref / f64 /
i32 element carriers. The native-string vec carrier (WasmGC
`ref $NativeString` elements, the standalone rep of `string[]`) is not in the
set, so:

- `__vec_push` returns the `-1` unsupported-carrier sentinel → the #2927
  `$__vec_base` brand arm (closed-method-dispatch.ts ~849–917, PR #2592)
  deliberately maps that to `undefined` — so `(a as any).push("x")` on a
  `string[]` is a silent no-op standalone.
- `__vec_pop` returns `null.extern` (`undefined`) for the same receivers.

No regression was introduced by #2592 (it was already broken — the old
fall-through also returned `undefined`); this issue is the actual fix.

## Implementation plan (distilled)

1. In `vec-access-exports.ts`, extend the `mutEntries` element-kind filter
   (~line 414) to admit the native-string carrier
   (`ref_null ctx.nativeStrTypeIdx` elements).
2. In the `__vec_push` fill (~line 485–520): the incoming externref value for
   a string carrier converts `any.convert_extern` + `ref.cast $NativeString`
   before `array.set` (mirror the f64/i32 arms' unbox step; the boxed side is
   already a `$NativeString` under nativeStrings — no numeric unbox).
   Grow-and-append logic is carrier-generic already.
3. In the `__vec_pop` fill: the popped `ref $NativeString` element boxes back
   via plain `extern.convert_any` (anyref subtype — no `__box_number`).
4. Also check `__vec_get`/`__vec_set`/`__vec_len` for the same carrier gap
   while in the file (the read guards at ~377 may already cover it — verify,
   don't assume).
5. Tests: standalone `const a: any = ["a","b"]; a.push("c")` → returns 3,
   `a[2]==="c"`, `a.length===3`; `a.pop()==="c"`; 0 function imports asserted.

## Acceptance criteria

- [x] `string[]` push/pop via the any-receiver brand arm works standalone
      (values, length, return values correct; host-free).
- [x] The `-1` sentinel path still returns `undefined` for genuinely
      unsupported carriers (no bogus boxed `-1` length).
- [x] Existing #2927 push/pop suite (`tests/issue-2927-standalone-any-push-pop.test.ts`)
      stays green.

## Notes

Filed under #2784 lineage per the #2927 audit ("fix belongs in the
`__vec_push`/`__vec_pop` carrier set, not the brand arm"). Umbrella:
#2927 → #1584.

## Implementation notes (senior-dev)

**Root cause precision.** The audit note's "`ref $NativeString` elements" is
imprecise: a `string[]` under `nativeStrings` lowers to a vec whose backing
array element type is `(ref null $AnyString)` — the `$AnyString` *supertype*
that covers flat native strings, cons strings, and slices — registered with
the `vecTypeMap` key `ref_<anyStrTypeIdx>` (native-strings.ts:1218,
native-strings-rewrite.ts:565), **not** `nativeStrTypeIdx`. The fix keys on
`ref_<anyStrTypeIdx>` and casts to `anyStrTypeIdx`, so all three string reps
round-trip.

**Why the gap was push/pop-only.** `__vec_get` already handles this carrier:
its non-externref, non-numeric `else` arm boxes `array.get` → externref via
`extern.convert_any`, and the element `(ref null $AnyString)` is an anyref
subtype, so reads worked. `__vec_len` reads field-0 (i32) generically, and
`__vec_set_len` grows via `array.new_default` (nullable-ref-safe). Only the
three **value-marshaling** sites needed a carrier arm:
1. `__vec_push` `valueInstrs` — recover the GC string ref from the externref
   value: `any.convert_extern` + `ref.cast_null $AnyString` before `array.set`
   (no numeric unbox — the boxed side is already a GC string ref). `ref.cast_null`
   (not `ref.cast`) matches the nullable element type and tolerates a pushed
   `null`/`undefined`.
2. `__vec_pop` `boxInstrs` — box the popped element straight back with
   `extern.convert_any` (anyref subtype; no `__box_number`).
3. `__vec_set_elem` (`vec-define-writeback.ts`) `valueInstrs` — **critical**:
   this consumes the same `mutEntries`, and its default arm does
   `__unbox_number` + `i32.trunc` → an i32 into a `(ref null $AnyString)` array =
   **invalid Wasm**. Any module with BOTH a `string[]` and `Object.defineProperty`
   would fail validation without a native-string arm here. Mirrors push's arm.

`mutEntries` (also feeding `__vec_mut_supported`) admits the carrier when
`nativeStrings && anyStrTypeIdx >= 0`. The new `nativeStrVecKey(ctx)` helper
(exported from vec-access-exports.ts) is the single source of the key across all
sites. The new `ref.test` arm is a sibling type under `$__vec_base`, so it can't
cross-match the existing externref/numeric carriers — order-independent, no
regression to those arms. The `-1` sentinel path is untouched for genuinely
unsupported carriers (e.g. `i64`).

## Test Results

- New `tests/issue-3311-string-vec-push-pop.test.ts` — 8 tests, all pass
  (host + standalone-host-free; push length, append, indexed read+equality,
  repeated push, pop value+equality, pop shrink, push/pop round-trip, typed
  control). Every standalone case asserts **0 function imports**.
- `tests/issue-2927-standalone-any-push-pop.test.ts` — 7/7 still green.
- `array-methods`, `array-prototype-methods`, `issue-1539-standalone-array-coercion`
  — green. (`array-capacity.test.ts` has 4 pre-existing failures unrelated to
  this change — a stale harness missing a `string_constants` import; verified
  identical with these files reverted to base.)
- Writeback validity: a module with both `string[]` and `Object.defineProperty`
  compiles to valid Wasm, host-free.
- `tsc --noEmit` clean.
