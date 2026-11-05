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
- no reference can run before the declaration initialises the binding:
  - for a local alias, no reference is written before the declaration and none
    sits in a nested function declaration (hoisted);
  - for a module alias, no reference (in a function or not) is written before
    it;
- every reference is one of these uses (narrowed in round 4):
  - an element read;
  - a plain element store `r[i] = v`; a compound store (`r[i] += v`), `++` /
    `--`, `delete`, and an element that is a destructuring or `for…of` target
    (`[r[0], r[1]] = …`, `for (r[0] of …)`) all decline;
  - `.length`;
  - a callback-free method that keeps the vec in (`push`, `pop`, `shift`,
    `unshift`, `splice`, `slice`, `concat`, `indexOf`, `lastIndexOf`,
    `includes`, `join`, `toString`, `at`), with no spread argument;
  - `sort()` / `reverse()` / `fill` / `copyWithin` whose own result is used the
    same way; `sort` and `reverse` only without arguments;
  - `===` / `!==` / `==` / `!=`;
  - `for…of`;
  - a discarded expression statement.

Any other use declines. That covers an assignment, an argument, a return, an
array or object literal, a `?:` / `||` operand, a destructuring, a
redeclaration, and the uses round 3 found broken on an externref vec:

- **Every callback method** (`map`, `filter`, `forEach`, `reduce`, …) and a
  comparator `sort(cmp)`: the callback is compiled against the checker's
  element type while it receives externref elements.
- **Every spread**: a rest parameter receives the vec itself, and a spread
  into an array literal loses mixed element kinds (`typeof c[1]`).
- **Compound element stores and for-of element targets**, found by the
  extended sweep: wrong answer / invalid wasm on a module alias.

A local alias also requires the source declaration to be the only binding of
its name in the function, because the name-keyed `localMap` is used to find
it.

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

- `tests/equivalence/issue-7166-sort-reverse-identity.test.ts`: 337 asserted
  rows plus 31 skipped sweep rows, each run on gc native-first, standalone and
  wasi against node.
- Sweep generator: `tests/equivalence/issue-7166-alias-sweep.ts`.
- Rows that fail identically on main:
  `tests/equivalence/issue-7166-alias-sweep-known.ts`.

Coverage:

- **Receiver-returning methods:** sort, sort(cmp), reverse, fill, copyWithin,
  the plain alias and `a.sort().reverse()`, over evolving, `any[]`, `number[]`
  and `string[]` receivers, module and local.
- **typeof and element operations,** on the source and on aliases.
- **Reassigned aliases.**
- **Review round 2 repros:** escapes, a closure write, and destructuring
  redeclarations.
- **Review round 3 repros:**
  - must match node: call spread into a rest parameter, `map(x => x)` and a
    comparator sort on a mixed alias;
  - must compile to valid wasm (main is also wrong or traps): the destructuring
    swap, a numeric comparator sort, TDZ reads, a closure declared before the
    alias.
- **Generated use-form sweep.** 51 uses × module / local × `const` / `let` ×
  4 element kinds (string, number, mixed, for…in) × 3 initializers = 2,328
  programs with `JS2WASM_FULL_SWEEP=1`; the default run is a 100-program
  subset. The uses are:
  - the safe uses;
  - every callback method with a callback that uses its element;
  - comparator sorts;
  - call spreads with and without a rest parameter;
  - element destructuring targets (a swap, an object pattern, a `for…of`
    target);
  - compound element stores;
  - TDZ and hoisted-function reads;
  - every escape and rewrite.

Full sweep, head vs main a54cd9fb8a, all three lanes (a compile failure counts
as worse):

| result | rows |
|---|---|
| same and correct | 1,620 |
| fixed | 240 |
| worse | **0** |
| identical wrong answer on both | 468 (listed in the known file, skipped) |
| different wrong answer | 0 |

**Review probe sets, head vs base:** 0 worse in all 18 sets.

- Round 3 sets: attack, extra, scope, ts, cb, src.
- Round 1–2 sets: alias, cases, cases2, cases3, cases11, cases13, sweepdef,
  het, typeof, extra, extra2, extra3.
- Two rows give a different wrong answer: `js_{mod,loc}_elem_method_sort`
  (main traps with "illegal cast", head returns a wrong value).

**Bytes (unoptimized, base a54cd9fb8a vs head, round 4).** The corpus is the
13 playground examples plus the 2,661 distinct equivalence-suite programs
recorded from the gate run, each compiled on gc, standalone and wasi:

- every playground example is identical on all three lanes;
- 2,544 equivalence programs are identical on all three lanes;
- the 117 that differ are all programs from the #7166 test file.

**Left out.**

- `slice` / `concat` results are new arrays by spec, so they are not aliases.
- Pre-existing on `main`, unchanged:
  - `(2).length` on a number element is not `undefined`.
  - wasi reads `a[0].length` through a module-level source as `undefined`.
  - Passing the alias to a `string[]` parameter still copies.
- Callback methods, comparator sorts, spreads and compound element stores on an
  alias now decline to main's behaviour (a copied slot) instead of sharing the
  vec.
- Multi-file programs are not covered by the sweep.
- The Linear backend (`src/codegen-linear/`) was not examined.
