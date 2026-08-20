---
id: 4565
title: "WASI `writeFileSync(path, data)` must support dynamic string arguments in linear-memory lowering"
status: done
sprint: current
created: 2026-08-19
updated: 2026-08-20
completed: 2026-08-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: es5
es_edition: 5
language_feature: strings
origin: "2026-08-19 ES5 standalone/wasi lane. `writeFileSync` lowers dynamic path/data strings via runtime scratch-memory flattening instead of relying on compile-time string literals."
loc-budget-allow:
  - src/compiler.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/wasi.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# #4565 — `writeFileSync` dynamic strings on `--target wasi` need runtime linear-memory lowering

## Symptom

Under `--target wasi`, `writeFileSync` is compiled to direct WASI syscalls when possible, but only literal string arguments are safely lowered to linear memory for `path_open`/`fd_write`.
Dynamic string expressions (concatenation, variables, template substitutions) currently follow a brittle/incorrect path and can fail when used for file path or data arguments.

## Root cause

`writeFileSync`’s WASI lowering relies on string literals being compiled into precomputed data segment offsets.
For non-literal argument expressions, the codegen path did not own the lifetime
of runtime-encoded bytes. Encoding path and data independently into the same
scratch range overwrote the path before `path_open` consumed it. The old
identifier shortcut also reused literal initializers after mutable variables
had changed.

## Work

- Add an on-demand IR helper `__wasi_write_file_strings(path, data)` in the WASI
  helper layer. It evaluates both arguments first, encodes and opens the path,
  then safely reuses scratch to encode and write the data.
- Normalize direct, nullable, union, and `any` carriers to a strict primitive
  `AnyString`; non-strings throw a catchable `TypeError` rather than a raw Wasm
  trap.
- Preserve literal/literal data-segment lowering and evaluate ignored options
  arguments in source order.
- Make the shared WASI byte sink match `TextEncoder` for unmatched surrogates.
- Keep the WASI node:fs exemption closed over explicitly lowered members and
  known path-based members owned by the precise no-provider gate. Aliased and
  first-class bindings fail loudly, and lexical shadows keep their own identity.

## Acceptance

- A `wasi` module that uses dynamic path and data strings for `writeFileSync`
  should compile, instantiate with only `wasi_snapshot_preview1` imports, and
  execute file writes with correct runtime values.
- Dynamic/dynamic and both mixed literal/dynamic shapes preserve current values,
  left-to-right argument side effects, and UTF-8 byte parity with literals.
- Strings carried through `any` work; genuine non-strings throw `TypeError`.
- Unsupported node:fs members fail compilation rather than disappearing.
- A late import during operand compilation cannot stale the final helper index.

## Verification

- `tests/issue-4565-wasi-dynamic-writesync-linear-memory.test.ts`
- `tests/issue-1035.test.ts`
- `tests/issue-1255.test.ts`
- `tests/issue-1470.test.ts`
- `tests/issue-2639-node-fs-writesync-string-dataview.test.ts`
- `tests/issue-2655-direct-wasi-readsync-writesync.test.ts`
