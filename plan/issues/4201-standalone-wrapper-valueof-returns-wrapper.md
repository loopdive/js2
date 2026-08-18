---
id: 4201
title: "Standalone: <primitive wrapper>.valueOf() returns the WRAPPER, not [[PrimitiveValue]] — Number/String/Boolean all affected; it is the residual blocker on 11 of #4196's 13 construct-through-bind files"
status: done
created: 2026-08-07
updated: 2026-08-18
completed: 2026-08-07
assignee: ttraenkler/W20
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: medium
reasoning_effort: high
sprint: 78
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

---

## Implementation notes (W20, 2026-08-07) — RESOLVED, `FIXED 12 / BROKE 0`

### The root cause is NOT "standalone ships no `Boolean.prototype.valueOf`"

That framing (from `object-runtime.ts:170`) is true but is not what makes
`b.valueOf()` answer `b`. The intrinsic is never consulted, because the
compiler never emits a lookup. `compileReceiverMethodCall`
(`src/codegen/expressions/call-receiver-method.ts`) ends with

```ts
// Fallback .valueOf() for any type not already handled above
// valueOf() on non-primitive types typically returns the object itself
if (propAccess.name.text === "valueOf" && expr.arguments.length === 0) {
  return compileExpression(ctx, fctx, propAccess.expression);
}
```

That is `Object.prototype.valueOf`, and it is the correct answer only when
nothing EARLIER in the receiver's prototype chain overrides it. Every arm above
it resolves the overriding cases — primitive wrappers, user classes, `Date`,
`Symbol` — from the receiver's **static TypeScript type**. A receiver typed
`any` (every receiver in compiled JavaScript, which is what test262 is) reaches
none of them, so the blanket identity swallowed **two** overrides at once:

| case | before | spec |
| --- | --- | --- |
| `var b = new Boolean(true); b.valueOf()` | the wrapper | `true` |
| `({valueOf: function(){return 7}}).valueOf()` | the object | `7` |
| `var b = new Boolean(true); b.valueOf` (read) | `undefined` | a function |

The second row is the tell, and it is why the "missing intrinsic" framing
misleads: a **user-defined** `valueOf` was equally swallowed, which no amount of
prototype-object modelling would explain. Confirming the shape: `o.foo()` on the
same `any`-typed literal dispatches correctly; only the name `valueOf` is
short-circuited. `--target standalone` is not special here either — host mode
has the same hole (measured: `any_num_valueOf` and `any_user_valueOf` both wrong
in JS-host mode too) — but the fix is deliberately standalone-gated, see below.

### The fix

New subsystem module `src/codegen/wrapper-valueof.ts`:

- `__dyn_valueOf(externref) -> externref`, a native helper that resolves the
  three answers in **spec order**: own/inherited `valueOf` (`__extern_get` →
  `__apply_closure`) → the wrapper's `[[PrimitiveValue]]` FLAG_INTERNAL slot
  (`__obj_find(WRAPPER_PRIMITIVE_KEY)`, the same read `__to_primitive` already
  does first) → the receiver. A non-`$Object` receiver returns unchanged, which
  is byte-for-byte the blanket fallback it replaces.
- `tryEmitDynamicValueOfCall(...)`, the call-site entry, gated on
  `ctx.standalone` **and** an ORACLE fact of `any`/`unknown`.

Three deliberate scope decisions, each load-bearing:

1. **Gated on `ctx.oracle.typeFactOf`, not the raw checker type / physical
   carrier** that `compileReceiverMethodCall` resolves ~40 lines further down.
   Hoisting that resolution above the `valueOf` arm was the first attempt and is
   wrong: `resolveWasmType` REGISTERS module types, so moving it perturbs
   emission for every receiver that reaches the late-fnctor arm — a surface
   far wider than this fix. The oracle query is side-effect-free by contract.
2. **Standalone only.** Host mode has the same defect but a different
   substrate (`__extern_method_call` is a host import there); keeping host
   emission byte-identical keeps the regression surface enumerable.
3. **`any`/`unknown` only.** A union-typed or externref-carrier receiver keeps
   the historical identity. Conservative, and it is what makes the claim below
   provable rather than estimated.

Consequence worth stating plainly: **a module with no zero-arg
`<expr>.valueOf()` property-access call site compiles byte-identically.** That
is what bounds the regression surface to an enumerable file list instead of an
estimate.

### Sizing — by probe and A/B, NOT by error-string grep

Grepping the standalone baseline for `valueOf` gives **1,175** non-passing
files. That number is worthless: the wrapper stringifies as its primitive, so
the defect renders as `SameValue(«true», «true»)` — a TYPE bug that reads as a
VALUE bug — while most of the 1,175 are Temporal/SharedArrayBuffer/Reflect
noise that merely mention the word.

The population that the change **can** touch is exactly the files whose
effective source (test body + every `includes:` harness) contains a zero-arg
`.valueOf()` call. Neither `assert.js` nor `sta.js` contains one, so this is a
real filter, and it is a *complete* population, not a sample:

| | files | ES5 (`es5id:`) |
| --- | --- | --- |
| LEVER (baseline non-pass ∧ zero-arg `.valueOf()`) | **83** | 25 |
| CONTROL (baseline pass ∧ zero-arg `.valueOf()`) | **90** | 22 |

Measured with `runTest262File(..., "standalone")` at the INTERPRETER
runtime-eval tier (`TEST262_FULL_RUNTIME_EVAL=1`, provider deleted and rebuilt
between arms), against the STANDALONE baseline
(`ensureStandaloneBaselineJsonl({force:true})` — 48,619 rows):

```
BASE (origin/main tip): lever   0/83   control 90/90   0 disagreements with the published jsonl
HEAD (this branch)    : lever  12/83   control 90/90
FIXED 12 / BROKE 0     (4 further files advance past their valueOf assertion)
```

All 12 carry `es5id:`, so **ES5 standalone 7,544 → 7,556 / 8,931 (84.47 % →
84.61 %)**; goal-90 gap 493 → 481.

### The 12, and a staleness trap that nearly cost the whole number

The 12 are the `built-ins/Function/prototype/bind/15.3.4.5.2-4-{3..14}` family
this issue predicted. **A first A/B measured `FIXED 0`** — because the branch
was cut from `origin/main@50127992c8`, minutes before #4196's `[[Construct]]`
slice landed as `14cb0f08d1`. Without that predecessor the 12 still fail
UPSTREAM of `valueOf`, at `SameValue(«null», «true»)` (construct returns null),
so `valueOf` is unreachable and the lever reads as dead. The mechanism was
real the whole time; the base was 40 minutes old. Re-measured on the true tip
it is +12. **Two levers in one issue, in series, and measuring the second one
against a base missing the first reports zero with a straight face.**

Also worth recording, because it contradicts a natural assumption: the
runtime-eval provider **cache key does not track `src/` edits**. Across four
builds here the key stayed `854c120ce015d507` while the artifact ranged
3,971,954 → 3,995,550 bytes. "cache MISS" text is not proof the key noticed
your edit, and byte-identical is not proof it did not compile. Delete the file.

### Not fixed here (measured, separate mechanisms)

- `Boolean.prototype.valueOf.call(b)` — still returns the wrapper. Uncurried
  `<Builtin>.prototype.<m>.call` only wires `Object.prototype`
  (`call-object-builtins.ts`); a real follow-on.
- `Object.prototype.toString.call(new Boolean(true))` is not
  `"[object Boolean]"` — §20.1.3.6 wrapper tagging, `object-proto-tostring.ts`.
- `Object('').valueOf()` now throws `String.prototype.valueOf is not yet
  implemented in --target standalone` instead of returning the wrong value —
  the own/inherited probe finds a not-implemented stub before the slot. Still
  a fail either way; it becomes a pass when that stub is implemented.
- `(new Boolean(new Object())).valueOf()` — a STATICALLY typed receiver, so it
  never reaches this path; it fails at `new Boolean(<object>)` → ToBoolean.
- `{ valueOf() {…} }` written as a method shorthand compiles to a CLOSED
  struct, not a `$Object`, so `__dyn_valueOf` returns the receiver — same as
  before, not a regression, and a candidate for the closed-method dispatcher.
