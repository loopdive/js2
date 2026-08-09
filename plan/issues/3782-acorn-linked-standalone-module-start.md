---
id: 3782
title: "Run linked Acorn benchmark driver through standalone module initialization"
status: ready
sprint: current
created: 2026-07-29
updated: 2026-07-29
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler, standalone, dogfood
language_feature: large modules, linked modules, strings, parser
goal: performance
assignee: "ttraenkler/codex"
depends_on: [3781]
related: [1710, 1712, 3780]
files:
  - plan/issues/3782-acorn-linked-standalone-module-start.md
  - scripts/generate-npm-compat-report.mjs
  - src/codegen/index.ts
  - src/codegen/object-ops.ts
  - tests/issue-3782-acorn-linked-init.test.ts
origin: "npm dual-lane benchmark #3781: linked Acorn 8.16.0 emits a zero-import standalone binary but throws during module initialization"
---

# #3782 — run linked Acorn benchmark driver through standalone initialization

## Reproduction

Run:

```bash
pnpm run benchmark:acorn:standalone
```

The deterministic pinned `acorn@8.16.0` source and a separate benchmark entry
module are passed to `compileMulti` with:

```text
allowJs: true
optimize: 4
target: standalone
```

The entry imports `parse` from Acorn, reconstructs the same 226 KB distribution
source from bounded 1 KB string chunks, parses it in the compiled loop, and
returns `ast.body.length` as a checksum.

The first generator form used a left-deep chain of string concatenations and
failed during compilation:

```text
Internal error compiling expression: Maximum call stack size exceeded
```

The captured stack ended in `compileStringBinaryOp` recursively compiling that
synthetic chain. #3781 fixed the harness by emitting a flat array of bounded
string literals and reconstructing the input in the compiled driver.

After that correction, compilation succeeds in about 28.6 seconds and emits a
valid 1,672,228-byte WasmGC binary with **zero imports**. Instantiation still
throws a `WebAssembly.Exception` from Acorn's module-start initialization before
the benchmark export can run. The published lane therefore records
`status: runtime-error`, `phase: instantiate` instead of inventing a timing.

## Investigation

Identify which Acorn module-start initializer throws in standalone. Compare:

1. Acorn package alone under `target: standalone`;
2. linked driver with a small input literal;
3. linked driver with the chunked 226 KB input;
4. default JS-host compilation of the same package and driver.

The input is now reconstructed inside the exported function, so the exception
precedes both input construction and parsing. Bisect Acorn's token types,
prototype/accessor setup, regular expressions, and lookup tables until the
throwing initializer and missing standalone semantic are isolated.

## Current finding

The module-start exception had two compiler causes. Repeated linked declaration
passes carried `defineProperty`/freeze/seal facts from the prior source pass,
and standalone `Object.defineProperties` could not apply Acorn's stable
runtime-filled descriptor maps to function prototypes. Resetting only those
order-sensitive compiler facts per source and generically expanding a
provably-stable descriptor map lets the exact linked Acorn module initializer
complete with zero imports.

The linked parser call still fails later in execution through a separate
cross-module value/closure ABI path. The measured standalone Acorn lane
therefore temporarily compiles the unchanged package and benchmark driver as
one source. It now performs the real parse and reports timings, but this linked
issue remains open until `compileMulti` does the same.

## Acceptance criteria

- [x] The exact linked package-and-driver reproduction compiles to a valid
      standalone binary with zero imports.
- [x] The binary instantiates and its explicit module initializer completes
      without throwing.
- [ ] One driver invocation returns the same `ast.body.length` checksum as
      native Acorn.
- [ ] `pnpm run benchmark:acorn:standalone` reports nine measured rounds rather
      than a failure status.
- [ ] A reduced regression test fails on the recursive traversal before the fix
      and passes without increasing Node's stack size.
