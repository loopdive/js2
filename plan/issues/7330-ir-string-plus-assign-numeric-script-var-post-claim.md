---
id: 7330
title: "IR: string `+=` of a numeric script var is claimed, then withdrawn (typed string += lacks encoding evidence)"
status: done
completed: 2026-11-19
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7287, 7331, 7332]
loc-budget-allow:
  # 2026-11-19 (S8) — select.ts +22: the string-slot test in
  #   isSelectableNumberCompound (7 lines, beside the dynamic-slot test it
  #   mirrors) and holdsString (it reads the selector's module-binding and
  #   family state, so it cannot leave this file).
  - src/ir/select.ts
---

# #7330: `out += name` with a numeric script var withdraws `<module-init>`

## Problem

The selector claims `<module-init>` when it appends a numeric script var to a
string module var. from-ast's typed string `+=` arm then needs checker or
producer string evidence plus an encoding for the right-hand side. A number
has neither, so the unit is withdrawn after the claim (`irPostClaimErrors`).
The output is still correct, because the unit falls back to legacy, but the
selector admits what from-ast rejects. This is the claim-then-withdraw rule
(set in the [#7147 PR review](https://github.com/loopdive/js2/pull/7147): a selector admission that from-ast then rejects counts as a blocker).

## Repro (bare compile; standalone, wasi and gc alike)

Pre-existing on main `b631a4bc`:

```js
var out = ""; var name = 1; out += name;
```

`<module-init>`: `ir/from-ast: typed string += requires checker/producer string and encoding evidence for "out"`.

Exposed by #7164 (head `c0dcb01a`; main gives `[]`, because `h` kept
`<module-init>` unclaimed):

```js
var out = ""; var name = 1; function h() { name = 2; } h(); out += name;
```

## Direction

Either the selector refuses a string `+=` whose RHS family has no string
proof (the rule `compoundWriteAdmissible` / `proveTypedStringAppend` apply),
or from-ast appends the number's ToString (the number→string fold that the
binary `+` already has). Pin a bare compile of both repros with
`irPostClaimErrors` empty.

## Implementation Plan

Reproduced on main `ee3fcdd6` (2026-11-19), all three lanes, both repros plus
`out += 1`.

**Cause.** Every selector arm admits `<id> += e` through
`isSelectableNumberCompound`, which only applies the dynamic-slot rule; a
string slot fell through to the number-compound test, which accepts any `+=`.
from-ast then applies `compoundWriteAdmissible("+=", "string", value)` (a
string value only) and withdraws.

**Fix (honest refusal, `src/ir/select.ts`).** In `isSelectableNumberCompound`,
next to the dynamic-slot check and in the same shape: a target that holds a
string asks the same `compoundWriteAdmissible` with the string slot, and
refuses as `compound-string-operand`. One helper, `holdsString` (a script
var's string home, else the checker/literal string proof the selector
already uses), classifies both the target and the value, so `string +=
string` keeps the IR route on every lane. No lowering is added: the binary
`out + name` is refused at selection too (`expr-module-extern-consumer`), so a
number append would be a new mechanism, not this fix.

**Quality acceptance.** The rule is `compoundWriteAdmissible`, the predicate
from-ast already uses; no second copy of it; one new 8-line helper.

**Tests.** `tests/issue-7330-string-compound-operand.test.ts`: the issue's
repros, `out += 1` and a numeric parameter into a string local are refused at
selection with no post-claim error on standalone, wasi and gc;
`string += string` and a numeric slot stay IR; the appended value is right
through the runner (standalone, gc).

## Result

700-file seeded ES5 sample (seed 7106, the census population;
`--target standalone`, original harness, compiled and run), base main
`ee3fcdd6` vs this branch, 2026-11-19:

| | base | head |
|---|---|---|
| IR-only and passing | 130 | 130 (0 gained, 0 lost) |
| legacy units | 1,261 | 1,261 |
| post-claim errors | 41 | 41 |
| verdict flips | | 0 |

No sample file carried this withdrawal, so the census does not move; one
unit's first refusal changes to `compound-string-operand`
(`S8.8_A2_T3.js`, `__mFunc`, already refused). Bytes: 100 files × standalone
and gc identical to base.
