---
id: 1482
title: "wasi: wire process.env to environ_get / environ_sizes_get"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: process.env
goal: wasi-completeness
sprint: 52
related: []
---
## Problem

Under `--target wasi`, `process.env.FOO` either disappears (when the
user passes `--define process.env.FOO=...` at compile time via
`src/compiler/define-substitution.ts`) or fails entirely. There is no
runtime path to `environ_get` / `environ_sizes_get`, so a WASI program
cannot observe the environment variables wasmtime hands it
(`wasmtime --env KEY=VALUE app.wasm`).

This matters for: CLI tools that switch on `NODE_ENV` / `DEBUG`,
benchmarks that read configuration at run time, and tests that need
to set `RUST_LOG`-style flags without recompiling.

## Current behavior

- `src/compiler/define-substitution.ts` only handles **compile-time**
  string replacement (`--define`). Anything else falls through.
- Runtime access to `process.env.X` under WASI compiles to a missing
  `env::process_env_*` import; wasmtime rejects the module unless the
  embedder happens to supply one (it never does).
- `grep -rn "environ_get\|environ_sizes_get" src/` returns nothing.

## Expected behavior

`process.env.FOO` (and `process.env["FOO"]`) compiled with
`--target wasi` should:

1. Read the actual environment passed to wasmtime via
   `environ_sizes_get` + `environ_get`.
2. Return a string when the key exists, `undefined` otherwise.
3. Round-trip with `wasmtime --env FOO=bar app.wasm` →
   `console.log(process.env.FOO)` prints `bar`.

A bulk accessor `Object.keys(process.env)` is a stretch goal — the
core requirement is single-key lookup.

## Implementation plan

1. **Detect usage.** In `src/codegen/index.ts:3063`
   (`registerWasiImports` visitor), look for
   `ts.isPropertyAccessExpression` chains whose base is the
   identifier `process` and property `env`. Set
   `needsEnviron = true`.

2. **Register imports.**
   ```ts
   const sizesType = addFuncType(ctx,
     [{ kind: "i32" }, { kind: "i32" }],
     [{ kind: "i32" }], "$wasi_environ_sizes_get");
   addImport(ctx, "wasi_snapshot_preview1", "environ_sizes_get",
     { kind: "func", typeIdx: sizesType });
   const getType = addFuncType(ctx,
     [{ kind: "i32" }, { kind: "i32" }],
     [{ kind: "i32" }], "$wasi_environ_get");
   addImport(ctx, "wasi_snapshot_preview1", "environ_get",
     { kind: "func", typeIdx: getType });
   ```
   Store the indices on `ctx.wasiEnvironSizesGetIdx` /
   `ctx.wasiEnvironGetIdx` (add fields to
   `src/codegen/context/types.ts`).

3. **Emit a lookup helper** `__wasi_env_lookup(keyPtr, keyLen) -> i32`
   that:
   - Calls `environ_sizes_get(countPtr, bufSizePtr)`.
   - Bumps the WASI bump pointer to allocate `count * 4 + bufSize`
     bytes, calls `environ_get(envPtrsPtr, envBufPtr)`.
   - Iterates each `"KEY=VALUE"` slot, scans for `=`, compares the
     prefix against the key, returns a pointer to VALUE bytes (and a
     length out-param at the bump scratch area) on match.
   - Returns `0` for not-found.

4. **Convert the result to a string.** Wrap the helper in
   `__wasi_env_lookup_str(keyPtr, keyLen) -> NativeString` that
   allocates the `anyStrTypeIdx` struct from the matched bytes, or
   pushes `undefined` (in JS terms, `null` / a sentinel) when no
   match is found.

5. **Wire the front-end.** In `src/codegen/expressions/identifiers.ts`
   (or wherever `process.env.X` resolves), if `ctx.wasi`, lower the
   property access to `__wasi_env_lookup_str("X", 1)`. Cache the
   key string in a data segment via `wasiAllocStringData` to avoid
   re-emitting per access.

6. **Cache `environ_get` results.** A program may call
   `process.env.X` many times. Add a guard global
   `__wasi_environ_loaded` so the bulk fetch only runs once; later
   lookups iterate the cached table.

7. **JS polyfill.** Extend `buildWasiPolyfill` in
   `src/runtime.ts:4870` to implement `environ_sizes_get` and
   `environ_get` from a user-supplied dict (default `process.env`
   in Node).

## Acceptance criteria

- `wasmtime --env GREETING=hi app.wasm` running a program that does
  `console.log(process.env.GREETING)` prints `hi`.
- Missing key (`process.env.MISSING`) yields `undefined`-equivalent
  (string `"undefined"` when concatenated, or `null` falsy in a
  conditional — pick one and document).
- Equivalence test compiles a fixture under
  `--target wasi`, invokes the polyfill with a known env, asserts
  the output.

## Files to modify

- `src/codegen/context/types.ts` — add
  `wasiEnvironSizesGetIdx`, `wasiEnvironGetIdx`.
- `src/codegen/index.ts` ~3036 — detect + register imports + helper.
- `src/codegen/expressions/identifiers.ts` (and/or
  `property-access.ts`) — lower `process.env.X` to the helper call
  under `ctx.wasi`.
- `src/compiler/define-substitution.ts` — leave alone; runtime path
  takes over only when no compile-time `--define` matched.
- `src/runtime.ts` ~4870 `buildWasiPolyfill` — add environ shims.
- New fixture/test under `tests/wasi-environ.test.ts`.
