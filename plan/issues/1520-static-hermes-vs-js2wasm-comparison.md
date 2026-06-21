---
id: 1520
title: "docs: architectural comparison — Static Hermes (native) vs js2wasm (WasmGC AOT)"
status: ready
created: 2026-05-20
updated: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: high
task_type: research
area: docs, architecture
goal: developer-experience
sprint: Backlog
related: []
---
# #1520 — Architectural comparison: Static Hermes vs js2wasm

## Goal

Produce a clear, technically accurate comparison of Facebook's Static Hermes
(`github.com/facebook/hermes/tree/static_h`) and js2wasm, documenting:

1. The compilation strategy each takes
2. The runtime model (what executes at runtime, what is eliminated)
3. The trade-offs: portability, performance, compatibility, toolchain complexity
4. Where each approach is better suited
5. What js2wasm can learn from Static Hermes (and vice versa)

## Background

Static Hermes is Meta's research branch of the Hermes JS engine that compiles
TypeScript/JavaScript to native code via a C intermediate representation. Unlike
the interpreter-based main Hermes branch, Static Hermes performs ahead-of-time
compilation and eliminates the bytecode interpreter loop entirely.

js2wasm similarly performs AOT compilation — but targets WasmGC bytecode rather
than native machine code, using the WebAssembly type system (struct/array/func
GC types) instead of C structs.

## Key comparison dimensions

- **IR / intermediate representation**: Static Hermes → typed C structs. js2wasm → WasmGC module.
- **Type system**: SH uses flow/TS types at the boundary; js2wasm uses TS types throughout.
- **Runtime dependencies**: SH needs a native runtime library; js2wasm's standalone mode needs no JS runtime.
- **Portability**: WasmGC runs anywhere (browser, wasmtime, wasmer, WASI); native binary is platform-specific.
- **GC**: SH uses a native GC (tracing); js2wasm relies on the host Wasm engine's GC.
- **Dynamic features**: how each handles `eval`, dynamic `import`, Proxy, etc.
- **Interop with JS host**: SH is designed for React Native; js2wasm targets browser/Node/WASI.
- **Test262 conformance posture**: does SH publish conformance numbers?

## Acceptance criteria

- `docs/comparisons/static-hermes-vs-js2wasm.md` created with:
  - Side-by-side table: feature × approach × notes
  - Narrative sections for each dimension listed above
  - Code examples showing the same TS snippet compiled by each
  - "What we can learn" section with concrete actionable insights
  - Sources cited (SH README, design docs, papers, js2wasm CLAUDE.md/plan/)
- The comparison is technically accurate — claims backed by source evidence
  (actual SH source files or docs, actual js2wasm source files)
- No speculation beyond what the source supports; mark unknowns explicitly

## Resources

- Static Hermes source: `https://github.com/facebook/hermes/tree/static_h`
- Static Hermes README / docs in that tree
- js2wasm: `src/codegen/index.ts`, `src/runtime.ts`, `CLAUDE.md`, `plan/goals/goal-graph.md`

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
