---
id: 3999
title: "wasm emission: preserve local reference types in styled-components"
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

# wasm emission: preserve local reference types in styled-components

## Problem

styled-components 6.4.4 dist/styled-components.esm.js emits invalid Wasm: WebAssembly.Module(): Compiling function #212: nt failed: local.tee[0] expected type (ref null 205), found local.get of type i32.

Preserve local type consistency across reference and scalar lowering.

Reproduce: pnpm run dogfood:styled-components.

## Current measurement and suspended handoff (2026-08-09)

The current canonical tarball still compiles, but the 272,881-byte binary does
not validate:

```text
WebAssembly.Module(): Compiling function #222:"nt" failed:
local.tee[0] expected type (ref null 227), found local.get of type i32 @+115835
```

Direct reproduction (the package script can hit a sandbox-only `tsx` IPC
`EPERM`, while this invokes the identical harness without that transport):

```bash
node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs \
  --package styled-components
```

The measured compile took 8.559 seconds. WAT for `nt` contains captured cell
locals such as `__boxed_s`, `__boxed_n`, `__boxed_r`, `__boxed_a` and
`__boxed_e` with `(ref null 227)`, while two generated locals named `$e` have
different types (`externref` and later `i32`). This strongly localizes the
failure to local identity/type lowering selecting an `i32` slot for a captured
reference cell, but the exact offending `local.tee` has not yet been mapped to
its source binding.

The suspended investigation worktree `/private/tmp/js2-styled-local-tee` on
`codex/4303-styled-local-tee` is clean at `7a50f7fd9a34fd`; it has no edits or
commits. Resume by enumerating the `local.tee`s targeting `(ref null 227)` in
`nt`, tracing the `i32` producer through binding-to-slot allocation, reducing
that binding pattern, and then rerunning both the reduction and this unchanged
package harness.

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
