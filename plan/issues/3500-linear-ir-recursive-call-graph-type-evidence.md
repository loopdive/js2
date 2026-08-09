---
id: 3500
title: "Carry checker-backed type evidence through recursive linear-IR call-graph closure"
status: in-review
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, codegen-linear, porffor
language_feature: recursive-call-graph-type-evidence
es_edition: multi
goal: backend-agnostic-ir
depends_on: [3497]
related: [1131, 2956, 3297, 3478, 3497, 3498]
origin: "2026-07-20 explicit user request: exact fib-recursive landing source through shared IR, linear Wasm, and Porffor native"
files:
  - src/ir/type-evidence.ts
  - src/ir/select.ts
  - src/ir/backend/linear-integration.ts
  - tests/issue-3500-linear-ir-recursive-call-graph-type-evidence.test.ts
  - plan/issues/3500-linear-ir-recursive-call-graph-type-evidence.md
loc-budget-allow:
  - src/ir/select.ts
---

# #3500 — Recursive linear-IR call-graph type evidence

## Problem

After #3497, the exact JavaScript landing source
`website/public/benchmarks/competitive/programs/fib-recursive.js` exposes the
JSDoc `number -> number` signature of exported `run`, but its local recursive
`fib(n)` remains checker-`any -> any`. The shared TypeMap can discover
`fib: number -> number` through optimistic arithmetic propagation, while the
linear integration neither supplies that map to the selector nor carries the
same evidence into AST-to-IR declaration/call lowering. Selection therefore
rejects `fib`, and call-graph closure then rejects `run`.

Passing the general TypeMap through unchanged would be unsound. Its optimistic
recursive seed is intentionally useful for discovery, but it is not on its own
proof that every recursive parameter, result, and call edge has one stable ABI.
An `any`, union, escaping callable, or call-site disagreement must remain on the
dynamic/direct path.

## Root cause

The linear driver previously invoked `planIrCompilation()` without a TypeMap
and pre-seeded call signatures only from raw annotation nodes. Even when a
recursive type could be discovered, three boundaries could disagree:

1. the selector could see no concrete signature;
2. the shared AST-to-IR builder could still observe checker `any` at recursive
   arithmetic proof sites; and
3. recursive call lowering could use a different signature from the function
   declaration override.

This is an evidence-transport gap, not an AST-lowering feature gap.
`src/ir/from-ast.ts` already has the required parameter, return, callee-signature,
and checker hooks and is deliberately unchanged by this issue.

## Prior-attempt constraints

- #1131's optimistic TypeMap is retained as a candidate generator, not promoted
  directly into an ABI proof. Repeating a propagation-only claim would accept
  circular guesses and polymorphic joins.
- #3497 correctly refused to infer the unannotated recursive function from
  JSDoc alone. This issue consumes the landed effective JSDoc signature as an
  external anchor without adding source annotations or rewriting the program.
- Fully annotated recursive functions keep their existing selector behavior;
  the new certifier owns only SCCs that need propagated evidence.
- No benchmark path, function name, or source-text special case is permitted.

## Implementation

### Conservative recursive certification

`src/ir/type-evidence.ts` builds the local direct-call graph with checker-resolved
symbols, finds recursive strongly connected components with Tarjan's algorithm,
and makes one component-wide decision. A cycle is certified only when:

- every inferred parameter and return is one supported scalar (`number`,
  `boolean`, or `string`);
- parameter evidence reaches a non-circular annotation/checker/caller anchor;
- return evidence reaches a non-circular base return through a monotone fixed
  point;
- every direct call has exact arity and arguments agreeing with the candidate
  signature; and
- no member is explicit-any, polymorphic, escaping, higher-order, conflicting,
  or unsupported.

Rejected SCCs receive stable component-wide details of the form
`recursive-type-evidence:<category>`. Certified expressions also retain the
actual checker `Type` object for their proven scalar kind. Linear lowering
overlays those facts only at the corresponding AST nodes, so existing
checker-keyed no-box/addition safety gates consume the proof without AST
mutation or a `from-ast.ts` change.

### Narrow linear integration

The linear driver computes the existing TypeMap, certifies recursive SCCs, and
passes only certified recursive entries to the selector. This intentionally
does not widen unrelated unannotated functions. Effective TypeScript/JSDoc
annotations remain authoritative for ordinary claims.

For each claimed function, one signature map now feeds both
`paramTypeOverrides` / `returnTypeOverride` and `calleeTypes`. Recursive
declaration and call lowering therefore cannot disagree about the ABI.

### Selector behavior

The selector accepts optional recursive evidence. A rejected component is
excluded before ordinary claim/closure processing and reports
`recursive-type-evidence` plus the stable category detail. With no evidence
option, selector behavior is unchanged.

## Acceptance criteria

- [x] Exact `fib-recursive.js` selects and IR-compiles both `fib` and `run`.
- [x] The exact source-derived linear Wasm output matches Node.
- [x] The same `IrModule` is legal for Porffor and executes through pinned
      Porffor-C with matching results under ASan/UBSan.
- [x] Ambiguous, polymorphic, escaping, higher-order, conflicting, and any-based
      cycles remain dynamic with stable diagnostics.
- [x] Existing fully annotated recursion, JSDoc selection, linear families,
      selector, and AST-to-IR tests retain their behavior.
- [x] No source annotation/rewrite and no source-path/function-name special case.
- [x] `src/ir/from-ast.ts` is unchanged.

## Validation

- `PORFFOR_NATIVE_REQUIRED=1 PORFFOR_NATIVE_SANITIZERS=1 pnpm exec vitest run tests/issue-3500-linear-ir-recursive-call-graph-type-evidence.test.ts`
  — 9/9 passed; pinned Porffor `60a1d41d60580ff4faa38ffd5f7783d23df68bad`,
  Clang `-fsanitize=address,undefined -fno-omit-frame-pointer`, and runtime
  `halt_on_error=1` completed with no sanitizer report.
- Exact post-merge probe against `origin/main` `e78ef504f`: IR compiled
  `[fib, run]`, no rejections, and linear-Wasm `run(10) === 55`.
- Selector/from-AST/linear/JSDoc/dynamic-any/Porffor preservation matrix —
  89/91 passed. The two `tests/ir-scaffold.test.ts` failures reproduce
  identically on detached landed `origin/main` `e78ef504f` (stale result-shape
  assertion and missing `__unbox_number` fixture import); no branch delta.
- WasmGC/shared-from-AST numeric/control-flow equivalence matrix — 73/73 passed.
- `pnpm run typecheck` — passed.
- Focused Biome lint and Prettier checks — passed.
- `pnpm run check:loc-budget` — passed with the issue-scoped selector allowance.
- `pnpm run check:ir-fallbacks` — passed with no baseline delta.
- `pnpm run check:linear-ir` — passed (`compiled=8`, baseline `8`; no bucket or
  baseline delta).

## Scope note

The `src/ir/select.ts` LOC allowance covers the minimal option, fallback enum,
and stable-detail plumbing in an already-grandfathered file. The certification
algorithm itself lives in the new focused module. No baseline file is changed.

## Allocation note

This issue was allocated from #3498's post-#3497 exact `fib-recursive.js`
native-route probe, where the unannotated recursive `fib` was rejected and
`run` closed with `select:call-graph-closure`. The implementation above resolves
that backend-neutral evidence gap without benchmark-specific type guesses.
