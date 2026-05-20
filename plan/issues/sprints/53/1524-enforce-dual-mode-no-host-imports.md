---
id: 1524
sprint: 53
title: "Enforce dual-mode architecture: --no-host-imports flag + CI gate"
status: ready
created: 2026-05-20
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: cli, codegen, ci
language_feature: WASI / standalone-mode
goal: standalone-mode
related: [1094, 1103, 1105, 1335, 1470, 1471, 1472, 1473, 1474]
---

# #1524 — Enforce dual-mode architecture: --no-host-imports flag + CI gate

## Problem

`CLAUDE.md` documents the architectural principle: **"JS host optional —
new features should have Wasm-native implementations for standalone mode;
JS host imports are acceptable as a fast path when a JS runtime is
available."**

The principle is **not enforced anywhere in the toolchain**. Import-
registration phases in `src/codegen/index.ts` add JS host imports
unconditionally, without checking `ctx.wasi`:

- `parseInt` / `parseFloat` — `src/codegen/index.ts:~4440–4450`
- `number_toString` / `toFixed` / `toPrecision` / `toExponential` — `~1920–1945`
- 20+ string methods (`split`, `replace`, `match`, `includes`, ...) — `~1900–1950`
- `RegExp_new` and RegExp prototype methods — `src/codegen/typeof-delete.ts:301–308`
- `Map` / `Set` / `WeakMap` constructors — runtime builtin table

Result: `--target wasi` silently produces modules with `env` imports that
no WASI runtime will satisfy. The "Standalone (WASI)" mode advertised in
`ROADMAP.md:38–42` works for trivial programs only.

The host-independence epics (#1470, #1471, #1472, #1473, #1474) provide
Wasm-native fallbacks for many of these, and #1103 / #1105 / #1335 are
the missing pieces. But there is no automated check that prevents
**new** code from introducing a host-only path.

## Acceptance criteria

1. **CLI flag `--no-host-imports` (alias of the existing strict mode
   intent of `--target wasi`)** errors at compile time when codegen
   would emit a JS-host `env` import that has no Wasm-native fallback.
   The error message names the offending feature and points at the
   tracking issue.
2. **The flag is implicit under `--target wasi`** — WASI builds always
   run in strict mode. A `--allow-host-imports` escape hatch exists for
   debugging only and is not on by default.
3. **CI smoke test** in `.github/workflows/ci.yml` compiles every file
   under `playground/examples/*.ts` with `--target wasi` and
   instantiates the result on Wasmtime with **no `env` import object**.
   The test fails if any module requires a host import that is missing.
4. **An allowlist of currently-acceptable host imports** lives at
   `src/codegen/host-import-allowlist.ts` (or similar). Each entry is
   tagged with the tracking issue that will eliminate it. The CI gate
   forbids growing this list; PRs that add an entry require an explicit
   sign-off (label or path-based CODEOWNERS).
5. **Coverage milestone**: at least the following examples instantiate
   without host imports on Wasmtime after this issue lands:
   - FizzBuzz
   - Fibonacci
   - Arithmetic on bigint
   - A string-method demo using only methods covered by #1105

## Implementation notes

- The check lives at the `addImport`/`registerImport` boundary in
  `src/codegen/index.ts`. Thread `ctx.strictNoHostImports` through.
- For features where the Wasm-native path exists but is not the default
  (e.g. `nativeStrings`), strict mode flips them on automatically.
- The example smoke test reuses `tests/wasi-runner.ts` (or creates one)
  to spawn Wasmtime and check exit code; no JS host shim is provided.
- Dispatch: this issue is the **meta-enforcement** for the dual-mode
  effort. It does not implement any new Wasm-native primitive — those
  live in #1103, #1105, #1335, and the host-independence epics. It
  ensures the rest of the work cannot regress.

## Related

- #1094 — shrink runtime.ts host boundary (foundational)
- #1099 — standalone FizzBuzz on Wasmtime (validation target)
- #1103 — Wasm-native Map/Set/WeakMap/WeakSet
- #1105 — Wasm-native String method implementations
- #1335 — Number formatting in pure Wasm
- #1470–#1474 — host-independence epics (boxing, string ops, object ops,
  error/exceptions, regex)
