---
id: 3254
slug: string-requireobjectcoercible
title: "Standalone: RequireObjectCoercible + ToString for borrowed String.prototype.<m>.call receiver"
status: ready
reopened: 2026-07-31
assignee: opus-tabrand
sprint: current
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/expressions/calls.ts
---

> ## 🚩 STOP — DO NOT WRITE A SECOND `trim` FIX (s78-dev2, 2026-08-01)
>
> **The reopening below is accurate about the symptom and wrong about the
> cause. `trim` was never left on the pre-fix terminal by a gap in THIS issue's
> fix — this issue's fix was MASKED, and it is repaired by a change already
> specified in #2742.**
>
> The #2875 reflective `String.prototype` member-body wiring
> (`emitStringProtoMemberBody`, `src/codegen/array-object-proto.ts`) intercepts
> **ahead of** the `receiverOverride` this issue added, so a borrowed `trim`
> call never reached the corrected path at all.
>
> **Measured** (scoped test262 A/B, same box, same run, both arms from one
> tree; 265 files; rows floored 265/265 on both arms with zero timeouts;
> 65 `substring`/`charAt` files carried as an in-sweep control):
>
> - refuse the superseded #2875 wiring ⇒ **10 `trim` files flip fail→pass**
> - **0 files regress**; the in-sweep control does **not** move
> - every one of the 10 flips is in `trim/`
>
> So it is **ONE repair, not two**. Writing a second `trim` fix here would be a
> redundant change against a path that is no longer broken, and because both
> changes target the same legacy borrowed-receiver path they would make each
> other's attribution unreadable.
>
> **Before doing any `trim` work on this issue, re-measure against a tree with
> the #2742 wiring removal applied, and quote the surviving file list.** Do not
> take the reopening text below at face value — it was written while the
> masking was in effect.
>
> One loose end worth pinning (not a `trim` issue): this issue's stated *"known
> limitation"* — that a dynamic `any`-typed OBJECT receiver stringifies through
> `__any_to_string` — predicts `new Object(42)` **failing**, and it **passes**.
> That limitation is therefore closed or mis-stated, and the doc is currently
> misleading the next reader either way.
>
> Full evidence, the 2-lane decomposition, and the three-population breakdown
> are in #2742.

## REOPENED 2026-07-31 — false-`done` on this issue's own headline method

This was `status: done` (completed 2026-07-13) while **`trim`, the method it is
named after, is still broken**. The text below claims _"the fix generalises
beyond trim"_ and cites _"the ~76 `assert.throws(TypeError, …)` trim-family
tests"_. Measured, it generalised to the **other** methods and left `trim` itself
on the pre-fix `$__any_to_string` `"[object Object]"` terminal.

`runTest262File` on the same file, both lanes, with spec-invariant controls
(`Object.keys({a:1,b:2}).length===2`, `"ab".toUpperCase()==="AB"`,
`String(new Boolean(false))==="false"`) **all passing**:

```
                                            host      standalone
String.prototype.trim.call(new Boolean(false))  [false]   [[object Object]]
String.prototype.trim.call(new Number(123))     [123]     [[object Object]]
String.prototype.toUpperCase.call(new Number(123))  123   123          <- works
```

So the ROC/throw half landed for `trim` and the **`ToString` half did not**,
while both halves landed for the other methods. ~10 ES5 standalone rows in the
`built-ins/String/prototype/trim` family are still failing on it.

Reopened rather than left `done`: a falsely-**open** issue gets caught by the
TaskList reconciler, but nothing detects a falsely-**closed** one, so it stays
invisible indefinitely. `sprint: current` puts it back on the TaskList where it
can be claimed. Whoever lands the `trim` half flips this back to `done`.

Related: #3877 (the assigned-method form, a distinct defect in the
`__proto_method_*` wrapper).

## Problem

Under `--target standalone`, the borrowed String-method dispatch
`String.prototype.<m>.call(thisArg, …)` synthesised `recv.<m>()` and leaned on
`compileNativeStringMethodCall`'s default `emitReceiver`, which only handled a
string / object-struct receiver. `.call(false)` / `.call(123)` / `.call(obj)`
fell through to the `$__any_to_string` "[object Object]" terminal, and
`.call(undefined)` (the non-null tag-1 singleton) silently coerced instead of
throwing. The reflective closure body already did RequireObjectCoercible +
ToString, but the `.call()` fast path bypassed it — so the `String.prototype`
trim family and siblings failed their §22.1.3 this-coercion assertions.

## Fix

Adds `emitBorrowedStringReceiverToString` (string-ops.ts): the §22.1.3 preamble
— RequireObjectCoercible(this) (throw TypeError on `null` / the `$undefined`
singleton / a null externref) then ToString(this) via the type-aware native
coercion engine. Wired as a `receiverOverride` in the borrowed-method dispatch
(calls.ts), so it covers every method in `STANDALONE_STR_PROTO_METHODS` (trim
family + charAt / …). This generalises beyond the trim tests to all
`String.prototype.<m>.call(<primitive>)` borrowed receivers.

Standalone-only path; host / gc / wasi lanes untouched.

## Known limitation (not a regression)

A dynamic `any`-typed OBJECT receiver still stringifies through
`__any_to_string` ("[object Object]" terminal) rather than a full ToPrimitive →
ToString chain, so `new Object(42)` / user-object receivers with a custom
`toString` are not yet covered. Pre-existing behaviour — this change does not
regress it. The merge_group standalone floor validates net-positive.

## Attribution

Root-caused and initially implemented by opus-strtrim (commit d44d0d6c);
adopted, main-merged, and landed by opus-tabrand (#3255 window).
