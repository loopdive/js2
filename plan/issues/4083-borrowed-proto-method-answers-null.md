---
id: 4083
title: "borrowed native-proto method answers `null` when the #3992 exact-identity receiver guard misses — a loud crash traded for a quiet wrong value"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
created: 2026-08-02
---

## Problem

A native-prototype method borrowed onto a receiver that the #3992
transferred-native-proto dispatch arm's **exact-identity guard does not match**
returns **`null`** instead of its real value.

Exact repro (standalone target):

```js
var re = /a/;
re.borrowed = RegExp.prototype.test;
re.borrowed("banana"); // → null, should be true
```

Measured with a probe export that distinguishes `true` / `1` / `false` / `0` /
`undefined` / `null` by identity: the call answers **`null`** for both a
matching and a non-matching input (`re.borrowed("zzz")` is also not `false`).

A **direct** call on the same object is correct — `re.test("banana") === true`
and `re.test("zzz") === false` — so the boxers exist and work. Only the
borrowed path is wrong.

## This was a CRASH before #4082, and is a silent wrong value after it

| | `var re = /a/; re.borrowed = RegExp.prototype.test; re.borrowed("banana")` |
| --- | --- |
| before #4082 | `CompileError: local.set[0] expected type externref, found call_ref of type i32` — module never instantiates |
| after #4082 | module validates and runs, answers **`null`** |

So #4082 traded a **loud** failure for a **quiet** one on this shape. That is a
real diagnosability regression and this issue exists so it is *recorded rather
than absorbed*.

It is **not** an outcome regression: the shape was already broken (as a crash),
and no test moves from pass to fail. #4082 was shipped on that basis, together
with 9 verified test262 flips whose real assertions were checked.

## Root cause — NOT the #4082 boxing

Ruled out by tracing rather than by argument. The #4082 boxing selects:

```wat
f64.convert_i32_s
call $__box_number
```

which cannot produce `null`. The `null` comes from the **outer dispatch**: the
#3992 arm's exact-identity guard (a `ref.test` on the per-(brand, member) META
subtype, followed by a field-3 `bfnid` equality re-check) does not match this
receiver at runtime, so control falls through every arm to the trailing
`ref.null.extern`.

`src/codegen/closures/transferred-native-proto.ts`'s own #3992 doc block
already names this symptom:

> had its arguments shifted one slot left (`thisValue` received `arg0`) and
> answered a silently **WRONG** value (measured: `null`), rather than throwing.

#3992 fixed that for the shapes its guard matches. This issue is the remaining
coverage gap: the guard is too narrow, and the crash was previously masking it.

## Why no test pins the current value

#4082 deliberately did **not** assert `null` anywhere. A test asserting the
wrong value would freeze the bug and manufacture exactly the vacuous pass this
issue is about; its fourth test records only that the module is *well-formed*,
with no correctness claim. That test is the natural place to add the real
assertion once the guard is widened.

## Acceptance criteria

- `var re = /a/; re.borrowed = RegExp.prototype.test; re.borrowed("banana")`
  answers `true`, and `re.borrowed("zzz")` answers `false` — asserted **by
  value and by identity** (`=== true` / `=== false`, not truthiness, so a
  number `1` does not pass).
- The residual-shape test in `tests/issue-4082-closure-result-boxing.test.ts`
  is upgraded from "validates" to the real value assertion.
- No new `ref.null.extern` fallthrough is reachable for a receiver that
  structurally carries the borrowed method.

## Notes for whoever takes it

- The guard lives in `collectTransferredNativeProtoReceivers` /
  `buildTransferredNativeProtoCallInstrs`
  (`src/codegen/closures/transferred-native-proto.ts`).
- The collector requires BOTH `nativeProtoReceiverClosureStructTypes` and
  `builtinFnMetaByTypeIdx` membership; the arm then re-checks field 3 against
  the literal `typeIdx`. One of those three conditions is what a regex-literal
  receiver fails — establish which **by measurement** before changing any of
  them, since narrowing exists deliberately (the shared base wrapper must not
  capture every structurally equal closure).
- Related: #4080 (duplicated emission sequences where one copy carries the
  type handling and another does not) — #4082 was the fourth instance.
