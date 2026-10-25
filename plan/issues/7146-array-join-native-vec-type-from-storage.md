---
id: 7146
title: "Native-first: compileArrayJoinNative uses the checker's vec type instead of the storage vec type (invalid wasm on for…in keys)"
status: done
completed: 2026-10-25
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [6899, 2787, 6708]
---

# #7146 — Native-first: compileArrayJoinNative uses the checker's vec type instead of the storage vec type (invalid wasm on for…in keys)

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `control/12-for-in-object.js` went `match → compile_error — `Compiling function #57`
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`control/12-for-in-object.js`: compile_error — `Compiling function #57:"__module_init" failed: local.tee[0] expected type (ref null 42), found ref.as_non_null of type (ref 2)`

## Cause (as diagnosed; verify before fixing)

`keys.sort().join(",")` on `const keys = []` filled by `for…in`: the storage vec is type 2 (externref elements); `__arr_sort_noop` (array-methods.ts ≈9113) keeps type 2; `compileArrayJoinNative` (array-methods.ts ≈5810, `__njoin_vec` local at ≈5875) takes the checker-derived `string[]` vec type 42, so `local.tee __njoin_vec` receives a `(ref 2)`.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `const keys = []; for (const k in {b:1,a:2}) keys.push(k); console.log(keys.sort().join(","))` on gc native-first; dump WAT.
2. In `compileArrayJoinNative`, derive the vec type from the receiver's *lowered* value type (the same source `__arr_sort_noop` and `push` use — look for the evolving-array / element-evidence helper in `array-element-inference.ts`) instead of the checker's declared element type; if the two disagree, prefer storage and insert the element coercion at read time (string element read from externref storage).
3. Audit the sibling native array methods that take `__n*_vec` locals (`indexOf`, `includes`, `slice`, `concat`, `reverse`) for the same checker-vs-storage source and fix them in the same commit if the same helper is used; otherwise list them here as follow-ups.
4. Equivalence test with `for…in`-filled, `push`-grown and literal arrays joined; WAT assertion that the join's vec local type equals the storage type.

Acceptance: `npx tsx scripts/diff-test.ts` row for `control/12-for-in-object.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7146-*.test.ts` pins the
case on standalone and gc.

## Resolution (2026-10-25)

probe/test reference: `tests/issue-7146-array-join-vec-type.test.ts` (WAT pin: the join's `__njoin_vec` local has the receiver global's storage type, gc native-first + standalone) and `tests/equivalence/issue-7146-sorted-array-join.test.ts` (both lanes vs native JS).

**Root cause (verified).** The vec type is not chosen in `compileArrayJoinNative`; it is chosen by
the dispatcher `compileArrayMethodCall`, which normally reads the receiver's lowered type (identifier
local/global slot, else a transactional probe-compile) and overrides the checker's `vecTypeIdx`. For
`join`/`toString`/`toLocaleString` under native strings it skips that whole step when the receiver is a
closure-producing array call (`receiverIsClosureProducingArrayCall` — closure registration is not
transactional, #2074/#2075), and `sort` is on that list. So `keys.sort().join(",")` kept the checker's
`string[]` vec (type 42) while `keys` is stored as `$__vec_externref` (type 2). It only fires at top
level: inside a function the checker types the module-level evolving array as `any[]`, which already
maps to the externref vec.

**Fix.** `x.sort(...)` sorts in place and returns `x`, so under the skip the dispatcher now reads the
storage type off `x`'s own slot (fast path only — no probe compile, so no closure re-registration).
No element coercion is needed: the existing externref-element arm of `compileArrayJoinNative` already
stringifies boxed elements. `sortedIdentifierOf` and the moved `receiverIsClosureProducingArrayCall`
live in `array-join-element.ts` (array-methods.ts net −13 LOC).

**Sibling audit.** `indexOf`, `includes`, `slice`, `concat`, `reverse` get their vec from the same
dispatcher but are never in the probe skip (it is gated on `join`/`toString`/`toLocaleString`), so they
already read storage; covered by equivalence rows (`keys.reverse().join()`, `keys.slice(1).join()`,
`keys.concat([…]).join()`, `keys.sort().indexOf(…)`, `keys.sort().includes(…)`). No follow-up needed.

**Follow-up (not fixed here, needs an id).** A comparator-less `sort()` on an externref-element vec
is still a no-op on gc native-first and standalone (`__arr_sort_noop`, the #2502 fallback; #3579 fixed
only the host lane): `for (k in {b:1,a:2}) keys.push(k); keys.sort().join()` yields `"b,a"`. The corpus
file matches only because its keys enumerate in order. The tests here use already-ordered keys for
that reason (the comparator row reorders for real).
