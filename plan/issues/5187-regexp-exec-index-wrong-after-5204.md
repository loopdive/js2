---
id: 5187
title: "A WasmGC carrier names a receiver for members it does not have — array expando reads return null (#5204)"
status: in-review
pr: 5237
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5180, 5190, 5204, 5216, 2547]
---

> **Note on the id:** this is issue **#5187**, allocated by
> `claim-issue.mjs --allocate`. Issue ids and PR numbers share one sequence, so
> it collides by name with **PR #5187** (the #4644 fix, unrelated). Link to this
> issue by slug, not by bare `#5187`.

# #5187 — an expando property on an array reads back `null`

## Problem

```js
var a = ["1"];
a.foo = 7;
a.foo          // wasm: null    node: 7
```

Compiles clean, runs, returns the wrong value — no diagnostic, no trap.
Verified on `origin/main` and on `origin/issue-5178-method-return-struct-type`.

## Root cause (dev-5180)

#5204's carrier-name fallback in `resolveStructNameForExpr`
(`src/codegen/property-access.ts:1147`) names a receiver by **the WasmGC carrier
it lowers to**. A JS array lowers to `__vec_<elem>`, whose only fields are
`length` and `data`. So the *read* of `a.foo` was diverted onto the struct path
while the *write* stayed dynamic — the value is stored in the expando side
table and read from a struct that never had the field.

Fix (**PR #5237**): a carrier may name the receiver only for a member it
actually **has**.

**Dead end, recorded so nobody repeats it:** screening by *name* instead
(`isSyntheticStructName`) fixes arrays and **breaks `__regexp_match_vec`**.
Measured by dev-5180, not assumed.

## Correction — this issue's original diagnosis was wrong

It was first filed as *"RegExp exec result `.index` reads 0 instead of the match
offset"*. That framing was wrong and is kept here rather than quietly rewritten,
because the way it went wrong is reusable:

* The test262 assertion text names `__executed.index`, so the failing side
  looked like the exec result. The fixture is
  `__expected = ["1"]; __expected.index = 0;` — **the null was on the
  `__expected` side**, an ordinary array expando. Reading the assertion message
  as if it named the broken operand is what produced a RegExp-shaped hypothesis
  for a bug with no RegExp in it.
* My own probe (`/b/.exec("abc").index` → `0`) *was* a real defect, but a
  **different** one — see #5190 below. Two symptoms from the same commit landing
  in one probe made a single cause look confirmed.

The bisect in the original file stands and is unchanged: correct at
`fc6fd3b5f3` and `4dfedbdc92` (#5203 is clean), broken at `523bd0428b`
(**#5204**). #5204 introduced *at least three* distinct defects: #5180, this
one, and #5190.

## Not fixed here — the host-lane exec result (#5190)

Exec-result `.index` / `.input` in the **host** lane is a separate, unlocalized
defect: correct before #5204, a constant `0` on main (so index-0 matches pass by
accident), and `NaN` with #5237 applied. Standalone is correct throughout. With
#5237 the cluster rows get past `.index` and stop at `__executed.input`.

Filed as **#5190**, with dev-5180's failed localization attempts recorded there
(a per-file revert scan over all 71 files of `8f161cbf15`, run on the coherent
tree at that commit, flips nothing; ten files crash when reverted alone and also
when reverted together; the property-access pair reverted together still gives
`NaN`). Next method suggested there: per-hunk reverts inside the coupled ten, or
a WAT diff of the reading function.

## Effect on the merge-group park

Context for the auto-park of #5169/#5178/#5216 (run
[33236737382](https://github.com/loopdive/js2/actions/runs/33236737382)), from
that run's own artifact — 931 non-timeout regressions, fine-gate net **-876**:

| cluster | count | cause |
| --- | --- | --- |
| `pass → compile_error … struct field index out of range` | 595 | #5180 — PR #5223 |
| `pass → fail … __executed.index is expected to equal …` | 224 | **this issue** (the `__expected` side) + #5190 |
| `pass → fail … __split.constructor is expected to equal …` | 65 | older, predates this window |
| everything else | ~47 | — |

**None of these were caused by the three parked PRs** — both dominant clusters
reproduce on plain `main`.

## Measured effect of PR #5237

dev-5180's A/B over 252 rows (String/match, RegExp/Symbol.match, Array/concat,
RegExp/exec): pass **146 → 151, net +5**. Six fixed (`S15.5.4.10_A2_T*`), one
broken — `regexp-builtin-exec-v-u-flag.js`, which was passing by luck.

## Acceptance

* `var a = ["1"]; a.foo = 7; a.foo === 7` in compiled output.
* A regression test asserting the **value**, not just a clean compile — this bug
  produces a valid module and a wrong answer.
* The `__executed.index` cluster clears once #5190 lands too; #5237 alone moves
  it to `__executed.input`.
