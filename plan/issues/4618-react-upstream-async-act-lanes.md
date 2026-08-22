---
id: 4618
title: "react upstream suite: async it-body/act() lanes — depth-3 nested-async unwrap, fn-decl capture in suspending bodies, IR nested-fn CE"
status: ready
created: 2026-08-22
updated: 2026-08-22
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
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/statements/nested-declarations.ts
  - src/ir/prepared-callable-resolution.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/destructuring-params.ts::destructureParamObjectExternref
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/async-frame.ts::buildAsyncFrameInfo
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
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
