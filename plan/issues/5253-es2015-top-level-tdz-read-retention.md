---
id: 5253
title: "ES2015 standalone: retain guaranteed top-level TDZ reads"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
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
