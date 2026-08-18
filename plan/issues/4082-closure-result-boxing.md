---
id: 4082
title: "borrowed native-proto methods returning i32 skip result boxing — `local.set` gets a raw i32 and the module fails validation"
status: done
sprint: 78
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/H-crashes
created: 2026-08-02
completed: 2026-08-02
---

## Problem

Borrowing a native-prototype method onto another object and calling it —
`obj.test = RegExp.prototype.test; obj.test("…")` — emits a module that
**fails Wasm validation**:

```
__call_fn_method_0 failed:
  local.set[0] expected type externref, found call_ref of type i32
```

The module never instantiates, so the whole file's assertions are lost.

Measured on the standalone lane (baseline row timestamp `2.8.2026, 03:32`;
ES5+untagged goal scope 8,545 run / 6,298 pass / 0 unopenable): **12** of the
53 goal-scope `invalid Wasm binary` files — 11 × `RegExp/prototype/test/
S15.10.6.3_*` plus `Object/getOwnPropertyDescriptor/15.2.3.3-4-166.js`.

Third distinct mechanism inside that one signature, after #4077 (`ref.null`
arg mis-pairing, 28 files) and #4079 (i32-slot global `++`, 8 files).

**Closes #4081 as well.** That issue is the same mechanism, filed from this
agent's own mid-investigation handoff before it finished the work; #4081 is the
finding, this is the fix. #4081 is set `done` here so it cannot be dispatched
to a second agent. Its "next place to look: `closed-method-dispatch.ts`" lead
was wrong and is corrected there.

## Root cause

`__call_fn_method_N` returns **externref**. Every dispatch arm therefore has to
lower its `call_ref` result to externref, and until now each arm carried its
own copy of that decision.

The #3992 transferred-native-proto arm
(`src/codegen/closures/transferred-native-proto.ts`) copied the generic arm's
`call_ref` but **not** its boxing:

```wat
call_ref $sig          ;; RegExp.prototype.test -> i32
local.set $resultSave  ;; $resultSave is externref   <-- invalid
local.get $prevThis
global.set $__current_this
local.get $resultSave
return
```

The missing half was **asserted in a comment instead of in code**. That
function's own doc block read:

> Stack balance: each arm pushes exactly one externref (the `call_ref` result)
> and immediately sinks it into `resultSaveLocal`

which is true only for reference-returning closures. `RegExp.prototype.test`
returns i32 (boolean), so the claim was simply false for it, and nothing
checked. An invariant that exists only as prose is not an invariant.

Both generic arms in `closure-exports.ts` (lines ~554 and ~907 pre-change) did
box correctly, via two byte-identical 30-line if-chains. So the shape is the
same one #3989, #4077 and #4079 all had: **a decision that must hold in
several places, duplicated rather than shared, where the newest copy is the
one missing a case.**

This is the **fourth** instance of #4080 in one cluster, and the sharpest: the
invariant was not merely absent from the newest copy, it was written there as
a **comment** (*"each arm pushes exactly one externref"*) in the copy that did
not implement it. Prose cannot be checked; the other three instances at least
failed silently rather than asserting their own correctness.

### What this refutes

The obvious hypothesis — given the previous two fixes — was that
`entry.returnType` (a recorded signature) disagreed with `entry.funcTypeIdx`
(the type `call_ref` actually uses), especially since the collector reads the
ground-truth `funcTypeDef` for the *self* param three lines above. That was
instrumented rather than assumed:

```
[RETTYPE] funcTypeIdx=113 recorded={"kind":"i32"} actual={"kind":"i32"}
```

**They agree.** The recorded type was correct and simply never consulted by
that arm. Not a stale-metadata bug.

## Fix

`buildClosureResultBoxing(ctx, returnType, boxNumberIdx)` in
`closure-exports.ts` now owns the call_ref-result → externref decision for the
whole ABI. Both generic arms are re-pointed at it (behaviour-identical: the
old fall-through-emitting-nothing case becomes an empty instruction list, and
the null-returnType case still emits `ref.null.extern`), and the
transferred-native-proto arm receives it as a `boxResult` callback — passed in
rather than imported, because `closure-exports.ts` already imports that
module.

`TransferredNativeReceiverEntry` gains `returnType`, taken from the same
`closureInfoByTypeIdx` record the generic arms use and measured above to match
the emitted func type.

## Measurements

Row timestamp `2.8.2026, 03:32` · corpus `test262-standalone-current.jsonl`
(loopdive/js2wasm-baselines) · official 43,505 run / 25,995 pass (59.75%) ·
goal scope 8,545 run / 6,298 pass (73.70%) / **0 unopenable**.

| stage      | count | note                                                      |
| ---------- | ----: | --------------------------------------------------------- |
| population |    53 | goal-scope `invalid Wasm binary`                          |
| mechanism  |    12 | `local.set[0] expected externref, found call_ref of i32`  |
| reachable  |    12 | all compile; the crash is at instantiate                  |
| **flips**  |     9 | `runTest262File`, `--target standalone`, run **serially** |

**Kill-switch control** — same 12 files, same runner, both touched files
reverted to their `HEAD` versions: **12 fail / 0 pass**. With the fix:
**9 pass / 3 fail**.

**Regression control** — deterministic seeded sample of 500 goal-scope files
the baseline records as `pass`, run with the fix: **496 pass / 4 fail**. The 4
were re-run with both touched files reverted and **failed identically**
(3 strict-mode negative tests plus one `js2wasm:runtime-eval` host-import case
that `runTest262File` does not gate the way the CI path does).
**Attributable regressions: 0 / 500.**

## KNOWN RESIDUAL — this fix removes the crash, not every wrong answer

**Tracked as #4083.** Measured and stated deliberately, because it is the
uncomfortable half — a loud→quiet trade is acceptable when it is *recorded*,
and unacceptable when it is absorbed.

For the shape `var re = /a/; re.borrowed = RegExp.prototype.test;
re.borrowed("banana")`:

| | result |
| --- | --- |
| base (`HEAD`) | `CompileError` — module never instantiates |
| with this fix | validates and runs, but the call answers **`null`** |

So the change converts a loud crash into a **silently wrong value** for that
shape. The cause is NOT the new boxing — a trace shows the arm selecting
`f64.convert_i32_s ; call $__box_number`, which cannot produce `null`. The
arm's exact-identity guard simply does not match this receiver at runtime, so
the outer dispatch falls through to its `ref.null.extern`. That is a **#3992
coverage gap** which the crash previously masked; this fix makes it
observable rather than causing it. The file's own #3992 doc block already
records `null` as the symptom of that gap.

Shipping anyway is justified by measurement, not by preference: 9 of the 12
files flip to **pass with their real assertions checked** (they assert a
`TypeError` on a non-RegExp receiver, and the probe confirms a genuine
`TypeError` is thrown), and there are 0 attributable regressions in 500. The
`null` case was already broken — as a crash — so nothing regressed. The
follow-up — widening the #3992 arm's receiver matching — is tracked as
**#4083**, and is NOT asserted as correct in the tests here, because pinning
the wrong value would freeze the bug. The fourth test in
`tests/issue-4082-closure-result-boxing.test.ts` records only that the module
is well-formed, and is the place #4083 should upgrade to a real value
assertion.

## Residual

Goal-scope `invalid Wasm binary` after #4077 (28), #4079 (8) and this (12):

- 2 `local.set expected (ref null 6), found struct.get of type i32`
- 2 `type error in fallthru`
- 1 `any.convert_extern expected externref, found if`
