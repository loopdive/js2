---
id: 3998
title: "codegen: give UUID v1ToV6 a stable source-callable inventory owner"
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

# codegen: give UUID v1ToV6 a stable source-callable inventory owner

## Problem

UUID 14.0.1 dist/index.js fails because source callable v1ToV6 has no consistent exact top-level/compiler support inventory owner.

Establish a stable canonical owner for source callables that originate in package entry graphs.

Reproduce: pnpm run dogfood:uuid.

## UUID upstream-suite measurement (2026-08-09)

The pinned original suite (`uuidjs/uuid@v14.0.1`, commit
`70177807e9229dfacde2038dc1e722f1828f358a`) now exercises v1/v6/v7 conversion
and state paths in the actual Wasm runtime. The native oracle passes 75/75;
the Wasm lane passes 6/75 admitted tests. v1's ten tests currently trap with
`RuntimeError: illegal cast`, while v6 conversion/vector assertions remain
red; these are compiler/runtime findings, not compile-only evidence. The full
per-test report is written by `pnpm run dogfood:uuid-upstream-suite` to
`tests/dogfood/report/uuid-upstream-suite.json`.

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
