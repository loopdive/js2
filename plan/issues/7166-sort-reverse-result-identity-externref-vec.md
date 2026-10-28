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
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/statements/variables.ts::compileVariableStatement
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
Module globals: `moduleGlobalWasmType` in `src/codegen/declarations.ts`
(a hoisted `var` alias of a later array-literal `const` types the source the
way its own registration will). Locals: the slot cascade in
`src/codegen/statements/variables.ts`. Nothing changes for any binding whose
source is not an externref-element vec.

**Tests.** `tests/equivalence/issue-7166-sort-reverse-identity.test.ts` —
112 rows, gc native-first, standalone and wasi vs node: sort, sort(cmp),
reverse, fill, copyWithin, plain alias and `a.sort().reverse()` on
module-level and function-local evolving (for…in, push, mixed), `any[]`
(literal / empty), `number[]` and `string[]` vecs, each checking `r === a`,
`r.push(x)` visible through `a.length`, and the last element; plus identity
inside a function and typed reads (`r[0]`, element string methods, `join`,
`indexOf`, `map`, `for…of`, `var` alias) through the aliased global.

**Bytes (unoptimized, base a54cd9fb8a vs head).** 13 playground examples and
2,436 distinct equivalence-suite programs × gc / standalone / wasi: every
playground example identical; 2,401 equivalence programs identical on all
three lanes; the 35 that differ are all programs of the new #7166 test file.

**Left out.** `a.slice()` / `concat` results are new arrays by spec and are not
aliasing. A `let r = a` later reassigned to a typed array literal keeps the
externref-carrier slot (it holds the literal as a dynamic vec — correct, but
not the typed fast path). Linear backend (`src/codegen-linear/`) not examined:
it does not use these vec slot types.
