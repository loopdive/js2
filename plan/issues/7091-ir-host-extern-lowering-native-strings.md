---
id: 7091
title: "IR: claim and lower host-extern (DOM/declared-class) calls under native strings in a JavaScript environment"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, compiler
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: current
parent: 5385
related: [6708, 6979, 3214, 1376]
---

# #7091 — IR host-extern lowering with native strings

Found during the #6708 flip (2026-10-16). The IR path has never claimed or
lowered calls to host externs (DOM capabilities such as `document`,
`CSSStyleDeclaration`, and user `declare function` imports) when the
module uses native strings: production selection sets `jsHostExterns =
irTargetProfile.allowHostImports`, which the regime projects as false, and
every IR host-extern switch is also gated `&& !ctx.nativeStrings`
(`allowHostExterns`/`allowBuiltinMapExtern`, `supportsHostPromiseDelay`,
`resolveAmbientClassCall` in `src/codegen/index.ts`; `jsHostExterns()` in
`src/ir/integration.ts`; six DOM arms in `src/ir/from-ast.ts`). With
`trackIrOutcomes`, the playground benchmark's `el`, `bench_dom` and `main`
are rejected at select with `host-surface-unavailable` and `bench_style`
follows as `call-graph-closure`. This is not regime-specific:
`host-assisted` + fast strings declines the same functions.

Consequence today: on the default (regime) build those functions compile
through the legacy direct-AST path, which still works, so the IR-fallback
gate's `#3214 A+B1` invariant (`benchmarks.ts::main` emitted through IR)
is measured with the explicit `host-assisted` spelling
(`scripts/check-ir-fallbacks.ts`, decision (B) in the #6708 checkpoint).
S7-a (#6979) deletes that spelling, so this issue is an entry condition for
the gate to keep measuring production.

## Plan

1. Measure: the exact IR rejection reasons for the 13 playground examples
   and the equivalence-suite programs that declare host functions or touch
   DOM, under the default profile (`trackIrOutcomes`), and the
   `check:ir-fallbacks` bucket counts.
2. Lower host-extern calls in the IR under native strings in a JavaScript
   environment: string and closure arguments cross as carriers that the
   runtime's platform-arg marshal (`src/runtime/platform-arg-marshal.ts`,
   from #6708) converts; results come back through the value adapter.
   Touches `src/ir/select.ts`, `src/ir/from-ast.ts`, `src/codegen/index.ts`
   (`jsHostExterns` projection), `src/ir/integration.ts`. Capability
   classification is unchanged (platform-capability).
3. Flip `scripts/check-ir-fallbacks.ts` back to the production profile and
   keep the `#3214 A+B1` invariant; bank the bucket decreases.
4. Acceptance: `check:ir-fallbacks` green on the default profile with
   `benchmarks.ts::main` IR-emitted; `tests/playground-example.test.ts` green;
   equivalence gate "No new equivalence regressions"; IR lowering tests for a
   DOM call with string + closure arguments under native-first. This is IR
   producer/lowerer work, which the direct-AST freeze explicitly allows.
