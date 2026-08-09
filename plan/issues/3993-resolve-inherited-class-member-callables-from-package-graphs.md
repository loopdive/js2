---
id: 3993
title: "codegen: resolve inherited class member callables from package graphs"
status: done
sprint: Backlog
created: 2026-07-30
updated: 2026-08-09
completed: 2026-08-09
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: dogfood
related: []
---

# codegen: resolve inherited class member callables from package graphs

## Problem

Packages:
- Hono 4.12.16 dist/index.js: RegExpRouterWithMatcherExport_add
- Webpack 5.109.2 lib/index.js: SortableSet_get_size
- Tailwindcss 4.3.3 dist/lib.mjs: U_get_size

Representative failure:
```
inherited class callable SortableSet_get_size has no exact defined function for handle 2438
```

Resolve inherited class member callables through canonical base-member lookup while preserving override semantics.

Reproduce: pnpm run dogfood:hono, pnpm run dogfood:webpack, pnpm run dogfood:tailwindcss.

## Resolution

Bundled packages commonly emit a class declaration as `var Base = class {}`.
Its methods are exact class-owned inventory units, but their terminal owner is
the module initializer. The inherited-alias registry looked the method up only
in `terminalByUnitId`, then rejected it even though collection had already
proved its exact class declaration and allocator handle. Alias validation now
uses the exact unit inventory plus its class lexical owner; terminal ownership
is deliberately orthogonal to whether the method can be inherited.

`tests/issue-3993-inherited-class-callable-alias.test.ts` pins the package
shape across two modules: a `var Base = class` export and a nested child class
that invokes the inherited method. It failed on the same invariant as Hono and
now compiles, validates, and returns `42`.

Measured package frontier after the correction:

- Hono 4.12.16 passes codegen in 5.9 s and emits 360,309 bytes. Validation now
  exposes a separate closure-result type mismatch tracked by #4286.
- Webpack 5.109.2 and Tailwind CSS 4.3.3 no longer report inherited-class
  callable errors; both reach the independent 120 s compile budget tracked by
  #4287.

This issue owns the inherited-alias abort only. It is complete without claiming
that the packages' later validation, runtime, or performance frontiers pass.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.
