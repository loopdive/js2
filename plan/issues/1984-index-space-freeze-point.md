---
id: 1984
title: "freeze-point discipline: indexSpaceFrozen flag — late addImport/ensureLateImport after final flush throws at the producer (#2043 Option 3)"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
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

## Resolution (2026-06-16)

Implemented the freeze-point flag + producer-site guards.

### What landed

- **`ctx.indexSpaceFrozen: boolean`** added to `CodegenContext`
  (`context/types.ts`), initialized `false` in `createCodegenContext`
  (`context/create-context.ts`).
- **Single per-mode freeze point.** Set `ctx.indexSpaceFrozen = true`
  immediately **before `stackBalance(mod)`** in BOTH `generateModule` and
  `generateMultiModule` (`index.ts`). This is the true final boundary: every
  legitimate late import mutation (`addUnionImports` / `addStringImports` /
  `reconcileNativeStrFinalizeShift`, across gc/wasi/standalone — they all run
  earlier in the body) is complete by then, and the remaining passes
  (`stackBalance`, `fixupExternConvertAny`, emit) add **no** imports (verified:
  `fixupExternConvertAny` has zero `addImport`/`ensureLateImport`/`addUnion`
  calls). So a single placement covers all modes — no per-mode tracing needed.
- **Producer-site guards (throw, own stack):**
  - `addImport` (`registry/imports.ts`) — the chokepoint all import additions
    flow through — throws `"import space frozen (#1984): '<module>.<name>' added
    after finalize …"` when frozen, before the `ctx.mod.imports.push`.
  - `ensureLateImport` (`expressions/late-imports.ts`) — throws its own named
    error **after** the existing-name early-return, so a post-freeze *lookup* of
    an already-registered import (shifts nothing) is still allowed; only a new
    registration throws. The throw is caught by the `generate*` try/catch and
    surfaced as a `Codegen error:` (compile fails loudly; never ships a poisoned
    binary).
- No `unfreezeForTest()` escape — tests build contexts before finalize like
  production (and the unit test sets the flag directly to drive the guard).

### Acceptance criteria — verified

- ✅ **Flag exists, set at the per-mode finalize boundary, both entry points
  throw the named error when frozen** — `tests/issue-1984.test.ts` (5 tests):
  default false; pre-freeze `addImport` registers; frozen `addImport` and
  frozen-new `ensureLateImport` both throw the named `#1984` error (and the
  import is NOT registered); a frozen lookup of an already-registered import is
  still allowed.
- ✅ **Corpus sweep unchanged — no false freezes** — direct sweep of the
  playground examples across **gc / wasi / standalone** (39 compiles) →
  **0 false freezes**; `check:ir-fallbacks` passes; wasi suite 29/29.
- ✅ **Regression test forcing post-freeze `ensureLateImport`** asserts the
  named producer-site error (above).

### No regression

Behaviour-neutral on the import-boundary-sensitive suites: 53 pass / 1 fail in
the union-import/standalone/closed-import set, and the 1 failure
(`closed-imports > includes extern class imports`, `expected undefined to be
defined`) reproduces **identically on `origin/main`** (verified by reverting
the 5 changed src files) — pre-existing and unrelated to freezing (not an
"import space frozen" error).

### Mode note (per the risk callout)

All modes that compile through `generateModule`/`generateMultiModule` (gc, wasi,
standalone, multi-module) share the one freeze point before `stackBalance` and
were corpus-validated. The linear backend (`generateLinearModule`) has its own
pipeline and is out of scope here; it can adopt the same flag in a follow-up if
its import space ever needs the same discipline.
