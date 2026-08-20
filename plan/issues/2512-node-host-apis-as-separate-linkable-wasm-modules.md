---
id: 2512
title: "Node.js host APIs as separate, link-on-demand Wasm modules (process, fs, path, …)"
status: backlog
sprint: Backlog
created: 2026-06-19
updated: 2026-08-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: node-host-apis
goal: architecture
related: [1044, 1046, 2514, 4382, 4567, 4568, 4570, 4571]
---

> **Interface and linking mechanism (decided):** the compiled user module
> declares the standard interface it needs, such as import module `node:fs`
> with member `readSync`. Core-Wasm module linking selects a provider over WASI,
> a JS host, or another explicit target adapter. The provider implementation's
> name is not part of the user's declared dependency. “Phase 1: process IO via
> linkable js2wasm:node-io shim” (#2524) owns the current linking substrate;
> “Component Model + WIT for host-API shims” (#2525) remains deferred.

## Problem / proposal

Node.js host-API support (`process`, and future `fs`, `path`, `url`, `os`, …)
is currently lowered as **inline glue** baked into each compiled module:
`node-process-api.ts` marshals buffers and emits the WASI syscall (`fd_read` /
`fd_write`) directly into the user module. There is no separately-compiled,
reusable Wasm module that implements the Node API surface and gets **linked when
required**.

Proposal: factor each Node host-API surface into its own linkable provider that
user modules import on demand, instead of re-emitting the glue per module. The
user artifact names the standard `node:<module>` interface and real member;
provider selection and composition happen after the compiler has frozen the
program's required-member set. This keeps the user's binary focused on user
code, lets implementations version independently, and gives a clean seam for
the dual-mode story (WASI syscalls vs JS host).

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

- Define a stable Wasm import interface named after each standard Node module,
  starting with byte/scalar members of `node:process` and `node:fs`.
- Emit only the real members proven used by prepared IR. Namespace recognition
  alone must not link a provider family.
- Select and link the provider from the frozen runtime-feature/capability plan;
  backend emission must not rescan source or infer use from stringly import
  names.
- Keep the dual-mode contract: WASI syscall backing in standalone, JS host
  backing when a JS runtime is present (cf. #1044 Node-builtins-as-host-imports).
- Prove with negative fixtures that unused Node modules, members, provider code,
  and transitive WASI imports are absent from the artifact.
- Out of scope: GC-typed runtime helpers (number_toString, string/array helpers)
  — tracked separately in #2514, blocked on the cross-module GC type-identity
  problem.

## Resolved constraints and remaining design work

- The public import namespace is `node:<module>`, never an
  implementation-specific shim name. The module declares what it needs, not
  how it is satisfied.
- Core-Wasm linking is the current composition mechanism. A real Node host may
  satisfy the same interface directly where ABI adaptation permits it.
- The first tractable tranche is byte/scalar IO. GC string/object APIs require
  an explicit cross-module representation/versioning decision; they must not be
  smuggled through ambient externrefs.
- ABI versioning, provider compatibility checks, and diagnostics for a missing
  or incompatible provider remain implementation work for this issue.

## Acceptance criteria

- [ ] A compiled member call declares `node:<module>` plus the real Node member
      name and never exposes an implementation-specific provider namespace.
- [ ] Prepared IR records the exact used-member set and provider requirements
      before emission; linking consumes that frozen record.
- [ ] JS-host and WASI providers can satisfy the same declared interface without
      source changes or compiler-special syscall lowering.
- [ ] ABI version/capability mismatches fail with stable diagnostics before a
      provider can return an empty or placeholder value.
- [ ] Positive fixtures execute one selected member per initial provider;
      negative fixtures prove unused members, modules, code, and transitive host
      imports are absent.
- [ ] “Compiler-derived capability manifest and per-program explain workflow”
      (#4382) explains the interface, selected provider, and transitive
      requirements from the same decision record.

## Notes

Discovered while investigating loopdive/js2#389 (Native Messaging host). For a
single standalone binary the dedup payoff is small (the inlined glue is exactly
what that host needs); the win is multi-module reuse and a clean dual-mode seam.
Pairs with #2514 (runtime helpers as a shared module); split out because the two
have different blockers — this one is value/byte-typed and tractable now, #2514
is GC-typed and blocked.
