---
id: 4442
title: "Self-contained %Function% carrier + the <fn>.constructor arm (R6 of #4440)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: function-properties
goal: standalone-gap
related: [4440, 4437, 2860, 2660]
origin: "2026-08-15 wave 9 — #4440's R6 residual, with its measurement and narrowing."
---

# #4442 — self-contained `%Function%` carrier + `<fn>.constructor`

## Problem & prior evidence (READ #4440's issue file R6 + finding 2 FIRST)

`<function value>.constructor` answers `undefined` for every AOT-compiled
closure (never implemented); runtime-eval-tier callables answer correctly.
#4440 built the arm two ways and measured **+9/−1 over the 509-file
`built-ins/Function` directory** — but did NOT ship it, because the working
route (a synthetic bare `Function` identifier read) resolves through
`js2wasm:runtime-eval`, silently ending host-freeness for every
`.constructor`-reading module (#2860; no gate measures this). The narrowing:
`compileIdentifier`'s `Function` resolution in
`src/codegen/expressions/identifiers.ts` (`emitStandaloneIntrinsicFunctionValue`).

## Implementation Plan

1. Build a SELF-CONTAINED `%Function%` carrier: a realm-stable native object
   (the `emitBuiltinNamespaceObject` / lazy-singleton pattern used for
   Array/Object namespace values) that is identity-stable with what
   `f.constructor` must return AND with what a bare `Function` identifier
   read yields in a module WITHOUT the runtime-eval provider linked. In a
   module WITH the provider, identity must match the provider's intrinsic
   (that equality is what #4440's `__builtin_ctor_Function` attempt failed —
   measure it explicitly this time, both provider-linked and provider-free).
2. Re-add the `.constructor` arm on function-valued receivers reading that
   carrier; A/B the 509-file directory (target ≥ #4440's +9/−1, ideally
   fixing the −1: `S15.3.2.1_A1_T10`) and a provider-free probe asserting the
   module emits NO `js2wasm:runtime-eval` import for a plain
   `f.constructor` read.
3. Controls per the campaign methodology: base copies at first edit; both
   arms yours; gc/host byte-identity; #4436/#4437/#4440 pins green.

## Acceptance criteria

- `f.constructor === Function` for AOT closures in both provider-linked and
  provider-free modules, with NO runtime-eval import added to provider-free
  modules; ≥ +9/0 on the 509-file A/B; zero control regressions.
