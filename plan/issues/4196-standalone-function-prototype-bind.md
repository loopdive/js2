---
id: 4196
title: "Standalone: Function.prototype.bind — 34 ES5 failures across SIX independent sub-mechanisms (construct-through-bind, builtin-ctor bind, IsCallable throw, this)"
status: ready
created: 2026-08-07
updated: 2026-08-07
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
sprint: current
horizon: l
related: [3140, 4192, 2928, 4163, 4201, 4203]
assignee: ttraenkler/W19
# Slice 1 ([[Construct]] through $__bound_fn) adds `src/codegen/construct-bound.ts`
# — a new subsystem module carrying the whole 300-line driver. What is left in the
# god-files is irreducible: the DISPATCH decision belongs to `compileNewExpression`
# (+4 lines) and the reserve-then-fill contract requires the fill to be called from
# the two finalize paths in `index.ts` (+3 lines). There is no subsystem module that
# can host either.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4196 — `Function.prototype.bind` in `--target standalone`

**34 of the 80 ES5-label `built-ins/Function/prototype/bind` files fail**, and
**none of them is eval-dependent** — this is the largest mechanism inside the
2026-08-06 `Function.prototype` census that no other issue covers.

Measured on 2026-08-06 main with the in-process runner linking
`js2wasm:runtime-eval` (PR #4163) and `TEST262_FULL_RUNTIME_EVAL=1` (the
CI-comparable interpreter tier). Without those two, this bucket is invisible:
46 of the 95 `Function/prototype` failures collapse onto a phantom
`dynamic code evaluation is not supported` label. See #4191 for the trap.

## This is NOT one fix — the decomposition is the point

| n | sub-mechanism | representative | signature |
| ---: | --- | --- | --- |
| **13** | **`new (bound)()` — [[Construct]] through a bound function** | `15.3.4.5.2-4-1` … `-4-14` | `newInstance.valueOf() Expected SameValue(«null», «true»)` (11), `newInstance.hasOwnProperty("returnValue") !== true` (2) |
| **8** | **`<Builtin>.bind(null)` then call** — binding a builtin CONSTRUCTOR | `15.3.4.5-2-3` … `-2-9`, `15.3.4.5-3-1` | `RuntimeError: dereferencing a null pointer in __module_init()` |
| **5** | **IsCallable(Target) TypeError not thrown** (§15.3.4.5 step 2) | `15.3.4.5-2-1`, `-20-2`, `-20-3`, `-21-2`, `-21-3` | `Expected a TypeError to be thrown but no exception was thrown at all` |
| **3** | **`this` not applied through the bound call** | `15.3.4.5-11-1`, `-6-2`, `-6-6` | `obj.property Expected SameValue(«undefined», «12»)` |
| **3** | null deref in the bound callee itself | `S15.3.4.5_A1`, `_A2`, `_A4` | `dereferencing a null pointer in baz()` / `in __module_init()` |
| **1** | outright refusal | `S15.3.4.5_A5` | `Function.prototype.bind is not yet implemented in --target standalone` |
| **1** | compile error | `15.3.4.5-2-7` | `'__get_builtin' … not yet supported (#1472 Phase B)` |

Six independent mechanisms. **Do not dispatch this as one task** — the biggest
single sub-bucket is 13 files, which is the same size as everything else left in
the tail (see #4163: no fifth big rock; the residue is flat).

## Where the machinery already is

A native bound-function carrier exists: **`$__bound_fn {target, thisArg,
boundArgs}`** (#3140), registered by `getOrCreateBoundFnType`
(`src/codegen/registry/types.ts:467`), minted at `.bind(…)` sites in
`src/codegen/expressions/calls.ts:2068/2119`, with a front-guard ladder in
`src/codegen/object-runtime.ts:5607+` that unwraps it and bridges to
`__apply_closure(target, boundThis, merged)` — `[[BoundThis]]` beating the
call-site receiver, as the spec requires. `calls.ts:3676/4116` handle a
`$__bound_fn` reaching a dynamic call site.

So the CALL side of `bind` largely exists. The three biggest sub-buckets are
about what that carrier does **not** implement:

- **[[Construct]] (13)** — §9.4.1.2 requires `new boundFn(…)` to
  `Construct(target, boundArgs ++ args, newTarget)` and return the TARGET's
  construct result. Probed on main: `func.bind({}, "a","b","c")` called
  normally returns the right value, but `new` on it does not produce the
  target's returned object. There is no `$__bound_fn` arm in the `new`
  lowering (`new-super.ts`) at all — this is a missing path, not a broken one.
- **Builtin-ctor targets (8)** — `Number.bind(null)`, `String.bind(null)`, …
  The bound target is a builtin CONSTRUCTOR value, which standalone reifies
  differently from a user closure (`ensureStandaloneBuiltinStaticMethodClosure`
  / the `$NativeProto` route), so the carrier's `target` field holds something
  `__apply_closure` cannot dispatch → null deref inside `__module_init`.
- **IsCallable throw (5)** — step 2 is a *runtime* check on the receiver;
  standalone emits no throw for a non-callable `Target`.

## Verified adjacent (do not fold in)

- The `this`-not-applied sub-bucket (3) is the **`.bind` third of #4192**. #4192
  slice 1 fixed `.call`/`.apply` for a variable-held function expression by
  installing `__current_this` at the call site; `.bind` routes through the
  `$__bound_fn` carrier instead and was deliberately left out. Whoever takes
  #4196 should read #4192's `closure-receiver-install.ts` first — the
  save/install/restore discipline and the null-receiver reasoning transfer
  directly.
- `S15.3.4.5_A5`'s bare refusal is one file and is probably the cheapest
  possible entry point for someone learning the carrier.

## Suggested slicing

1. **[[Construct]] through `$__bound_fn` (13)** — largest, self-contained, and
   the one with a clean spec algorithm to follow. Start here.
2. **IsCallable throw (5)** — small, independent, no carrier work.
3. **Builtin-ctor targets (8)** — needs the reified-builtin value to be a
   dispatchable target; likely overlaps the `$NativeProto` work in #4176.
4. The 3 null-derefs and the CE last; they may fall out of 1–3.

## Acceptance

Per slice: named sub-bucket goes fail → pass on `--target standalone`,
verify-first (RED on the base commit), zero regressions in a base-vs-head sweep
of all 80 ES5 `built-ins/Function/prototype/bind` files **plus** the
`Array.prototype` HOF-`thisArg` family, plus a committed vitest. Re-measure with
the interpreter runtime-eval tier and rebuild the provider after every `src/`
edit (#4191) — a stale provider cache silently reports the refusal tier and will
make a correct fix look like a 10-file regression.

---

## Slice 1 RESULT (W19, 2026-08-07) — `[[Construct]]` through `$__bound_fn`

**Shipped. `FIXED 2 / BROKE 0`** measured base-vs-head over all 100 files of
`built-ins/Function/prototype/bind/`, on the **INTERPRETER** runtime-eval tier
(`key 28ef51749bf42e4c`, rebuilt from an empty provider cache for this run —
3,960,183 bytes, a different artifact from the 3,970,785-byte one that was
cached, so the instrument was demonstrably live). Base 52 → head 54 pass.

Absolute positions fixed:

- `built-ins/Function/prototype/bind/15.3.4.5.2-4-1.js`
- `built-ins/Function/prototype/bind/15.3.4.5.2-4-2.js`

**Control sweep: `built-ins/TypedArrayConstructors/` — 738 files, FIXED 0,
BROKE 0, and ZERO error-message changes** (base 318 pass = head 318 pass). That
population was chosen deliberately: the retry hangs off the #2872
dynamic-`$__ta_ctor` arm, and `testTypedArray.js` calls `.bind`, so these files
are *inside* the byte-neutrality gate rather than trivially excluded by it.

**The control earned its keep on its first run.** It caught a real regression
the bind directory could not see: 7 previously-passing
`…/use-default-proto-if-custom-proto-is-not-object.js` files died with
`Internal error compiling expression: Invalid value used as weak map key`.
`Reflect.construct(...)` desugars to a **synthesized** `NewExpression` with no
parent chain, so `getSourceFile()` on it is `undefined`, and handing that to the
gate's memo `WeakMap` kills the whole compile. Fixed (unknown provenance now
reads as "cannot mint a bound fn" — the same fail-safe direction as the
cross-file case), all 7 verified restored, regression test committed.

### The 13-file sizing of the construct row does not survive contact — and the row is really 14

`15.3.4.5.2-4-*` is **14** files, all failing, not 13; the census split
`-4-5` off by its distinct assertion text.

More importantly, **the construct path was only the FIRST of two stacked
defects for 12 of the 14.** After this slice every one of the 14 constructs
correctly — the whole family moved from

```
newInstance.valueOf() Expected SameValue («null», «true»)   ← new returned NULL
```
to
```
newInstance.valueOf() Expected SameValue («true», «true»)   ← construct CORRECT
```

They still fail because `<primitive wrapper>.valueOf()` in standalone returns
**the wrapper**, not `[[PrimitiveValue]]`. The render prints «true» on both
sides (the wrapper stringifies as `"true"`), so the message reads like a value
bug and is a **type** bug. That residual is filed as **#4201** and is
independent of `bind` entirely:
`new Boolean(true).valueOf() === new Boolean(true)`, and `new Number(5)`,
`new String("x")` behave the same.

Only `-4-1` / `-4-2` assert with `hasOwnProperty` instead of `valueOf`, which is
exactly why the yield here is 2 and not 14. **The census bucketed by
first-assertion message, so one downstream mechanism was distributed across a
construct-shaped row.** Anyone sizing the remaining rows should assume the same
can be true of them.

`-4-5` additionally regressed its *failure mode* (clean assertion → a
`float unrepresentable in integer range` trap in `__call_fn_method_2`) because
it now reaches a real object and trips the same wrapper-`valueOf` path. Status
is `fail` on both arms, so it is not a conformance regression, but it is worth
knowing #4201 owns it.

### The "IsCallable throw (5)" row is two mechanisms, not one

Re-read of the five files: **1** is IsCallable (`15.3.4.5-2-1`, `f.bind()` on a
non-callable). The other four (`-20-2`, `-20-3`, `-21-2`, `-21-3`, plus
`BoundFunction_restricted-properties.js`) want `obj.caller` / `obj.arguments`
on a bound function to throw — that is the **%ThrowTypeError% restricted-property
accessor on `Function.prototype`**, which has nothing to do with `bind` and
applies to every function. Size and slice it as its own thing.

### What landed

- `src/codegen/construct-bound.ts` (new subsystem module) — the
  `__construct_bound(callee, args)` driver, reserve-then-fill.
- Two call-site lines in `compileNewExpression` + two fill calls in
  `index.ts` (the `loc-budget-allow` / `func-budget-allow` above).
- `tests/issue-4196.test.ts` — 8 cases, verify-first: **5 RED on the base
  commit, 8 green on the branch**, with the two that pass on BOTH arms being
  the explicit **precondition** (the carrier exists and its CALL side already
  works — without this the rest would be vacuous) and the **control**.

Design points worth keeping if this is extended:

- `[[BoundThis]]` is IGNORED on the construct path (§10.4.1.2 threads
  `newTarget`). This is the one place that must NOT reuse `__apply_closure`'s
  front guard, which deliberately lets `[[BoundThis]]` beat the caller-supplied
  receiver (§10.4.1.1, the CALL rule). Hence the explicit unwrap loop.
- `.prototype` is read from the innermost TARGET; a bound function has none.
- **Byte-neutrality gate**: the retry hangs off the #2872 dynamic-`$__ta_ctor`
  arm, which *every* host-free `new <any-typed binding>(…)` in the corpus goes
  through. A per-source-file "does this file contain a `.bind` property access"
  memo keeps bind-free modules byte-identical; gating on
  `ctx.boundFnTypeIdx >= 0` does **not** work, because a `new` site can compile
  before the `.bind` site that mints the type.

### Still open on #4196 after this slice

Rows 2–6 are untouched: builtin-ctor targets (8), IsCallable (1) +
restricted-property accessors (4), `this` not applied (3), the 3 null-derefs,
the `__get_builtin` CE, and `S15.3.4.5_A5`'s bare refusal
(`Function.prototype.bind.apply` — a distinct route from `.bind` and
`.bind.call`). Issue stays `ready`.

### Row 4 (`this` not applied) is a SUBSTRATE defect — see #4203

W21's §10.4.3 residue census handed over 8 more `.bind` files outside this
directory (`language/function-code/10.4.3-1-{77,79,80,98}{-s,gs}.js`), all
verified still failing on `issue-4196-bind-construct`. They are not a `bind`
bug: `__current_this` spells "no receiver installed" and "receiver is
explicitly `null`" with the SAME value (`ref.null.extern`), so a strict callee
answers `undefined` where §10.4.3 requires `null`. The identical gap blocks
`f.call(null)` / `f.apply(null)` in strict code (4 more files), so 12 come
together. Filed as **#4203**, with the lead that the substrate is closer than it
looks — the #2106 `undefinedSingleton` regime already gives standalone an
externref `undefined` distinct from `null`, and `$__bound_fn.thisArg` already
has the slot; `emitBoundFnValueFromLocals` (`calls.ts:2096`) is the one line
that currently discards boundness on the bind path.

Do **not** start #4203 before W21's top-level-`this`-as-receiver admission fix
lands (`named-this-call.ts` + `helpers/sloppy-this-global.ts`) — same files.
