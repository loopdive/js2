---
id: 4081
title: "`__call_fn_method_N` has a THIRD dispatch arm that inlines save-result/restore-`__current_this`/return without the i32 boxing the other two arms do — 12 files"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
assignee: ttraenkler/H-crashes
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
related: [4077, 4079, 4080]
---

# A third `__call_fn_method_N` dispatch arm skips return-type boxing

> **DONE — implemented as #4082 (PR #4011). Do NOT dispatch this issue.**
>
> `H-crashes` handed this over mid-investigation and then finished it in the
> same session, so the finding and the fix ended up in two issue files. This
> one is the finding; **#4082** is the fix and carries the measurements
> (population 53 → mechanism 12 → reachable 12 → **9 flips**; kill-switch
> 12/12 fail; regression control 500 → 496 with 0 attributable).
>
> The emitting site named as "not yet identified" below **was** identified:
> `src/codegen/closures/transferred-native-proto.ts` — the #3992
> transferred-native-proto arm, **not** `closed-method-dispatch.ts`. See the
> correction at the end of this file.
>
> #4082 also records a residual it deliberately did not fix: **#4083**, where
> the same borrowed call now answers `null` instead of crashing.
>
> **Permanent repro** (#2093): `tests/issue-4082-closure-result-boxing.test.ts`
> — its first two cases are exactly the shape below, and the second asserts by
> value that a genuine `TypeError` is thrown. Conformance repros:
> `test262/test/built-ins/RegExp/prototype/test/S15.10.6.3_A2_T1.js` and
> `test262/test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-166.js`.

Located 2026-08-02 by the `H-crashes` agent, which **deliberately stopped short
of implementing** because it had not finished identifying the emitting site.
Handed over with a repro, the exact failing instruction sequence, one hypothesis
already eliminated, and the two files to search.

## Population

**12 files** in the `invalid Wasm binary` cluster (population 53). 11 of the 12
are `built-ins/RegExp/prototype/test/S15.10.6.3_*`.

## Repro — 9 lines, standalone target

```js
__instance = new Object();
__instance.test = RegExp.prototype.test;
__instance.test("…");
```

Fails as:

```
__call_fn_method_0 failed: local.set[0] expected type externref, found call_ref of type i32
```

## The failing sequence, from the emitted WAT

```wat
… struct.get 114 0 ; ref.cast (ref 113) ; call_ref 113   ;; returns i32
local.set 6                                              ;; local 6 is externref  <-- crash
local.get 5 ; global.set 10 ; local.get 6 ; return       ;; __current_this restore
```

## ⚠ Hypothesis already ELIMINATED — do not re-run this one

The obvious hypothesis, given the two sibling fixes (#4077, #4079), is that
`entry.returnType` (a recorded signature) disagrees with `entry.funcTypeIdx`
(the type `call_ref` actually uses). It is **plausible** — the code three lines
above reads the ground-truth `funcTypeDef` for the self param while taking the
return type from the parallel record.

It was **instrumented rather than argued**, and disproved:

```
[RETTYPE] funcTypeIdx=113 recorded={"kind":"i32"} actual={"kind":"i32"}
```

**They agree. That is not the mechanism.** Both `call_ref` sites already read
(`closure-exports.ts:554-584` and `:907-937`) box i32 correctly via
`boxI32ClosureResult`.

## The actual shape

There is a **third** dispatch arm: an early-return path that inlines the
"save result / restore `__current_this` / reload / return" sequence — the same
shape as `closure-exports.ts:1039-1042`, whose comment asserts *"Stack at this
point: [result : externref]"* — and **this copy does no return-type boxing at
all**.

The emitter that writes it has **not** been identified. It is not either of the
two arms above. Next place to look: **`closed-method-dispatch.ts:547`**, which
also calls `__call_fn_method_<arity>`.

### CORRECTION (resolved in #4082) — the lead above was wrong

`closed-method-dispatch.ts` was the wrong place to look; it emits no `call_ref`
at all. The arm is `buildTransferredNativeProtoCallInstrs` in
**`src/codegen/closures/transferred-native-proto.ts`** — the #3992
transferred-native-proto arm, reached from `closure-exports.ts` via
`buildTransferredNativeProtoCallInstrs(...)`, not from a `closed-method`
path. Recording the miss because a confidently-named "next place to look" is
the kind of hint that costs the next reader an hour.

Its doc block is also the sharpest evidence for #4080: the invariant it
violates is written *in that same doc block* — *"each arm pushes exactly one
externref (the `call_ref` result)"* — so the copy missing the type handling is
the copy asserting its own correctness in prose.

Fixed by giving the whole ABI one owner for the decision, a new subsystem
module `src/codegen/closures/result-boxing.ts`, imported by all three arms.

## Why this matters beyond 12 files

Fourth instance of the pattern in one cluster (#3989, #4077, #4079, this), and
it sharpens the statement of it. It is **not merely "a hand-maintained case
list"** — in #4079 and here it is **a duplicated emission sequence where one
copy carries the type handling and another does not**. Worse, the invariant is
written down as a *comment* in one copy (`"[result : externref]"`) and silently
assumed in the other, so the two copies cannot be kept honest by anything.

See #4080: the `malformed_wasm` invariant already catches this class by
construction; the gap is diff-test corpus coverage.
