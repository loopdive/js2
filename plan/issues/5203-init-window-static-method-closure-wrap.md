---
id: 5203
title: Dynamic static-method dispatch during module init — `_wrapForHost` needs exports, so `JSBI.__clz30(t)` throws in the init window
status: done
assignee: ttraenkler/opus-dev-5203
completed: 2026-08-29
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5203 — init-window dynamic static-method dispatch (closure/`_wrapForHost` facet)

## Problem

Fifth Temporal module-init blocker (#4628 Option A). With #5191 (merged),
#5193 (PR #5252), #5201 (PR #5256) and #5202 (PR #5258) applied, the
polyfill bundle advances past `__clzmsd` and stops at:

```
TypeError: __clz30 is not a function
```

`jsbi.mjs` calls `JSBI.__clz30(t)` — a STATIC method on the builtin-derived
class, reached dynamically — during module init. `moduleInitRuns` stays
`false`.

## Reduced repro (from dev-5202, with after-init control)

```ts
class D extends Array {
  constructor(n: number) { super(n); }
  static clz(): number { return 9; }
}
function g(c: any): number { return c.clz(); }
const A: number = g(D);                              // THROWS: clz is not a function
export function test(): number { return g(D); }      // 9 — the control
```

Same family as #5193/#5202 (works after init, throws during it), different
surface: a static reaches the host as a raw closure struct in the
`__register_class_static_method` sidecar, and `_wrapForHost` needs `exports`
to turn it into a callable — the CLOSURE facet, not the dispatch-export
facet #5202 closed. Statically-resolved static calls (`D.clz()` written
directly) already work at init and are unaffected.

## Direction

Extend the #5193/#5202 start-exports channel to whatever export(s)
`_wrapForHost` needs, OR route init-window closure wrapping through the
registered funcrefs. Caution from dev-5202: `_wrapForHost`'s export argument
feeds a lot of unrelated behaviour — widening it deserves its own
measurement; keep the late path untouched and standalone/WASI out of scope.

## Acceptance criteria

1. Reduced repro above: `A === 9` at init, control still 9; new
   tests/issue-5203-*.test.ts failing on base (= the #5202 stack), passing
   with fix.
2. Temporal harness advances past `__clz30` on a probe tree with
   #5252+#5256+#5258+this. New later blocker → file it (coordinator
   allocates ids); `moduleInitRuns` true → say so LOUDLY.
3. No regressions in issue-5193/5201/5202 test files + scoped
   static-method/class runs (name them). Gates green.

## Notes

- Blocker chain: #5191 → #5193 → #5201 → #5202 → this.
- Stack on PR #5258's branch (issue-5202-init-window-prototypes) —
  sanctioned predecessor-stacking; lands after #5252 and #5258.
- Sibling issue #5204 covers the NON-timing parameter-bridge gap that will
  hit right after this (methods with arguments).
- Id #5203 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.

## Implementation notes (2026-08-29, opus-dev-5203)

### Which mechanism, and why not the other one

The issue offered two arms: widen the start-exports channel to what
`_wrapForHost` needs, or **route init-window closure wrapping through the
registered funcrefs**. This takes the second, and dev-5202's caution is the
reason: `_wrapForHost`'s `exports` argument is read by a large amount of
unrelated behaviour (vec/DataView/primitive decoding, own-key enumeration,
prototype vivification), so a module-init `exports` view reaching it would
change many paths at once for one symptom. Nothing in `_wrapForHost` moved.

### Root cause (measured, not inferred)

The throw comes from `__extern_method_call`'s `typeof fn !== "function"`
tail (`src/runtime.ts` ~L14057, reached via
`src/runtime/fixed-extern-method-call.ts:19`). A static reaches the host as a
RAW closure struct in the `__register_class_static_method` sidecar, and every
recovery arm on that tail ends in `_maybeWrapCallableUnknownArity` →
`_wrapWasmClosureUnknownArity`, both of which open with

```js
const exports = callbackState.getExports();
if (!exports) return null;      // ← the whole of module init
```

They need exports not to *find* the method but to *invoke* it: the closure is
called through the `__call_fn_<N>` / `__call_fn_method_<N>` dispatchers, with
`__is_closure` as the discriminator and `__closure_arity` for arity choice.
All exports, all unreachable while the `start` section runs.

So this is the CLOSURE facet, not the dispatch-export facet #5202 closed:
`__class_call_*` is never consulted for a static.

### Fix

1. `src/codegen/init-class-dispatch-helpers.ts` — the #5202 registration now
   also enumerates the closure-bridge family: prefixes `__call_fn_` and
   `__\0js2_call_fn_method_argc_`, plus the exact names `__closure_arity`,
   `__is_closure`, `__closure_has_rest`, `__is_ctor_closure`. Prefix-matched so
   a new arity is covered without another edit.
2. `src/runtime.ts` — `_wrapWasmClosureUnknownArity` and
   `_maybeWrapCallableUnknownArity` read `marshalExports(callbackState)`
   instead of bare `getExports()`.

### Downstream effects considered

- **Snapshot vs. live exports.** `_wrapWasmClosureUnknownArity` captures the
  `exports` object once and the dispatch closure keeps reading it, and the
  bridge is cached permanently in `_wasmClosureDynamicWrapperCache` — so a
  bridge built at init is used after init too. That is safe *only* because the
  dispatch body reads exactly four things from the snapshot
  (`__call_fn_<n>`, `__call_fn_method_<n>`, the argc wrapper, `__closure_arity`),
  and all four are now in the registered set — and because a `ref.func` passed
  to a JS import materializes as the SAME function object the export later
  yields. Adding a new export to the dispatch body without adding it to the
  registration list would reintroduce a partial snapshot; the prefix match
  makes that hard for the arity families and impossible to miss for a new one.
- **The NUL-named argc wrappers round-trip.** `__\0js2_call_fn_method_argc_<N>`
  goes into the pooled CSV; verified by intercepting the import that all 19
  names (6 argc + 5 direct + 6 method + 2 discriminators) arrive intact, NUL
  included. Without them the bridge silently falls back to the plain method
  dispatcher and the callee's `arguments.length` would be the dispatcher's
  arity, not the caller's.
- **Emitted bytes change for more modules than #5202 did.** The prologue is
  gated on "has a module initializer AND at least one registerable export";
  the closure family is present in nearly every JS-host module with top-level
  code, so those modules gain ~19 registrations (4 instructions each). #5202's
  byte-identity claim does not carry over and is not claimed here.
- **Init-window closures are now wrapped where they used to stay raw.** This
  is the intended behaviour change and it is broader than statics — e.g. the
  `__extern_set` store path that #4149 documents as "saved unwrapped because
  `_maybeWrapCallableUnknownArity` had no exports at store time" now wraps.
  The equivalence gate is the check on that.
- Standalone/WASI unreachable (`ctx.wasi || noJsHost(ctx)` guard, unchanged);
  the late `__setInstance` path untouched.

### Test results

- `tests/issue-5203-init-window-static-dispatch.test.ts` — 5 cases; **3 fail on
  base** (any-typed class value, static with arguments, plain-class static),
  2 pass on base and are deliberate controls (statically-resolved `D.clz()`,
  and a bare function value through an `any` alias — that one already worked,
  which is what pins the failure to the class-value route). All 5 pass with
  the fix.
- `tests/issue-5202-init-window-class-dispatch.test.ts` 5/5,
  `tests/issue-5193-init-marshal-host-typedarray.test.ts` +
  `tests/issue-5191-builtin-derived-class-value.test.ts` 34/34 — unchanged.
