---
id: 5309
title: "Legacy class-body route resolves `this.#m()` to the PARENT's `#m` when the child declares `#m` as a field — returns 1 where node returns 2"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [3522, 3518]
requested_by: ttraenkler/orchestrator
---

# A wrong-answer miscompile on the direct route, found while measuring #3522 W1-B

Found by the [#3522](3522-ir-r3-classes-closures-compile-once.md) W1-B
implementer (PR #5552) while pinning the private-name shadow family, and
recorded in that issue's W1-B checkpoint. It is **not** caused or changed by
W1-A/W1-B: the row is `class-member-unsupported`, legacy-owned, on base and on
the branch, and reverting each W1-B site leaves the answer unchanged.

```ts
class A { #m() { return 1; } }
class B extends A {
  #m = () => 2;
  f() { return this.#m(); }
}
new B().f();
```

| | result |
| --- | --- |
| node | `2` |
| js2 (direct route, gc and standalone) | **`1`** |

Private names are per-class: `B.#m` and `A.#m` are two different members. Both
mangle to `__priv_m`, and the direct route's member-name resolution
(`src/codegen/class-bodies.ts`, `resolveClassMemberName` and the inherited
member lookup it feeds) resolves the call against the parent's **method**
`__priv_m` instead of the child's **field** `__priv_m`, so the parent's body
runs.

The IR side is not affected today only because the shape is refused before
selection (`class-member-unsupported` — a field-typed private member has no
method descriptor). W1-B's S3 change (`classElementProjectionName`) makes the
selector prefer the child's own private member for that reason; the direct
route has no equivalent rule.

## Acceptance criteria

1. The program above returns `2` on gc and standalone through the direct
   route, with a test that pins both lanes and the current wrong answer red on
   base.
2. The public twin (`class B extends A { m = () => 2; f() { return this.m(); } }`)
   is measured alongside: if it already returns 2, name the branch of the
   member-name resolution that treats private names differently; if it also
   returns 1, the defect is the inherited-callable lookup order, not the
   mangling, and the issue title is corrected in the PR.
3. State whether the same collision exists for a child **method** `#m()`
   shadowing a parent method `#m()` (W1-B measured that case IR-owned and
   correct after S3; the direct route is unmeasured).
4. Byte identity on the 34-case corpus, gc + standalone: any moved row named.

## Out of scope

The `#m` vs public `__priv_m` mangling collision (inherited, listed in the
#3522 W1-B plan) — a different program shape.
