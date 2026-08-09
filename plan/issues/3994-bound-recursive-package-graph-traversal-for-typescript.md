---
id: 3994
title: "compiler: bound recursive package graph traversal for TypeScript"
status: ready
sprint: Backlog
created: 2026-07-30
updated: 2026-08-09
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

# compiler: bound recursive package graph traversal for TypeScript

## Problem

TypeScript 5.9.3 lib/typescript.js fails with: Codegen error: Maximum call stack size exceeded.

Use bounded or iterative work scheduling for recursive package graph traversal, or provide a structured diagnostic that identifies the recursion front.

Reproduce: pnpm run dogfood:typescript.

## Current investigation

The first crash is now localized to the generic object-assignment widening
pre-pass, not module graph resolution. In the pinned TypeScript 5.9.3 entry,
the checker overflows while asking for the type of the RHS of
`links.aliasTarget = target || unknownSymbol`. The pre-pass now treats that
single `RangeError` as an unknown RHS, keeps the conservative object carrier,
and continues scanning; non-stack checker errors are still propagated. The
regression is covered by `tests/issue-3994.test.ts`.

That moves the exact package probe past the opaque stack error. The catalog
budget is now 600 seconds for this unusually large entry, so the compiler can
continue measuring the post-fix frontier instead of being cut off at the
generic three-minute limit. The remaining work is to reduce or schedule that
large-package codegen frontier without
silently dropping its dependency graph; the timeout remains the honest catalog
result if the extended budget is still exhausted.

## Current frontier and source-build comparison (2026-08-09)

The published entry is a generated CommonJS artifact, not TypeScript source:
the npm tarball contains no runtime `.ts` files and its `lib/typescript.js` is
9,112,572 bytes. Parsing it produces two top-level statements, with the second
being one 9.1 MB esbuild IIFE (about 1.08 million AST nodes, 11,065 functions,
and 9,101 arrows). The generic #4031 optimization now avoids the redundant
capture-analysis walk when the module initializer has no local capture
candidates. The attempted second-initializer suppression was rejected after
merge-group conformance exposed broad regressions, so the conservative second
compile remains. The full package still needs a supervised compile measurement
before its catalog timeout can be revised.

An upstream-source experiment is tracked separately from npm compatibility:
the official v5.9.3 source archive is about 31 MB, `npm ci` takes 22 seconds,
and TypeScript's own `npm run build:compiler` takes 18 seconds to regenerate
the same 9.1 MB public bundle. Compiling the public source entry
`src/typescript/typescript.ts` directly currently fails with 172 diagnostics
(mostly Node/system and type-resolution gaps), while a small source leaf
(`src/compiler/corePublic.ts`, 1,318 bytes) compiles to valid zero-import
standalone Wasm in about 3.3 seconds. This proves a useful source lane, but it
must not replace the npm lane or be compared as if it were the same artifact;
the full source graph needs ESM graph, Node builtin, and checker/front-end work.

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
