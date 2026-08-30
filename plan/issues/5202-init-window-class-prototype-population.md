---
id: 5202
title: Compiled class prototypes are empty during module init — the #5193 window's method/prototype facet blocks Temporal
status: done
assignee: ttraenkler/opus-dev-5202
completed: 2026-08-29
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
# Two small growths; the mechanism itself went into a NEW module
# (src/codegen/init-class-dispatch-helpers.ts) plus a helper in the existing
# src/runtime/init-marshal-registry.ts.
#  - runtime.ts (+~20): the `__register_init_class_export` handler must live in
#    the import-resolution switch, and one resolver call site swaps one
#    expression (`exports` → `marshalExports(callbackState, exports)`).
#  - codegen/index.ts (+~10): one import + one call in each of the two finalize
#    pipelines, at a placement contract only expressible there.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/index.ts
# Dispatch/sequence functions whose growth IS the new arm/step (same rationale
# as #5193, which added the sibling arm to both).
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateModule
---

# #5202 — class prototypes unpopulated during the module-init window

## Problem

Fourth Temporal module-init blocker (#4628 Option A). With #5191 (merged),
#5193 (PR #5252) and #5201 (PR #5256) all applied, the jsbi receiver is now
CORRECT at the failing call (`[object Array]`, proto ctor `JSBI`, own keys
`0, sign`) — but `JSBI.prototype` carries only `constructor`, so
`_.__clzmsd()` still throws `__clzmsd is not a function`. `moduleInitRuns`
stays `false`.

## Mechanism (isolated by dev-5201)

Timing, not dispatch. Same source, same wiring, only the call's timing
differs:

```js
class D extends Array { constructor(n, s) { super(n); this.sign = s; }
                        __clzmsd() { return 7; } }
function f(a) { return a.__clzmsd(); }

const AT_INIT = f(new D(1, false));                     // THROWS
export function test() { return f(new D(1, false)); }   // returns 7
```

The host runtime populates a compiled class's prototype with its methods
only once it has the instance's exports, wired via
`result.importObject.__setInstance(instance)` — callable only AFTER
`WebAssembly.instantiate` returns. Top-level code runs in the wasm `start`
section, DURING instantiate, so every prototype is bare for the whole of
module init. This is the #5193 window again — its method/prototype facet
(#5193 fixed the marshalling-probe facet via the `__register_init_export`
funcref registry, PR #5252).

Corroborating detail from dev-5201: on the same binary,
`runtime.buildImports(...)` + explicit `setInstance` answers correctly for
the after-init shape while `result.importObject` alone throws.

## Direction

Extend the #5193 mechanism (src/runtime/init-marshal-registry.ts /
src/codegen/init-marshal-helpers.ts — `getStartExports()`): the prototype
population that `__setInstance` performs late should be doable from the
start-section prologue too, using the same funcref-registration channel
(method funcrefs registered before the class's first top-level use), or by
having `__register_class_*` calls at init time consult the start-exports
registry. Decide with evidence; keep the late `__setInstance` path intact
for the non-init case, and keep standalone/WASI untouched.

## Acceptance criteria

1. The reduced repro above: `AT_INIT === 7`, host lane, failing on base and
   passing with the fix (new tests/issue-5202-*.test.ts; include the
   after-init control).
2. The Temporal harness advances past `__clzmsd`
   (`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs`, run on
   a tree containing #5252 + #5256 + this). If a NEW later blocker appears,
   file it (coordinator allocates ids when the scan is degraded) and record
   it. If `moduleInitRuns` flips `true`, say so LOUDLY — that un-gates
   #4628's integration step.
3. No regressions in the #5193 test file, the #5201 test file, and scoped
   class/method runs (name them). Ratchet gates green.

## Fix

**Mechanism: extend the #5193 start-export channel with a NAME-keyed
registration, and let the class-method resolver read it.** Decided against the
two alternatives, with evidence:

- *Populate `Sub.prototype` during init instead.* Rejected: there is nothing to
  populate it WITH. A compiled method is not a JS function object anywhere —
  `__set_subclass_proto` synthesizes a bare `class Sub extends Parent {}`, and
  the runtime answers `inst.m()` by calling the compiler-emitted dispatch
  EXPORTS (`__class_call_*`, `__member_kind_*`, `__member_arity_*`,
  `__call_get_*`) through `_resolveClassMemberOnInstance`. The issue title says
  "prototypes are empty"; measurement says the prototype is empty AFTER init too
  and that is fine — the missing thing is the export view, not the prototype.
  Confirmed by instrumenting the throw: it comes from `__extern_method_call`'s
  `typeof fn !== "function"` arm, and `_resolveClassMemberOnInstance` bails on
  its literal first line, `if (exports === undefined) return miss`.
- *Make `deferTopLevelInit` (#2796) the default* — i.e. run top-level code from
  an exported `__module_init` after `setInstance`, the way standalone/WASI
  already does. This is the real structural cure and would close every facet of
  the window at once, but it changes the host contract for every consumer
  (website, playground, test262, library users must call
  `instance.exports.__module_init()`), and #2796 deliberately kept it opt-in for
  byte-identity. Out of scope here; worth a separate issue.

### What landed

- `src/codegen/init-class-dispatch-helpers.ts` (new) — prepends
  `__register_init_class_export(namesCsv, index, ref.func $export)` onto
  `__module_init` for every class-method dispatch export the module emitted.
  Placement contract mirrors #5193's (after `emitIteratorMethodExport`, before
  dead-import elimination / the #1984 freeze / `finalizeInModuleInitFlag`).
- **Wire shape — one CSV, not one string per name.** #5193 could use a fixed
  positional `i32` id because its helper set is six names, append-only. The
  dispatch surface is one export per (class, method, arity), unbounded and
  module-specific; a string constant per name would add one imported
  `string_constants` global PER NAME (hundreds on a Temporal-sized bundle). The
  module registers ONE pooled comma-separated name list and indexes into it, so
  the cost is one new pooled string + one new import + four instructions per
  export. The runtime splits the CSV once per distinct string
  (`classDispatchExportName` in `src/runtime/init-marshal-registry.ts`);
  splitting per call would be quadratic.
- `src/runtime.ts` — handles the new import (unknown index ignored, so an older
  runtime tolerates a newer module) and passes `marshalExports(callbackState,
  exports)` instead of bare `exports` at the `_invokeClassMethod` call site in
  `__extern_method_call`. That is the ONLY resolver site changed: the property-
  READ sites (`_resolveClassMember` at the `__extern_get`/gOPD paths) were left
  alone because nothing measured needs them and widening them would change what
  `getExports() !== undefined` means on paths that use it as a
  "post-instantiation" test.

As in #5193 this is a pure TIMING shim: a `funcref` passed to a JS import
materializes as the same function object the export later yields. The registry
stays OUT of `getExports()`, the late `__setInstance` path is untouched, and
standalone/WASI never reach the emitter (`ctx.wasi || noJsHost(ctx)` early
return; the nativeStrings `-1` string-pool sentinel is also refused).

### Evidence

- Reduced repro, A/B on this branch's base (PR #5252's branch), file-copy revert:
  base `TypeError: __clzmsd is not a function` thrown from
  `WebAssembly.instantiate`; with the fix `atInit() === 7` and the after-init
  control `test() === 7`.
- `tests/issue-5202-init-window-class-dispatch.test.ts` — 3 of 5 cases fail on
  base, 5 of 5 pass with the fix. The 2 that pass on base are deliberate
  controls (plain WasmGC-struct class; module with no dispatch exports).
- Byte-identity: 13/13 `website/playground/examples` binaries hash-identical
  base vs fix (sha1 of `result.binary`, measured 2026-08-29 on this branch).

### Harness result — advanced, still gated

`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs` on a probe tree
of #5252 + #5256 + this (2026-08-29):

```
esm (linked, modern): compile() success=true — 0 errors, binary 1,569,833 bytes
esm (linked, modern): WebAssembly.compile() OK
esm (linked, modern): WebAssembly.instantiate() FAILED — TypeError: __clz30 is not a function
"moduleInitRuns": false
```

The blocker moved from `__clzmsd` to `__clz30`, so criterion 2 is met.
**`moduleInitRuns` is still `false`** — #4628's integration step stays gated.

**NEW BLOCKER, fifth in the chain — dynamic STATIC-method dispatch during the
same init window.** `jsbi.mjs` calls `JSBI.__clz30(t)`, a static on the
builtin-derived class. Reduced repro, measured with an after-init control:

```ts
class D extends Array {
  constructor(n: number) { super(n); }
  static clz(): number { return 9; }
}
function g(c: any): number { return c.clz(); }
const A: number = g(D);                              // THROWS: clz is not a function
export function test(): number { return g(D); }      // 9 — the control
```

Same family (works after init, throws during it), different surface: a static
reaches the host as a raw closure struct in the `__register_class_static_method`
sidecar, and `_wrapForHost` needs `exports` to turn it into a callable — so it
is the CLOSURE facet, not the dispatch-export facet this issue closes. Not
folded in here: `_wrapForHost`'s export argument feeds a great deal of unrelated
behaviour, so widening it deserves its own measurement and its own issue.
Statically-resolved static calls (`D.clz()` written directly) already work at
init and are unaffected.

### Deliberately NOT fixed here (pre-existing, NOT timing)

Measured with an after-init-only control on the base branch — these fail
*after* init too, so they are not this window:

- a builtin-derived method taking arguments (`add(x: number, y: number)`) →
  `add is not a function`;
- a builtin-derived rest-param method (`sum(...xs: number[])`) →
  `sum is not a function`;
- a builtin-derived getter (`get g()`) → reads `NaN`.

`emitExternrefClassMethodDispatch` publishes the class-qualified bridge only
when every parameter passes `supportsHostClassBridgeParam`, which an `f64`
parameter does not. jsbi's `__clzmsd()` is zero-arg, so the harness gets past
it; the next jsbi method that takes arguments will hit this instead. Worth its
own issue.

## Notes

- Blocker chain: #5191 (class value null) → #5193 (init marshalling window)
  → #5201 (lossy vec representation) → this.
- Prerequisites: PR #5252 and PR #5256 should be on main before this lands
  (the harness measurement depends on both); the reduced repro itself may
  reproduce on plain main.
- Id #5202 reserved with a degraded PR scan (gh offline); manually verified
  against all open PR head branches on 2026-08-29 (the one grep hit for
  "5202" is the long-merged PR #5202's deno branch, not an issue file). The
  `check:issue-ids:against-main` gate arbitrates.
