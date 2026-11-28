---
id: 7426
title: "gc: a native $undefined that reaches JS arrives as an opaque object, not undefined"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413, 2106, 2864]
---

# #7426: native `undefined` crossing to JS on gc

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242. The probe encodes the argument as undefined→1, null→2, other→3, plus `10 * arguments.length`.

On gc (the JS environment), the native tag-1 `$undefined` singleton can
reach JS, for example as the return value of an export. It arrives as an
opaque object, not `undefined`, so `=== undefined` in JS is false.

This is not caused by #7413. The same happens for:

- a `let u` with no initialiser;
- an unpassed parameter;
- a missing property;
- a generator's terminal value.

On base, the #7413 path gave `null` here instead.

## Direction

The JS-environment value adapter (the export boundary) should map the
native `$undefined` to host `undefined`. This is not a new host semantic:
it is the boundary wrapper that the one-native-core principle (#6708)
already assigns to the JS environment.

## Acceptance

- Every native-undefined source listed above reads as `undefined` in JS on
  gc: `===`, `typeof` and `Object.is`.
- Standalone and wasi output is byte-identical.
