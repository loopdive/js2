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
related: [3140, 4192, 2928, 4163, 4201]
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
