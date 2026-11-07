---
id: 7330
title: "IR: string `+=` of a numeric script var is claimed, then withdrawn (typed string += lacks encoding evidence)"
status: ready
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
---

# #7330: `out += name` with a numeric script var withdraws `<module-init>`

## Problem

The selector claims `<module-init>` when it appends a numeric script var to a
string module var. from-ast's typed string `+=` arm then needs checker or
producer string evidence plus an encoding for the right-hand side. A number
has neither, so the unit is withdrawn after the claim (`irPostClaimErrors`).
The output is still correct, because the unit falls back to legacy, but the
selector admits what from-ast rejects. This is the claim-then-withdraw rule
(the "#7147 standard" in the #7164 review).

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
