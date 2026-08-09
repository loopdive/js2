---
id: 3995
title: "npm-compat: pin and adapt original upstream test suites for catalog packages"
status: ready
sprint: Backlog
created: 2026-07-30
updated: 2026-08-09
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
language_feature: n/a
goal: dogfood
related: []
---

# npm-compat: pin and adapt original upstream test suites for catalog packages

## Problem

The catalog package tarballs do not ship their original unit suites. The npm-compat page correctly reports upstream suite not shipped; adapter pending, but this needs a tracked path to genuine validation.

Pin matching source revisions and provide adapters for: hono, lodash, axios, react-dom, webpack, uuid, typescript, redux, jest, styled-components, moment, stylelint, three, lit, tailwindcss, and cookie. Keep upstream-suite validation distinct from compile checks, synthetic differential vectors, and benchmark harnesses.

Start with React DOM, Jest, and Lit, which already compile and validate their entry artifacts.

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

## UUID v14.0.1 lane (measured 2026-08-09)

The UUID adapter is now pinned and runnable at
`pnpm run dogfood:uuid-upstream-suite`. It clones
`uuidjs/uuid@v14.0.1`, verifies commit
`70177807e9229dfacde2038dc1e722f1828f358a`, and runs the ten original
`src/test/*.test.ts` files against the published `uuid@14.0.1` tarball. The
shared `test_constants.ts` fixture is pinned separately. Registration-shaped
`Array#forEach` calls are expanded only by the generic runner so the source
test bodies stay intact; this preserves all dynamically generated cases.

Measured oracle/runtime result: **75/75 native tests pass; 6/75 admitted tests
pass in Wasm** (exact denominator 75, no harness-incompatible tests). All ten
generated modules compile; nine validate, while `v35.test.ts` emits the
compiler validation error in `hashToHex` (`local.tee[0]` type mismatch). The
remaining 69 Wasm failures are recorded individually in
`tests/dogfood/report/uuid-upstream-suite.json`, including illegal casts in v1,
null dereferences in validate/version, and assertion mismatches in vector and
crypto paths. This is runtime evidence, not a compile-only card; the lane
remains open until the compiler/runtime frontier improves.
