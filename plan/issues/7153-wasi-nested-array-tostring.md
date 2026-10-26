---
id: 7153
title: "WASI: nested arrays still stringify as [object Object] — the WASI __to_primitive vec arm never reserves the array ToString driver"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7147]
---

# #7153 — WASI nested-array ToString

Found during the review of PR #6908 (#7147). On `--target wasi`,
`[1,[2,[3]]].join(",")`, `String([1,[2]])` and `` `${[1,[2]]}` `` still print
`[object Object]` for the nested element on base and head: the WASI
`__to_primitive` vec arm never reserves `__array_to_primitive_string` (the
native `Array.prototype.toString` driver that #7147 fixed for gc native-first
and standalone), while the WASI inline join still emits the cycle-guard
enter/leave and the `__extern_toString` call as dead weight.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the three programs with `--target wasi` (run under `node:wasi`),
   dump WAT, confirm the vec arm of the WASI `__to_primitive` returns the
   generic object string.
2. Route the WASI vec arm through the same driver `#7147` uses on the other
   no-host lanes (one spelling: the driver is lane-neutral; only the
   reservation site differs) and reserve it where the WASI runtime builds its
   ToString table; the cycle guard then stops being dead weight on WASI.
3. Tests: extend `tests/equivalence/issue-7147-nested-array-join.test.ts` (or
   a sibling) with a WASI lane for the nested, cyclic, `String` and template
   cases; bytes on gc host-assisted, gc native-first and standalone must stay
   identical.
