---
id: 7513
title: "Native strings past 2^31 code units: `+` / concat / templates / `+=` / join give a negative length, replaceAll traps"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
task_type: bug
area: runtime, strings
goal: core-semantics
related: [7442, 7548]
depends_on: [7442]
---

# #7513 — string builders past the native length limit

## Problem

Measured on `origin/main` 1a726b3e (2026-11-26), gc and standalone, default and legacy pipelines, all alike. The
program is `let s = "ab"; for (let i = 0; i < 30; i++) s = s + s;`, which makes `s` 2^31 code units long:

| expression | js2wasm | node |
| --- | --- | --- |
| `s.length` after the doubling | -2147483648 | RangeError (V8's limit is 2^29 - 24) |
| `(s + "x").length` | -2147483647 | RangeError |
| `s.concat("x").length` | -2147483647 | RangeError |
| `` `${s}x`.length `` | -2147483647 | RangeError |
| `t += "x"; t.length` | -2147483647 | RangeError |
| `[s, "x"].join("").length` | -2147483647 | RangeError |
| `s2.replaceAll("a", "aaa")` (`s2` 2^30 long) | `RuntimeError: requested new array is too large` | RangeError |

The concat kernels add two i32 lengths with `i32.add` and keep the wrapped sum. The flat paths then trap in
`array.new`.

#7442 (PR #7460) introduced the shared limit `NATIVE_STRING_MAX_LENGTH` (2^30, `src/ir/core/string-runtime.ts`), the
message `RangeError: Invalid string length`, and the check builder `buildNativeStringLengthCheck`
(`src/codegen/native-string-length-limit.ts`). It applied them to repeat and pad only. This issue applies the same limit
to every remaining builder.

**Scope decided by the lead (2026-11-26): a trap, not yet a RangeError.** A catchable RangeError in the shared kernels
pulls in the error-object runtime: a minimal `a + b` module grows from 13,054 to 38,498 B on gc and from 11,974 to
32,501 B on standalone (measured, prototype of option A). Module size is a tracked product property, so the kernels
trap at the limit, which is never a wrong value and costs almost no bytes. The catchable RangeError is #7548, and it
needs the error runtime shared lazily.

## Implementation Plan (2026-11-26, v3: the trap, per the lead's decision; keeps PRV-7513 items 2, 4, 5 and 6)

**D1 = (A), decided by the lead.** One guard in the native-string prelude, called once where each kernel computes a
result length. No per-call-site wrappers.

**The guard is a named trap.** `__str_check_length(len: i32) -> i32` returns `len`, or runs `unreachable` when `len`
exceeds `NATIVE_STRING_MAX_LENGTH` (2^30), the limit #7460 introduced.

- This is the same mechanism as the abort bodies (`src/ir/abort-bodies.ts`): a bare `unreachable`. The function's
  name is the abort's name in the trap's stack frame.
- It adds no import, no exception tag, no error constructor and no string constant.
- The catchable RangeError is #7548.

**Overflow-safe reads and sums (PRV item 2).**

- The guard compares **unsigned** (`i32.gt_u`), so a sum that wrapped past 2^31 counts as too long.
- Every string that exists is at most 2^30 code units, because every builder checks. So one add of two lengths is at
  most 2^31, which an unsigned compare still holds exactly.
- `__str_concat`: one add, then the guard. The batched `concat_many` kernel (`buildStringBatchedConcatDefinition`): the
  guard after **each** add, so four 2^30 lengths cannot wrap to 0 unseen.

**Checked at the length computation, not the allocation (PRV item 5).** A ConsString stores `newLen` without
allocating (`string-concat-bodies.ts`, the `newLen >= 64` arm). A check at `array.new` would never see the rope that
carries a wrapped length; the next flatten would then trap at `array.new` or misread it.

**Both emitters, through the shared builders (PRV item 1).** The guard is passed to the body builders in
`src/runtime/wasmgc/values/string-concat-bodies.ts` as a required resource (`checkLengthIdx`).

- The legacy prelude (`native-strings-basics.ts`) emits the guard and passes it to both builders.
- The IR / Prepared emitter (`src/backend/wasmgc/resources/native-string-output.ts` L330/L338) owns a guard function in
  its pack and passes it to the same builders. A trap needs no error reservation, so `native-errors.ts` is untouched.
- The guard's body comes from one builder in `string-concat-bodies.ts`, which both emitters call. Its limit comes from
  `NATIVE_STRING_MAX_LENGTH`.

**Kernels, completed list (PRV item 4).** Each gets one guard call where it computes a result length:

- `__str_concat` and `concat_many`, as above. `+`, `String.prototype.concat`, templates and `Array.prototype.join`
  reach them; join folds through `__str_concat` (`builtin-scaffold.ts` `emitStringJoinFold`) and sizes no buffer of
  its own, so no array code changes.
- `__str_concat_owned`, `__str_buf_next_cap` and the legacy #1210 string-builder growth (`+=` loops);
- `__str_replace` and `__str_replaceAll` (replaceAll gets its own call), and `__str_getSubstitution`
  (`native-strings-rewrite.ts`);
- the `JSON.stringify` output length (`json-bodies.ts`, `L_OUTLEN`);
- the regexp-vm replace result (`regexp-vm-arms.ts`).

For each kernel, the PR body names the exact add the guard follows.

**Length unit (PRV item 6).** `len` is in UTF-16 code units under both storages. `--utf8-storage`'s `Utf8String.len` is
also the code-unit count (`native-strings-core.ts`, `__str_utf8_to_flat`), so one limit covers both. The test gets a
`--utf8-storage` row.

**No import, no tag, bytes measured (PRV items 3 and 7).**

- The PR shows the import and tag lists unchanged on gc and standalone for a minimal string module and for the
  100-file sample.
- The PR states the per-module byte growth (expected: the guard function plus one call per kernel).

**Acceptance.**

- Every row of the problem table **traps** (`WebAssembly.RuntimeError: unreachable`) instead of yielding a wrong
  length or the `array.new` trap. This holds on gc and standalone, default and legacy, and in a `--utf8-storage` row,
  pinned by a test that fails on main.
- Below the limit, results are unchanged (the string suites and `tests/issue-7442-*`).
- No new import or tag on any target; the byte growth is measured and listed.
- Quality:
  - one limit (`NATIVE_STRING_MAX_LENGTH`) and one guard builder shared by both emitters;
  - one guard call per kernel length computation;
  - no per-call-site copies.
