---
id: 5253
title: "ES2015 standalone: retain guaranteed top-level TDZ reads"
status: done
sprint: current
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen, conformance
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-tdz-prior-stmt-terra-20260901
related: [3623, 4433, 4672, 5154]
origin: "Current-main ES2015 census: direct top-level reads before a later let/const are silently dropped before TDZ lowering."
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/expressions/identifier-module-storage.ts
  - tests/issue-5253.test.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
commit: 0b60ac4c9db6b21cd10d743a7e7a8103ab11d933
---

# #5253 — Retain guaranteed top-level TDZ reads

## Problem and locked evidence

On `upstream/main` at
`83b173d8ded5d10ea7d9986f62290334982fdee9`, the authoritative isolated
standalone runner reports **0 pass / 2 fail** for these ES2015 rows:

- `language/statements/const/global-use-before-initialization-in-prior-statement.js`
- `language/statements/let/global-use-before-initialization-in-prior-statement.js`

Both are runtime-negative tests expecting `ReferenceError`; both instead
succeed. The sources reduce to `x; const x = 1;` and `x; let x;`. The command
was `node --import tsx scripts/run-test262-paths.mts <two-path-list> --isolate
--standalone`; no compiler/test process was active before the lane. The locked
f841 census has the same two outcomes.

This is not the closure/loop work completed under #4672 and not #5154's
block/closure TDZ slice. The bare identifier never reaches TDZ lowering:
`collectDeclarations` keeps a special CaseBlock lexical read but sends a
generic top-level `x;` to the module-init classifier, where a non-effectful atom
is recorded and dropped. Existing identifier lowering already knows how to
emit the static in-module `ReferenceError` once the statement is retained.

No GitHub issue was created. ID 5253 was allocated and claimed atomically in
the repository's `issue-assignments` ref.

## Implementation plan

1. Add a focused red regression proving that a source-owned top-level lexical
   read before its declaration is currently dropped. Cover `let` and `const`,
   real `ReferenceError` identity, standalone zero-import instantiation, and a
   host/GC target-neutral control.
2. Add a collector predicate beside the existing CaseBlock exception. Retain a
   bare identifier statement only when symbol ownership proves it resolves to
   an exact top-level lexical declaration in the same source and static TDZ
   analysis proves the access is before initialization. Reuse the existing
   symbol-aware helpers when import topology permits; otherwise extract only a
   cycle-safe ownership predicate into `identifier-module-storage.ts`.
3. Quantify every statement selected by the new predicate before landing. Do
   not change the general `expressionRunsUserCode`/atom classifier and do not
   broadly collect unbound identifiers, `var` reads, block-local future
   bindings, or post-initialization reads. Broad module-init vacuity remains
   owned by #3623/#4433.
4. Run controls for post-init `let`/`const`, `var`, block-local future binding,
   and unbound `x;`, plus existing TDZ/error substrate suites
   `issue-1597`, `issue-1473`, `issue-723-tdz`, and `issue-906`.
5. Rerun the exact two official rows through the authoritative isolated
   standalone runner and record before/after counts and zero-loss evidence in
   this file.

## Acceptance criteria

- The exact two ES2015 rows pass in standalone and throw an actual
  `ReferenceError` object.
- The generated standalone modules remain host-free with zero new imports.
- The predicate selects only proven forward reads of their own direct
  top-level lexical binding; all listed controls retain their prior behavior.
- Focused tests, TDZ/error controls, typecheck, lint/format, and repository
  ratchets pass.

## Root cause

`collectDeclarations` already retained a CaseBlock lexical exception, but sent
a direct source-level `x;` to the generic module-init expression classifier.
That classifier correctly treats ordinary bare atoms as inert for its broad
scope, so the read never reached existing TDZ lowering and the required
`ReferenceError` was silently omitted.

## Implementation summary

The collector now builds a source-local map of unambiguous direct runtime
`let`/`const` declarations. It retains a direct bare identifier statement only
when the declaration is from that exact source, the oracle resolves the
identifier to that exact declaration node, and the source position proves the
read occurs before the declaration completes. At a direct `SourceFile` child
there is no closure or loop deferral, so this is the static TDZ analyser's
guaranteed-throw case.

Each retained statement increments
`module-init-direct-top-level-tdz-forward-read-statements`; no generic atom
collection or identifier storage behavior changed. The implementation is
`0b60ac4c9db6b21cd10d743a7e7a8103ab11d933`; this closeout also removes an
unreachable test-control branch only.

## Test Results (2026-09-01)

- Red baseline: the authoritative isolated standalone runner reported **0
  pass / 2 fail** for the exact `const` and `let`
  `global-use-before-initialization-in-prior-statement.js` rows; both completed
  instead of throwing `ReferenceError`.
- After the fix, the same command,
  `node --import tsx scripts/run-test262-paths.mts .tmp/issue-5253-test262-paths.txt --isolate --standalone`,
  reported **2 pass / 0 non-pass**.
- `tests/issue-5253.test.ts`: **13/13 pass**. It covers both exact Test262
  rows, `let`/`const` direct standalone reads, actual in-module
  `error instanceof ReferenceError` identity, zero compiler/Wasm/host imports,
  and the host/GC control.
- Combined substrate sweep: **44/44 pass** across #5253, #1597, #1473, #723,
  and #906 in one single-fork run.
- Profiled direct standalone `let` and `const` probes each reported
  `module-init-direct-top-level-tdz-forward-read-statements=1`.
- `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`,
  `check:loc-budget`, `check:func-budget`, `check:oracle-ratchet`, and
  `check:coercion-sites` all passed.
- Differential harness: **115/120 match** (the expected five pre-existing
  non-matches make the harness exit nonzero); `pnpm run test:diff:gate` passed
  with **0 new regressions** and **3 improvements**.

## Residuals

- `{ x; let x = 1; }` remains the existing block-local bare-read gap owned by
  #5154; this change deliberately does not collect it through the new direct
  top-level predicate.
- An unbound top-level `x;` remains generic atom-collection work owned by
  #3623/#4433. `var` and post-initialization lexical reads likewise retain
  their prior inert collector behavior.

No GitHub issue was created.
