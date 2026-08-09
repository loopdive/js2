---
id: 3494
title: "Standalone compileMulti must resolve literal dynamic imports from its module graph"
status: blocked
sprint: Backlog
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: compiler
goal: test262-conformance
lane: A
related: [440, 2932, 3362, 3491, 3492, 3493]
files:
  - src/compiler.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-3494-standalone-literal-dynamic-import.test.ts
loc-budget-allow:
  - src/compiler.ts
  - src/codegen/expressions/calls.ts
---

# #3494 — Standalone `compileMulti` must resolve literal dynamic imports from its module graph

## Problem

Dynamic `import()` currently always lowers to the host `env.__dynamic_import`
function. The compiler explicitly documents that this traps in standalone mode
because no JavaScript host exists. That is unnecessarily restrictive when
`compileMulti` receives a string-literal import whose target is already present
in the pinned virtual module graph.

The official Test262 reproducer is:

```text
language/module-code/top-level-await/module-graphs-does-not-hang.js
```

It statically imports a TLA fixture, then executes:

```js
await import("./module-graphs-grandparent-tla_FIXTURE.js");
$DONE();
```

The project runner previously false-passed this test by omitting bare
side-effect and literal dynamic fixture edges. Once #3492 supplies the honest
graph, the standalone lane must settle the internal import and resume the entry
module without a host callback.

## Evidence (2026-07-20)

- FYI original-harness standalone on Node 25.9.0 fails with
  `async completion marker not observed`.
- #3491 graph discovery handles static imports only, so the literal dynamic
  grandparent fixture is not yet transported.
- `src/codegen/expressions/calls.ts` states that every dynamic import delegates
  to `__dynamic_import` and will trap in standalone mode.
- The import specifier is a compile-time string literal and the target plus its
  transitive static dependencies exist in the pinned Test262 checkout.

## Feasibility finding

This is not a `calls.ts`-only lowering. `analyzeMultiSource` resolves virtual
static imports but discards the resulting graph. `generateMultiModule` then
flattens every supplied source into one realm-wide declaration table and one
eager initialization stream. It has no per-source evaluation state, cached
evaluation Promise, or module namespace object.

The minimum honest substrate is therefore:

1. Persist canonical static and literal-dynamic edges in `MultiTypedAST`.
2. Partition executable top-level initialization by source module.
3. Add cached per-module evaluators with `unstarted`, `evaluating`, `evaluated`,
   and `errored` states.
4. Create one stable namespace object per module, including live exports.
5. Drive module top-level await through the async frame engine so pending and
   rejected dependency Promises settle the cached evaluation Promise.
6. Handle static cycles as SCCs (or explicitly reject them in an initial
   slice), rather than treating a backedge as an already-evaluated module.

The existing native standalone Promise scheduler can carry the result once
those records exist. The current ordinary top-level-await expression path only
unwraps an already-settled native Promise synchronously; it cannot stand in for
a pending module evaluator.

## Bounded rewrite ruled out

A prototype restricted the target to an empty runtime body whose dependencies
were already entry-static-reachable, then rewrote `import()` to a native
`Promise.resolve` of a synthesized object. It compiled the FYI shape without a
host import, but the runtime identity/settlement regression did not complete in
`compileMulti`. More importantly, such an object is not a module namespace and
the fulfilled rewrite cannot preserve rejection, live bindings, repeated
cross-importer identity, or future executable target bodies. Keeping it would
be the exact false-positive placeholder prohibited by this issue, so the
prototype was removed.

The safe slice banked here is diagnostic integrity: standalone `import()` now
fails explicitly before registering `env.__dynamic_import`. The exact FYI graph
has a regression proving it is reported as unsupported rather than silently
compiled into an unusable host dependency. The host lane remains unchanged.

## Acceptance criteria

- Add a compiler-level standalone `compileMulti` regression with a literal
  dynamic import whose target is present in the supplied virtual files.
- Resolve the target relative to the importing virtual file and evaluate the
  internal module graph without importing `env.__dynamic_import`.
- Return a Promise-compatible value that settles after the target graph has
  evaluated, allowing top-level `await` to resume in the entry module.
- Preserve module namespace identity, single evaluation, rejection propagation,
  and transitive static dependency side effects for the supported literal case.
- Non-literal, missing, external, and import-attribute cases remain explicit
  unsupported/error paths in standalone mode; host behavior remains unchanged.
- Do not rewrite Test262 source or replace the Promise with an always-fulfilled
  placeholder.
- `module-graphs-does-not-hang.js` reaches `$DONE` in the honest FYI standalone
  lane under Node 25.
- Standalone import-leak gates and ordinary static `compileMulti` tests remain
  green.

## Validation

- Run `tests/issue-3494-standalone-literal-dynamic-import.test.ts`.
- The exact reproducer is intentionally a blocker characterization until the
  module-record substrate above lands; the namespace/evaluation acceptance test
  remains a TODO rather than a false green.
- Run dynamic-import, multi-source, async/TLA, and standalone import-manifest
  regressions plus TypeScript checks.
- Run the exact official path through both honest harnesses with fresh workers.
- Rerun the historical 3,472-path standalone comparison set and verify the row
  changes for the supported literal internal-import capability only.
