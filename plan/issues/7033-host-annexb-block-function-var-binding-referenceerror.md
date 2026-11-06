---
id: 7033
title: "JS host: Annex B block-function outer var binding reads throw ReferenceError, and a TDZ ReferenceError escapes try/catch (issue-2552/4456/2641 red since July)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: annex-b
goal: core-semantics
parent: 7014
related: [2552, 4456, 2641, 7029]
---

# #7033 — host-lane Annex B §B.3.3 var binding and TDZ catch

## Evidence (upstream/main 0727e2985b, `node node_modules/vitest/vitest.mjs run <file>`)

- `tests/issue-2552-annexb-phase2.test.ts` 4 red: "bare READ of F before its block → undefined, NOT ReferenceError" throws `ReferenceError: f is not defined` from the `__throw_reference_error` host import (`src/runtime.ts` `hint`), plus the standalone repeated-declaration case.
- `tests/issue-4456.test.ts` 10 red, same message, raised from `__closure_3` during `__module_init` (direct-eval + block/switch-case carriers).
- `tests/issue-2641.test.ts` 1 red: `let s` TDZ read inside a method throws the right ReferenceError, but it is NOT caught by the caller's `try/catch` (the throw surfaces out of `test`).

## Plan

1. Bisect each on first-parent with `.tmp`-extracted `src/` trees (`git archive <c> src | tar -x`) against a 10-line probe; July 16 (`38dd745884`) is a known-good anchor for issue-tests.
2. 2552/4456: find where the B.3.3.1 outer `var F` binding stopped being declared for the host lane (`annexb-cancel.ts`, `eval-annexb.ts`, global-environment binding registration). Expected value is `undefined` before the block runs.
3. 2641: inspect the emitted `try` in `test` — check it uses `catch_all`/the JS-exception path for a host-import throw, not only the module tag.
4. Fix, then scoped test262 `language/statements/block`, `annexB/language` base vs fix (`npx tsx scripts/run-test262-paths.mts`).

## Acceptance criteria

- [ ] the three files green
- [ ] no test262 regression on the scoped dirs, gc and standalone
