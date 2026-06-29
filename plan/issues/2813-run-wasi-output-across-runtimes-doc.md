---
id: 2813
title: "Doc: running js2wasm --target wasi output across runtimes (wasmtime / bun -b / deno) + required -W flags"
status: done
completed: 2026-06-30
created: 2026-06-29
updated: 2026-06-30
priority: low
feasibility: easy
task_type: docs
area: docs
goal: platform
sprint: current
horizon: s
related: [389, 2812]
---

# Running js2wasm `--target wasi` output across runtimes

## Problem

A `--target wasi` build is a WasmGC module that needs specific runtime flags,
and there's no single doc listing what each runtime requires. The loopdive/js2#389
reporter is discovering this ad hoc:

- **wasmtime** needs `-W gc=y,function-references=y,tail-call=y,exceptions=y` —
  and **not** `-W all-proposals=y` (that turns on stack-switching, which wasmtime
  rejects).
- **`bun -b host.wasm`** executes the WASM-GC binary directly.
- **deno** runs it too.

## Scope

Add a "Running the output" section to `docs/standalone-io.md` (or a new
`docs/runtimes.md`):

- a runtime matrix — wasmtime (exact `-W` flags + the all-proposals caveat),
  `bun -b`, deno — and what each needs;
- the `node:fs` `--preload` shim note for the node:fs host;
- cross-links from `docs/cli.md` and `examples/native-messaging/README.md`.

## Acceptance

A reader can pick a runtime and run a `--target wasi` `.wasm` without
trial-and-error on the flags.

## Related

- #389 — reporter running the output under wasmtime / `bun -b` / deno.
- #2812 — the deployment recipe that builds on this.
