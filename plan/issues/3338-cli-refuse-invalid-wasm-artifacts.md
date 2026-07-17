---
id: 3338
title: "cli: refuse to write invalid Wasm artifacts after optimizer fallback"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: cli, compiler, optimizer
language_feature: compiler-output-validation
goal: trustworthiness
sprint: Backlog
horizon: s
es_edition: n/a
complexity: S
related: [953, 1858, 1927, 1950, 2143, 3024]
origin: "2026-07-17 stronger-model current-origin/main audit: CLI exits 0 and writes a validator-rejected private-field-in artifact in default and --no-optimize modes"
---

# #3338 - CLI must refuse invalid Wasm artifacts

## Problem

The CLI treats `CompileResult.success` as sufficient to publish output. When
codegen returns `success: true` with an invalid binary, the default optimizer
reports a validator warning and returns the original bytes; the CLI then exits
zero and writes those bytes. `--no-optimize` writes the same invalid module
without even the optimizer warning.

Users therefore receive a `.wasm`, `.wat`, and imports helper accompanied by a
success exit code even though the primary artifact cannot be instantiated.

## Evidence on current `origin/main`

This reduced source is distilled from
`test/language/expressions/in/private-field-rhs-non-object.js`:

```js
let caught = null;
class C {
  #field;
  constructor() {
    try {
      #field in {} << 0;
    } catch (error) {
      caught = error;
    }
  }
}
new C();
```

- Running `src/cli.ts` normally exits `0`, prints the generated artifact paths,
  and writes an 808-byte Wasm file. The warning says `wasm-opt -O3 failed` and
  identifies `C_init` with `local.tee` producing `f64` for a reference local.
  `WebAssembly.validate` on the written file is `false`.
- Running the same CLI command with `--no-optimize` also exits `0`, writes the
  same 808-byte invalid Wasm, and has no optimizer validator diagnostic.
- `src/cli.ts:383-395` gates failure only on `result.success`, then
  `src/cli.ts:438-448` writes `result.binary` and `result.wat` without a binary
  validation boundary.
- `src/compiler.ts:671-685` turns optimizer failure into a warning without
  changing `success`.
- `src/optimize.ts:208-223` presumes the input is valid and returns the original
  binary after a native `wasm-opt` error; the fallback at
  `src/optimize.ts:236-245` likewise describes shipping unoptimized output.
- The current committed test262 summary records 138 `wasm_compile` failures,
  and #3024 already includes the private-field `in` family. The producer bug is
  real and separately owned; this issue is the missing user-facing publication
  boundary.

## Impact

A compiler CLI that exits successfully after writing an invalid primary
artifact breaks shell automation, build caches, package publishing, and user
trust. Fixing individual emitter bugs cannot close this systemic boundary: any
new malformed-Wasm producer can recur until the CLI validates before publishing.

## Root cause / unknowns

`CompileResult.success` currently means code generation completed, not that the
binary validates. The optimizer deliberately preserves the original binary on
failure, and the CLI has no final validation step. The implementation must
decide whether to validate in memory before any output is written or stage all
artifacts and publish atomically after validation; the small in-memory check is
the expected first slice.

## Proposed approach

1. Add a CLI publication guard after compilation/optimization and before the
   `--wat` stdout path or any output-file write.
2. Validate `result.binary` with `WebAssembly.validate`; on failure, emit a
   concise fatal diagnostic, optionally obtaining the first engine validation
   detail from `new WebAssembly.Module(result.binary)`.
3. Exit nonzero and write no `.wasm`, `.wat`, `.d.ts`, or imports-helper files
   when the primary binary is invalid.
4. Add subprocess tests for both default `-O3` and `--no-optimize`, following
   the CLI patterns in `tests/issue-1950-default-optimization.test.ts`.
5. Keep ordinary optimizer-availability warnings nonfatal when the preserved
   binary itself validates.

## Non-goals

- Fixing the private-field `in` emitter defect or the wider #3024 bucket.
- Changing the programmatic `compile()` API's definition of `success`; that
  broader contract needs separate compatibility analysis.
- Making every warning fatal.
- Replacing Binaryen or changing optimization policy for valid input.

## Dependencies / related issues

- No hard dependency: the CLI can protect users before #3024 is fully fixed.
- #3024 owns default-lane malformed-Wasm producers, including this source
  family; it does not own CLI artifact publication.
- #2143 validates binaries in the differential harness, not the CLI boundary.
- #1927/#1950 own optimizer plumbing and default optimization behavior.
- #953 is done and claimed CLI validation in acceptance, but current source and
  the executable probe show that invariant is not present today.

## Why this is not already covered

Existing malformed-Wasm issues repair producer families. #2143 classifies
malformed output in a test harness. #953 is closed, and its intended CLI guard
is absent from current main. Searches across open issues, CLI tests, and
optimizer tests find no active owner for refusing the final invalid artifact in
both optimized and unoptimized CLI modes.

## Acceptance criteria

- [ ] The reduced private-field source exits nonzero through the default CLI
      pipeline and creates none of its normal output artifacts.
- [ ] The same source with `--no-optimize` exits nonzero and creates no output
      artifacts.
- [ ] The fatal diagnostic states that the emitted Wasm failed validation and
      includes the first available engine/validator detail.
- [ ] A representative valid source still exits zero and emits all requested
      artifacts in default and `--no-optimize` modes.
- [ ] An unavailable/failing optimizer remains a warning, not a fatal error,
      when the original binary validates.
- [ ] Focused tests exercise the real CLI as a subprocess and assert exit code,
      stderr, and filesystem side effects.

## Validation plan

- Run the new `tests/issue-3338-*.test.ts` subprocess suite.
- Run `pnpm test tests/issue-1950-default-optimization.test.ts` plus existing
  CLI output/flag tests.
- Run the reduced source manually in both modes and call
  `WebAssembly.validate` on any artifact; no invalid artifact may remain.
- Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check`.
