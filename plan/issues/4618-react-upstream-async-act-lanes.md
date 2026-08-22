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
