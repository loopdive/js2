---
id: 7528
title: "Native core: `new Error(msg, { cause: obj }).cause === obj` is false"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [5159, 5381, 7527]
---

# #7528: `Error` `cause` loses identity on the native core

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26), default JS target:

```ts
const obj = {};
const e = new Error("m", { cause: obj });
e.cause === obj; // false; JS gives true (ECMA-262 §20.5.8.1 InstallErrorCause stores the value itself)
```

Affects the CONTROL "Error cause" case in `tests/issue-5381-intl-options-bag.test.ts` (`expected 'false' to be
'true'`), with the harness from #7527's patch. Before that harness fix the result came back as an unwrapped `{}`.

#5159 (done 2026-08-28) installed `cause` on the host lane, which #6979 removed. The native core either does not
install `cause`, or installs a copy instead of the value. It is probably the same bug as the class-A
`tests/issue-5159-error-options-cause.test.ts` failure in `plan/log/root-test-triage-2026-11-26.md`.

## Acceptance criteria

- `new Error(m, { cause: obj }).cause === obj` on the default and standalone targets, also for `AggregateError`.
- The 5381 CONTROL "Error cause" case passes with #7527's harness patch.
- `tests/issue-5159-error-options-cause.test.ts`'s cause cases pass, unless that file fails for a separate reason,
  which is then named here.
