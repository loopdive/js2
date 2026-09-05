---
id: 4715
title: "ES2015 for-of array assignment targets preserve let/const write errors"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
assignee: codex/4715-es2015-forof-destructuring-write-errors
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen, destructuring, for-of
es_edition: es6
language_feature: for-of-assignment-destructuring
related: [2602, 4690, 4710]
loc-budget: 180
loc-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts
func-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuring
---

# #4715 — for-of assignment destructuring must honor lexical write errors

## Scope and live baseline

The four requested Test262 rows were run through the authoritative assembled
`runTest262File` seam on upstream/main `598cb2f226dc1c60376a5d19f858b2db99f91b06`
(2026-08-25). The default host/GC lane and `target: "standalone"` were both
measured, with the probe's must-pass and must-fail fixtures reporting opposite
outcomes before the row counts were accepted.

| file | host/GC | standalone | observed signature |
| --- | --- | --- | --- |
| `language/statements/for-of/dstr/array-rest-put-let.js` | fail | fail | expected `ReferenceError`, no exception |
| `language/statements/for-of/dstr/array-rest-put-const.js` | fail | fail | expected `TypeError`, no exception |
| `language/statements/for-of/dstr/array-elem-put-let.js` | fail | fail | expected `ReferenceError`, no exception |
| `language/statements/for-of/dstr/array-elem-put-const.js` | fail | fail | expected `TypeError`, no exception |

The same live host run measured the nearby assignment-write controls
`array-rest-put-prop-ref.js` and `array-elem-put-prop-ref.js` as pass (2/2),
showing that ordinary identifier/member PutValue lowering is reachable and that
the defect is the lexical target-error arm rather than a dead harness. The
corresponding `*-no-get.js` rest control remains a separate pre-existing
property-setter residual and is not part of this issue.

The four failures share one shape: the for-of head is an assignment pattern,
but the target is a top-level `let`/`const` binding. The dedicated destructuring
writer currently performs direct local/module-global stores (or skips an
out-of-bounds element) without consulting the TDZ flag or `constBindings` set.
Thus a write before `let x` does not throw `ReferenceError`, and a write to
`const c` does not throw `TypeError`. Rest writes already materialize the rest
slice (#2602); this issue adds only the missing target-write guards.

## Implementation plan

1. Add a small for-of assignment-target guard in
   `src/codegen/statements/for-of-destructuring.ts` that performs the existing
   TDZ check first and the existing constant-assignment `TypeError` throw
   second. Keep member references on their existing PutValue dispatcher.
2. Invoke the guard at the actual write point for identifier targets in the
   tuple/vec/externref array-element paths, rest materialization paths, and
   out-of-bounds element path. Preserve spec ordering by evaluating the source
   element or rest slice before attempting PutValue.
3. Add focused issue pins for the exact four rows in both host and standalone,
   plus passing member-target and initialized-rest controls. Keep compiler
   source growth below 180 lines.
4. Re-run the exact rows and controls after merging latest upstream/main, then
   run the required TS5/TS7/typecheck/lint/format/prepush checks.

## Non-goals

This issue does not broaden the #2602 rest-slice implementation, repair the
existing rest `no-get` property-setter residual, change for-await lowering, or
alter unresolvable/sloppy global assignment behavior. It is limited to lexical
`let`/`const` writes in for-of array assignment patterns.

## Acceptance

- All four named rows pass in host/GC and standalone through
  `runTest262File`.
- The member-target controls remain passing in both lanes.
- Focused regression tests, typecheck, lint, format, and prepush pass.
- Only scoped issue/source/test files are changed and compiler source growth is
  at most 180 lines.

## Test Results

After the implementation, the authoritative assembled harness reports the
following (each command also reported its must-pass/must-fail harness probes as
the expected opposite outcomes):

| lane | exact four rows | controls |
| --- | --- | --- |
| host/GC | 4/4 pass | 3/3 pass |
| standalone | 4/4 pass | 3/3 pass |

The controls are `array-rest-put-prop-ref.js`, `array-elem-put-prop-ref.js`,
and `array-rest-after-element.js`. The nearby
`array-rest-put-prop-ref-no-get.js` residual remains unchanged and is not an
acceptance control for this issue.

Focused Vitest regression: `tests/issue-4715.test.ts` passed 2/2 lane tests;
the related TDZ controls (`issue-723-tdz.test.ts`, `tdz-reference-error.test.ts`,
`issue-1128-dstr-tdz.test.ts`) passed 24/24 tests (26/26 combined).

Quality checks: TypeScript 7 and TypeScript 5 with the repository's required
Node typings passed; changed-file Biome lint and Prettier checks passed. The
package-manager `pnpm run` wrapper could not run its default dependency-status
check in this environment because the available fallback is pnpm 11.19.0
while the repository pins pnpm 10.30.2; the direct pinned-path binaries were
used for the checks above.

The repository pre-push hook was exercised against the merged commit with the
same pinned-path runtime and passed typecheck, lint, format, oracle/coercion
ratchets, numeric-local parity, and issue-integrity gates.

After the initial PR run, the advisory cross-backend gate exposed that using
the real-JS-error form for every module TDZ check could shift a module-global
read inside an unrelated try/finally body. Current main passed the same corpus
case. The repair keeps the legacy generic TDZ path unchanged and opts into the
real `ReferenceError` payload only from the for-of assignment-target guard.
The formerly failing `control/try-finally-early-exit` parity case passes, and
the complete issue matrix above remains green in both lanes.
