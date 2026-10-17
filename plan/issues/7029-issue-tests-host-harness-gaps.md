---
id: 7029
title: "tests: issue-tests backlog, host-harness slice — hand-rolled import objects and stale test doubles that drifted from the compiler/runtime contract"
status: done
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: medium
horizon: m
feasibility: easy
reasoning_effort: high
task_type: bug
area: tests
language_feature: n/a
goal: ci-hardening
parent: 7014
related: [7032, 7033, 7034, 7035, 7036, 7037, 7038, 7039]
assignee: "ttraenkler/wave15-host-harness"
---

# #7029 — issue-tests backlog: the host-harness slice

## Problem

#7014 made the `issue-tests` detector measure again and found ~950 non-pin
failing tests that were not in the July baseline. This issue covers two of its
first-error classes: **missing host import at instantiate** ("Import #N … module
is not an object" / "function import requires a callable", 18 files) and
**TypeError/ReferenceError inside the test harness** (26 files). Re-run on
upstream/main `0727e2985b`, the 44 files had **163 failing tests**.

## Root causes (test-side; no compiler change)

| Cause | Files | Fix |
| --- | --- | --- |
| Hand-rolled `env` lists only the imports the program needed when the test was written; the JS-host lane has since added real-semantics imports (`__register_prototype` 5ff86e89f5 #5347, `__new_TypeError` #3287, `__get_undefined`, `__call_function_N`, `__bigint_ctor_ref`, `__make_iterable`, `__throw_reference_error`, `__get_builtin`) | 257, 258, 272, 277, 282, 284, 324, ts-scanner, 237, 347, externref | link against the production resolver `buildImports(result.imports, …)` (externref: serve `__get_undefined`) |
| Partial import object (missing `wasm:js-string` / `env`) | 1232, 1004 | pass the whole resolver result |
| `setExports` never called, so a union-receiver method call cannot reach the class bridges | 530 | call `setExports` |
| Standalone module referencing the `Function`/`eval` VALUE imports the linked `js2wasm:runtime-eval` provider by default (88d8444b72, #6676); test instantiates against `{}` | 1472, 3287, 4200 | compile with `runtimeEvalProvider: false` (39 other suites already do) |
| #4200 scope guards asserted "no carrier → descriptor undefined" for Date/String/Number/Boolean/Function; standalone now returns the spec descriptor (13) and `C.prototype.constructor === C` holds | 4200 | assert the correct JS answer |
| Fake contexts / doubles missing fields the code grew: `targetProfile` (dbccc693f6), `protoNamedWrittenMembers`/`inheritedSetDirtyKeys` (d47ae45835, 642978d67a), provider artifact `binary` (fec95636bd), `WORKER_SELF_VALIDATES` (1de31aa63c) + positional `doCompile` args shifted by `moduleGraph` (f1ad427b98), `window.t262ViewState` (fa1e5df779) | 1326, 4159-4160, 5364, 5738, 5385, 4362 | add the field / bind by name / eval the real view-state script |
| `$state` no longer unique to the standalone `$Promise` (async `$AsyncFrame_<fn>`, 393e42bd96) | 1326 | assert on the `$Promise` type |
| reconcile-tasklist JSON split `mergedPrFixed` into done/unknown/rejected (d31db7888d, #3969) | 2147 | assert the new contract |
| `wrapTest(src, {})` skipped frontmatter, so the propertyHelper shim never rewrote `verifyProperty` | 1567 | let wrapTest parse the frontmatter |

## Regression probes

The fixed files are the permanent probes, e.g. `tests/issue-257.test.ts`,
`tests/ts-scanner-test.test.ts`, `tests/issue-4200.test.ts`,
`tests/issue-1326.test.ts`, `tests/issue-5385-test262-native-lane.test.ts`,
`tests/issue-2147.test.ts` (full list in the table above, each as
`tests/<name>.test.ts`).

## Acceptance criteria

- [x] every file above green locally on upstream/main + this change, run one file at a time
- [x] no assertion weakened: every change either supplies the real contract or asserts the correct JS value (checked against node)
- [x] the rest of the slice has a fix (#7032) or an issue with a plan (#7033–#7039)
