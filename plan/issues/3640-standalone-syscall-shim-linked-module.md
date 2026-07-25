---
id: 3640
title: "Factor standalone/WASI's linear-memory host operations (timers, fs, env, clock) into a pre-compiled, separately-linked module"
status: backlog
sprint: Backlog
created: 2026-07-25
priority: low
feasibility: medium
model: opus
horizon: l
reasoning_effort: high
task_type: investigation
area: compiler, codegen
language_feature: compiler-internals
goal: performance
related: [1585]
---

# #3640 — outsource the WASI reactor/syscall shim to a pre-linked module

## Context

Investigating js2wasm compile-time cost (from the test262.fyi js2wasm
integration work — `--target gc` compile+execute steady-state is ~1-1.5s per
test even with a warm compiler instance). A CPU profile of a single warm
`compile()` call showed the cost splits roughly:

- ~55% TypeScript's own parser/checker/binder (`resolveNameHelper`,
  `checkExpressionWorker`, `getUnionTypeWorker`, etc.) — substantial even
  with `skipSemanticDiagnostics: true`, because codegen still needs real
  type information to choose Wasm instructions.
- ~39% js2wasm's own codegen (`mapTsTypeToWasm`, `collectInterfaceMembers`,
  `compileCallExpression`, `compileBinaryExpression`, etc.)
- ~5% GC, rest negligible.

While investigating whether standalone/WASI-specific codegen could be
factored out of the per-compile hot path (see #3641 for the broader
"share the front end across targets" investigation this issue was split off
from), one category stood out as a genuinely good candidate for **not
regenerating from scratch on every compile**: the standalone/WASI
event-loop reactor.

## What the reactor is

Under `--target wasi`/`standalone`, there's no JS host to drive
`setTimeout`/`setInterval`/stdin waiting the way a browser or Node does. The
compiler synthesizes its own tiny event loop into every compiled program:

- a **timer heap** (generated Wasm code + memory tracking pending
  `setTimeout`/`setInterval` calls and their deadlines)
- a **run loop** that calls the real WASI syscall `poll_oneoff`
  (`wasi_snapshot_preview1` — "block until a clock deadline passes or a file
  descriptor becomes ready", WASI's analog of `select`/`poll`) plus
  `clock_time_get` for the current time
- dispatch back into user code via typed function references (`call_ref`)
  when a timer fires

This machinery lives in `src/codegen/wasi.ts` (`ensureTimerHeap`,
`emitDeferredWasiHelpers`, the `poll_oneoff`/`clock_time_get`/`fd_read`/
`fd_write`/`path_open`/`environ_get` import wiring) and gets **synthesized
fresh into every compiled program** that touches timers, file I/O, or stdin
under a host-free target.

## Why it's a good candidate for factoring out

Unlike the bulk of standalone/WASI-specific codegen (string representation,
object/array layout, Map/Set/WeakMap's native runtime — see #3641's
category-2 findings), this cluster interacts entirely through **linear
memory**: `poll_oneoff`/`fd_read`/`fd_write`/`path_open`/`environ_get`/
`clock_time_get` all take i32 pointer/length pairs into linear memory, not
GC-typed references. That's a calling convention that's already universal —
there's no data-representation disagreement to resolve, unlike (for
example) `setTimeout`'s own callback argument, which genuinely differs by
target (`externref` for JS-host's real host round-trip vs. native `funcref`
for standalone's direct `call_ref` — confirmed by reading
`import-resolver.ts`'s `TIMER_SHIM_FNS` handling).

Proposed shape: compile the reactor's timer-heap + run-loop + syscall-wiring
logic **once**, ahead of time, as its own small Wasm module exporting
`setTimeout`/`clearTimeout`/`setInterval`/an event-loop-driver function
(e.g. `__run_event_loop_if_needed`), using the native `funcref` calling
convention standalone already uses. At instantiation time, this module gets
instantiated first and its exports wired into the user program's import
object — the same composition mechanism js2wasm's own JS-host target already
uses for `result.importObject`, just with a Wasm module as the import
source instead of JS functions. Every compiled standalone/WASI program then
just emits a handful of import declarations instead of the full reactor
machinery.

**Cross-module GC type compatibility isn't a blocker.** Verified: the WasmGC
spec defines type canonicalization by structural equivalence at the
store/embedding level, not scoped to a single module — if the reactor module
and every generated program declare the identical structural shape for "a
zero-arg callback function," the runtime treats them as the same canonical
type with no extra machinery needed. (Worth an empirical two-module Wasmtime
test before relying on this, since this session has independently found
multiple cases of "the spec allows X but stable Wasmtime doesn't fully
support it yet.")

## Expected benefit

Removes a chunk of the ~39% codegen-time bucket for any standalone/WASI
program that uses timers, file I/O, or stdin — real, but bounded: it's one
identified cluster within codegen, not the dominant cost driver (general
expression/property/array/string compilation — see #3641 — is much larger
and does NOT benefit from this pattern, since it's genuinely
representation-bound rather than backend-swappable).

## Suggested approach

1. Empirically verify cross-module GC type canonicalization in Wasmtime with
   a minimal two-module test (module A exports a function taking a typed
   `funcref` callback param; module B, compiled separately with the
   structurally-identical type declared independently, imports and calls
   it) before investing further design time.
2. Identify the reactor's minimal exported surface
   (`setTimeout`/`clearTimeout`/`setInterval`/the drain/run-loop entry
   point) and its stable ABI (argument/return types) as a contract both the
   reactor module and the main compiler's codegen must agree on.
3. Prototype: compile the reactor module once (part of js2wasm's own build,
   not per-user-compile), swap `src/codegen/wasi.ts`'s per-compile
   synthesis for import declarations against that stable ABI.
4. Measure compile-time delta on a representative WASI/standalone test262
   sample that exercises timers/fs/stdin.

## Non-goals (for now)

- Does not address the dominant codegen cost (string/object/array
  representation differences) — see #3641 for that, and it isn't the same
  pattern (those differences aren't swappable-backend, they're
  representation-level, per that investigation).
- Not committing to this shipping — this is a backlog investigation, not an
  active work item. Revisit if/when #3641 lands or standalone compile-time
  becomes a concrete bottleneck worth the engineering cost.
