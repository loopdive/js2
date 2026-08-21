---
id: 4582
title: "STANDALONE: `Object(true).valueOf()` works — until the module also mentions `Boolean.prototype`, which switches it onto the refusing reflective glue"
status: ready
sprint: current
created: 2026-08-20
updated: 2026-08-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: boxed-primitives
goal: es5
related: [4580, 4119, 2742, 4163]
origin: "2026-08-20, ES5 standalone push follow-up. Isolated from the `<Boxed>.prototype.valueOf` refusals recorded in #4580. A fix was attempted, measured to produce a WRONG ANSWER, and reverted — see below."
---

# #4582 — boxed `valueOf` refuses once the prototype is touched

## The trigger is an unrelated statement

```js
var x = Object(true).valueOf();   // true — fine on its own
```

```js
var x = Object(true).valueOf();   // now THROWS
var p = Boolean.prototype;        // <-- adding this line breaks the line ABOVE
```

`TypeError: Boolean.prototype.valueOf is not yet implemented in --target standalone`

Reading `Boolean.prototype` reifies the builtin prototype object, which routes
the call through the reflective member-closure glue (`makeGlue`,
`array-object-proto.ts`) instead of the direct lowering — and every member of
that glue for the boxed brands is a refusal stub. **So this was never a missing
`valueOf`**; it is an unrelated statement switching a working call onto a path
that refuses.

That is exactly why test262 catches it and a minimal probe does not:
`built-ins/Object/S9.9_A3` asserts `Object(true).valueOf()` on one line and
`Object(true).constructor.prototype === Boolean.prototype` three lines later.
Isolated by truncating that file to its first assertion — which **passes**.

## Rows

4 in the standalone ES5 residue: `built-ins/Object/S9.9_A3` (Boolean),
`S9.9_A4` (Number), `S9.9_A5` (String), `harness/deepEqual-primitives` (String).

## A fix was attempted and REVERTED — read this before retrying

Wiring `<Brand>.prototype.valueOf` bodies into `makeGlue` (`__unbox_boolean` →
`__box_boolean`, `__unbox_number` → `__box_number`, `__unbox_string`) got past
the refusal and then **answered `false` for `Object(true).valueOf()`**.

That is strictly worse than the refusal it replaced — a loud TypeError became a
silent wrong boolean — so it was reverted rather than shipped. Two things the
next attempt needs that this one did not have:

1. **`__unbox_boolean` on the reflective receiver does not yield the wrapped
   value.** Either `this` is not arriving in param 1 on this glue (the sibling
   bodies in `array-object-proto.ts` document param 1 as `this`, but those are
   the `String`/`Array`/`Date` factories, and the boxed brands may differ), or
   the helper does not accept the `$BoxedBoolean` carrier the reflective path
   presents. **Verify what param 1 actually holds before trusting either.**
2. **`String` never reaches that branch at all.** `name === "String"` is routed
   to `emitStringProtoMemberBody` earlier in the same ternary, and that function
   refuses `valueOf` (it is not in its `IN_SCOPE` set). So the String third of
   this issue needs a body *there*, not in the shared fallback.

## Acceptance criteria

- The two-line repro above passes, and so does the bare one-line form.
- All four rows pass, `target=standalone`.
- **A wrong value is a failure, not a partial win.** Assert the returned value,
  not merely that no TypeError was thrown — the reverted attempt would have
  passed a "does not throw" test.
- 551-row standalone ES5 guard clean; GC-lane unit suites relative to the merge
  base (`makeGlue` is shared).

## Why the refusal is the correct current state

Until a body is proven to return the right value, the refusal is the better
behaviour: it is loud, catchable, and cannot be mistaken for a correct answer.
