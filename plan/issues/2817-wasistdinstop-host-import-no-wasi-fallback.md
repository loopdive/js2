---
id: 2817
title: "nm_node_process: env.__wasiStdinStop host import has no WASI-native fallback / not on the dual-mode allowlist (#2735 follow-up)"
status: done
assignee: ttraenkler/sendev
created: 2026-06-29
updated: 2026-06-29
completed: 2026-06-29
priority: medium
feasibility: medium
task_type: bug
area: codegen
language_feature: process-stdin-async-reactor
goal: platform
sprint: current
horizon: m
related: [389, 2735, 2807, 2777]
---

# `env.__wasiStdinStop` host import has no WASI-native fallback

## Problem

Compiling `examples/native-messaging/nm_js2wasm_node_process.ts --target wasi`
emits (reported on loopdive/js2#389):

> warning: Host import `"env.__wasiStdinStop"` requested under `--no-host-imports`
> / WASI strict mode, but the name is not on the dual-mode allowlist
> (`src/codegen/host-import-allowlist.ts`).

`__wasiStdinStop` (introduced in #2735 for a **non-EOF reactor exit** —
`emitStdinStop` in `src/codegen/async-scheduler.ts`, declared in
`src/process-stdin-prelude.ts:180`) drops the fd0 reactor subscription so the
async `process.stdin` run loop can terminate without an EOF. Under `--target wasi`
(host-free / strict) it's emitted as an `env.*` **host import with no Wasm-native
fallback**, which bends the dual-mode principle ("no new host imports without a
standalone fallback", CLAUDE.md), and it isn't on `HOST_IMPORT_ALLOWLIST`, so the
strict-WASI gate warns.

`nm_node_process` does round-trip under real wasmtime today, so first confirm
whether the import is actually satisfied/invoked or effectively dead in the WASI
build — the warning may indicate a **latent strict-WASI gap** (the non-EOF stop
path unsatisfiable standalone).

## Fix (one of)

- **(a)** provide a WASI-native fallback for the non-EOF stdin-subscription stop
  so the reactor terminates without a host import under `--target wasi`; **or**
- **(b)** if a transitional host import is genuinely required, add a justified
  `HOST_IMPORT_ALLOWLIST` entry citing this issue (with `[allowlist-grow]`) and
  document the standalone limitation.

## Acceptance

`nm_js2wasm_node_process.ts --target wasi` compiles without the
`__wasiStdinStop` allowlist warning (via a WASI-native fallback) — or it's a
justified allowlisted import — and still round-trips under real wasmtime v46.

## Resolution (route a — WASI-native, no host import)

**Invoked-vs-dead finding: the `env.__wasiStdinStop` import was DEAD.** Every
`__wasiStdinStop()` call site is intercepted by `tryWasiTimerCall`
(`src/codegen/expressions/calls.ts`, `name === "__wasiStdinStop"`) and
inline-lowered by `emitStdinStop` (`src/codegen/async-scheduler.ts`) to a native
`i32.const 0; global.set $__stdin_fd_active` — there is no host call. The
`env.__wasiStdinStop` import only ever appeared because
`collectExternDeclarations` (`src/codegen/index.ts`) re-registered the prelude's
`declare function __wasiStdinStop(): void` stub as an `env.*` host import, which
dead-import elimination then dropped from the binary (hence the WASI build ran
fine under wasmtime) while still firing the "not on the dual-mode allowlist"
warning.

**Root cause:** `__wasiStdinStop` (added in #2735) was never added to the
`WASI_STDIN_REACTOR_INTRINSICS` skip-set in `src/codegen/index.ts`, even though
its four sibling intrinsics (`__wasiStdinReadByte` / `__wasiStdinAvailable` /
`__wasiStdinEof` / `__wasiStdinSetReader`) were. #2735 added the lowering + the
prelude `declare` but missed the skip-set, so the stub leaked as a phantom
import.

**Fix:** add `"__wasiStdinStop"` to `WASI_STDIN_REACTOR_INTRINSICS`. No host
import emitted, no allowlist growth, no standalone limitation. Verified: the
`--target wasi` compile of `nm_js2wasm_node_process.ts` no longer prints the
`__wasiStdinStop` warning, the finished `.wasm` has no `env.*` import, and it
round-trips byte-exact under wasmtime v46 at 1/64/128/256 MiB (with host
re-chunking to ≤1 MiB per #2814). EOF path and other WASI programs unaffected.

## Related

- #2735 — introduced `__wasiStdinStop`.
- #389 — reporter's compile output.
- #2807 / #2777 — `nm_node_process` and the stdin prelude.
