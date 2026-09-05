---
id: 4618
title: "react upstream suite: async it-body/act() lanes — depth-3 nested-async unwrap, fn-decl capture in suspending bodies, IR nested-fn CE"
status: ready
created: 2026-08-22
updated: 2026-08-24
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, async
language_feature: async, await, closures
goal: dogfood
related: [1042, 1373b, 3958, 4616]
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/closure-exports.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/function-body.ts
  - src/codegen/registry/imports.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/annexb-cancel.ts
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/declarations.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/expressions/extern.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
  - src/codegen/statements/nested-declarations.ts
  - src/ir/prepared-callable-resolution.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileSuperCall
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/destructuring-params.ts::destructureParamObjectExternref
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/async-frame.ts::buildAsyncFrameInfo
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/statements/nested-declarations.ts::compileNestedClassDeclaration
  - src/codegen/expressions/extern.ts::emitLazyClassObjectGet
  - src/runtime.ts::_wrapForHost
  - src/runtime.ts::<anonymous>#91
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/statements.ts::compileStatementInner
---

# react upstream suite: the async `it`-body / `act()` lane cluster

## Problem

`tests/dogfood/react-upstream-suite.mjs` (measured 2026-08-22 on the #4728
branch, jest at 319/331): **81/146 scored, 63 fail** (126 harness-incompatible,
module compiles + validates, 13 MB, 44 batches). Per-file: ReactChildren 18 ·
ReactES6Class 13 · ReactStrictMode 12 · ReactJSXRuntime 6 · ReactCreateElement 5
· ReactElementClone 5 · JSXTransformIntegration 2 · PureComponent 2.

Most of the failure mass shares ONE shape: React's tests are `it(name, async
() => { … await act(() => root.render(<Inner/>)) … })` — an async closure,
dispatched dynamically by the harness, that awaits a compiled async helper
which awaits a dynamic callback. Three distinct compiler defects were pinned
with minimized probes (all in `.tmp/probe-v*.mts` during the #4616 session,
reproduced against the #4728 branch):

### (a) Depth-3 nested compiled-async never unwraps/resumes

```ts
async function inner(cb: any): Promise<string> { const r = await cb(); return "inner=" + String(r); }
async function outer(): Promise<string> { const r = await inner(() => 9); return "outer(" + r + ")"; }
export async function t(): Promise<string> { return await outer(); }
// direct call of outer(): answer is "[object Promise]" — await did not unwrap.
```

Depth 2 (`t → inner`) works. Depth 3 (`t → outer → inner`) returns an
un-unwrapped Promise; in the it-body shape the inner frame simply never
resumes (probe vJ: `act` enters, the callback runs, the statement AFTER
`await cb()` never executes, and the outer promise resolves undefined).
This is the known **cps-unsupported-shape legacy lane** — the #1042
reconcile note gates "nested/buried await" to the legacy path, and the
legacy path's await is a passthrough (#1313 fixed the direct case only).
Every `await act(...)` react test dies here.

### (b) Function declarations inside a SUSPENDING async body lose captures

```ts
it("x", async () => {
  const Fragment = React.Fragment;           // (or const {Fragment} = React)
  function ParentComponent({useFragment}: any) { return useFragment ? Fragment : "s"; }
  await act(() => root.render(createElement(ParentComponent, …)));
});
// → ReferenceError "Fragment is not defined" thrown INSIDE the resumed
//   segment (stack: __async_resume_fanon → ParentComponent → the
//   unresolved-identifier hint import).
```

A nested function declaration hoisted in an async body that genuinely
suspends compiles its enclosing-const reads to the global-miss lane
instead of captures. The non-suspending variant (probe vD) captures fine,
so it is the CPS split (`splitBodyAtAwait`) that loses the binding
environment for hoisted fn-decls. This is the react "X is not defined"
sub-bucket (7 tests) and likely the "expected not null" bucket too (13
tests — components render null when their captured consts read undefined).

### (c) IR CE: nested function declaration in an async EXPORT function

```ts
export async function t(): Promise<string> {
  const marker = "ok";
  function inner(): string { return marker; }
  return inner();
}
// CE: "IR path failed for t: prepared unit …:nested-function:… /
//      t__nested_inner_0 has non-function type 0 [IR-FALLBACK]" and
//     "retained function t__nested_inner_0 references non-function or missing type 0"
```

Same shape as (b) but at the module boundary — the IR unit for the nested
fn is prepared with a broken type, and the failure is a hard CE, not a
demote.

## Non-async residual buckets (smaller)

- proxy `ownKeys` trap "returned extra keys but proxy target is
  non-extensible" (6) — the #983 live-mirror proxy's ownKeys vs a
  non-extensible target.
- mock-args / mock-call-count mismatches (12) — spy plumbing through
  createElement.
- `Cannot read properties of null (reading 'setState')` (2) —
  class-component `this` in the ES6-class bucket.

## Progress

- **(c) FIXED 2026-08-22** (on the #4728 branch): `preparedUnitProgramAbiBinding`
  now DEFERS program-ABI planning when the unit's allocator slot is still an
  unpatched placeholder (empty body, non-func typeIdx) instead of throwing —
  the async parent reaches slot binding before Phase 3 lowers the lifted
  nested body; the slot resolves by funcIdx and the Phase-3 patch lands in
  place. A real function with a broken type still fails loudly. Guards:
  ir-fallback gate OK, async equivalence 33/33, acorn 3518/3518, jest
  319/331 hold. Regression test: `tests/issue-4618-async-nested-fn-decl.test.ts`.
- **(a) diagnosis sharpened**: the callee DOES resume; the defect is the
  CALLER's await — `await <variable>` (non-call operand, e.g. in the
  runner's `const p = fn(); await p;` loop) is a PASSTHROUGH in the non-CPS
  lane. Two-line repro: `for (const p of ps) { const v = await p; }` over
  compiled-async promises yields "[object Promise]" per element. The
  canonical `await act(...)` (call operand) chains correctly at depth 2
  (probe vM) — depth 3 (`t → outer → inner`) still mis-unwraps.
- **(b) narrowed**: a hoisted fn-decl capturing a const in a suspending
  async arrow works when CALLED directly (probe vP: captured-ok). The loss
  needs the react ingredient: the fn-decl passed as a VALUE into a member
  call (React.createElement) — i.e. the host-callback/value materialization
  lane compiled from a CPS-split body.

- **NEW pinned defect (d), FIXED 2026-08-22**: the any-receiver first-match
  extern binding routes a WasmGC-STRUCT receiver into the generic
  `<Class>_<method>` host shim under a colliding ambient method name —
  `el.type()` on a struct with a closure-valued `type` field bound
  `env.CSSNumericValue_type`, whose shim read only `self[m] ?? sidecar`
  (both blind to struct fields) and silently answered undefined. The shim
  now resolves through `_resolveHostField` + `_maybeWrapCallableUnknownArity`
  (the same struct-aware path __extern_method_call uses). Regression test:
  `tests/issue-4618-extern-shim-struct-receiver.test.ts`. Did NOT move the
  react score (react reads `.type` as a property, not a call) — the
  misbinding class is real regardless (any struct-receiver method whose
  name collides with an ambient DOM member).
- **(b) minimal repro found (probe w3)**: hoisted fn-decl `Parent` reading a
  body const `Fragment`, ALSO referenced by an inner arrow (the act
  callback), then called directly in the RESUMED segment → ReferenceError
  "Fragment is not defined" from inside Parent's compiled body. Without the
  inner-arrow reference the same shape works (probes vZ/w2) — the arrow
  flips Parent's capture classification so the CPS spill/remap
  (`referencedInNamedNested` → ref-cell) misses Fragment. Additional
  sub-defect: a CLASS declaration captured by the hoisted fn-decl in a
  suspending body reads back null (`new Child()` → "Cannot read properties
  of null", probe vY with-class-capture).

- **2026-08-22 later findings**: the harness-shaped probe (async export fn,
  whole body in `try { … }`, fn-decl + `await act(...)` + post-await direct
  call — probe w8) now passes end-to-end after the liveness slice. The
  full react module STILL reports "ParentComponent is not defined"
  unchanged, so the remaining ingredient is inside the 13 MB module itself
  (JSX-transformed references through root.render/act chains, or
  batch-scale effects) — next step is IN-PLACE instrumentation of the
  generated react module, not more standalone probes. The class-capture
  null is now pinned tighter: it needs DYNAMIC DISPATCH of the enclosing
  closure (`register[0]()`), sync or async alike — direct calls work
  (probe w7: async-arrow-direct OK, async/sync-arrow-dynamic both
  "Cannot read properties of null") — i.e. the lifted/callback closure
  body lane loses sibling CLASS declarations for its nested fn-decls,
  independent of CPS.

- **2026-08-22 ROOT CAUSE of the react symbol buckets (in-module probes)**:
  instrumenting the pinned ReactStrictMode test inside the real 13 MB module
  (non-throwing expect probes; a throwing probe makes the test
  harness-incompatible because the native oracle fails too) pinned the
  failure to the SYMBOL CARRIER:
  - `typeof Fragment` (from `const {Fragment} = React`) answers **"object"**
    compiled vs "symbol" native;
  - `Fragment === React.Fragment` is **false** compiled (each host-boundary
    read mints a non-identical carrier) while a single read-chain stays
    self-consistent (`createElement(Fragment, null).type === Fragment` is
    true);
  - a direct `ParentComponent({useFragment:true})` call — which routes
    createElement(Fragment,…) — TRAPS with "dereferencing a null pointer".
  Everything else in the test body resolves (pc/child/createElement all
  `function` after the liveness slice). React's switch-on-type and
  `$$typeof` identity checks are exactly re-read symbol comparisons, so
  this one carrier defect plausibly underlies the "expected not null" (13),
  symbol-check (3+2) and mock-comparison buckets. This is the #2610
  symbol-as-any value-rep arc; #3961 fixed the struct-FIELD read-back but
  deferred exactly this carrier canonicalization. Fix direction: ONE
  canonical carrier per symbol id at every host-boundary read (a
  Map<symbolId, carrier> in the runtime + the compiled `typeof` arm
  answering "symbol" for it), or completing #2610.

- **2026-08-22 the symbol bucket's EXACT trigger, small-scale repro found**:
  `typeof React.Fragment` DIRECT is "symbol" and self-`===` holds — the
  degradation is ONLY the DESTRUCTURED binding (`const {Fragment} = React`)
  in a suspending async body whose name is ALSO referenced by a hoisted
  fn-decl (the ref-CELL spill lane). Twelve-line repro, TRAPS today
  (pre-existing — file-copy A/B against pre-liveness async-cps.ts produces
  the identical binary):

  ```ts
  const REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
  var exports_obj: any = {}; exports_obj.Fragment = REACT_FRAGMENT_TYPE;
  const NS: any = exports_obj;
  async function act(cb: any): Promise<any> { return await cb(); }
  export async function t(): Promise<string> {
    const {Fragment} = NS;
    function Parent(): any { return Fragment; }
    await act(() => 1);
    return typeof Fragment + "," + String(Fragment === NS.Fragment);
  }
  // RuntimeError: dereferencing a null pointer at __async_resume_ft
  ```

  Without the named-nested reference the same shape passes (plain spill —
  probe sym5), and without destructuring it passes (probe sym6 minus
  pattern). So the BindingElement + ref-cell + suspend combination is the
  broken lane: entry creates the cell (async-frame.ts ~2683) but the
  DESTRUCTURING declaration's init/read path doesn't flow through it. In
  react's bigger layout the same lane degrades to an object carrier
  instead of trapping (`typeof Fragment` = "object", `Fragment ===
  React.Fragment` false), which gates every switch-on-symbol/`$$typeof`
  comparison — the dominant "expected not null"/symbol buckets.

- **2026-08-22 boxed-destructure store slice LANDED**: the externref
  destructure lane stored a binding's extracted value with a plain
  local.set into a slot that IS a ref cell (boxed spilled binding) — the
  coercion cast the VALUE to the cell type (the 12-line trap above), and
  where it validated, the cell stayed unwritten so captures read null
  (A/B'd: base answers "symbol:null", fixed answers "symbol:6" on the
  let-{n}+arrow-mutation shape). Stores now redirect to a value-typed
  scratch and flush through the cell (boxedForInitStore convention). The
  sym6 trap is now a CATCHABLE "Fragment is not defined" — the residual is
  the OUTER pre-hoist not creating locals for BindingElements, so a
  hoisted fn-decl's capture of a destructured name still misses at
  hoist-compile time (plain consts pre-hoist fine, probe w8). Guards:
  destructuring battery 49/49, jest 319/331, acorn 3518/3518, cookie
  63740/63740 hold. Regression test:
  `tests/issue-4618-boxed-destructure-store.test.ts` (1).

- **2026-08-22 TDZ-flag-cells slice LANDED**: TDZ flags were per-invocation
  resume-fn LOCALS — the resume returns at every suspend and re-enters with
  zeroed locals, so a flag flipped by a declaration in state k read 0 in
  state k+1, and a hoisted fn-decl capturing the binding threw
  "X is not defined" from its boxed flag param AFTER the declaration ran.
  Flagged spilled bindings now persist TDZ state in i32 ref-cell frame
  fields (entry creates each cell; the resume prologue re-binds it into
  boxedTdzFlags/tdzFlagLocals — both emitLocalTdzInit and the call-site
  flag prepend are already cell-aware). The 12-line sym6 repro now fully
  passes: `symbol,true,viaFn=symbol,true` — destructured symbol keeps
  typeof AND identity, directly and through the hoisted fn, across the
  suspend. The legacy-lane shape (try + multi-await) also passes
  small-scale — the react module's degradation persists at 81/146, so the
  in-module ingredient is still unreproduced small; next owner: bisect the
  generated react module (comment out test-body parts) rather than more
  standalone probes. The 6-test tdz-reference-error battery fails
  IDENTICALLY with origin/main's src for every touched file (verified by
  file-copy A/B) — pre-existing, not this slice.

- **2026-08-22 sibling-class pre-collection slice LANDED**: a hoisted
  fn-decl in a CLOSURE body referencing a sibling class declared later in
  the same list constructed from null — the plain lane pre-collects
  classes in the collection phase, closure/callback/method bodies only
  collected them at statement execution (after the fn body compiled
  through the graceful-null fallback). hoistFunctionDeclarations now
  pre-collects sibling class declarations at its top-level pass (marked
  deferred so the statement-position compile still fills ctor/method
  bodies — an eager collect without the deferred flag left method stubs
  answering null). Probes w7 (sync + async dynamic dispatch) and cls1 all
  answer A,B. Residual: the CPS variant (class capture used in a
  POST-AWAIT call, probe vY with-class-capture) still answers null — the
  resume-lane class value path, same family as the fn-decl value
  rebinding. Also added (belt): sibling-class names are excluded from the
  hoisted fn's VALUE-capture list (they resolve via the global class
  machinery). Guards: class equivalence battery 24/24 + standalone class
  guards 37/37, jest 319/331, acorn 3518/3518 hold; cookie/clsx verified
  100% pre-restart. Regression test:
  `tests/issue-4618-closure-sibling-class-capture.test.ts` (1).

- **2026-08-22 the react "is not defined" ROOT pinned — DUPLICATE fn-decl
  NAMES across sibling test functions**: after the TDZ-cell + destructure
  slices, re-running the in-module Fragment probes shows the symbol carrier
  is FIXED in-module (the probe expect `t=symbol tag=[object Symbol]
  str=Symbol(react.fragment) ctor=Symbol` now PASSES inside the real
  module) and the test fails at the NEXT link: `root.render(<ParentComponent
  …/>)` → "ParentComponent is not defined" at RUNTIME from the sandbox
  dynamic-global lane (zero compile-time miss/TDZ emissions — instrumented
  all three emitters). Minimal repro (probe w12/w13): TWO OR MORE export
  async fns EACH declaring `function ParentComponent(){…}` + an act-arrow
  referencing it — ALL of them throw, even the first. With unique names the
  ReferenceError disappears. ReactStrictMode declares ParentComponent 3×,
  ReactChildren declares ComponentRendering* families repeatedly — this is
  the bare-name registry collision family (same disease as #4616 slice 16's
  closureMap leakage), interacting with the #4456 shadow machinery: the
  act-arrow's reference to the hoisted fn value resolves to NOTHING and
  falls to the dynamic-global read. Next owner: trace where the arrow's
  identifier read consults funcMap/closureMap during the shadow window —
  probe w12 compiles in seconds, no suite needed.

- **2026-08-22 duplicate-name matrix (seconds-fast probes w9/w13/w14/w15)**:
  the "is not defined" needs BOTH ingredients — the hoisted fn-decl crossing
  to HOST as a VALUE (`Host.take(ParentComponent)`) AND sibling test
  functions. Matrix: single fn + host-crossing → OK (w9); duplicates +
  DIRECT call → OK (w15); duplicates + host-crossing → ReferenceError from
  the INTERPRETER's envLookup (src/interp/loop.ts — zero compile-time
  miss/TDZ/hoist-fail emissions, all three instrumented; the value crossed
  as an INTERPRETED-callback whose env lacks the binding); UNIQUE names but
  two sibling exports each host-crossing → no error but the chained
  `taken.f(1)` result silently degrades to NaN (w14). So the value
  materialization of hoisted fn-decls interacts with BOTH the bare-name
  registries and the runtime-eval/interp callback lane. Next owner: find
  where a host-crossing fn-decl VALUE becomes an interp-backed callback
  (\`__runtime_eval_unwrap_interpreted_callback\`) instead of a
  \`__cb_\`/dynamic-bridge wrapper, and why sibling exports flip it.

- **2026-08-22 the "is not defined" bucket FIXED — react 81 → 85/146 (first
  score movement)**: `annexBReadEscapesFunctionScope`'s intervening-scope
  walk (`boundByInterveningScope`, annexb-cancel.ts) did not count a
  block-level FUNCTION DECLARATION as a lexical binding of its block
  (§14.2.3), so a read inside `try { function ParentComponent(){…} … }` was
  condemned by a SAME-NAMED Annex B site in a DIFFERENT sibling function
  and compiled to an unconditional "X is not defined" throw — every copy
  threw, even the first (probe w12/w13; unique names → no error, w14). The
  walk now counts sibling block fn-decls. ReactChildren 18 → 14. Guards:
  annexB battery 55/56 (the 1 pre-existing on base, A/B'd), jest 315/349,
  acorn 3518/3518, cookie 63740/63740 hold. Regression test:
  `tests/issue-4618-annexb-sibling-fn-name.test.ts` (1). The earlier
  "interp-callback" attribution was wrong — the ReferenceError text matched
  interp/loop.ts by coincidence; the real emitter was the Annex-B unbound
  throw (found by instrumenting emitAnnexBUnboundReferenceError). The
  chained `Host.take(fn).f(n)` NaN degradation (w14) remains a separate
  open defect.

- **2026-08-22 ownKeys/gOPD proxy invariants under `Object.freeze(element)`
  — react 85 → 87/146**: react dev builds freeze every element; freeze on a
  `_wrapForHost` proxy calls [[PreventExtensions]], which the handler did
  not trap, so the EMPTY proxy target got locked while `ownKeys` still
  reported the wasm object's keys — "'ownKeys' on proxy: trap returned
  extra keys but proxy target is non-extensible" (§10.5.11, 6 tests). Fix
  1: a `preventExtensions` trap that first materializes every
  `collectKeys()` key onto the target (via the handler's own gOPD +
  `Object.defineProperty`), marks the obj in `_wasmNonExtensibleObjs`, then
  locks the target. Fix 2 (follow-on §10.5.5 violations, 3 tests): once the
  target is non-extensible, `getOwnPropertyDescriptor` serves the target's
  descriptors verbatim instead of re-deriving them. Guards: freeze/seal
  battery 32/39 — the 7 failures pre-exist on base runtime.ts (A/B'd);
  jest 315/349 and acorn 3518/3518 hold. Regression test:
  `tests/issue-4618-proxy-freeze-invariants.test.ts` (1). Remaining react
  buckets: "expected not null" 13, mock args/count 12, null-deref "at
  933:18" ×7 (ReactChildren), setState null 2.

- **2026-08-22 bare `console` as a value — null-deref "at 933:18" ×7
  RESOLVED (no score change yet)**: the ×7 bucket was NOT ReactChildren —
  all 7 are ReactStrictMode "console logs logging" tests, and 933:18 is
  `target[key]` in the shim's `__jestSpyOn`. Bare `console` in value
  position (`spyOnDevAndProd(console, 'log')`) compiled to the
  null-externref fallback. Fix: added `console` to the existing host-only
  ERM-ctor identifier path in identifiers.ts
  (`__extern_get(__get_globalThis(), name)`, gated !standalone/!wasi,
  unshadowed). 3-line probe (.tmp/probe-console-val.mts): typeof console
  null → "object". The 7 tests now progress into rendering and fail later
  at "expected 0 toBe 1" — host react-dom does not invoke the compiled
  class component's render (the wider host-instantiates-compiled-class
  bucket; react stays 87/146). Guards: jest 315/349, acorn 3518/3518,
  freeze/annexB regression tests hold. Regression test:
  `tests/issue-4618-console-as-value.test.ts` (1).

## Implementation Plan — host-instantiates-compiled-class (the S-class bridge)

The dominant remaining react buckets ("expected not null" 13, "expected 0
toBe 1" ×7, `instance.props` null-derefs ~10, setState null 2) share ONE
seam: host react-dom receives a compiled `class Foo extends React.Component`
as element.type and must (a) DETECT it as a class
(`type.prototype.isReactComponent` truthy — chain walk to the fnctor
parent's prototype), then (b) CONSTRUCT it (`new type(props, context)`).
Today the class object crosses as a plain non-constructible `_wrapForHost`
proxy: no `[[Construct]]`, `.prototype` undefined (probe
.tmp/probe-hostclass*.mts: "Foo is not a constructor"). Measured secondary
compiled-side gaps (separate defects, masked for render because react-dom
assigns `instance.props` itself): `Foo.prototype.isReactComponent` is false
even in-module; `super(props)` into a fnctor base does not run the base body.

Slices (verified against current tree):

1. **Codegen registration** — `src/codegen/expressions/extern.ts
   emitLazyClassObjectGet` initBody (runs once at class-object singleton
   init, exactly like the #4371 static-method block): emit
   `__register_class_ctor(classObj, ctorClosure, protoObj, parentFnctor)`
   where ctorClosure = `emitFuncRefAsClosure` over
   `classMemberFuncKey(ctx, "<Class>_new")` (the alloc+init ctor used by
   compiled `new`), protoObj = `emitLazyProtoGet` (nested lazy-init inside
   initBody is fine), parentFnctor = `emitCachedFuncClosureAccess` over
   `fnctorAncestorOfClass(ctx, className)` or ref.null.extern. Import
   pre-registered in `src/codegen/index.ts` next to both
   `__register_class_object` sites (4 externref params; host lane only) to
   avoid late-import shifts against instructions already in initBody.
2. **Runtime mirror** — `src/runtime.ts`: `_classCtorClosures` /
   `_classProtoStructs` / `_classFnctorParents` WeakMaps + the import
   handler next to `__register_class_static_method`. At the main
   `_wrapForHost` return (`new Proxy(target, handler)` ~7521), a registered
   class object instead returns a `_makeClassCtorMirrorForHost` proxy over
   a real `function` target (modeled on `_wrapCallableForHost`): `construct`
   trap dispatches the ctor closure via `_maybeWrapCallableUnknownArity`;
   `apply` throws the §15.7 class-without-new TypeError; property traps
   delegate to the inner proxy; `fnTarget.prototype` (writable → no
   invariant conflict) is set to a chain-aware facade: own keys from the
   wrapped proto struct, misses fall back to
   `_getOrVivifyFnPrototype(parentFnctor)` so `isReactComponent` inherited
   from the compiled `React.Component` fnctor answers truthy.
3. **Validation** — probes: `new Foo(props)` from host works, `.marker`
   set, `.render()` dispatches, `Foo.prototype.isReactComponent` truthy;
   react suite (expect the class-component wall to move); guards jest
   315/349, acorn 3518/3518, freeze battery, equivalence spot files.

Instance-side inheritance needs NO new work: every ctor of a
fnctor-descendant class already tail-emits `__register_fnctor_instance`, so
`instance.setState` resolves through `_fnctorProtoLookup`.

Out of scope for the first slice: class-extends-class host chains (register
the parent classObj as a 5th arg later if needed), the compiled-side
`super(props)`-into-fnctor gap, and `Foo.prototype.isReactComponent`
in-module reads (host-side detection is what react-dom needs).

**2026-08-22 S1+S2 LANDED (probe-level green; react suite unchanged at
87/146 so far):**

- `__register_class_ctor(classObj, ctor, proto, parent, name)` emitted in
  emitLazyClassObjectGet's initBody (import PRE-registered in index.ts at
  both `__register_class_object` sites — a late import here shifts baked
  initBody call indices). Runtime `_makeClassCtorMirrorForHost`: mirror at
  the main `_wrapForHost` return; construct dispatches the ctor closure and
  tags instances (`_userClassTags` + `_fnctorInstanceCtor`) so host-side
  `instance.render()` resolves through the #3123 member surface; the class's
  instance method names are admitted to `ctx.hostDynamicClassMethodNames` so
  those exports exist. `_hostProxyCache.delete(classObj)` at registration —
  the #4616 name stamp can cache a plain proxy first.
- **Dynamic heritage must NOT be compiled inside initBody** — measured: the
  first class-value crossing produced a foreign struct. It is compiled at
  the class DECLARATION statement instead (`emitRegisterDynamicClassParent`
  → `__register_class_parent(name, value)`, name-keyed like the singleton;
  also the spec's extends-evaluation point). Nested classes only for now —
  top-level dynamic-extends classes still lack the chain (react's are all
  nested; probe B top-level shape constructs + renders but irc=false).
- **Top-level `F.prototype.m = …` was silently dropped from `__module_init`
  in host mode** (declarations.ts #2671 keep-arm deliberately excluded
  prototype chains — predates the #1712 vivified proto). React's whole
  `Component.prototype.*` surface is such writes. Now kept; write lands on
  the vivified proto (probe: in-module readBack 42, host read 42).
- Probes: nested react shape fully green — typeof function,
  `prototype.isReactComponent` true through the dynamic parent,
  `new Foo(props)` works, `inst.render()` dispatches. Guards: jest 315/349,
  acorn 3518/3518, cookie 63740/63740, clsx 32/32, class/fnctor/proto
  battery 148/149 (1 pre-existing), equivalence class/proto/closure subset
  64/66 (2 pre-existing, A/B'd on base via stash — solo session). Regression
  test: `tests/issue-4618-host-class-ctor-bridge.test.ts` (2).
- **React suite still 87/146**: class components now construct (the
  `instance.props` null-deref singles bucket is gone) but render still does
  not complete through react-dom's lifecycle — the count/mock buckets
  ("expected 0 toBe 1" ×7, mock args 7, call count 5, "expected not null"
  13) persist. Next: trace one StrictMode test's failure point inside
  react-dom with the bridge live.

- **2026-08-22 bridge hardening + e2e findings (react holds 87, jest 315)**:
  probe-driven E2E (real harness react-dom): a compiled
  `class Inner extends Base { render() }` DECLARATION renders THROUGH host
  react-dom end-to-end (`.tmp/probe-render3.mts` → "DIV:foo") — the bridge
  works for the simple declaration shape. Landed hardening: (a) extern.ts —
  pre-hoist `__new_plain_object` before the ctor `ref.func` bake and
  re-resolve the `__register_class_ctor` call index at push time
  (emitLazyProtoGet's late import shifts indices; flush repairs call sites
  in tracked bodies but NOT a captured index variable or an already-baked
  ref.func); (b) runtime — the mirror presents on ALL closure-wrap paths
  (`_maybeWrapCallableUnknownArity` / `_wrapCallableForHost` /
  `_wrapWasmClosureUnknownArity`, with a rawDispatch bypass for the mirror's
  own construct/apply), and `apply` dispatches the ctor closure instead of
  throwing (react's legacy module-pattern fallback CALLS an undetected
  class; pre-bridge behavior).
  **Found + REVERTED as a net regression (react 87→79)**: registering
  class-EXPRESSION ctor values (`Inner = class extends React.Component` —
  the ReactES6Class beforeEach shape) with the bridge broke 8
  `expect(element.type).toBe(Component)` identity tests — element.type
  wraps as the mirror while the direct read produces a different host
  function (a "[native code]"-stringifying bound/bridge fn), and unifying
  three wrap chokepoints did NOT close it. Class EXPRESSIONS therefore
  remain on the legacy callable-wrapper path (§10.2.2 ordinary construct)
  — the emitRegisterClassExprBridge helper was removed with the experiment;
  see this entry for its design if resumed. Separately measured residual:
  a 2-method class DECLARATION's value crossing reaches the host as a
  struct that is NOT the registered singleton (traced: registration stores
  obj#2, every crossing wraps other structs) — cause not yet located
  (suspect a second representation from the escape-gate/value-read path,
  NOT IR: JS2WASM_LOG_IR_FALLBACKS shows claimed=0). Debugging note that
  cost an hour: the react test environment captures console.error — use
  process.stderr.write for runtime-side instrumentation under the harness.

- **2026-08-22 the 2-method divergence ROOT-CAUSED and fixed — global-index
  staleness in emitLazyClassObjectGet**: string constants are IMPORTED
  globals; an intern mid-initBody (name stamp / static names / bridge name
  arg) shifts the global index space. `fixupModuleGlobalIndices` repairs
  maps + reachable bodies, but initBody is DETACHED during construction
  and `classObjectGlobalIdx` was a captured const — wasm-dis showed the
  lazy-init checking the PROTO global while setting the CLASS-OBJECT
  global; every crossing returned the proto struct. Fixed by pre-interning
  + liveBodies-registering initBody + per-push index re-reads. The
  2-method react shape now renders through host react-dom (probe
  "DIV:foo", was NULL); regression test extended (bridge test 3 cases).
  React stays 87/146 — the suite's failing class tests are class
  EXPRESSIONS (ReactES6Class `Inner = class extends React.Component` in
  beforeEach) still on the legacy path, and StrictMode's console-spy mock
  assertions. Same staleness family may affect emitLazyProtoGet's own
  captured `protoGlobalIdx` (unaudited). A second gated experiment —
  compiling class-EXPRESSION values as the singleton — made element.type
  cross as UNDEFINED; reverted, expressions stay on emitClassCtorValue.

- **2026-08-22 StrictMode bucket ATTRIBUTED to the (a) await/act lane, not
  classes**: the exact double-ctor StrictMode shape (class extends
  React.Component + ctor count++ + <StrictMode> wrapper + flushSync render)
  passes STANDALONE with the bridge (probe .tmp/probe-strictctor.mts:
  count=1, correct for production). In the suite the same tests read
  "expected 0 toBe 1" — the assertion runs BEFORE the un-awaited
  `await act(() => root.render(...))` completes (defect (a), #1042 arc) —
  and the one "expected 2 toBe 1" is the PREVIOUS test's deferred render
  flushing into the next test's count. Host-side `new` on a
  CAPTURE-carrying class also verified working (probe-classcapture2: ctor
  and method writes both land in the boxed capture). Remaining react mass
  therefore: (1) the #1042 await-act passthrough lane (StrictMode 7 +
  likely most "expected not null"/mock buckets), (2) the class-EXPRESSION
  value path (ReactES6Class 13), (3) spy/mock plumbing.

- **2026-08-22 spy/mock plumbing MINIMALLY PINNED (probe
  .tmp/probe-jestfn.mts)** — the shim's `__jestFn` shape compiled and its
  mock called FROM THE HOST fails three ways: (i) `mock.mock.calls.push`
  inside the mock body reads null — the fn-decl SELF-read (`mock.mock`)
  does not see the sidecar prop written after the declaration
  (`mock.mock = {calls: []}`), the #4616 fix-20 family but for an
  arguments-reader with post-decl props; (ii) other arities die with
  "__call_fn_0/__call_fn_1 not exported"; (iii) in the full harness the
  installed console spy traps "illegal cast" in `__fn_tramp_mock_*` when a
  HOST caller invokes it (probe-actlane2). This is the direct mechanism
  behind react's "expected mock arguments" (7) / "mock call count" (5)
  buckets and the StrictMode console-spy assertions. Next owner starts at
  the self-read materialization for `function mock()` +
  `Array.prototype.slice.call(arguments)` readers.
  **Sub-defect (i) FIXED same day**: prepareHoistedFunctionValueBindings
  now routes an observed fn-decl with an UNSTABLE capture ABI through the
  cyclic ref-cell strategy (cell identity fixed at entry, closure
  materialized into it at the declaration statement) instead of skipping —
  self-reads see post-decl props; compiled AND host invocations of the
  mock are tracked (probe-jestfn3: count 1 → 2 across the boundary; was a
  hard TypeError). Suites unchanged (react 87, jest 317/351 — the mock
  buckets also need the await/act lane) but every __jestFn-shaped mock now
  functions. 14 battery failures A/B'd identical on base. Regression test:
  `tests/issue-4618-observed-fndecl-unstable-captures.test.ts`. Residual:
  HOST-side `m.mock.calls` read still answers undefined (host wrapper
  sidecar view of the cell-mediated closure), and the harness-level
  "illegal cast in __fn_tramp_mock_*" (iii) is not yet re-measured.
  **Spy-on-host-object protocol FIXED same day (jest 317 → 322/356; first
  StrictMode pass in the filter run)**: the spy stored on `console` crossed
  as the BARE dynamic bridge, dropping the sidecar (`console.log.mock` /
  `.mockRestore` undefined; `.call` missing broke the platform-capability
  console adapter). Fixes: bridge stamps live accessors for the mock
  protocol (gated on a sidecar carrying `mock` — the ungated variant AND a
  mirror-on-every-path variant EACH broke acorn to 3/3518, both reverted);
  the callable wrapper's get serves %Function.prototype% members; extern_get
  resolves props through a bridge's raw closure; extern_set/strict store the
  prop-delegating mirror for prop-carrying closures landing on HOST objects.
  Guards: acorn 3518/3518, cookie 63740/63740, react 87/146 hold. Regression
  test: `tests/issue-4618-spy-bridge-protocol.test.ts`.

- **2026-08-22 same-named nested class DECLARATIONS silently shared ONE
  compiled identity — FIXED**: collection is name-keyed and the structMap
  guard no-oped duplicates, so react's per-test `class Foo extends
  React.Component` re-declarations all bound to the FIRST test's class
  (probe: two fns each declaring `class Foo`, the second answered the
  first's methods). Duplicates now mint the per-site synthetic identity
  class EXPRESSIONS use (collection: declarations.ts; statement compile
  binds the scoped VALUE to a same-named local; identity resolution via
  declaration node in class-expression-identity.ts + new-super's
  boundClassExpressionName walk now accept ClassDeclaration nodes;
  deferredClassBodies flag required or methods stay null stubs). En route:
  `class Component extends React.Component` false-tripped the §15.7.1
  own-name TDZ check on the property NAME (6 tests briefly regressed to
  "Cannot access 'Component' before initialization") — the walk now skips
  property-access NAME positions. React test outcomes unchanged at 87/146
  (the same-named-class tests also sit behind the await/act lane), but the
  wrong-class binding was real everywhere. Guards: acorn 3518/3518, jest
  322/356, cookie 63740/63740, class battery 147/147. Regression test:
  `tests/issue-4618-scoped-same-name-classes.test.ts` (2).

- **2026-08-22 scoped-class local binds the SINGLETON — react 87 → 88/146,
  StrictMode filter 0/7 → 2/7**: binding the scoped class local to the
  legacy ctor-value closure sent scoped classes down the lane without the
  host [[Construct]] bridge; binding the emitLazyClassObjectGet SINGLETON
  (bridge-registered) — uniformly, first declaration included — fixed
  double-ctor and double-getDerivedStateFromProps outright and moved
  state-updaters past its setState null-deref. Remaining in that filter:
  the render-dispatch variants (count++ inside render never runs —
  instance.render dispatch through the bridge for the batch shapes).
  **Root cause of the remaining render-dispatch failures PINNED (traced
  end-to-end)**: with same-named sibling classes of IDENTICAL FIELD LAYOUT
  in one module, WasmGC type canonicalization makes their struct types ONE
  type — the member dispatchers' `ref.test` cascades (`__member_kind_*` /
  `__class_call_*`) then match BOTH arms and the FIRST wins, so the
  canonical class's instance dispatches to the SIBLING's method body
  (probe-actlane5: canonical Foo's render — count++ — never runs; the
  synthetic sibling's bare render runs instead; detection/construct/kind
  all traced correct). The `__tag` field (ctx.classTagMap, struct field 0)
  is the intended per-class disambiguator — the fix is tag-guarded dispatch
  arms (or class-qualified `__class_call_<Class>_<m>_<n>` dispatchers, the
  pattern the externref-backed path already uses) for classes that share a
  canonical layout. This gates the StrictMode render variants and likely
  the ES6Class "expected not null" family. Implementation caveat for the
  tag-guard: a PARENT class's dispatch arm currently matches SUBCLASS
  instances via ref.test subtyping (inherited-method dispatch) — guard each
  arm with the class's tag PLUS all descendant tags (classParentMap walk),
  or guard only within the same-layout conflict set, or a bare
  `tag == ownTag` check will break `class Sub extends Base {}` inherited
  calls.
  **IMPLEMENTED same day — react 88 → 91/146, StrictMode filter 3/7**: the
  `__class_call_*` cascade arms in emitMethodDispatch are now tag-guarded
  (own tag + descendant tags via classParentMap walk) whenever the entry's
  field layout collides with another entry's — zero byte change otherwise.
  The kind/arity discriminators (emitClassMemberKindExports, separate
  function scope) are NOT yet guarded — a wrong-arm `kind` answer is
  behaviorally benign today (both arms answer "method") but an arity
  mismatch between same-layout siblings could still mis-select; follow-up
  if a shape surfaces. Guards: acorn 3518/3518, jest 322/356, cookie
  63740/63740, clsx 32/32; the 16 issue-1712 battery failures are
  identical on base (A/B'd).

- **2026-08-22 cross-KIND name hijack fixed — react 91 → 94/146**: the
  classObjectGlobals identifier branch resolved by NAME, so `class Foo`
  anywhere in the module made every same-named identifier read the class
  singleton — including a sibling scope's `function Foo()` (react's
  StrictMode batch declares a class in one test, a function in the next;
  the function crossed to the host as the class mirror and was never
  callable as itself). The branch now verifies CHECKER identity
  (`ctx.oracle.valueDeclarationOf`): a class/class-expression declaration
  re-resolves through its per-site synthetic (anonClassExprNames); a
  function/arrow/parameter/variable declaration OPTS OUT and falls through
  to the normal identifier lanes. Guards: acorn 3518/3518, jest 322/356,
  cookie 63740/63740, clsx 32/32, 4618 battery 10/10. Regression test
  added to `tests/issue-4618-scoped-same-name-classes.test.ts` (cross-kind
  grab: F() === "fn").
  **Residual pinned (capture-loss family, probe-crossasync fncount=0)**:
  routing is fixed, but a `function Foo()` declared in an ASYNC body whose
  sibling scope has the same-named class builds a BARE closure without its
  captures — boxed `count` writes go nowhere. Lead: the act-arrow's
  closures.ts skip-condition (~L3400) checks
  `fctx.hoistedFunctionValueBindings?.has(name)` on the ARROW's fctx while
  the binding lives on the DECLARING fctx — the arrow never captures the
  sibling fn-decl when `ctx.funcMap.has(name)`.
  **Capture-loss residual FIXED same day — react 94 → 95/146.** The
  closures.ts lead was wrong: the callback DID capture `count` correctly in
  both A/B probe variants (traced — the skip on `Foo` is fine because
  `count` rides the transitive-capture walk). The real defect was
  downstream in identifiers.ts's funcref-as-value arm: its
  `!ctx.classSet.has(name)` veto is NAME-keyed, so the class Foo anywhere
  in the module vetoed the arm for the sibling FUNCTION Foo — the read
  fell to the graceful default, crossing a bare value whose capture writes
  went nowhere. The veto now yields when `ctx.funcMapOwnerDecl.get(name)`
  IS the declaration the reference resolves to (checker identity).
  Guards: acorn 3518/3518, jest 322/356, cookie 63740/63740, clsx 32/32,
  4618 battery + #2669 21/21; issue-1712 1 failure identical on base
  (A/B'd). Regression test: cross-kind captures case in
  `tests/issue-4618-scoped-same-name-classes.test.ts` (5 total).

- **2026-08-22 method-capture promotion hardened (3 defects, react holds
  95/146)**: react's `componentDidMount(){ test = this }` family traced
  end-to-end in the real per-file batch. Fixed:
  (1) `promoteAccessorCapturesToGlobals`'s #2669 funcMap skip is name-keyed —
  the shim's module-level `function test` blocked promotion of a shadowing
  enclosing `let test`; the skip now yields when the local provably shadows a
  module-level function (no `funcMapOwnerDecl`, not a hoisted value binding).
  (2) The #2818 defer heuristic's `wouldPromote` carried the SAME veto — a
  try-nested class under the collision compiled eagerly and promotion never
  fired (`[promote-entry] refs=∅`). Same discrimination applied.
  (3) Module-init compiles twice with `capturedGlobals` CLEARED between
  passes, while class method bodies compile ONCE (bound to pass-1 globals) —
  the re-compile's early return left the frame reading a fresh local while
  methods wrote the pass-1 global. New `ctx.classMemberCaptureGlobals`
  records each class's promoted globals at full compile (threaded out of
  promoteAccessorCapturesToGlobals via `promotedRecord`) and the early
  return re-binds them + syncs the fresh local; `ctx.capturedGlobalsOwner`
  keeps sibling same-named bindings from silently reusing another frame's
  global (mints fresh instead — an unguarded broad resync variant broke the
  ES6Class `Outer`/`Foo` test and was replaced). Records ride the
  fixupModuleGlobalIndices shift walk (an unshifted record hit "immutable
  global cannot be assigned").
  Regression tests: `tests/issue-4618-method-capture-promotion.test.ts` (2).
  Guards: react 95/146 zero flips, jest 322/356, acorn 3518/3518, cookie
  63740/63740, clsx 32/32; issue-2818/2029/1712 failures identical on base.
  **Root cause of the remaining ~12 `Cannot access property on null` tests
  PINNED but NOT yet fixed**: componentDidMount NEVER RUNS in the batch —
  react-dom treats the class as a FUNCTION component because
  `Test.prototype.isReactComponent` is false: `__register_class_parent`
  received NULL (the static member lane's read of `React.Component` at the
  declaration nulls in the batch while the body's own read answers an
  object). Registration now stores the live container + key
  (`__register_class_parent_ref`) and the mirror resolves lazily host-side —
  but the container (the compiled `exports` struct behind
  `require('react')`) exposes `Component` through NO host lane tried so far
  (sidecar `__get_*`, `__sget_*` export probe, `_wrapForHost` proxy, plain
  read all answer null/undefined). Next lead: find which store the compiled
  `exports.Component = Component` write lands in for the batch module, or
  resolve the parent compiled-side via a dedicated export instead of a host
  read. The facade now installs even without a proto struct and treats a
  NULL own-prop answer as a miss (the wasm-object proxy answers null, not
  undefined) — both needed once the parent resolves.

- **2026-08-22 top-level-function classSet veto lifted (react holds 95, the
  detection chain is one link from closing)**: `React.Component` READ NULL
  inside the batch module — `typeof React.Component` says "object" (the
  typeof lane answers statically) while the VALUE read was null, because the
  funcref-as-value veto (`!classSet.has(name)`) is name-keyed and the
  per-test `class Component` declarations vetoed value reads of react's own
  top-level `function Component`, so `exports.Component = Component` stored
  NULL. Fixed like fix 50: a checker resolution to a TOP-LEVEL
  FunctionDeclaration with no nested funcMap owner lifts the veto (probe:
  `.tmp/probe-cc.mts`, regression test added to
  issue-4618-scoped-same-name-classes). `React.Component` now reads a
  function batch-wide.
  **Remaining broken link (traced, still open)**: react-dom STILL treats the
  class as a function component. Runtime traces show `Component.prototype
  .isReactComponent = {}` writes DO land in a sidecar proto, but the parent
  value that reaches the mirror's lazy resolver (via the exports struct's
  `__get_Component` sidecar getter) is a DIFFERENT closure identity — its
  vivified proto lacks the write (`pfIsIrcProtoTarget=false`). Two closure
  materializations of the same top-level function exist; neither
  emitFuncRefAsClosure nor emitCachedFuncClosureAccess traces fire for the
  reads, so the read lane is a third path (existingClosure/moduleGlobals
  branch in identifiers.ts is the lead). Unify the identity (or route the
  mirror's parent-proto through the SAME store the `F.prototype.m=` writes
  use) and the whole ES6Class/CreateElement/JSXRuntime detection bucket
  (~20 tests) should open.

- **2026-08-22 NaN-props residual: exhaustive lane hunt, reverted as
  score-neutral.** After the detection fix the NaN/normalize-props tests run
  their lifecycle but die on `expect(test.props.value)`: the instance's
  `.props` VALUE read answers null/undefined while a host read of the same
  object answers the sidecar object react-dom wrote. Four fallback layers
  were implemented and measured (dispatcher struct-arm null→host fallback +
  undefined-aware miss test; inline-IC decline under dynamic-heritage
  classes; static fast-path fallback in emitNullGuardedStructGet; fix-48
  style __tag guards on member-get field arms via a new
  `classDynamicHeritageSet`): react stayed 97/146 with zero flips, and
  runtime import tracing showed the whole p2/p3 read lane never calls ANY
  host import — the read resolves entirely in-wasm through a lane none of
  the four patches reach (the dispatcher WAS called per WAT but its
  miss-fallback never fired at runtime; only ONE `__extern_get(…,"props")`
  crossed per run). All four patches were REVERTED (uncommitted) as
  unproven complexity; the probes stay in `.tmp/probe-nan.mts` (batch,
  fully instrumented) and `.tmp/probe-fproto.mts`. Next session: trace the
  resume fn's `$62` local flow around the `call $__get_member_props` site
  in `.tmp/react-batch.wat` (~line 176223+) — the receiver feeding the
  dispatcher, not the dispatcher itself, is now the suspect.

- **2026-08-22 unmatched-callable dispatch host fallback — react 97 →
  109/146 (the whole ReactChildren mock bucket, +12, zero flips)**: the
  `__call_fn_N` / `__call_fn_method_N` dispatchers terminated in a bare
  `ref.null.extern` when the callee matched no closure-struct arm — but a
  callable that crossed the host boundary and came back (react's
  `Children.forEach(children, callback, ctx)` passes the callback through
  an extern method call; the compiled wrapper's
  `forEachFunc.apply(this, arguments)` then dispatched a genuine HOST
  function) was silently dropped. Standalone repro chain:
  `.tmp/probe-applyargs.mts` D/F (object-literal method wrapper → 0 hits;
  `count`'s identical wrapper worked because its callback stayed a wasm
  closure). New `hostCallableFallbackTerminal` in closure-exports.ts emits
  `__call_function_<arity>(fn, thisArg, args…)` for a non-null unmatched
  callee (host lane, arity ≤ 4; null keeps the old null answer).
  Guards: jest 322/356, acorn 3518/3518, cookie/clsx 100%, dispatch
  battery 35/36 (#1712 pre-existing). Regression tests:
  `tests/issue-4618-host-callable-dispatch-fallback.test.ts` (2).

- **2026-08-22 instance-props residual PINNED PRECISELY (runtime-traced)**:
  react-dom's `instance.props = props` write DOES reach the object wrapper's
  set trap → `_safeSet` → the `__sset_props` writeback — which returns **0**
  (no dispatch arm matches the instance's runtime type), because a
  dynamic-heritage class like `class Test extends React.Component` declares
  NO own `props` field — the value can only live in the host sidecar. The
  compiled read (`this.props` in render / `test.props` in the assertion)
  ref.test-matches an UNRELATED same-canonical-layout struct's arm and
  answers that arm's slot. Fix direction for next session: for
  dynamic-heritage classes, route instance member reads through the sidecar
  lane end-to-end (the four reverted read-fallback layers each missed the
  actually-executing lane — instrument the resume fn's local flow first,
  don't re-guess). This gates the 9-test ES6Class "expected not null"
  family + the NaN/normalize-props family.

## Fix order

1. (c) first — it is a hard CE with a two-line repro and pins the IR
   nested-function type-table bug.
2. (b) — the capture environment for hoisted fn-decls across
   `splitBodyAtAwait`; unlocks "is not defined" + likely "expected not null".
3. (a) — extend the CPS-supported shapes to the buried-await/depth-3 case
   or make the legacy lane's await do a real unwrap (the #1313 fix scoped
   to direct call results only). #1042 remains the acceptance owner for
   the general case; this issue only needs the `await <compiled-async
   call>` composition react uses.

## Acceptance

- The three probes above (checked into the issue as text) behave per spec.
- react upstream suite: the "is not defined" bucket (7) and the act()-shape
  failures move; target ≥ 100/146 scored.
- jest 319/331, acorn 3518/3518, cookie 63740/63740, clsx 32/32 hold.

## 2026-08-23 park root cause FIXED — fix-49's var opt-out broke `var C = class` (205 class/elements regressions)

The PR #4728 merge_group auto-park (205 regressions in
`test/language/expressions/class/elements`, net −255, all "TypeError: Cannot
convert undefined or null to object" in verifyProperty/module-init) bisected
to **aa6ae8af (fix 49)**: its checker-identity guard opted every
VariableDeclaration binding out of the classObjectGlobals arm — but
`var C = class { … }` is the DOMINANT test262 class-elements shape, and the
var-bound class expression IS that arm's class. Every read of `C` fell to
the normal identifier lanes (undefined). The guard is narrowed: a var/let/
const binding opts out only when its initializer is provably a function
value (function-expr / arrow — the react StrictMode cross-kind case fix-49
exists for); a class-expression initializer keeps the class arm (per-site
synthetic honored via anonClassExprNames keyed on the initializer node).

Validated: 4 sampled park regressions flip back to pass via the real
test262 runner; the full 1004-baseline-pass class/elements sweep re-running;
react holds 109 (incl. the cross-kind grab test), acorn 3518/3518, jest
328/358, scoped-same-name-classes 7/7. Regression test:
`tests/issue-4618-var-bound-class-expression-identity.test.ts` (both
directions: var-bound class expression stays a class; function-valued const
still opts out).

## 2026-08-23 merge_group regression triage (post-#4728 merge) — capture-record keying

PR #4728's merge_group run 32618016516 failed (net −168; 216 wasm_compile) but
the queue landed the chain anyway; main carried the regression. Bisected with
the single-file src-checkout script to **9565dea9** (fixes 51–52):
`ctx.classMemberCaptureGlobals` was keyed by CLASS NAME, and `structMap` is
name-keyed too — so test262 TemporalHelpers' dozen `class MySubclass extends
construct` helper methods sent the SECOND same-named class into the
early-return rebind arm with the FIRST one's record. The sync then emitted
`global.set <other frame's global>` from a differently-typed local —
`global.set expected f64` module-wide wasm validation failure across ~216
Temporal files. Fixed on the follow-up branch: the record map is keyed by the
class DECLARATION NODE (stable across module-init's two passes, distinct for
same-named siblings), and the sync only fires when the fresh local's ValType
matches the recorded global's. Regression test:
`tests/issue-4787-temporal-merge-group-regressions.test.ts` (same-named
sibling classes case, fails on the merged base).

## 2026-08-24 assignment-position class identity checkpoint

The ReactES6Class setup uses `let Inner; Inner = class extends
React.Component { ... }`, so its class value took the generic
`wasmClosureDynamicBridge` path. That wrapper was constructible but had no
registered class prototype or dynamic-parent mirror. A narrowly gated class
expression RHS of plain `=` now materializes the canonical lazy class-object
singleton and registers dynamic heritage at ClassDefinitionEvaluation.
Classes with an implicit constructor and runtime parent also stamp the class
registration; the host mirror applies the synthesized parent initializer to
the allocated derived receiver. Inline class expressions and Proxy/call
argument sites keep their existing closure representation.

Two adjacent name/capture defects surfaced while exercising the original
shape and are fixed generically:

- late-discovered class declarations inside host callbacks no longer reuse an
  earlier same-named graph-wide class entry; each lexical owner receives its
  per-site synthetic identity;
- same-named boxed method captures no longer reuse a sibling frame's global,
  and the per-class capture record now restores its boxed-cell metadata on the
  module's later compile pass.

Focused regressions are green: assignment-position host construction,
ReactDOM rendering, implicit and explicit runtime/compiled-parent
initialization, late class-owner isolation, and sibling boxed-capture
isolation are **10/10**. The nearby host class constructor and var-bound
class-identity guards remain green.

The exact original ReactES6Class filter now executes 24/273 upstream tests:
14 scored (**3 pass, 11 fail**) and 10 harness-incompatible; the module still
compiles and validates. This is up from the original 2/14 baseline: the simple
stateless class component is the newly passing full-batch case.

An additional generic superclass fix now calls a statically named top-level
function parent on the already allocated derived receiver when there is no
compiled class `_init` (`class Foo extends Component { constructor(props) {
super(props); } }`). The isolated verbatim upstream test "renders based on
state using initial values in this.props" flips to **1/1 pass**, proving that
`React.Component` initializes `this.props` and the derived constructor can
initialize `this.state`. The complete 24-test batch remains 3/14, however:
later same-named class declarations in the same generated module still perturb
that earlier test's class identity and leave its container empty. The next
blocker is therefore the batch-scale per-site class registry/lookup, not the
fixed assignment representation or SuperCall semantics.

## 2026-08-24 batch-only same-layout class-member collision fixed

The 3/14 batch result above was not a remaining class-object lookup failure.
The earlier and later `class Foo` declarations have distinct tags, but the
host-visible class-member dispatch only requested a tag guard when *another
class declaring the same member* had the same canonical WasmGC layout. That
missed the important negative case: a later same-layout `Foo` declared a
lifecycle method that the earlier `Foo` did not declare at all. Because the
method had only one positive dispatch entry, its unguarded structural
`ref.test` accepted the earlier instance and exposed the later class's method.

Class-member dispatch now compares each arm against every emitted struct with
the same canonical layout, including siblings that do not own that member,
and applies the existing per-class tag test on collision. The focused
regression `does not expose a method owned only by a same-layout sibling` pins
the exact positive/negative pair without React-specific names or behavior.

Fresh evidence on the shared candidate tree:

- isolated original upstream `renders based on state using initial values in
  this.props`: **1/1 pass**;
- complete original `ReactES6Class` filter: **8/14 scored pass**, 24/273
  upstream tests executed, 10 harness-incompatible, 0 quarantined, and the
  module compiles and validates;
- focused class identity/capture matrix: **18/18 pass** across
  `issue-4618-scoped-same-name-classes`,
  `issue-4618-class-capture-owner-isolation`, and
  `issue-4618-class-expression-assignment-bridge`.

This closes the batch-withdrawal subproblem (3/14 → 8/14). The six remaining
scored ReactES6Class failures are later semantics (state updates, derived
state, force-update, and lifecycle ordering), not the same-named class leak.

## 2026-08-24 host-visible static results and React state writeback

The first full-suite measurement after the class-member tag fix is now the
authoritative checkpoint: **138/180 scored pass**, 42 fail, 92
harness-incompatible, 272/273 upstream tests executed (one upstream skip), 44
batches, zero quarantined, and every batch compiles and validates. This is a
measured +5 over the prior 133/180 checkpoint; no denominator was projected.

The remaining derived-state cluster exposed two separate boundary defects:

- a registered class static method used the generic closure bridge's
  deliberately raw plain-call return. React successfully called
  `getDerivedStateFromProps` with the right arguments, but received an opaque
  WasmGC object and could not read its returned state keys. Registered static
  closures are now branded in a `WeakSet`; only their Wasm-struct object
  results are reified for the host. Ordinary closure exits retain the raw
  behavior that protects the broader regression corpus;
- a class extending a runtime property/element-access parent such as
  `React.Component` stored a declared closed-object field like `state =
  {foo, bar}` in a typed Wasm ref. React later replaced `instance.state` with
  a plain host object after merging derived state. The typed `__sset_state`
  could not store that host object, so compiled `render()` kept reading the
  initializer while the host sidecar held the new state. Closed-object fields
  on this dynamic-host-parent class family now use an externref carrier, making
  host replacement and compiled reads share the same live field.

Exact original upstream evidence (clean pinned checkout, no source probes):

- `sets initial state with value returned by static
  getDerivedStateFromProps`: **0/1 → 1/1**;
- `updates initial state with values returned by static
  getDerivedStateFromProps`: **0/1 → 1/1**;
- `renders updated state with values returned by static
  getDerivedStateFromProps`: **0/1 → 1/1**.

Every focused binary compiles and validates. The static-object return is also
pinned outside React by the assignment-position class bridge regression,
including own-key enumeration and `Object.assign`; dynamic-parent field
writeback has a separate host-replacement regression.

The fresh complete measurement confirms all three flips with no withdrawals:
**141/180 scored pass**, 39 fail, 92 harness-incompatible, 272/273 executed,
44/44 batches compile and validate, zero quarantined. That is exactly +3 over
the preceding 138/180 measurement. The ReactES6Class batch is now **11/14**
scored pass (formerly 8/14), with the three remaining failures limited to the
explicit-constructor ref, forceUpdate, and lifecycle-ordering cases.

The next shared cluster is now localized but intentionally not patched in this
checkpoint. In ReactCreateElement's default-prop/ref case, the component's own
compiled `render()` observes `this.props.fruit === "mango"`, and a temporary
host-side inspection of the exact same ref instance observes an own `props`
object with key `fruit` and value `"mango"`; nevertheless the subsequent
compiled expression `instance.props.fruit` answers `undefined`. The value is
there and the host proxy is correct. The remaining defect is the dynamic
consumer read: an `any`/externref class instance can enter the call-site
closed-struct candidate ladder before the authoritative `__extern_get`
sidecar-aware fallback, allowing a structural false-positive to mask inherited
host state. The NaN-prop ref case and the lifecycle-captured instance case have
the same outward symptom. Any follow-up should preserve the in-Wasm candidate
fast path for ordinary dynamic objects (Acorn performance); route only proven
host-mutated/class-instance carriers to the sidecar-aware read or add an exact
class/sidecar discriminator. All temporary probes were removed and the pinned
upstream checkout is clean.

## 2026-08-24 React ref-cell identity at the host renderer boundary

The explicit-constructor test's class and `setState` method were already
correct. Its `React.createRef()` value crossed through the harness's required
Wasm-element reifier, which recursively cloned every props object. Cloning the
public ref shape `{ current: null }` broke its defining identity contract:
ReactDOM wrote the rendered instance into the clone while the compiled test
read the original cell and still saw `null`.

The reifier now preserves a one-key `{ current }` cell instead of cloning it.
The existing Wasm host wrapper provides live reads and writes, so ReactDOM and
the compiled caller share the same ref without a React-specific compiler
builtin. Ordinary props and element records continue through the recursive
reifier.

Exact evidence:

- original `renders based on state using props in the constructor`: **0/1 →
  1/1**;
- full original `ReactES6Class` filter: **11/14 → 12/14**, 24/273 upstream
  tests executed, 10 harness-incompatible, zero quarantined, and the binary
  compiles and validates;
- focused infrastructure identity assertion confirms
  `prepareReactValue(ref) === ref`.

The two remaining scored failures are the `forceUpdate` rerender and complete
lifecycle-ordering cases. They no longer share the ref-cell blocker.

## 2026-08-24 ReactES6Class wind-down and remaining two-test handoff

The last clean full-batch measurement remains the authoritative result:
**12/14 scored ReactES6Class tests pass**, with 24/273 upstream tests executed,
10 harness-incompatible, zero quarantined, and a compiling, validating module.
The focused retained regression matrix is **31/31 pass** across assignment-
position class construction/static dispatch, same-named class identity and
capture isolation, and the React host-infrastructure adapter. The TypeScript
typecheck is green.

The two remaining original failures are deliberately not hidden or rewritten:

- `renders using forceUpdate even when there is no state`: a temporary probe
  proved the compiled assignment has already changed `mutativeValue` from
  `"foo"` to `"bar"` before `forceUpdate`; the same canonical host proxy still
  has React's updater and fiber metadata, and the native `forceUpdate` call
  returns. The observed output nevertheless remains `"foo"`. This localizes
  the remaining defect after the field write and inherited method dispatch,
  in rerender scheduling/result propagation. A proposed broad fnctor-parent
  fallback was not retained: its isolated probe passed but withdrew in the
  complete focused file because the runtime's dynamic-parent registry is
  still keyed by a repeated class name rather than the class object's lexical
  identity.
- `will call all the normal life cycle methods`: the original test remains the
  exact oracle for mount, update and unmount callback order and arguments. It
  needs the same stable per-class host identity across successive root renders
  before individual lifecycle callback semantics can be attributed safely.

After this checkpoint, concurrent shared-tree work made an exact filtered
rerun stop during instantiation with `WebAssembly objects are opaque`; that is
not counted as a React result and does not replace the measured 12/14 baseline.
All temporary React diagnostics were removed. The oracle-ratchet check now
reports only unrelated concurrent files (array/import/call lowering), not the
retained React closure changes, so no React-specific oracle allowance was
added.

## 2026-08-24 ReactES6Class completion: tagged field writes and underscore methods

The final two scored failures had independent generic causes:

- React writes several framework-owned keys (`state`, `props`, `context`) onto
  a compiled class instance through the host proxy. WasmGC `ref.test` is
  structural, so `__sset_state` could match a same-layout sibling class and
  overwrite an unrelated field at the same physical slot. In the forceUpdate
  case it reset `mutativeValue` from `"bar"` to `"foo"` between scheduling and
  `render()`. Struct-field setter arms now include the class's nominal `__tag`
  (plus descendant tags for inherited fields). Crucially, a tag or anonymous
  shape mismatch is part of the outer arm condition and falls through to the
  next structurally-equal candidate; treating it as an inner no-op fixed the
  false write but initially blocked legitimate React state writes.
- Host class-member collection recovered a method key with
  `fullName.slice(fullName.lastIndexOf("_") + 1)`. That truncated methods whose
  real source name contains underscores, so argument-bearing lifecycle hooks
  such as `UNSAFE_componentWillReceiveProps(nextProps)` and
  `UNSAFE_componentWillUpdate(nextProps, nextState)` were excluded from the
  host bridge. The collector now receives the already-known source key rather
  than re-parsing a synthesized identifier.

Exact original upstream evidence is now **14/14 scored ReactES6Class tests
pass**, with 24/273 upstream tests executed, 10 harness-incompatible, zero
quarantined, and a module that compiles and validates. The two-test completion
filter is **2/2**, and the generic same-layout class regression file is
**10/10**. No upstream test body was changed and all temporary diagnostics
were removed.
