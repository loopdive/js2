---
id: 4578
title: "Elide unobservable strict arguments poison accessors"
status: done
created: 2026-08-20
updated: 2026-08-20
priority: critical
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen, standalone, npm-compat
language_feature: strict arguments object
goal: performance
sprint: current
depends_on: [4555]
assignee: ttraenkler/codex
horizon: s
related: [3781, 4243, 4555, 4576, 4577]
origin: "Published Acorn/clsx standalone-dynamic collapse after PR #4658; exact reduced A/B pins the first hot-path regression to 536a3c0."
files:
  - src/codegen/arguments-callee.ts
  - src/codegen/helpers/arguments-registration.ts
  - tests/issue-4578-strict-arguments-perf.test.ts
  - plan/issues/4578-strict-arguments-poison-accessor-perf.md
---

# #4578 — elide unobservable strict arguments poison accessors

## Problem

`536a3c0` made the standalone strict arguments object conformant by eagerly
installing the `%ThrowTypeError%` `callee` accessor on every activation. The
installation enters the generic object runtime and calls
`__defineProperty_accessor`, even when the arguments object is private and the
function reads only `arguments.length` and numeric elements.

That work sits directly in the hottest variadic paths of Acorn and clsx. A
correct-checksum reduced clsx A/B measured roughly `0.148 us/op` before the
change and `249.7 us/op` after it. The first published post-merge results
deteriorated about 120x for Acorn and 1,425x for clsx.

## Scope

- Reuse one conservative arguments-use analysis to prove when the implicit
  object is private and observed only through `.length` and numeric-index reads.
- Omit eager poison-accessor construction only under that proof.
- Preserve eager construction for direct eval, escape, aliasing, reflection,
  dynamic or string keys, mutation/receiver uses, `with`, and unknown shapes.
- Treat computed method/accessor names as outer-scope code while continuing to
  exclude their nested callable bodies, which bind their own `arguments`.
- Preserve the existing syntactic TypeError path for direct strict
  `arguments.callee` reads and writes.

## Acceptance criteria

- [x] A clsx-shaped strict variadic function has no reachable
      `__defineProperty_accessor` call in its emitted hot body.
- [x] Escaping, reflected, dynamic-key, direct-eval, and otherwise unproved
      arguments uses retain the real poison accessor.
- [x] An escape from a computed method/accessor name retains the accessor;
      `arguments` used only inside the nested callable body does not block
      elision for the outer function.
- [x] Existing strict descriptor, identity, `hasOwnProperty`, read, and write
      tests remain green.
- [x] Same-machine standalone `optimize: 4` differential uses identical source,
      runtime, checksum, and harness; median Wasm time is no worse than 5x the
      pre-regression parent (the broken path is over 1,000x slower).
- [x] Acorn and clsx benchmark result files or baselines are not weakened to
      hide the regression.

## Non-goals

- Removing `%ThrowTypeError%` semantics from observable strict arguments
  objects.
- Replacing the general property-descriptor runtime.
- Claiming a browser/Node speedup from the standalone-vs-direct comparison.

## Completion evidence

- The focused structural and semantic matrix passes 13/13; the combined
  private-arguments and strict-arguments suites pass 36/36.
- TypeScript 5 and 7 typechecks, Prettier, Biome, LOC/function budgets, IR and
  codegen fallback gates, and the verdict-oracle gate pass.
- The exact clsx 2.1.1 standalone-dynamic `-O4` kill-switch A/B, with identical
  source/runtime/checksum, measures `0.143173 us/op` with elision versus
  `729.364 us/op` with eager poisoning. Both lanes pass 14/14 checksum rounds;
  optimized binaries are 42,562 and 48,410 bytes respectively.
- Acorn's artifact shrinks by 440 bytes. Both candidate and eager-control
  timings hit the same pre-existing Binaryen `Flatten` failure, so no Acorn
  runtime claim or benchmark baseline change is made.
