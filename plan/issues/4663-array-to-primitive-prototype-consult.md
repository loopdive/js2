---
id: 4663
title: "standalone: `__array_to_primitive_string` is a hard-coded join(\",\") with no prototype consult — `\"\" + a` ignores an overridden Array.prototype.toString; the fix is blocked on unbounded recursion, not on scope"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: to-primitive
goal: standalone-gap
related: [4655, 4492, 4641, 3580]
origin: "dev-4492 measured the defect; dev-4655 read the emitter, confirmed the root, and DECLINED it with a named blocker — 'real target, correct root, wrong size'. Filed by the lead so the blocker is not rediscovered from the call site."
---

# #4663 — the `+` path never consults `Array.prototype.toString`

## Root (confirmed by reading the emitter, not inferred)

`fillArrayToPrimitive` (`src/codegen/array-to-primitive.ts`, 207 lines) builds
`__array_to_primitive_string` as a hard-coded `join(",")` loop with **no
prototype consult**, and `__to_primitive`'s vec arm calls it. So with
`Array.prototype.toString` overridden:

| receiver | `String(x)` | `x.toString()` | `"" + x` |
| --- | --- | --- | --- |
| `var a = new Array` | ✓ | ✓ | **✗** |

`String(a)` and `a.toString()` honour the override; `"" + a` does not.

## Why this is NOT a small fix — read before starting

The obvious repair is the machinery #4655 shipped for the element step:
`m = __extern_get(arr,"toString"); if (m) return ToString(__apply_closure(m,arr,null)); else <inline join>`.
dev-4655 is the lane that just built that and **declined this anyway**:

- **The consult resolves `"toString"` whether or not the user overrode it.** If
  any path installs `Array.prototype.toString` reflectively, the driver calls a
  `toString` that routes back through `__to_primitive`'s vec arm →
  **unbounded recursion on a hot path**: `Number([1])`, `"1,2" == [1,2]`,
  `1 + [2]`, every array-in-string-concat.
- There is **no cheap "is this the builtin?" test** in that driver — no identity
  carrier for the builtin to compare against.
- The shape that works is a **user-override flag**: a module-level global set
  when user code assigns to `Array.prototype.toString`, with the driver
  consulting only when the flag is set. That is an assignment-site change in
  another subsystem plus a runtime global — a slice, not a rider.

**Start from the recursion question, not from the consult.**

## Measurement warning specific to this area

A JS-level probe does NOT establish what `__extern_get` sees. dev-4655 hit this
in #4655: an object literal is a CLOSED `$__anon_N` struct, so
`__extern_method_call` resolves null on it while the *same* object reached via a
computed member call works. Any "does the reflective read see it" claim here must
come from an **emitted arm**, not from a probe.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully.
   Especially methodology 6 (a table only evidences the axes it varies), 8 (a
   residual is a CLAIM — probe the negative case; carry positive controls), the
   counts rule (`total > 0 && passed + failed == total` off the summary line,
   never the exit status), the contention trap (serially re-verify every
   apparent flip AND regression), and the `test262` GITLINK hazard.
2. Settle the recursion design FIRST and record it before writing the consult.
   Establish where a user assignment to `Array.prototype.toString` can be
   observed, and whether a module-level override flag is sound for the
   reflective-install paths as well as the syntactic one.
3. Absent-not-wrong: if the flag cannot cover a reflective install, DECLINE the
   consult for that shape rather than recursing or answering wrongly.
4. Pins must EXECUTE the concatenation and read the result, and carry a positive
   control — an array whose prototype has NO override must still render
   `join(",")` — so the suite claims the prototype consult rather than "string
   concatenation works". dev-4492's residual pins in
   `tests/issue-4492-wave5.test.ts` cover this row and should be flipped from
   `it.fails` by whoever lands it.

## Related: the inline-vs-named receiver half is NOT filed here

dev-4492 measured that an INLINE receiver (`String([1,2])`) ignores the override
while a NAMED one honours it — the shape `built-ins/String/S15.5.1.1_A1_T8`
uses. dev-4655 reframed that half, and the reframing is the useful part: it is
**carrier selection decided before the operation runs**, the same axis as its own
#4655 residuals R3 (`toString/S15.4.4.2_A1_T2` — a var whose wasm carrier was
fixed to `f64` first renders `",1,0,3"` while a fresh var renders `",1,,3"`) and
R4 (`concat` results whose slot stays statically `number[]`, turning holes and
inherited indices into `NaN`). So it belongs with the **value-rep carrier** work
alongside #4641 and #3580, not with the String-conversion path — and a lane
fixing it there will likely move all three rows at once.
