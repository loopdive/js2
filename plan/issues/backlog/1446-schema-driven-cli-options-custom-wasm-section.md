---
id: 1446
title: "Schema-driven CLI options via custom Wasm section"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
area: tooling
language_feature: n/a
depends_on: []
related: []
---

# #1446 — Schema-driven CLI options via custom Wasm section

## Problem

Several runtime-shape options today live as ad-hoc CLI flags:

- `--target wasi` vs JS host
- `--nativeStrings` (string backend choice)
- RegExp backend (#682)
- WASI-shim presence/absence
- Various optimisation flags

Each is added by editing the CLI parser, and each ships independently
in every artefact we build. There is no machine-readable record of
which options apply to a given build, which makes both `--help`
discoverability and host-side compatibility checking awkward.

A cleaner pattern: emit a **custom Wasm section** in every artefact
declaring the build's target descriptor (WASI shim set, string
backend, RegExp backend, runtime-helper version). The CLI reads
the schema from a compiler-side declaration and auto-derives the
`--help` table. Hosts that consume our modules can introspect the
custom section to refuse early if their environment cannot serve
the declared runtime contract.

## Proposed approach

1. Define a small schema for "build target descriptor" — string
   backend, RegExp backend, WASI version, runtime-helper version,
   etc. Express as TypeScript types.
2. Generate a CLI option group per descriptor field automatically.
   `--help` shows them grouped under `--target` headings.
3. Emit the descriptor as a custom Wasm section in every artefact.
4. Document how a host can read the section and refuse to instantiate
   a module whose runtime contract it cannot satisfy.

## Acceptance criteria

- Target descriptor schema defined in TypeScript with one source of
  truth for both CLI parsing and custom-section emission.
- CLI `--help` groups options under their descriptor field.
- Built artefacts carry the custom section; `wasm-tools` can dump
  it.
- A short host-side example demonstrates reading the section and
  failing gracefully on contract mismatch.
- No regression in existing CLI behaviour.

## Notes

The pattern reduces by-hand CLI maintenance and gives hosts a
real handshake before instantiation. Low risk, medium upside,
fits comfortably in a one-week implementation window.

Pattern observed in Javy (https://github.com/bytecodealliance/javy),
specifically `crates/cli/src/commands.rs:60-70` and 305-352: the
plugin's custom Wasm section advertises supported options; the CLI
reflects them in `--help` automatically. Their `import_namespace`
custom section additionally encodes ABI versioning. Two Bytecode
Alliance projects (Javy + StarlingMonkey) use related patterns,
suggesting the convention is worth codifying ecosystem-wide rather
than reinvented locally.
