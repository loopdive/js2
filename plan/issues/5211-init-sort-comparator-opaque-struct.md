---
id: 5211
title: invokeMethod never callable-wraps struct arguments — a compiled comparator crosses to Array.sort as an opaque struct
status: done
sprint: current
priority: high
horizon: m
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/dev-5211
created: 2026-08-30
completed: 2026-08-30
# `invokeMethod`'s argument-marshalling loop gains the two-step
# callable-then-facade wrapping every other host-dispatch path already uses,
# plus the #5209 `marshalExports` view and the comment explaining why the DOM
# hot path is untouched. All of it inside `resolveImport`.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
---

# #5211 — compiled sort comparator crosses as an opaque struct

## Problem

Eleventh Temporal module-init blocker (#4628). With the full fix stack plus
PR #5283 (#5209), the polyfill sorts the era table right after the filter
guard and stops at:

```
TypeError: The comparison function must be either a function or undefined: [object Object]
    at Array.sort (<anonymous>)
    at invokeMethod                 src/runtime.ts:10952
    at GregorianBaseHelper_init ← OrthodoxBaseHelper_init ← EthiopicHelper_init ← __module_init
```

`moduleInitRuns` stays false.

## Mechanism (located by dev-5209)

`invokeMethod` (src/runtime.ts:10952) wraps struct arguments with
`_wrapForHost(args[i], exports)` where `exports = callbackState?.getExports()`
(undefined at init — the same window family), and **never applies
`_maybeWrapCallableUnknownArity` to arguments at all** — so a compiled
comparator closure crosses to the host `Array.sort` as an opaque struct even
after init. Two facets to verify separately:

1. Timing: `getExports()` → `marshalExports()` on that path (the established
   pattern from #5193/#5202/#5205/#5209).
2. Capability: callable-wrapping of struct arguments that are compiled
   closures. dev-5209 deliberately did NOT do this — `invokeMethod` is the
   DOM lane's hot path and adding callable-wrapping semantics to arguments
   is a behaviour change needing its own regression run. Measure the
   after-init behaviour of `arr.sort(cmp)` with a compiled closure on base
   first: if it is ALSO broken after init, this is a capability gap, not
   just timing.

## Acceptance criteria

1. Reduced repro: `t.sort((a,b) => a.x - b.x)` on an untyped param inside a
   ctor, at init AND after init, host lane; plus a DOM-lane-shaped control
   (host method taking a compiled callback via invokeMethod) proving no
   behaviour change where it worked before. New tests/issue-5211-*.test.ts
   failing on base for every wrong row.
2. Perf sanity on the invokeMethod hot path — no wrapping added for
   non-closure structs; state how you kept the fast path.
3. Temporal harness measured before/after on the full stack (…#5279 → #5283
   → this). Advances past the sort error; new later blocker → report
   precisely; `moduleInitRuns` true → say so LOUDLY.
4. No regressions in issue-5209/5207/5205 test files + DOM/host-method
   scoped runs (name them). Gates green.

## Notes

- Found by dev-5209 while validating PR #5283. Related unfiled observations
  recorded in that PR's body (dynamic-receiver init trap — possibly #5210
  family; vec write-side exports not on the init channel) — file them only
  if they land on the critical path.
- Id #5211 reserved with a degraded PR scan; manually verified against open
  PR head branches 2026-08-30. `check:issue-ids:against-main` arbitrates.

## Implementation notes (dev-5211, 2026-08-30)

### Result first

**`moduleInitRuns` flipped to `true`.** The @js-temporal/polyfill ESM lane now
compiles, validates AND finishes `WebAssembly.instantiate()`. This was the last
module-init blocker in the #5193 → #5209 series; the harness headline changed
from "compiled + validates, but module init THROWS" to "compiled + validates +
module init ran", and `moduleInitError` is `null`.

### Which facet was real — the issue's guess was half right

The issue proposed two facets and asked which are real. Measured answer:

| Facet | Real? | Evidence |
| --- | --- | --- |
| 2 — capability (`invokeMethod` never callable-wraps arguments) | **YES, and it is the reported failure** | The reduced repro throws the exact reported TypeError **at init AND after init**. Timing is not the axis at all. |
| 1 — timing (`getExports()` → `marshalExports()`) | **YES, but a different symptom** | A non-closure **vec** argument reaches the host as the generic `[object Object]` proxy during init instead of its array facade. Separately reproducible; unrelated to the sort throw. |

So facet 2 alone unblocks Temporal. Facet 1 is fixed in the same two lines
because it is the identical divergence #5209 closed in the twin dispatcher, and
it now has its own failing-on-base row.

### Root cause

`invokeMethod` (the generic `extern_class` method shim, `src/runtime.ts`)
marshalled struct arguments with `_wrapForHost` **alone**. `_wrapForHost`
builds a DATA facade — a struct/vec/tuple view — and never builds a callable.
Every other host-dispatch path in the runtime already does two steps, callable
bridge first and host facade otherwise: `wrapHostValue` in
`__extern_method_call`, the keyed-collection (`Map`/`Set`) arm 130 lines above
in the same `switch`, and `wrapLinkedProviderValue`. This one dispatcher did
only the second step.

The polyfill's era table, minified, is

```js
n = n.filter((e) => e.code);          // -> a REAL host Array (post-#5209)
n.sort(((e, t) => { … }));            // comparator crosses as a raw struct
```

`n` is `any`, so `tryExternClassMethodOnAny`'s first-match loop binds `sort` to
the first ambient extern class declaring it — `Uint8ClampedArray_sort`
(confirmed by instrumenting the resolver: the harness logs exactly
`[extern_class] Uint8ClampedArray sort 2`). At runtime `self` is the host
Array, `self["sort"]` is `Array.prototype.sort`, and the argument arrives as a
non-callable facade: *"The comparison function must be either a function or
undefined: [object Object]"*.

### Why a reduced repro is fiddly (and what makes the rows valid)

Two things must both hold or the defect is invisible:

1. **The TypedArray extern classes must be registered.** Without them the
   first-match loop finds no `sort` candidate and the call falls to
   `__extern_method_call`, which has had both fixes since #5209 — a different
   dispatcher, no bug. A bare `const _re = /x/;` in the module registers them.
   Every row in `tests/issue-5211-invoke-method-callable-arg.test.ts` carries
   it, and that line is load-bearing, not decoration.
2. **The comparator must NOT be an inline arrow that the call site can turn
   into a `__make_callback` bridge.** An inline arrow usually crosses as a real
   JS function, so `hasStructArg` is false and `invokeMethod` never touches it.
   A comparator held in a variable crosses as a struct and reproduces the throw
   verbatim. (The polyfill's inline arrow does cross as a struct — its body is
   a multi-statement closure inside a nested function expression — but that is
   an accident of that shape, not a rule, so the test uses the variable form
   which reproduces deterministically.)

The inline-arrow rows are kept as **controls**: they passed on base, they must
keep passing, and they are precisely the fast path this fix must not disturb.

### The fix

One block, in `invokeMethod`'s argument loop:

- callable bridge first (`_maybeWrapCallableUnknownArity`), host facade
  otherwise (`_wrapForHost`) — the same two-step every sibling path uses;
- `marshalExports(callbackState, exports)` for the facade, not the strict
  `exports` local. `exports` stays untouched because the arms below read it as
  "init has finished"; only the marshalling question gets the wider view.

### How the DOM hot path stays fast

`invokeMethod` is the DOM lane's hot path (#4150: 5,000 of
`dom/set-attributes`'s 7,000 crossings land here), so the shape of the fix
matters more than its content:

1. **The added work is entirely inside the existing `hasStructArg` branch.**
   No new predicate, no new loop, no new allocation on the common path — the
   `callArgs = args` no-copy path is byte-identical.
2. **The DOM lane never enters that branch.** Its arguments are strings and
   host element handles (`MockElement` / real `Element`), never WasmGC structs.
   Pinned by the DOM-lane control test, which drives the
   `dom/create-elements` + `dom/set-attributes` shapes against a recording mock
   and asserts the recorded attributes and child order.
3. **The fixed-arity wrappers below still short-circuit** before `invokeMethod`
   runs at all when no argument is a struct — unchanged.
4. **A non-closure struct argument keeps exactly its previous result.**
   `_maybeWrapCallableUnknownArity` asks the module's own `__is_closure`
   discriminator and returns the value unchanged for anything else, so those
   arguments still take `_wrapForHost`. The one added cost is a single
   `__is_closure` call per *struct* argument — a path that was already
   allocating a new `callArgs` array and building a proxy.

### Defects found and NOT fixed here

1. **Standalone lane: `.sort(cmp)` on a dynamic receiver is a silent no-op.**
   `[3,1,2]` in, `[3,1,2]` out, no throw, both at init and after — while the
   statically-typed receiver sorts correctly. Wrong answers, not a crash.
   Entirely independent of this change (host-lane only), and reproduced on
   pristine `origin/main`.
2. **An omitted optional argument is lowered to `null`, not `undefined`.**
   `n.sort()` on an `any` receiver reaches native `Array.prototype.sort` as
   `sort(null)` and throws *"...must be either a function or undefined: null"*.
   Pre-existing, unchanged by this fix, pinned by a `known-unfixed` row so the
   eventual fix is noticed.
3. **The `#5193` init-marshal helpers are registered only when the module needs
   them elsewhere.** A module with no vec-producing call registers none, so
   `marshalExports` is still `undefined` during its init and a vec ARGUMENT
   still crosses as `[object Object]`. Adding one `t.filter(...)` anywhere in
   the module flips the same row from wrong to right — i.e. the residue is a
   codegen emission-condition gap in `src/codegen/init-marshal-helpers.ts`, not
   a runtime gap. The facet-1 row in the test uses the registering shape.
4. **UMD lane still fails at `WebAssembly.compile()`**, unchanged before and
   after: `Compiling function #472:"__closure_35" failed: type error in
   return[0] (expected externref, got i32)`. Only the ESM lane is unblocked.
5. **8 test failures pre-exist on pristine `origin/main`**, unrelated to this
   stack: `tests/dom-containment.test.ts` (4), `tests/externref.test.ts` (1),
   `tests/issue-3058-dyn-view-proto-methods.test.ts` (3). Verified by running
   them against `origin/main`'s `src/` directly.
