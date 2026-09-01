---
id: 5273
title: "Module-init ledger claims a legacy body for a type-only `declare namespace` population"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: medium
horizon: s
complexity: S
feasibility: medium
reasoning_effort: medium
task_type: bug
area: ir, codegen, modules
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
related: [3142, 3523]
origin: "#3523 R4 gap-2b census probe P4 — split out rather than fixed in the gap-2b slice"
files:
  - src/ir/module-init.ts
---

# #5273 — Module-init ledger claims a legacy body that was never emitted

## Problem

`collectModuleInitPopulation` (`src/ir/module-init.ts:9-27`) skips the
type-only top-level statement kinds — function/class/interface/type-alias
declarations, imports, exports, empty statements — but **not**
`ts.ModuleDeclaration`. A `declare namespace` block is therefore counted as a
runtime top-level statement even though it emits nothing.

The consequence is a truthfulness defect in the outcome ledger, not a
miscompile: the module-init unit is selector-rejected and records
`legacyBodyEmitted: true` while **no direct module-init body is compiled at
all**.

## Evidence (measured 2026-09-01, `origin/main` `d153a08826`)

`tests/fixtures/extern-demo.ts` — its only non-skipped top-level statement is
`declare namespace Host { … }`:

```
population size: 1
  kind: ModuleDeclaration "declare namespace Host {\n  class Box {\n "
success: true
direct passes: pass1 = 0  pass2 = 0
module-init outcome: {"kind":"unsupported","legacyBodyEmitted":true,"irBodyEmitted":false}
```

`pass1 = pass2 = 0` is the proof: the profiler counts every entry into the
direct module-init emitter, and neither ran. The row nonetheless asserts a
legacy body was emitted.

## Why this is filed rather than fixed in #3523 gap-2b

Gap 2b is a predicate-only slice in `src/codegen/index.ts` whose acceptance
criterion is byte-neutrality on already-admitted shapes (verified 15/15). This
defect is in the population collector — a different file, a different
mechanism, and a change that moves at least one module out of the
"claimable" bucket, so it needs its own census diff. It is adjacent to gap 4
(non-executable modules recording a truthful outcome row) and should be
scheduled with it.

## Acceptance criteria

- `declare namespace` / `declare module` (`ts.ModuleDeclaration`) with no
  runtime body does not enter the module-init population.
- `tests/fixtures/extern-demo.ts` records a truthful outcome row: no claim of
  a legacy body that no pass emitted.
- A pin covering the `legacyBodyEmitted` ⇒ "a direct pass ran" implication for
  this shape, so the ledger cannot silently re-acquire the lie.
- `pnpm run check:ir-fallbacks` diffed; any bucket move is intended and stated.

## Notes

The id was reserved with `claim-issue.mjs --allocate --allow-unscanned`
(`pr_scan=degraded`): `gh` is not installed in the implementation container,
so the open-PR id scan could not run. Re-check for a collision against
in-flight PRs before this file merges.
