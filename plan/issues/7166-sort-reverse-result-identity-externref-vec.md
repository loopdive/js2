---
id: 7166
title: "Native-first and standalone: a.sort() === a and a.reverse() === a are false for a module-level externref vec"
sprint: current
created: 2026-10-25
updated: 2026-10-27
completed: 2026-10-27
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: done
reasoning_effort: high
priority: low
horizon: s
feasibility: medium
language_feature: arrays
related: [7151, 7146]
# 2026-10-27 (#7166): one import + one slot-cascade arm in each file; the
# logic lives in src/codegen/declarations/module-global-vec-alias.ts.
# 2026-10-28 (#7166 round 2): typeof-delete.ts gains one import + one call
# (the helper lives in anyvalue-elem-materialize.ts).
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
  - src/codegen/typeof-delete.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/typeof-delete.ts::compileTypeofExpression
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

## Resolution (2026-10-27)

**Diagnosis (measured on `origin/main` a54cd9fb8a).** The issue's exact form
(`a.sort() === a`, `a.reverse() === a`, also `fill` / `copyWithin`, module and
local, `any[]` / `number[]` / `string[]`) already answered `true` on gc
native-first, standalone and wasi; the `===` lowering was not at fault and was
not touched. The defect behind the symptom is a **slot-type copy** at the
binding that holds the result:

```js
const keys = [];                       // evolving array, module level
for (const k in { b: 1, a: 2 }) keys.push(k);
const r = keys.sort();                 // also plain `const r = keys`
console.log(r === keys);  r.push("c");  console.log(keys.length);
// was: false 2   (node: true 3)
```

The module global for `keys` is typed from the declared evolving `any[]`
(`$__vec_externref`), but `r` was typed from the checker's evolved flow type
`string[]` (`$__vec_ref_<AnyString>`), so `global.set $__mod_r` converted the
vec by **copying** it. Same copy for a function-local `const a = []` pushed
mixed kinds (`a` is the externref carrier from `inferArrayVecType`, `r` was
typed `(string | number)[]`).

**Fix.** `src/codegen/declarations/module-global-vec-alias.ts`. A binding
whose initializer is an identifier naming a binding that already holds an
**externref-element vec** takes that slot type. The identifier may be wrapped
in parens / `!` / `satisfies`, or reached through receiver-returning `sort` /
`reverse` / `fill` / `copyWithin` calls. Module globals go through
`moduleGlobalWasmType` in `src/codegen/declarations.ts`; locals go through the
slot cascade in `src/codegen/statements/variables.ts`.

The alias gets that slot only through an **allow-list** (review round 3). An
alias whose vec can reach a place typed from the checker's `T[]` would be
converted by copying, so every condition below must hold, or the binding keeps
main's slot:

- the binding has exactly one declaration;
- the file has no `eval`, `with` or `arguments`;
- a module binding is not exported;
- every reference to the name in the scope (the file, or the enclosing
  function including its closures) resolves through `ctx.oracle` to this
  declaration;
- every reference is one of these uses:
  - an element read or write;
  - `.length`;
  - a method that keeps the vec in (`push`, `pop`, `join`, `indexOf`, …);
  - a callback method whose callback cannot see the array (`map`, `filter`, …
    with at most `(element, index)` parameters);
  - a receiver-returning call whose own result is used the same way;
  - `===` / `!==` / `==` / `!=`;
  - `for…of`;
  - a spread into an array literal or a call;
  - a discarded expression statement.

Any other use declines. That covers an assignment, an argument, a return, an
array or object literal, a `?:` / `||` operand, a destructuring, and a
redeclaration. A local alias also requires the source declaration to be the
only binding of its name in the function, because the name-keyed `localMap`
is used to find it.

**`typeof` of an externref element (round 2).** The element of such a vec has
the checker type `string | number` (`$AnyValue`) but compiles to an externref.
`typeof a[i]` fed it to `__any_typeof` through a bare `ref.cast` (trap
"illegal cast"), and `typeof a[i] === "…"` boxed it with the legacy tag-5 wrap
(every value read as "string"). This trapped on `main` for a function-local
source; the alias rule spread it to every alias. Both forms now classify the
externref by its runtime value through `__any_from_extern_honest`
(`externrefOperandAsAnyValue` in `src/codegen/anyvalue-elem-materialize.ts`,
called from `src/codegen/typeof-delete.ts`). An externref that already holds an
`$AnyValue` box is recovered unchanged, as before.

**Tests.**

- `tests/equivalence/issue-7166-sort-reverse-identity.test.ts`: 328 asserted
  rows plus 36 skipped sweep rows. Every row runs on gc native-first,
  standalone and wasi against node.
- The sweep cases come from `tests/equivalence/issue-7166-alias-sweep.ts`.

Coverage:

- **Receiver-returning methods.** sort, sort(cmp), reverse, fill, copyWithin,
  the plain alias and `a.sort().reverse()`. Receivers: module-level and
  function-local evolving arrays (for…in, push, mixed), `any[]` (literal and
  empty), `number[]` and `string[]`.
- **Element operations.** `typeof r[i]`, `typeof r[i] === "…"`,
  `switch (typeof r[i])`, `typeof` in a loop, `r[0] + 1`, `r[0].length` and
  `r[0] === "b"`. These run on the source and on aliases, module and local,
  with mixed, string and number elements.
- **Reassigned aliases.** `let` / `var` `r = keys` followed by `r = other` or
  `r = mk()`, module and local.
- **Review round-2 repros.** An alias escaping into `const t = r`, `[r]`, a
  return, `?:`, `{ v: r }` and `f(r)`. A local `let` alias written in a
  closure. A `var r` redeclared by an array pattern, by an object pattern, and
  by a pattern in a block.
- **Generated use-form sweep.** 28 uses (safe uses and escapes) × module /
  local × `const` / `let` × 3 sources × 3 initializers = 954 programs with
  `JS2WASM_FULL_SWEEP=1`. The default run is a 106-program slice.

Full sweep, head vs main a54cd9fb8a, all three lanes:

| result | rows |
|---|---|
| same and correct | 534 |
| fixed | 180 |
| worse | 0 |
| wrong on both | 240 |

The 240 rows that are wrong on both are skipped by a rule in the test that
matches them exactly:

- escapes of a module or mixed-element alias, which decline to main's
  copy-on-flow;
- a typed `other` written into a mixed alias;
- wasi's spread-call `Math.max`.

**Bytes (unoptimized, base a54cd9fb8a vs head, round 3).** The corpus is the
13 playground examples plus 2,652 distinct equivalence-suite programs, recorded
from the gate run, each compiled on gc, standalone and wasi.

- Every playground example is identical on all three lanes.
- 2,485 equivalence programs are identical on all three lanes.
- The 167 that differ are all programs from the #7166 test file.

**Left out.**

- `slice` / `concat` results are new arrays by spec, so they are not aliases.
- Pre-existing on `main`, unchanged:
  - `(2).length` on a number element is not `undefined`.
  - wasi reads `a[0].length` through a module-level source as `undefined`.
  - Passing the alias to a `string[]` parameter still copies.
- The Linear backend (`src/codegen-linear/`) was not examined.
