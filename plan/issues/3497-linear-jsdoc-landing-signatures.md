---
id: 3497
title: "Resolve exact-source JSDoc signatures for the linear IR landing benchmarks"
status: done
completed: 2026-07-23
sprint: 75
created: 2026-07-20
updated: 2026-07-20
pr: 3446
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir, codegen-linear, benchmarking
language_feature: jsdoc-function-signatures
es_edition: multi
goal: backend-agnostic-ir
depends_on: []
related: [2949, 2956, 3498]
origin: "2026-07-20 explicit user request: unblock the exact landing benchmark JavaScript sources without source rewriting"
files:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - tests/issue-3497-linear-jsdoc-landing-signatures.test.ts
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #3497 — Exact-source JSDoc signatures for linear IR landing benchmarks

## Problem

The four checked-in landing programs are ordinary JavaScript files whose
exported `run` functions use standard `@param {number}` and
`@returns {number}` JSDoc annotations. Compiling the exact bytes with
`target: "linear"` and `allocator: "analysis-stack"` currently selects no IR
functions. Each annotated `run` is rejected as
`select:return-type-not-resolvable`.

The recursive program also contains an unannotated local `fib(n)`. Its type can
only become concrete through call-graph/body propagation from the annotated
export. `string-hash` has separate unsupported `.charAt()` / `.charCodeAt()`
lowering after signature selection; those methods are explicitly outside this
issue.

## Reproduction on current main

Verified against `origin/main` `4b6cccfe8c79278093313fbb8efef3253f089e67`
with each source read directly from
`website/public/benchmarks/competitive/programs/<name>.js` and passed to:

```ts
compile(source, {
  target: "linear",
  allocator: "analysis-stack",
  fileName: exactPath,
});
```

| Program         | IR compiled | Selector rejection(s)                         | Compile result |
| --------------- | ----------- | --------------------------------------------- | -------------- |
| `fib`           | none        | `run: return-type-not-resolvable`             | success        |
| `fib-recursive` | none        | `fib`, `run: return-type-not-resolvable`      | success        |
| `array-sum`     | none        | `run: return-type-not-resolvable`             | success        |
| `string-hash`   | none        | `run: return-type-not-resolvable`             | string methods unsupported |

## Root cause

TypeScript represents a JavaScript JSDoc signature through its effective type
annotation APIs/checker facts; it does not populate
`ParameterDeclaration.type` or `FunctionDeclaration.type`. The checker-backed
`buildTypeMap` used by the WasmGC overlay therefore sees these annotations, but
the linear selector path calls `planIrCompilation` without that map.

At the final selector/build boundary, both `src/ir/select.ts` and the shared
AST-to-IR signature resolver in `src/ir/from-ast.ts` inspect only the raw
`.type` properties. A standard JSDoc primitive consequently looks exactly like
an unannotated dynamic signature and is rejected before IR lowering.

## Implementation plan

1. Centralize parameter/return type-node lookup at the selector boundary using
   TypeScript's public JSDoc APIs. Prefer explicit TypeScript syntax and accept
   only the same primitive/function-type nodes the selector already accepts.
2. Reuse that lookup in the shared AST-to-IR signature resolver so a function
   selected from JSDoc receives the same IR parameter/result types during
   lowering. Do not parse comment text, synthesize annotations, rewrite source,
   or special-case benchmark paths/names.
3. Preserve the existing `any`/dynamic move-only gate and rejection of
   unsupported union/non-primitive signatures.
4. Add focused JavaScript/JSDoc selector and exact-source linear compile tests,
   including a negative unannotated dynamic case.
5. Probe all four exact landing files and record the post-fix selection/build
   matrix. The string-method failures remain expected and out of scope.

## Acceptance criteria

- [x] Exact `fib.js` selects and IR-compiles its annotated `run` export.
- [x] Every annotated landing `run` stops failing with
      `select:return-type-not-resolvable`.
- [x] Standard JSDoc `number`, `boolean`, and `string` signatures resolve
      without source rewriting or filename/function-name special cases.
- [x] Explicit/dynamic `any`, unannotated dynamic operations, unions, and
      unsupported non-primitive signatures are not widened into primitive IR
      claims.
- [x] `fib-recursive` is reported honestly; infer its internal `fib` only when
      the existing call-graph/type evidence makes that safe.
- [x] Focused tests, typecheck, lint, and format checks pass; no local Test262
      run is performed.

## Test results

CI initially exposed that TypeScript's public declarations do not include the
internal `getEffectiveTypeAnnotationNode` / `getEffectiveReturnTypeNode`
helpers. The fix-forward uses `param.type ?? ts.getJSDocType(param)` and
`fn.type ?? ts.getJSDocReturnType(fn)`, preserving explicit annotation
precedence and the tested selector behavior.

- `pnpm exec vitest run tests/issue-3497-linear-jsdoc-landing-signatures.test.ts`
  — 6/6 passed.
- `pnpm exec vitest run tests/issue-2859.test.ts tests/issue-2949-slice3b-any-dynamic.test.ts tests/linear-integration.test.ts`
  — 19/19 passed.
- `tests/issue-1169q.test.ts` — 9/10 passed on both this branch and unchanged
  `origin/main`; the pre-existing async telemetry assertion expects
  `non-export-modifier` although current main reports `async-function`.
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed.
- `pnpm run format:check` — passed.
- `pnpm run check:ir-fallbacks` — passed with no baseline delta.
- `pnpm run check:linear-ir` — passed (`compiled=8`, baseline `8`; no baseline
  update required).
- No local Test262 run, per scope.

### Post-fix exact-source matrix

| Program         | IR compiled | IR rejection(s) | Compile result |
| --------------- | ----------- | --------------- | -------------- |
| `fib`           | `run`       | none            | success; `run(10) === 55` |
| `fib-recursive` | none        | `fib: select:return-type-not-resolvable`; `run: select:call-graph-closure` | success through direct fallback |
| `array-sum`     | none        | `run: build` (`empty array literal needs a vec-typed hint`) | success through direct fallback |
| `string-hash`   | none        | `run: build` (string compound-assignment representation) | expected direct-path `.charAt()` / `.charCodeAt()` errors |

Every annotated `run` now passes the selector's signature gate. The latter
three rows expose independent, explicitly out-of-scope body/lowering gaps
rather than losing the JSDoc signature.

The internal recursive `fib` remains conservative. TypeScript's checker/oracle
reports its unannotated recursive signature as `any -> any`; inferring `f64`
there would require threading the existing checker-backed `TypeMap` into the
linear selector/build driver. That driver is outside this issue's ownership,
so this change does not guess a primitive type or create a second propagation
engine.

## Implementation summary

- Added one shared effective-signature lookup in `src/ir/select.ts`, preferring
  ordinary TypeScript annotation nodes and falling back to TypeScript's public
  `getJSDocType` / `getJSDocReturnType` APIs. This exposes standard JavaScript
  JSDoc without parsing comments or mutating the AST.
- Routed the selector's existing primitive/object/dynamic classification
  through the effective nodes. Existing `any`, union, and unsupported type
  handling remains unchanged.
- Reused the same lookup at the narrow signature boundary in
  `src/ir/from-ast.ts`, ensuring a selected JSDoc function is built with the
  same parameter/result types.
- Added focused selector, linear-builder, exact-source, behavior, and negative
  dynamic/union tests in
  `tests/issue-3497-linear-jsdoc-landing-signatures.test.ts`.

No benchmark source, runner, backend adapter, workflow, package script,
website file, fallback baseline, or #3498 artifact changed.

Implementation PR: https://github.com/loopdive/js2/pull/3446
