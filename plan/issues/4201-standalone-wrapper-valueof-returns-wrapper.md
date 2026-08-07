---
id: 4201
title: "Standalone: <primitive wrapper>.valueOf() returns the WRAPPER, not [[PrimitiveValue]] — Number/String/Boolean all affected; it is the residual blocker on 11 of #4196's 13 construct-through-bind files"
status: ready
created: 2026-08-07
updated: 2026-08-07
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: medium
reasoning_effort: high
sprint: current
horizon: m
related: [4196, 1910, 2374, 3118, 344]
origin: "W19, 2026-08-07 — fell out of #4196 slice 1; probes .tmp/p2..p4 in worktree agent-ac1fc06e358fa787f"
---

# #4201 — standalone `<wrapper>.valueOf()` is the identity function

## Measured (standalone, `--target standalone`, main @ 5270c427d7)

An **explicit `.valueOf()` method call** on a primitive-wrapper object returns
the wrapper itself instead of the `[[PrimitiveValue]]` slot. All three wrapper
kinds are affected:

```ts
const b: any = new Boolean(true);
b.valueOf() === b        // true   ❌ must be the primitive `true`
typeof b.valueOf()       // "object" ❌ must be "boolean"

new Number(5).valueOf() === 5      // false ❌
new String("x").valueOf() === "x"  // false ❌
Boolean.prototype.valueOf.call(b) === true  // false ❌
```

The wrapper is otherwise well-formed and **does carry the value** — the
to-primitive path finds it:

```ts
String(b) === "true"     // true ✓
b.toString() === "true"  // true ✓
Boolean(b)               // truthy ✓
```

so this is not a missing slot. `object-runtime.ts:3520` already reads the
`WRAPPER_PRIMITIVE_KEY` (`[[PrimitiveValue]]`) slot FIRST inside
`__to_primitive`, which is why `String(b)` is right. What is missing is the
**intrinsic `valueOf` method itself**: `object-runtime.ts:170` records it
outright — *"standalone ships no `Number.prototype.valueOf`"*. So an explicit
`recv.valueOf()` resolves nothing on the wrapper's prototype chain, falls
through to `Object.prototype.valueOf`, and returns `this`.

`Object.prototype.toString.call(b)` also answers something other than
`"[object Boolean]"`, so the §20.1.3.6 wrapper tagging is a second, adjacent
symptom worth checking in the same pass.

## Why this is filed separately, and why it is worth its own slice

It is the **residual blocker on 11 of the 13** files in #4196's largest
sub-bucket (`built-ins/Function/prototype/bind/15.3.4.5.2-4-*`). #4196 slice 1
landed `[[Construct]]` through `$__bound_fn`, and all 13 moved from

```
newInstance.valueOf() Expected SameValue («null», «true»)   ← construct returned null
```
to
```
newInstance.valueOf() Expected SameValue («true», «true»)   ← construct is CORRECT;
                                                              valueOf is the wrapper
```

The render says «true» on both sides because the wrapper stringifies as
`"true"`; `sameValue` still fails because the left side is an OBJECT. That is
worth calling out for anyone triaging by message: **this bucket's error text is
actively misleading** — it looks like a value bug and is a type bug.

Only 2 of the 13 (`-4-1`, `-4-2`) assert with `hasOwnProperty` instead of
`valueOf`, which is exactly why slice 1's measured yield was 2 and not 13. The
census bucketed by first-assertion message, so a single downstream mechanism was
distributed across a construct-shaped row.

## Scope beyond #4196

Unmeasured but structurally implied — every standalone site that calls
`.valueOf()` on a boxed primitive: `Object(1).valueOf()`, the
`propertyHelper`/`compareArray` harness paths that unwrap boxed values,
`Date.prototype.valueOf` on a wrapper receiver, and any `x.valueOf()` written
explicitly in test code rather than reached through coercion. **Size this
against the standalone JSONL before scheduling** — do not inherit the 11 as the
estimate.

## Suggested approach

The dispatch to extend is `__extern_method_call` (`object-runtime.ts:4480`),
which already has an interned-name fast-path idiom (`ref.eq` against the
interned method-name global, `#3673 round 9`). A `valueOf` arm that reads
`__obj_find(recv, "[[PrimitiveValue]]")` and returns the slot when present —
falling through to the generic path when absent — matches that idiom and reuses
the slot accessor `__to_primitive` already uses. `toString` on a wrapper wants
the same arm.

Regression surface is every `.valueOf()` call in standalone, so this needs a
base-vs-head sweep well beyond the bind directory.

## Acceptance

- `new Boolean(true).valueOf() === true`, `new Number(5).valueOf() === 5`,
  `new String("x").valueOf() === "x"` in `--target standalone`.
- `Boolean.prototype.valueOf.call(new Boolean(true)) === true`.
- The 11 `15.3.4.5.2-4-*` files above go fail → pass.
- Zero regressions in a base-vs-head standalone sweep sized to the `.valueOf()`
  population, not to the bind directory.
- Committed vitest, verify-first (RED on the base commit).
