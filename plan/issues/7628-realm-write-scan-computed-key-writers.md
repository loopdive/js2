---
id: 7628
title: "Computed-key and reflective member writers are unseen by the realm write scan"
status: backlog
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7350, 7503, 7363]
---

# #7628 — Computed-key and reflective member writers are unseen by the realm write scan

## Problem

#7350 slice 1 (PR #7549) folds a writable member `X.k` of a realm constructor (an `Object` static's call form,
`Number.isNaN`, a `Math` method, …) only when nothing in the program writes the key `k` on a realm object. The
member-write scan, `src/ir/realm-member-writes.ts`, counts every store target and every call of a key writer
(`defineProperty`, `defineProperties`, `assign`, `__defineGetter__`, `__defineSetter__`, and the readers that hand a
writer out: `getOwnPropertyDescriptor(s)`, `values`, `entries`) by key.

It does not see a key writer that is reached by a key the source does not spell. In each of these, `fold` stays true
for `Number.isNaN` although the program redefines it (review RV-PR7549, round 2):

1. `Object["define" + "Property"]((1).constructor, "isNaN", {value: 1});`, a computed read of a key writer;
2. `var p = "Property"; Object[`define${p}`]((1).constructor, "isNaN", {value: 1});`, a template key with a
   substitution;
3. `(1).constructor["__define" + "Getter__"]("isNaN", function () {});`, a computed read off a constructor;
4. `var {["define" + "Property"]: d} = Object; d((1).constructor, "isNaN", {value: 1});`, a computed binding-element
   key;
5. `var d; ({["define" + "Property"]: d} = Object); d((1).constructor, "isNaN", {value: 1});`, a computed key of an
   assignment pattern;
6. `Object.getOwnPropertyNames(Object).forEach(function (n) { Object[n]((1).constructor, "isNaN", {}); });`, own
   names read back by key.

None of these is observable today: on the Prepared path a folded member and the native are the same algorithm until
B3b-1 holds the realm's prototypes and statics. **#7350 B3b-1 (#7561, PR #7535) depends on this**: once members are
held objects, a fold that the program has redefined answers wrongly.

They are pinned as `it.fails` rows (fold = false) in `tests/issue-7350-slice1-expando-escape.test.ts`. They flip when
the rule closes. The `foldsBuiltinMember` doc lists them under "Not yet seen".

## Why the naive rule is not taken

The naive rule is: any element access, or computed binding-element key, whose key is not a literal writes every key.
Measured on `e104f5a5a0` (2026-11-28, real harness, `plan/samples/7350-b3bc/README.md`):

| list | base pass | with the naive rule | lost |
| --- | ---: | ---: | ---: |
| carriers (`plan/samples/7350-b3bc/carriers.txt`) | 229 | 215 | 14 |
| o411 (`plan/samples/7354-o411.txt`) | 83 | 40 | 43 |

The cause is the harness itself. `compareArray` in `assert.js` reads `a[i]` and `b[i]`, so every test262 program
"writes every key" and no writable member folds. The `assert.js` + `sta.js` prelude alone stops `Math.abs` from
folding. Lost rows:

- carriers: `getOwnPropertyDescriptor/15.2.3.3-4-191`, `-194`, `-196` … `-201`, and `defineProperty/15.2.3.6-3-5`,
  `-6`, `-7`, `-10`, `-11`, `-12`;
- o411: its `Object.create` / `defineProperty` / `defineProperties` / `getOwnPropertyDescriptor` / `Math` rows.

The patch and its 6 rows are kept in the slice 1 worktree's scratch (`.tmp/r2/rule-a.patch`), not in the repo.

## Direction (to plan)

A computed key counts only where its value can be a key writer's name. Candidates:

- the key's possible values, from a constant or string-concatenation analysis;
- or the receiver: a computed read whose receiver is provably not a realm constructor or one of its values (the
  harness's `a[i]` on an array parameter) writes nothing;
- or both, with a tracked fall-back to "every key".

Acceptance: the 6 pinned rows pass (fold = false), no census loss on carriers and o411 against the base, and
prepared/ordinary bytes are identical.
