---
id: 4671
title: "ES5 standalone: the language/ bucket's four scope roots — `with`-statement scope (4 rows), direct-eval scope interaction (6), catch-binding leak (3), `var` hoisting (2, two distinct mechanisms)"
status: ready
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: scope
goal: standalone-gap
related: [4668, 4667, 4639, 4643]
origin: "rooted by the #4668 lane while fixing §10.4.3 — every error string in #4668's table is from that lane's own base run. Filed so the rooting is not lost when #4668 closes."
---

## The table lives in #4668 — read it first, do not re-derive it

`plan/issues/4668-primitive-receiver-proto-chain-read.md`, section
**"Rooting of the rest of the `language/` bucket (not taken here)"**, carries the row
lists, the test sources and the measured base error for each root. It is evidence, not a
guess: the lane ran every one of those rows on its own base arm.

This issue exists so that rooting survives #4668 going `done`, and to record the routing
decisions below.

## The four roots, in the order worth taking them

| # | root | rows | why this order |
| --- | --- | --- | --- |
| 1 | **catch-binding scope leak** | 3 | Narrowest and self-contained: after the catch block the parameter must be unresolvable; today referencing it does not throw, so the binding leaks to function scope. One mechanism, one fix. |
| 2 | **`var` hoisting — TWO distinct mechanisms** | 2 | (a) `var x = 1` *after* a `return` must still create the binding, so a nested function reads `undefined` rather than the outer `0`. (b) reading `x` before `var x = true` answers **`false`**, not `undefined` — an inferred-boolean local default-initialised to its i32 zero instead of the undefined carrier. **In (b) the binding exists; only its pre-init VALUE is wrong.** Do not fold these together. |
| 3 | **`with`-statement scope** | 4 | Assignment target, closure capture, and `delete`, all three surfaces. Bigger, but one scope object. |
| 4 | **direct-eval scope interaction** | 6 | Largest and the most entangled with the runtime-eval goal. Note one of its rows, `expressions/object/11.1.5-0-{1,2}`, hits the **same terminal `ref.null.extern`** #4668 just removed for primitives — on an eval-minted-object receiver. Check whether #4668's arm generalises before writing anything new. |

## Routing decisions — these rows are NOT this issue's

- **arguments-object representation (3 rows)** → **#4667**
  (`arguments-array-identity-vec-shared-rep`). The lane recommended this and it is right:
  `S13_A2_T2` reads `arguments[1]` at the *first parameter's numeric representation*, so
  `"1"` becomes `1` — a `$Vec` element-representation question, which is exactly #4667's
  subject. Recorded on #4667.
- **`expressions/in/S8.12.6_A2_T2`** → the **#4639/#4643 fnctor-prototype family**.
  `__extern_has` does not walk a fnctor prototype reassigned to an object literal. It is
  the `has` twin of the `get` walk #4668 fixed — so whoever takes it should read #4668's
  fix first, not start from `__extern_has`.
- **`[[HasInstance]]` (3 rows)** — `instanceof` — is its own family and wants its own
  issue when someone takes it.

## Two singles rooted here, cheap enough to fold into whichever slice touches them

- `types/object/S8.6.2_A8` — `x.__proto__ = y` on a `preventExtensions` object mutates the
  prototype; the `__proto__` setter ignores `[[Extensible]]`.
- `expressions/instanceof/S11.8.6_A2.4_T1` — `(OBJECT = Object, {}) instanceof OBJECT` with
  `var OBJECT = 0`: the RHS must be re-read at runtime; base resolves it from the declared
  numeric binding.

**Not rooted, and honestly so:** `expressions/call/11.2.3-3_8`,
`expressions/assignment/8.12.5-3-b_1`, `expressions/assignment/S8.12.5_A2` (this one
*traps*: `dereferencing a null pointer in __str_concat()`), `statements/function/13.2-18-1`,
`S13.2.2_A17_T3`, `S13.2.2_A2`.

## Implementation Plan

1. `plan/method/es5-standalone-agent-brief.md` — BINDING. In particular the section
   **"A sweep scoped to FAILING rows cannot see a row that passes for the WRONG reason"**,
   which came out of #4668 nearly shipping a regression on `10.4.3-1-105`. Scope your sweep
   from what your diff can **reach**, never from the rows you intend to fix, and grep
   `harness/` separately — a harness file that arms your gate makes the reachable set the
   whole corpus.
2. Take **one** root, in the order above. Each is independently shippable.
3. Scope derivation is part of the deliverable: state the gate, state the superset you
   grepped for, and state what you dropped.

## Acceptance

- The root's rows flip, serially re-verified.
- **Zero regressions**, argued from a sweep whose scope is derived from the gate — plus
  `wasm_sha` byte identity for the modules the diff cannot reach.
- Movement reported separately from flips.
- Anything declined is declined with a measurement.
