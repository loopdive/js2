---
id: 1984
title: "freeze-point discipline: indexSpaceFrozen flag — late addImport/ensureLateImport after final flush throws at the producer (#2043 Option 3)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: compiler-correctness
parent: 2043
related: [2043, 2029, 1809, 1839, 1677]
origin: "Child slice of #2043 (ratified Implementation Plan, Option 3). Emit-time range validation (landed) catches out-of-range indices at the symptom site; this catches the PRODUCER that mutates the import space after it should be final."
---

# #1984 — Index-space freeze-point discipline

## Problem

The #2043 emit-time validation names the *symptom* location (which function
held the poisoned index). The producer — the code path that called
`addImport`/`ensureLateImport` after every already-emitted index was final —
is still found by reading codegen. A freeze-point makes the producer
self-identify: once the module's index spaces are declared final, any further
mutation throws **at the mutating call site** with its own stack.

## Implementation sketch (from the #2043 ratified plan)

- Add `ctx.indexSpaceFrozen: boolean` (default false) to `CodegenContext`.
- Set it in `generateModule` / `generateMultiModule` immediately after the
  last legitimate finalize flush (`finalizeUnifiedCollector` →
  `addUnionImports` / `addStringImports` / `reconcileNativeStrFinalizeShift`
  — trace the exact last mutation point per mode; wasi/nativeStrings differ
  from the JS-host path, see #1677).
- `addImport` (`src/codegen/registry/imports.ts`) and `ensureLateImport`
  (`src/codegen/expressions/late-imports.ts`) throw a named codegen error
  when called with the flag set:
  `"Codegen error: import space frozen (#1984): '<name>' added after finalize — this producer must register its import before the freeze point or refuse loudly"`.
- An explicit `unfreezeForTest()` escape is NOT provided; tests construct
  contexts before finalize like production does.

## Risks / notes

- The freeze point must be placed AFTER every legitimate late mutation in
  ALL modes (gc / wasi / standalone / linear / multi-module). A premature
  freeze converts working compiles into errors — validate with the corpus
  sweep (`gc`/`wasi`/`standalone` × playground examples) plus the wasi and
  equivalence suites before merging.
- If a mode legitimately has no final flush boundary (imports added lazily
  per function forever), document that and freeze only the modes that do.

## Acceptance criteria

- Flag exists, is set at the per-mode finalize boundary, and both mutation
  entry points throw the named error when frozen.
- Corpus sweep outcomes unchanged (no false freezes) on gc/wasi/standalone.
- A regression test that forces a post-freeze `ensureLateImport` and asserts
  the named producer-site error.
