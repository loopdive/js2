---
id: 2512
title: "Node.js host APIs as separate, link-on-demand Wasm modules (process, fs, path, …)"
status: backlog
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: node-host-apis
goal: architecture
related: [1044, 1046, 2514]
---

> **Linking mechanism (decided):** **core-wasm module linking** (per-host shim
> modules: `node-shim.wasm` over WASI, `deno-shim.wasm`, … sharing a store with
> the user module) — see **#2524** (chosen, implement first). The Component Model
> + WIT alternative — a `node:io/process` WIT world embedded in the component as
> the declared dependency, composed against a shim component — is **#2525**
> (deferred; clean fit for this byte/scalar boundary but lower priority).

## Problem / proposal

Node.js host-API support (`process`, and future `fs`, `path`, `url`, `os`, …)
is currently lowered as **inline glue** baked into each compiled module:
`node-process-api.ts` marshals buffers and emits the WASI syscall (`fd_read` /
`fd_write`) directly into the user module. There is no separately-compiled,
reusable Wasm module that implements the Node API surface and gets **linked when
required**.

Proposal: factor each Node host-API surface into its own linkable Wasm module
(or host-import interface) that user modules import on demand, instead of
re-emitting the glue per module. This keeps the user's binary focused on user
code, lets the host-API implementations version independently, and gives a clean
seam for the dual-mode story (WASI syscalls vs JS host).

## Why this surface is the tractable half

The IO core already lives outside the user module: `process.stdin/stdout/stderr`
compile to `wasi_snapshot_preview1.fd_read` / `fd_write` **imports**, satisfied
by the WASI host — and they're emitted only when `process` is used (DCE). What
crosses the boundary is **byte buffers + counts** (linear memory + i32), which
have **no cross-module type identity problem** (unlike GC objects — see #2514).
So host APIs that pass bytes/scalars can be factored into a shared module or a
stable host-import interface now, without waiting on WasmGC cross-module type
sharing.

The js2wasm-side glue that remains inline (buffer marshalling, the
`process.stdin.read` read-loop shape, argv/env access #1490) is the candidate to
extract behind a stable interface.

## Scope

- Define a stable host-API interface (Wasm imports / a `node:` runtime module)
  per supported Node surface, starting with `process`.
- Emit an *import of* that interface from the user module instead of inline glue,
  gated on actual usage (preserve current DCE behavior).
- Keep the dual-mode contract: WASI syscall backing in standalone, JS host
  backing when a JS runtime is present (cf. #1044 Node-builtins-as-host-imports).
- Out of scope: GC-typed runtime helpers (number_toString, string/array helpers)
  — tracked separately in #2514, blocked on the cross-module GC type-identity
  problem.

## Open questions (route to architect)

- Module-linking vs Component Model vs plain shared host-import namespace — which
  seam, and how does it interact with `--target wasi` vs JS-host?
- Relationship to #1044 (Node builtins as host imports) and #1046 (separate
  ES-module compilation + consumer-driven linking) — is this a generalization of
  #1044, or a distinct runtime-module layer?
- Versioning / ABI stability of the interface across compiler versions.

## Notes

Discovered while investigating loopdive/js2#389 (Native Messaging host). For a
single standalone binary the dedup payoff is small (the inlined glue is exactly
what that host needs); the win is multi-module reuse and a clean dual-mode seam.
Pairs with #2514 (runtime helpers as a shared module); split out because the two
have different blockers — this one is value/byte-typed and tractable now, #2514
is GC-typed and blocked.
