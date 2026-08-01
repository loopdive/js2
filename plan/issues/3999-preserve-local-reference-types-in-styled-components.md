---
id: 3999
title: "wasm emission: preserve local reference types in styled-components"
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

# wasm emission: preserve local reference types in styled-components

## Problem

styled-components 6.4.4 dist/styled-components.esm.js emits invalid Wasm: WebAssembly.Module(): Compiling function #212: nt failed: local.tee[0] expected type (ref null 205), found local.get of type i32.

Preserve local type consistency across reference and scalar lowering.

Reproduce: pnpm run dogfood:styled-components.

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
