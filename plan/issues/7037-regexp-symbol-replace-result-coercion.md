---
id: 7037
title: "RegExp @@replace / @@split: result-array fields and replaceValue are not coerced through user valueOf/toString (issue-3051 red, 7 tests)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: regexp
goal: core-semantics
parent: 7014
related: [3051, 7029]
---

# #7037 — §22.2.6.11 RegExpBuiltinExec result coercion

## Evidence (upstream/main 0727e2985b, `tests/issue-3051.test.ts`)

- `result[0]` / captures with a user `toString` → `"[function () { [native code] }]"` instead of the `toString` result (the compiled method object is stringified, not called).
- `index` / `length` objects with `valueOf` → not coerced (`'0abcd'` vs `'ab2cd'`, `'$1$2$3'` vs `'foobar$3'`).
- non-callable `replaceValue` object and fake-regexp splitter `lastIndex` protocol → `TypeError: Cannot convert object to primitive value` (host `ToPrimitive` over a compiled struct with no host-visible `valueOf`/`toString`).
- a `null` result field read back as `undefined`.

Common thread: the exec result is a compiled object literal; the host-side
@@replace/@@split algorithm reads its fields as plain JS and cannot see compiled
`toString`/`valueOf` methods.

## Plan

Route ToString/ToIntegerOrInfinity/ToLength of the result fields through the
compiled-object ToPrimitive bridge (the one `__to_primitive`-style imports use)
instead of host coercion; make the null field read preserve `null`. Scoped
test262 `built-ins/RegExp/prototype/Symbol.replace`, `Symbol.split` base vs fix.

## Acceptance criteria

- [ ] issue-3051 green
- [ ] no test262 regression in the scoped dirs
