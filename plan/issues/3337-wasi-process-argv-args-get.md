---
id: 3337
title: "wasi: materialize process.argv through args_get instead of a silent empty vector"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, wasi
language_feature: process-argv
goal: standalone-mode
sprint: Backlog
horizon: m
es_edition: n/a
complexity: M
related: [1035, 1482, 1490, 1532, 1801, 3340]
origin: "2026-07-17 current-origin/main PO audit, corrected by second-pass probe: process.argv validates but returns an empty import-free vector"
---

# #3337 - WASI `process.argv` must materialize through `args_get`

## Problem

`process.argv` under `--target wasi` reports compile success and emits valid
WebAssembly, but the module has no argv imports and silently exposes an empty
vector. A direct runtime probe returns `argc() === 0` even when the host has
arguments. The current `it.fails` test and its invalid-binary comment are stale:
the assertion now passes, so Vitest fails only because an expected failure
unexpectedly passed.

The fix should implement a real WASI argv path, not reuse the Node host-import
path and not narrow the behavior to a JS polyfill-only shortcut.

## Evidence on current `origin/main`

- `tests/real-world-wasi.test.ts:39-58` still marks `"reads process.argv as a
valid WASI module"` as `it.fails` and describes an `__str_flatten`
  invalid-binary failure. On current main, focused execution reports
  `Expect test to fail`: both `result.success` and `WebAssembly.validate` are
  now `true`.

  ```ts
  declare const process: { argv: string[] };
  export function argc(): number {
    return process.argv.length;
  }
  ```

- A current-main runtime probe of that exact source reports no module imports,
  instantiates with `buildWasiPolyfill()`, and returns `argc() === 0`. It does
  not import `wasi_snapshot_preview1.args_sizes_get` or `args_get`.
- #1801 recorded the then-observed native-string failure as out of scope at
  `plan/issues/1801-wasi-process-exit-invalid-binary.md:121-129`. The failure
  mode has changed, but the deferred argv semantics remain unimplemented.
- The implemented `process.argv` runtime path is explicitly non-WASI:
  `src/codegen/property-access-dispatch.ts:1524-1549` gates the Node
  `__get_process_argv` import on `!ctx.wasi`.
- `tests/wasi.test.ts:22-27` still lists `args_get` / `args_sizes_get` and
  `process.argv` support as out of scope.
- #1490 is done for Node host mode, not WASI: its problem statement and plan
  are Node runtime access at
  `plan/issues/1490-nodejs-process-argv-env-runtime.md:18-24` and
  `plan/issues/1490-nodejs-process-argv-env-runtime.md:72-83`.
- #1035's follow-up list points `process.argv` / `process.env` to #1044 at
  `plan/issues/1035-wasi-hello-world-compile-console.md:232-240`, but #1044 is
  not the WASI argv implementation; the pointer is stale.
- #1532 mentions `process.argv[2] -> args_get` as one case in a tests-only WASI
  syscall suite at `plan/issues/1532-wasi-syscall-unit-test-suite.md:26-33`,
  but its acceptance is "PR is tests-only" at
  `plan/issues/1532-wasi-syscall-unit-test-suite.md:69-77`. It cannot fix this
  compiler/runtime behavior.
- `src/runtime/wasi-polyfill.ts:24-35` exposes fd, env, clock, and memory
  helpers but no `args_sizes_get` / `args_get` shims or `{ args }` option.
- `src/codegen/wasi.ts:498-525` shows the current `process.env` precedent:
  WASI imports are registered for the protocol, with a separate JS-polyfill
  fast path. There is no analogous argv registration.

## Impact

WASI CLI programs cannot inspect their arguments, and the failure is silent:
valid-looking programs compile, instantiate, and observe the wrong argc rather
than receiving an unsupported-feature diagnostic. That can misconfigure real
command-line programs without any compilation or runtime signal. The stale
expected-failure sentinel also pollutes the root issue-test baseline (#3340).

## Root cause / unknowns

The exact current lowering route is unknown. It no longer reaches the old
invalid native-string path; instead, it produces an import-free value whose
length is zero. The implementation must trace where `process.argv` is replaced
or defaulted before adding `args_sizes_get` / `args_get` materialization.

Open semantic choices for the implementer:

- Whether guest `process.argv` should expose WASI argv verbatim, including
  argv0, or emulate Node's `process.argv` shape. The issue should document the
  chosen contract and keep tests consistent with it.
- Whether the first slice supports only `.length` and indexed reads, or full
  array iteration. If only a subset is shipped, unsupported operations must
  fail loudly instead of silently returning incomplete data.

## Proposed approach

1. Add a WASI `process.argv` detector beside the existing `process.env` scan in
   `src/codegen/wasi.ts`, registering `args_sizes_get` and `args_get` only when
   argv is referenced.
2. Materialize argv into the existing standalone string/array representation
   using WASI linear-memory buffers, with bounds-checked allocation and a clear
   contract for argv0.
3. Extend `buildWasiPolyfill()` with deterministic test args, for example
   `{ args?: string[] }`, and implement memory-writing `args_sizes_get` /
   `args_get` shims.
4. Keep the Node host import path in `property-access-dispatch.ts` gated to
   non-WASI mode. WASI modules should import only `wasi_snapshot_preview1`
   functions for argv unless a documented test-only polyfill import is needed.
5. Replace the stale `it.fails` sentinel with executable import, validity, and
   runtime coverage.

## Non-goals

- Reworking Node host-mode `process.argv` (#1490).
- Implementing all Node `process` APIs in WASI mode.
- Solving unrelated native-string invalid-binary buckets.
- Implementing WASI component-model `wasi:cli/environment`; this issue targets
  preview1 `args_sizes_get` / `args_get`.

## Dependencies / related issues

- Related: #1482 (`process.env`/`environ_get`) is the closest implementation
  precedent.
- Related: #1801 fixed `process.exit` invalid-binary behavior and documented
  argv as separate work.
- Related: #1490 covers Node host mode and must not be regressed.
- Related: #1532 should use this issue's implementation as the prerequisite for
  its argv syscall-suite case; it is not an implementation owner.
- Related: #3340 owns expected-failure/baseline hygiene, not argv semantics.
- No open issue other than this one owns WASI argv support.

## Why this is not already covered

#1801 explicitly deferred argv work. #1490 is Node-host-only, #1482 is env-only,
#1532 is tests-only, #3340 is gate hygiene only, and #1035's old follow-up
pointer is stale. Searches for `args_get`, `args_sizes_get`, and `process.argv`
on current `origin/main` find no implementation owner that supplies host argv
to the guest.

## Acceptance criteria

- [ ] The stale `tests/real-world-wasi.test.ts` `it.fails` sentinel and
      invalid-binary comment are replaced with a passing runtime contract test.
- [ ] `process.argv.length` under `{ target: "wasi" }` returns the documented
      argc value with a deterministic test argv source.
- [ ] At least one indexed read test, for example `process.argv[1].length` or a
      string equality check, validates that argv strings are materialized
      correctly.
- [ ] The emitted WASI module validates with `WebAssembly.validate(binary) ===
true` and instantiates with `buildWasiPolyfill({ args: [...] })`.
- [ ] The module's argv imports come from `wasi_snapshot_preview1`
      `args_sizes_get` / `args_get`, with no `env.__get_process_argv` host
      import in WASI mode.
- [ ] Existing Node host-mode tests for #1490 still pass.

## Validation plan

- Run the focused WASI argv tests added for this issue.
- Run `pnpm test tests/real-world-wasi.test.ts tests/wasi.test.ts tests/issue-1490.test.ts`.
- Run a WAT/import inspection asserting only expected WASI argv imports are
  introduced when argv is referenced.
- Run the standard issue-specific test gate if the implementation adds
  `tests/issue-3337.test.ts`.
