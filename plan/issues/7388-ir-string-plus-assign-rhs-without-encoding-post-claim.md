---
id: 7388
title: "IR: string `+=` of a call or string conditional is claimed, then withdrawn (selector skips the encoding proof)"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7330, 7389]
---

# #7388: string `+=` whose RHS has no encoding evidence still withdraws `<module-init>`

## Problem

This is what is left of #7330 after PR #7311. That PR makes the selector
(`isSelectableNumberCompound` in `src/ir/select.ts`) apply
`compoundWriteAdmissible`, which refuses a numeric RHS. But from-ast's
typed string `+=` arm also needs `proveTypedStringAppend`
(`src/ir/analysis/string-evidence.ts`) to succeed, and that proof requires
an **encoding** for both sides. A string-typed RHS with no encoding
evidence passes the selector and then fails the proof. The unit is then
withdrawn after the claim (a post-claim error in `irPostClaimErrors`).

```js
var out = ""; function g() { return "a"; } out += g();
var out = ""; var c = 1; out += c ? 'a' : 'b';
```

Each repro is a separate program, compiled bare with `trackIrOutcomes`.

| | main `89e47482` (no #7311) | branch `claude/7330-string-compound-refusal` `1b6c1389` |
|---|---|---|
| `out += g()` | withdrawn | withdrawn |
| `out += c ? 'a' : 'b'` | withdrawn | withdrawn |
| `out += name` (the #7330 repro, `name = 1`) | withdrawn | refused at select (fixed) |

- **The withdrawal is the same on gc, standalone and wasi:** `<module-init>`:
  `ir/from-ast: typed string += requires checker/producer string and
  encoding evidence for "out"`.
- **Runtime values are still correct.** The unit falls back to legacy, and
  `out` is `"a"` on standalone and gc, as in node. This breaks the
  claim-then-withdraw rule, not the result.

## Direction

- **Option 1: the selector asks the same proof.** It refuses a string `+=`
  unless the RHS has the encoding evidence `proveTypedStringAppend` needs.
  The best way is to share one admission predicate between the selector and
  from-ast, rather than mirror it by hand a second time.
- **Option 2: from-ast supplies the encoding.** It derives the encoding for a
  call whose return is a producer string, and for a conditional whose arms
  are both string literals. Then the proof succeeds.
- **Test:** pin both repros with `irPostClaimErrors` empty.
