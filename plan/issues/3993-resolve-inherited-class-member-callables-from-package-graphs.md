---
id: 3993
title: "codegen: resolve inherited class member callables from package graphs"
status: ready
sprint: Backlog
created: 2026-07-30
updated: 2026-08-01
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
