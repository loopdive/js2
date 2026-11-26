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

## Implementation Plan (2026-11-26, draft: needs the lead's decision D1)

**Builders that compute a result length** (all in the native-string prelude, `ensureNativeStringHelpers`):

- `__str_concat` (`native-strings-basics.ts`), which `+`, `String.prototype.concat`, templates and join reach;
- `__str_concat_owned` (the IR owned-append fast path), plus `__str_buf_next_cap` and the legacy #1210
  string-builder growth (`string-builder.ts`), which `+=` builder loops reach;
- the batched `concat_many` helpers (`native-batched-concat.ts`), to be confirmed: they may call `__str_concat`;
- `__str_replace` / `__str_replaceAll` (`native-strings-rewrite.ts`), result sizing.

**D1, the decision: where the throw lives.** The prelude is throw-free today. #7442 kept its checks in lazy providers
for that reason: a throw registers the error constructor (a late import on the JS target, the in-module constructor in
standalone) and the exception tag.

- **(A) One guard in the prelude.** `__str_check_length(len: i32)` (or its sum form) throws `Invalid string length` when
  the length exceeds `NATIVE_STRING_MAX_LENGTH`. Each kernel above calls it once, at the point where it computes the
  result length.
  - One site per kernel and no call-site changes; the cost is one compare per concat.
  - **Bytes change in every module that emits the string prelude**: the guard function, the constructor or import,
    and the tag. The size of that will be measured on the usual 100-file sample before I code it.
- **(B) Lazy checked providers.** Like #7442's pad provider: a `…_checked` wrapper per kernel, materialized on first
  use, with every call site switched to it.
  - Bytes change only in modules that concatenate, but that is nearly every module that uses strings.
  - About 60 `__str_concat` references and the IR concat resolver arms would have to switch, plus one more call per
    concat.

**Recommendation: (A).** One guard and one call per kernel. B's byte scope is about the same in practice (concat is
everywhere strings are), with far more sites and a wrapper call on the hottest string path.

**Under either option:**
- The guard reuses #7460's message and limit. With (A), `buildNativeStringLengthCheck` becomes the body of the prelude
  guard instead of a second copy.
- `.length` of a string built before the check (none, once every builder checks) needs no change.
- Join is Session B's area (arrays). It is covered through `__str_concat` without touching array code; if it has its
  own sizing, I tell the lead first.

**Acceptance.**

- Every row of the table throws `RangeError` on gc and standalone, default and legacy, pinned by a test that fails on
  main.
- Below the limit, results are unchanged (the existing string suites and `tests/issue-7442-*`).
- Bytes: under (A), the measured per-module growth is stated, and modules without strings are identical. Under (B),
  only concatenating modules change.
- Quality: one limit, one message, one check builder (#7460's), one guard call per kernel; no per-call-site copies.
