---
id: 7649
title: "Three predicates disagree on which `namespace` declaration is executable"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: codegen
goal: core-semantics
related: [7625]
---

# #7649 — one predicate for an executable `namespace` declaration

Found by the review of #7625. Three call sites decide whether a symbol's declaration is a TypeScript
`namespace N { … }` whose members run, and they answer differently:

| site | accepts |
| --- | --- |
| `runtimeNamespaceBlockOf` (`src/codegen/module-namespace-value.ts`), used by `canonicalRuntimeNamespaceSymbol` and `runtimeNamespaceFunctionSurface` | a `ModuleDeclaration` with a `ModuleBlock` body, outside a declaration file |
| `runtimeNamespaceFunctionValueReceiver` (`src/codegen/property-access.ts`) | the same, plus an identifier name, and not in an ambient context (`isAmbientDeclarationContext`) |
| `isRuntimeNamespaceReceiver` (`src/codegen/expressions/calls.ts`) | any `ModuleDeclaration`, including `declare namespace`, `declare module "x"` and body-less ones |

#7625 folded the two identical copies in `module-namespace-value.ts` into `runtimeNamespaceBlockOf`. Folding the
other two changes which receivers each lowering claims: for example, a `declare namespace N` in a `.ts` file is a
receiver for calls.ts and for `module-namespace-value.ts`, but not for property-access.ts. So it is not provably
byte-neutral and was left out of #7625.

## Plan

- Export one predicate (the strictest, property-access's, is the likely shape: an ambient block has no executable
  members) and use it at all three sites.
- Measure before and after: the single-file byte corpus on gc/standalone, the `namespace` test files
  (`tests/issue-1058-*`, `issue-4614-*`, `issue-5222-*`, `issue-7106-*`), and the #7625 pin test.
- Code-quality criterion: one predicate, no per-site variants.
