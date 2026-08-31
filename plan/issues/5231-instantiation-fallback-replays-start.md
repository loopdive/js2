---
id: 5231
title: "Instantiation fallback retries modules after start-section failure, replaying initialization"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: runtime
language_feature: wasm-instantiation
goal: core-semantics
related: [66, 907, 1155, 1619]
requested_by: ttraenkler/codex-sol-ultra
---

# #5231 — do not replay a failed Wasm start section as feature fallback

## Problem

`instantiateWasm` is intended to try native `wasm:js-string` built-ins and
fall back to the JS polyfill only when the native option is unsupported.
Instead, `src/runtime.ts:18708-18717` catches **every** rejection from
`WebAssembly.instantiate` and retries at lines 18719-18724.

Instantiation is not side-effect-free: a Wasm start section can call host
imports and then throw. The catch-all cannot distinguish an unsupported
built-in option from a compile error, link error, import exception, or
start-section runtime failure. It therefore repeats user-visible
initialization before propagating the second error.

The streaming path is worse. `instantiateWasmStreaming` first catches the
streaming rejection at `src/runtime.ts:18744-18755`, reads the cloned response,
then calls the same two-attempt helper at lines 18771-18772.

## Reproduction

A minimized module whose start function calls `env.hit()` once and then traps
produced these counts on current upstream main:

- `instantiateWasm`: `hit` called **2** times, final error
  `WebAssembly.RuntimeError: unreachable`;
- `instantiateWasmStreaming`: `hit` called **3** times, same final error;
- duplicate helper `src/runtime-instantiate.ts`: **2** calls.

A positive control confirmed that top-level module initialization happens
inside the awaited instantiation operation. No active issue owns this retry
classification; #66 merely recorded that the fallback stayed as-is.

## Impact

Any start-time host effect can be duplicated or triplicated: registration,
logging, counters, DOM writes, callbacks, or mutations in an imported service.
The caller sees only the final failure and cannot know that initialization was
replayed. The same broad catch also obscures the original error if the retry
fails differently.

## Direction

Separate compile/feature negotiation from instantiation. Prefer compiling with
the native options first, or classify only the precise unsupported-option
failure before a start section can execute. Once instantiation begins, propagate
compile/link/start/import failures unchanged and never retry the module.

Keep one canonical implementation; `src/runtime-instantiate.ts` duplicates
the public helpers and must not retain a second fallback policy (see #3103).

## Acceptance criteria

- [ ] A start-section or imported-function failure is propagated unchanged
      after exactly one instantiation attempt.
- [ ] Throwing byte and streaming fixtures each observe exactly **1** `hit`.
- [ ] An engine that genuinely rejects native string built-in options still
      reaches the JS polyfill and instantiates successfully.
- [ ] MIME/streaming compilation fallback remains supported without retrying a
      module after instantiation has begun.
- [ ] Production and any retained helper entry point share the same tested
      classification policy.
