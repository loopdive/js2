---
id: 7166
title: "Native-first and standalone: a.sort() === a and a.reverse() === a are false for a module-level externref vec"
sprint: current
created: 2026-10-25
updated: 2026-10-25
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: ready
reasoning_effort: high
priority: low
horizon: s
feasibility: medium
language_feature: arrays
related: [7151, 7146]
---

# #7166 — `sort`/`reverse` return a different reference than the receiver

Found while implementing #7151 (PR #6918). Pre-existing on `origin/main`, gc
native-first and standalone (host-assisted correct):

```js
const a: any[] = ["b", "a"];
console.log(a.sort() === a, a.reverse() === a);   // false false   (node: true true)
```

## Cause (as diagnosed; verify before fixing)

The module-level externref vec is read through a boxing conversion on each access; `sort`/`reverse` return the vec re-boxed (a fresh externref wrapper, `extern.convert_any` of the same struct) while the comparison converts the receiver separately, and the two externrefs are not identical under `ref.eq`-style comparison. Site: the `===` lowering on externref operands vs the method return path in `src/codegen/array-methods.ts` (`sort`, `reverse`) — compare with `push`-style methods that return a number and with `fill` which also returns the receiver.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `sort`, `reverse`, `fill`, `copyWithin` and a local (non-module-level) vec on gc native-first and standalone; dump WAT around the `===`.
2. Fix whichever side is wrong: if `===` on two externrefs that box the same struct answers false, make the equality lowering unbox-and-compare (`any.convert_extern` + `ref.eq`) when both operands are extern-boxed anyrefs; otherwise return the original receiver local instead of re-boxing. Host-assisted gc bytes unchanged.
3. Tests: `tests/issue-7166-sort-reverse-identity.test.ts` with the programs from step 1 on gc native-first and standalone vs node.

Acceptance: `true true` for all four methods on both lanes; host-assisted gc bytes unchanged; equivalence gate no new regressions.
