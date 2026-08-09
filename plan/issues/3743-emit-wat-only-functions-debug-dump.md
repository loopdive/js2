---
id: 3743
title: "CompileOptions.emitWatOnlyFunctions — targeted WAT debug dumps for huge compileProject graphs"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: tooling
area: codegen
language_feature: n/a
goal: npm-library-support
origin: "surfaced while diagnosing #3672's ESLint Linter compileProject validation failure — needed to inspect one function's WAT out of a 4800+-function, 10.5MB-binary module and full emitWat() threw 'Invalid string length'"
related: [3672]
loc-budget-allow:
  - src/compiler.ts
---

# #3743 — targeted `emitWat` function filter

## Problem

`emitWat(mod)` builds the entire module's WAT text as one giant
`lines.join("\n")`. On large `compileProject` graphs (e.g. ESLint's
`Linter` entry, ~4800+ functions / 10.5MB binary) that throws `RangeError:
Invalid string length` — there is no way to recover WAT for even a single
function of interest (e.g. the one named in a
`WebAssembly.Module()` validation error) without the full-module build
succeeding first.

This surfaced directly while diagnosing #3672: the validation error named
one closure function, but there was no way to dump just that function's
WAT to inspect the bad instruction sequence.

## What changed

- `src/emit/wat.ts` — `emitWat(mod, opts?)` takes an optional
  `{ onlyFunctions?: Set<string> }`; when set, function formatting is
  filtered to just those Wasm names (types/imports/globals still emitted
  for context).
- `src/index.ts` — `CompileOptions.emitWatOnlyFunctions?: string[]`, a
  debug-only knob threaded through to `emitWat`.
- `src/compiler.ts` — `runPipeline` passes
  `options.emitWatOnlyFunctions` through as the `onlyFunctions` set when
  present.

## Scope

Pure diagnostic tooling — no codegen/runtime behavior change when the new
option is unset (existing full-module `emitWat` callers are unaffected).
Does not fix any compiler bug itself; #3672's actual blocker (a
cross-module identifier-identity collision) was fixed separately.

## Acceptance criteria

- [x] `emitWat` accepts an optional function-name filter without changing
      default (unset) behavior.
- [x] `CompileOptions.emitWatOnlyFunctions` threads through
      `runPipeline`'s existing `emitWat` call site.
- [x] `tsc --noEmit` clean; loc/func budget gates clean.
