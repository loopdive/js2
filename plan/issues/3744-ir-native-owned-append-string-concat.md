---
id: 3744
title: "IR-native fast path for owned-append string.concat (promote #3740's fix into the IR pipeline)"
status: done
created: 2026-07-28
completed: 2026-07-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: performance
area: ir, codegen, strings
goal: performance
language_feature: strings, loops
related: [3740, 1210, 1761, 3741, 3745]
# loc-budget-allow justification: the detector, kill-switch predicate and all
# documentation live in the subsystem module src/ir/string-builder-shape.ts;
# what remains in the two driver files is irreducible wiring — select.ts (+3):
# the `string-builder-candidate` IrFallbackReason union variant, its import,
# and the one-line `stringBuilderForcedLegacy(body)` gate call, which must sit
# in `whyNotIrClaimable`; integration.ts (+7): the `owned-append` dispatch in
# the `emitStringConcat` resolver, which needs the closure-scoped
# `stringBackend` helper table and cannot move out of `makeResolver`.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/integration.ts
# func-budget-allow justification: same irreducible wiring as above —
# `whyNotIrClaimable` gains exactly one line (the kill-switch gate call) and
# `makeResolver` gains the 7-line `owned-append` dispatch, which must live in
# its `emitStringConcat` resolver method because it reads the closure-scoped
# `stringBackend` helper table. The helper emission itself
# (`emitStrConcatOwnedHelper`, ~180 LOC) is a separate function in
# src/codegen/native-strings-basics.ts, under the 300-LOC ceiling.
func-budget-allow:
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/integration.ts::makeResolver
---

# #3744 — IR-native fast path for `owned-append` `string.concat`

## Context

#3740 fixed the landing `string-hash` benchmark's ~24-28x regression by
making the IR selector gate (`whyNotIrClaimable`) defer functions containing
the `let s = ""; for (...) s += <expr>` shape to legacy codegen, which
already has the #1210 string-builder / #1761 presize rewrite. That issue's
"Non-goals" section flagged the obvious follow-up: teach IR itself the
optimization instead of just working around its absence.

## Finding: the front end already has the proof, the backend ignored it

`src/ir/from-ast.ts`'s `collectOwnedStringAppendSymbols` (used by
`lowerCompoundAssignment`) already recognizes exactly this shape and marks
matching `s += <expr>` nodes with `concatMode: "owned-append"` on the IR
`string.concat` instruction — a formal proof that `s`'s prior value is never
observed again, licensing an in-place mutation instead of an immutable
combine. But `src/ir/integration.ts`'s `emitStringConcat` resolver
implementation took **zero** parameters and always called the general
`__str_concat` helper regardless of mode — the `owned-append` proof was
computed and then silently discarded.

## Fix

- **`src/codegen/native-strings-basics.ts`**: new WasmGC helper
  `__str_concat_owned(lhs: ref $AnyString, rhs: ref $AnyString) -> ref
  $AnyString`, added inside `emitStrConcatHelpers` (needs `__str_flatten`
  and `__str_buf_next_cap`, both already registered by that point). Flattens
  both operands (cheap identity when already flat), then:
  - if `lhs`'s backing array has spare capacity beyond its own recorded
    length AND its byte-offset is 0: writes `rhs`'s code units directly into
    the tail of the SAME backing array (`array.copy`) and wraps a fresh,
    cheap `struct.new $NativeString(newLen, 0, sameArray)` — no array
    allocation at all.
  - otherwise: grows via `__str_buf_next_cap` (geometric doubling, the same
    helper #1210's legacy rewrite already uses) and copies both operands
    into the new array.
  - The result is always an ordinary, fully valid `$NativeString` — every
    existing consumer (length, charAt, equality, return, argument-passing,
    …) works completely unchanged; only the growth strategy differs from
    the general-purpose `__str_concat`.
- **`src/ir/integration.ts`**: `computeStringBackend` also indexes
  `__str_concat_owned` by name (alongside `__str_concat`/`__str_equals`).
  `emitStringConcat` now reads its `mode` parameter and, when
  `mode === "owned-append"` in `nativeStrings` mode, calls the new helper
  instead of falling through to `__str_concat` (falls back safely to the
  general helper if, for any reason, `__str_concat_owned` isn't registered).

## Safety argument for in-place growth

`lhs` reaching this helper is always either the empty-string literal
(capacity 0 → always takes the grow-a-fresh-array branch on the very first
append, so a shared/interned literal's backing array is never written into)
or this same helper's own prior result (a data array WE allocated ourselves,
never shared with anything else). Any earlier struct wrapper over that same
array only ever reads indices below **its own** recorded `len`; writing into
cells at `[lhsLen, newLen)` — strictly past every earlier wrapper's own
length — never changes what an earlier observer would see. The `byteOffset
=== 0` guard defensively routes any genuinely offset/sliced view (not
something this builder chain itself produces) through the safe copy path
instead.

## #3740's gate is now OFF by default — IR claims this shape

Migrated per explicit direction: IR now claims `let s = ""; for (...) s +=
<expr>` functions BY DEFAULT and compiles them through the new
`__str_concat_owned` fast path (verified — no 64-char cons threshold, has
`array.len` — instead of the old `__str_concat`). `JS2WASM_IR_STRING_BUILDER=0`
is a kill switch (same convention as e.g. `JS2WASM_UNION_ANYREP=0`) that
forces this shape back to legacy, kept for A/B comparison and rollback.

Measured trade-off on the actual `string-hash` benchmark (Node WasmGC
engine, no local `wasmtime` available to reproduce the Cranelift-AOT numbers
#1580/#1746/#2619 measured): warm avg dropped from the pre-#3740 ~5.4ms
default-IR baseline to ~3.1ms under this fix alone. **#3741** ("IR path has
no equivalent to legacy's #1120 i32-coerced-local promotion") — an
independent same-day rediscovery of the identical root cause via a
different benchmark (`loop.ts`) — merged into `main` while this issue was in
flight (`#3718`); re-measuring after picking it up via merge narrows it
further to **~1.8ms**. Legacy (forced via `JS2WASM_IR_STRING_BUILDER=0`)
still measures ~0.18ms, so a real, separate gap remains even with #3741's
fix. Disassembly shows why: IR still emits zero `i32.mul` anywhere in `run`
— every bitwise/`| 0` op goes through the #3739 i64-bit-manipulation ToInt32
rewrite instead of native i32 arithmetic, because #3741's inference doesn't
reach this benchmark's specific shapes (two chained bitwise-derived locals
per build-loop iteration; a multiply-then-add hash accumulator). Filed as
**#3745** with the disassembly evidence and a concrete next step. Fully
closing that gap would let this exact benchmark reach legacy parity
entirely through IR, with no gate involved at all.

## Validation

- New test `tests/issue-3744-ir-owned-append-string-builder.test.ts`:
  - confirms IR claims this shape by default;
  - confirms `JS2WASM_IR_STRING_BUILDER=0` forces legacy (kill switch);
  - confirms owned-append output matches the JS reference across several
    geometric-doubling-boundary trip counts (0,1,2,7,8,9,15,16,17,31,32,33,
    63,64,65,100,1000,5000);
  - confirms the *actual* string-hash benchmark source is byte-for-byte
    correct through the new path too (0..20000).
- `tests/issue-1761.test.ts`'s `growCalls` helper counted
  `call $__str_buf_next_cap` **module-wide**, which broke once
  `__str_concat_owned` (unconditionally emitted whenever native-string
  support initializes, same as every other string helper) added its own
  static call to that helper — a false positive unrelated to whether presize
  actually fired in the function under test. Fixed by scoping the count to
  the tested function's own body (`exportedFuncWat`), which is what the
  test's stated intent already was.
- Full `tests/equivalence` suite (1719 tests, run against both the
  pre-migration opt-in state and the final default-on state) and a targeted
  sweep of all 130 `nativeStrings`-referencing test files: no new failures
  (pre-existing environment-specific failures — e.g. a hardcoded
  `/workspace/...wasm-dis` path in `issue-1270.test.ts`, and one pre-existing
  red test in `issue-2682.test.ts` and `issue-2856-builtins-component.test.ts`
  — reproduce identically without this change).
- `pnpm run check:ir-fallbacks`: no change (none of the tracked
  `playground/examples/**` corpus contains this loop shape).
