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
related: [7442]
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

## Implementation Plan (2026-11-26, v2: answers PRV-7513's blocker on 34b37fcb)

**D1 = (A), decided by the lead on 2026-11-26.** One guard in the native-string prelude, called once where each
kernel computes a result length. No per-call-site wrappers.

**The guard.** `__str_check_length(len: i32) -> i32` returns `len`, or throws `RangeError: Invalid string length`
(#7460's message) when `len` exceeds `NATIVE_STRING_MAX_LENGTH` (2^30).

- It reads `len` **unsigned** (`f64.convert_i32_u` into #7460's `buildNativeStringLengthCheck`), so a sum that wrapped
  past 2^31 counts as too long.
- `len` is in UTF-16 code units under both storages. `--utf8-storage`'s `Utf8String.len` is also the code-unit count
  (`native-strings-core.ts`, `__str_utf8_to_flat`), so one limit covers both.

**Where it is checked: at the length computation, not the allocation (PRV item 5).** A ConsString stores `newLen`
without allocating anything (`string-concat-bodies.ts`, the `newLen >= 64` arm). A check at `array.new` would never see
the rope that carries a wrapped length; the next flatten would then trap or misread it. So the guard sits on the sum.

**Sums cannot wrap past the guard (PRV item 2).** Every string that exists is at most 2^30 code units, because every
builder checks. So one add of two lengths is at most 2^31, which an unsigned read still holds exactly.

- `__str_concat`: one add, then the guard.
- The batched `concat_many` kernel (`buildStringBatchedConcatDefinition`): the guard runs **after each add**. Then
  four 2^30 lengths cannot wrap to 0, because the partial sum is checked before the next add.

**Both emitters (PRV item 1).** The check goes in the shared body builders (`src/runtime/wasmgc/values/string-concat-bodies.ts`),
with the guard passed in as a resource (`checkLengthIdx`, required, not optional).

- **Legacy prelude** (`native-strings-basics.ts`) emits the guard function and passes it to both builders.
- **IR / Prepared** (`src/backend/wasmgc/resources/native-string-output.ts` L330/L338): today its error resources
  (`native-errors.ts`) reserve only a TypeError constructor and tag.
  - The pack gains a RangeError reservation in the same shape as `newTypeError`, and a guard function the pack owns.
  - The concat and batched bodies there get the same `checkLengthIdx`.
  - One error family, two kinds; no second catalog.

**No new host import (PRV item 3).**

- The guard uses the in-module constructor on every target (`forceInModuleCtor: true`).
- The guard is emitted inside `ensureNativeStringHelpers`. That function flushes pending late imports on entry, and
  the guard adds none: no late-import shift happens mid-function, so no flush owner is needed.
- Measured on a minimal `a + b` module, gc: the import list is unchanged (the 3 existing `env` string imports), and so
  on standalone (0 imports).
- `strictNoHostImports` uses the same in-module path. It is pinned by a row in the new test.

**Kernels, completed list (PRV item 4).** Each one gets the guard where it computes a result length:

- `__str_concat` and `concat_many`, as above. `+`, `String.prototype.concat`, templates and `Array.prototype.join` reach
  them; join folds through `__str_concat` via `builtin-scaffold.ts` `emitStringJoinFold`, with no buffer sizing of its
  own, so join needs no array-code change.
- `__str_concat_owned`, `__str_buf_next_cap` and the legacy #1210 string-builder growth (`+=` loops);
- `__str_replace`, `__str_replaceAll` and `__str_getSubstitution` (`native-strings-rewrite.ts`);
- the `JSON.stringify` output length (`json-bodies.ts`, `L_OUTLEN`);
- the regexp-vm replace result (`regexp-vm-arms.ts`).

For each kernel, the PR body names the exact add the guard follows.

**Measured cost (PRV item 7).** Prototype of the guard plus one call in `__str_concat`, base #7460 df9c70c9:

- **100-file test262 sample**, default pipeline. All 83 compiled modules per target already emit the string prelude.
  - gc: +124 to +487 B, median +150 B (+0.06 % of a median 302 KB module).
  - standalone: +131 to +675 B, median +244 B (+0.17 %).
- **Minimal string module** (`f(a, b) { return a + b }`):
  - gc: 13,054 → 38,498 B. Tags 0 → 2, functions 62 → 108, globals 11 → 39, imports unchanged (3).
  - standalone: 11,974 → 32,501 B. Tags 0 → 2, functions 56 → 99, globals 11 → 39, imports 0 → 0.
  - The growth is the error-object runtime that a RangeError needs. The test262 modules already carry it; a minimal
    string module does not. This cost is reported to the lead. **Open: does the lead accept it?**
- **Tests that pin imports, tags or minimal-module bytes:** found by running the prototype through 323 candidate test
  files (the size / prelude / import / tag / recgroup suites, and every test asserting empty imports or byte bounds),
  then comparing failures with base df9c70c9. The list goes here before code.

**Acceptance.**

- Every row of the table throws `RangeError` on gc and standalone, default and legacy, plus a `--utf8-storage` row and
  a `strictNoHostImports` row, pinned by a test that fails on main.
- Below the limit, results are unchanged (the string suites and `tests/issue-7442-*`).
- Bytes: the per-module growth above is listed in the PR; there are no new imports on any target.
- Quality:
  - one limit, one message, one check builder (#7460's);
  - one guard, called once per kernel length computation;
  - the guard passed to the shared body builders as a required resource;
  - no per-call-site copies.
