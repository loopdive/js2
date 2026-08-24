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

## Lead ruling: the recursion blocker is already solved in-tree — do NOT build a runtime override flag (2026-08-24)

#4655 declined this issue on the grounds that "there is **no cheap 'is this the
builtin?' test** in that driver", so the only sound shape was "a module-level global
set when user code assigns to `Array.prototype.toString` … an assignment-site change
in another subsystem plus a runtime global — a slice, not a rider."

**That test exists.** `src/codegen/builtin-proto-member-override.ts` is the same
problem, already solved, for method **call** sites. Read its header before anything
else. Its shape is:

```
__protoidx_has_r(recv, "<m>") ? apply the companion entry : the builtin
```

and the load-bearing sentence is in its own doc:

> Under `protoNamedDirty` alone the companion is seeded with NOTHING
> (`protoMemberDirty` drives seeding and a proto WRITE deliberately does not set it),
> so `has` is exactly **"the user overrode this member"**, not "this member exists".

That is the missing predicate. **The recursion this issue is blocked on cannot happen
through it**, because a companion hit can only ever be a value user code installed —
`__protoidx_has_r` can never hand back the builtin `toString` that would route back
into `__to_primitive`'s vec arm. The unbounded-recursion hazard was a property of
`__extern_get`-and-resolve, not of the consult as such.

(If the user's own override does `"" + this`, that recurses — but that is the user's
own infinite recursion and V8 does the same. Not our problem to prevent.)

### Gating — this is what makes it a rider, not a slice

Three gates, all compile-time, all already built:

1. `ctx.standalone`
2. `ctx.protoNamedDirty` — a **pre-scan** flag, so a module that never overrides does
   not merely leave the arm dead, it never builds it (byte-identical output)
3. `ctx.protoNamedWrittenMembers.has("toString")` — the #4492 wave-5 member-name set.
   `src/codegen/callable-any-to-string.ts:157,235` **already uses this exact predicate**
   for the `Function.prototype.toString` side. Copy that precedent; do not invent a new
   flag.

`isProtoNamedWrite` (`src/codegen/array-holes.ts:690`) reaches
`Array.prototype.toString = f` through its property-access-assignment arm, which has no
Array exclusion.

### The one thing you must MEASURE, not assume

`isProtoNamedWrite` **deliberately excludes `Array.prototype`** from its element-access
and `defineProperty` arms, on the stated grounds that those forms already set
`protoIndexDirty`, "which reserves the same store". So:

- `Array.prototype.toString = f` → sets `protoNamedDirty` **and** records `"toString"`. Covered.
- `Object.defineProperty(Array.prototype, "toString", …)` → sets `protoIndexDirty` but
  **not** `protoNamedDirty`, and records **no member name**.

Establish from an **emitted arm** (not a JS probe — see the measurement warning above)
whether the companion is armed and `__protoidx_has_r` answers for the `defineProperty`
form. If it does not, that shape is **absent-not-wrong**: leave it on the inline join,
say so in the report, and do not widen `isProtoNamedWrite` to reach it as part of this
issue — that predicate's Array exclusion is load-bearing for `protoIndexDirty` and
changing it is its own blast radius.

### Revised sizing

Rider, not slice. One gated two-arm branch in `fillArrayToPrimitive`
(`src/codegen/array-to-primitive.ts`), modelled on `builtin-proto-member-override.ts`
and gated by `callable-any-to-string.ts`'s predicate. A module that does not override
`Array.prototype.toString` must compile **byte-identically** — verify that with a
`wasm_sha` comparison, which is a stronger and far cheaper zero-regression argument
than a wide sweep (the technique #4655 used when its own full sweep was OOM-killed).

### Correction to the ruling above — the gate alone is NOT sufficient (lane-4663, 2026-08-24)

The lane objected before writing any code, and it was right. Recorded here because the
ruling as first written would have shipped a regression.

`ctx.protoNamedWrittenMembers` is **member-name-only, not ctor-qualified** —
`array-holes.ts:96` is `ctx.protoNamedWrittenMembers.add(lhs.name.text)`. And
`__protoidx_has_k`'s walk (`fillHasKBody`, `src/codegen/proto-index-store.ts` ~L922)
probes `firstOff`'s companion **and then falls back to Object's** whenever
`firstOff != OBJ_OFF`.

Composed, those two facts break a shape that works **today**: a module writing only
`Object.prototype.toString = f` arms the gate, and the arm then answers *Object's*
override for `"" + [1,2]` — where real JS keeps `Array.prototype.toString`'s join,
because Array's builtin **shadows** Object's (`[1,2].toString()` stops at
`Array.prototype`). Consulting Object's companion here is wrong, not merely coarse.

**Ruled: make the RUNTIME probe precise, leave the compile-time gate coarse.**

Build an Array-companion-**only** probe from `companionProbeArm` at `ARR_OFF` — the same
first arm `fillHasKBody` uses, **without** the Object tail:

- Object-only override → gate arms, arm builds, arm **misses** → inline join → today's
  correct answer preserved.
- `Array.prototype.toString` override → hits → user value applied.

The gate then only decides whether to *build* the arm; it can no longer make the arm
answer wrongly. This is strictly preferable to ctor-qualifying `protoNamedWrittenMembers`,
which would mean editing the `array-holes.ts` pre-scan whose Array exclusions are
load-bearing for `protoIndexDirty` — the blast radius this issue is explicitly scoped out of.

**Required pin (negative control), not a note:** a module that writes ONLY
`Object.prototype.toString = f` must still render `"" + [1,2]` as `"1,2"`. Alongside the
positive control (no override at all → `join(",")`).
