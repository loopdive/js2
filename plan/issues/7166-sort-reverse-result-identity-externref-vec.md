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

**Fix.** `src/codegen/declarations/module-global-vec-alias.ts`: a binding
whose initializer is an identifier (through parens / `!` / `satisfies` and
receiver-returning `sort` / `reverse` / `fill` / `copyWithin` calls) naming a
binding that already holds an **externref-element vec** takes that slot type.

- Module globals (`moduleGlobalWasmType`, `src/codegen/declarations.ts`): only
  a `const`, or a `let` / `var` whose name is never written again in the file
  (a later `r = other` would store a typed vec into the externref slot and
  copy it). A hoisted `var` alias of a later array-literal `const` types the
  source the way its own registration will.
- Locals (slot cascade in `src/codegen/statements/variables.ts`): the source
  local is looked up by name only when its declaration is the one binding of
  that name in the function, so a shadow cannot be picked.

Nothing changes for a binding whose source is not an externref-element vec.

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

**Tests.** `tests/equivalence/issue-7166-sort-reverse-identity.test.ts` —
250 rows, gc native-first, standalone and wasi vs node:

- sort, sort(cmp), reverse, fill, copyWithin, plain alias and
  `a.sort().reverse()` on module-level and function-local evolving (for…in,
  push, mixed), `any[]` (literal / empty), `number[]` and `string[]` vecs, each
  checking `r === a`, `r.push(x)` visible through `a.length`, and the last
  element; identity inside a function; typed reads through the aliased global.
- `typeof r[i]`, `typeof r[i] === "…"`, `switch (typeof r[i])`, `typeof` in a
  loop, `r[0] + 1`, `r[0].length`, `r[0] === "b"` on the source and on
  `r = a` / `r = a.reverse()`, module and local, mixed / string / number
  elements.
- Reassigned aliases: `let` / `var` `r = keys` then `r = other` or
  `r = mk()`, and an unreassigned `let r = keys.sort()`, module and local.

**Bytes (unoptimized, base a54cd9fb8a vs head).** 13 playground examples and 2,574 distinct
equivalence-suite programs (recorded from the gate run) × gc / standalone /
wasi. Every playground example and 2,475 equivalence programs are identical on
all three lanes. The 99 that differ are all programs of the new #7166 test
file.

**Left out.**

- `slice` / `concat` results are new arrays by spec, so they are not aliases.
- Pre-existing on `main`, unchanged:
  - `(2).length` on a number element is not `undefined`.
  - wasi reads `a[0].length` through a module-level source as `undefined`.
  - Passing the alias to a `string[]` parameter still copies.
- The Linear backend (`src/codegen-linear/`) was not examined.
