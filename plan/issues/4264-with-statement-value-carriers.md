---
id: 4264
title: "`with` statement, ES5 standalone: the object environment's value is destroyed by the destination's stale carrier — a with-assigned var keeps its primitive slot, strict-eq routes off the stale type, and a with-hoisted var is `null` not `undefined`"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: with-statement
goal: es5
related: [4231, 4204, 4179, 3956, 2663, 1387, 1472]
assignee: "ttraenkler/senior-dev"
origin: "ES5-standalone-90 program, `with` bucket. Successor to #4231's 'Leftovers, precisely located' list (RC-G/H/I), re-measured on upstream/main e1aeff7c2."
# loc-budget: the two analyses live in satellite modules
# (declarations/with-body-var-hoisting.ts, declarations/heterogeneous-scalar-var-widening.ts,
# analysis/mixed-assignment-carrier.ts, callable-to-string.ts). What lands in the
# god-files is only the CALL into them plus the doc-comment that states WHY the
# existing #4204 predicate cannot see a `with`-body write — which is the whole
# finding and belongs at the decision site, not in a satellite nobody reads from
# the type picker:
#   declarations.ts  +29  — the module-global type arm and the __module_init seed
#   binary-ops.ts    +19  — the one `!leftIsWidenedPrimitiveGlobal` conjunct
#   string-ops.ts    +15  — the #4265 callable arm in the concat cascade
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/binary-ops.ts
  - src/codegen/string-ops.ts
# func-budget: three single-branch additions inside the closures that OWN the
# decision. `compileDeclarations` gains the __module_init `undefined` seed (it
# is the only place with the init FunctionContext in scope, and it sits beside
# the identical #4182 Annex B seed); `collectDeclarations` gains the arm in its
# nested `moduleGlobalWasmType` type picker; `compileBinaryExpression` gains one
# conjunct plus the doc-comment explaining the operand asymmetry it fixes.
# Splitting any of the three would move a two-line decision away from the
# cascade whose ORDER is the semantics.
func-budget-allow:
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/binary-ops.ts::compileBinaryExpression
---

# #4264 — the `with` residue is a VALUE-CARRIER defect, not a scope-resolution one

## Headline

`language/statements/with`, `--target standalone`, sequential
`runTest262File(…, "standalone")`, **runtime-eval tier: REFUSAL** (both arms;
`node scripts/build-runtime-eval-provider.mjs --refusal-only`, key
`53838e1372b11156`) — so the two `12.10.1-5-s.js` / `S12.10_A4_T6.js`
eval-dependent entries are comparable to each other but **not** to CI's FULL
interpreter tier.

| | base (`upstream/main` e1aeff7c2) | head |
| --- | --- | --- |
| pass | 59 | **89** |
| fail | 78 | 48 |
| compile_error | 44 | 44 |
| fail→pass | — | **+30** |
| pass→fail | — | **0** |

All 30 are the `S12.10_A1.*` battery (`A1.1`, `A1.2`, `A1.3`, `A1.4`, `A1.5`,
`A1.6`, `A1.9`, `A1.10` × their `_T*` variants).

## Why #4231's list pointed at the wrong layer

#4231 fixed four genuine *scope-resolution* defects and left three residues
named RC-G/H/I — "a Tier-1 write is coerced to the field's ValType", "a
non-executing `var` is not `undefined`", "`NaN`/`Infinity` are folded before
`with` resolution runs". Re-measured here, **RC-I does not exist as its own
mechanism** and RC-G is not what stalls the battery. The one thing actually
wrong is a layer below scope resolution:

> The `with` object environment supplies the RIGHT value; the DESTINATION
> cannot hold it.

Everything below is that sentence, three times.

### RC-1 — a module global assigned inside a `with` body keeps its primitive slot

`moduleGlobalWasmType` types a top-level binding from its initializer:
`var st_parseInt = "parseInt"` becomes `(global $__mod_st_parseInt (mut (ref
null $AnyString)))`. #4204 already widens such a slot when a later assignment
provably disagrees — but its predicate is blind inside a `with` body, twice
over:

- `oracle.variableDeclarationOf(target)` is `undefined` (TypeScript resolves
  nothing inside a `with`; §14.11's object Environment Record can bind any name
  at runtime), so the walk never attributes the write to the declaration; and
- the RHS's static tag is `mixed` for the same reason, and #4204 deliberately
  refuses to widen on `mixed`.

So the slot stays a native string, the function externref the object supplied
coerces to null, and `st_parseInt` reads back `null`.

**Isolated RED probe** (`var r5 = "seed"; with (other) { r5 = myObj.zzz; }` —
note the RHS is fully resolvable and it *still* does not widen, which is what
proves the TARGET half is the blind spot):

```
base: r5null=true  r5t=string
head: r5null=false r5t=function
```

Fix: `withBodyAssignmentWidens` in
`src/codegen/declarations/heterogeneous-scalar-var-widening.ts`. Inside a `with`
body `mixed` is not "unresolvable" but "dynamically resolved **by
construction**" — the same reasoning #4204 already applies to a bare `this`
receiver, applied to the other construct the spec defines as dynamically scoped.
The name-keyed lookup (normally forbidden, #3364) is admissible only because the
oracle resolved *nothing*: a real inner shadow resolves, and is excluded.

The function-scoped twin lives in
`src/codegen/analysis/mixed-assignment-carrier.ts`
(`assignmentTargetsDeclaration`) — same blind spot, same fallback.

### RC-2 — strict equality picks the string route from the LEFT operand's stale type

Widening the slot is not enough, and the way it fails is diagnostic:

```
st_parseInt === parseInt   →  true    ← wrong
parseInt === st_parseInt   →  false   ← right
```

`binary-ops.ts` chooses the native-string comparison from
`isStringType(leftTsType)`, and a widened binding keeps its initializer-derived
checker type forever (`var st = "parseInt"` is still `string` to TypeScript
after the slot became `externref`). So the left-hand form cast a function
externref to `$AnyString`, got null on both sides, and answered `true`. Only the
left operand steers the route, hence the asymmetry.

`moduleGlobalIsDynamicButStaticallyPrimitive` is #4204's own name for this
representation-vs-static-type disagreement; #4204 used it for `typeof` and
recorded strict-eq as "verified fine" — true for the `number`-tagged globals it
measured, false for a `string`-tagged one, because only the string tag has a
content-compare route. Equality ops now consult it. `+` deliberately does not:
its concat path already coerces through externref, and re-routing a hot lowering
for no measured gain is not justified.

This is assertion **#11** (`myObj.parseInt !== parseInt`) and, by the same
mechanism, **#14–#17** (`eval` / `parseFloat` / `isNaN` / `isFinite`).

### RC-3 — a `var` hoisted out of a `with` body is `null`, not `undefined`

Two halves, both required, both in
`src/codegen/declarations/with-body-var-hoisting.ts`:

1. **The slot must be able to hold `undefined`.** §14.11.2 consults the object
   environment FIRST, so when the target owns the name (`myObj.value`) the
   declaration's store goes to the OBJECT and the hoisted binding is *never
   written* — its initial value is the only value it can ever be read at. A
   native-string slot cannot represent `undefined` at all.
2. **That initial value must be the `undefined` singleton.** A module global is
   constant-initialised, and the only constant externref is `ref.null.extern`,
   which the standalone lane does not read as `undefined`. Function-scoped
   `var`s never had this gap — the local hoister seeds `undefined` explicitly
   (#737). `__module_init` now seeds the module-global twin, exactly as the
   #4182 Annex B block-function binding does and for the same reason.

This is assertions **#18/#19** (`value === undefined` && `myObj.value ===
"value"`), and it subsumes #4231's RC-H (`with (o) { throw v; var p4 = 'x4'; }`).

### RC-I (#4231) — withdrawn as a separate mechanism

`st_NaN === "obj_NaN"` (#12) and `st_Infinity !== Infinity` (#13) both pass
after RC-1/RC-2, with no change to intrinsic folding. The observed symptom was
the destination carrier, not the fold: `st_NaN`/`st_Infinity` are
string-initialised vars, and the object's values (`'obj_NaN'`, `'obj_Infinity'`)
are strings, so the *fold* was never what lost them. Do not staff a folding fix
on this evidence.

## Demand gating (proved, not asserted)

Every analysis added here is gated on the source file containing a `with`, and
the gate is a cheap text pre-filter whose *decision* is structural
(`isInsideWithBody`). A module that merely mentions the word "with" in a comment
takes the identical path. `tests/es5-standalone-with-carrier.test.ts` carries the
sha256 emission-stability half of that claim plus a behavioural case for the
word-mentioning module.

## Regression evidence

Every number below is a real A/B — the head sources were swapped out for
`upstream/main`'s by FILE COPY (never `git stash`; `refs/stash` is one shared
stack across worktrees) and the same command re-run.

| check | base | head | delta |
| --- | --- | --- | --- |
| `language/statements/with` (181 files, standalone, REFUSAL tier) | 59 pass | 89 pass | **+30 / −0** |
| `built-ins/Function/prototype` (309) | 152 pass | 152 pass | 0 / 0 |
| `language/expressions/addition` (48) | 35 pass | 35 pass | 0 / 0 |
| `language/expressions/concatenation` (5) | 3 pass | 3 pass | 0 / 0 |
| `tests/equivalence/**` (1664) | 24 fail | 24 fail | **identical failure SET** |
| `#1387`/`#2663`/`#3025`/`#3364`/`#3956`/`#4179`/`#4182`/`#4204`/`#4206`/`#737` suites (139) | 14 fail | 14 fail | **identical failure SET** |

The 24 equivalence failures and the 14 neighbour failures are pre-existing on
`upstream/main` e1aeff7c2; the sets were compared by test name, not by count.

`tests/es5-standalone-with-carrier.test.ts` is **4 of 8 RED on base** (the four
positive cases); the four negative cases pass on base by construction, which is
the point of including them.

## What is left, with the mechanism named

Ordered by size in the head measurement (48 fails, 44 compile errors remain):

1. **40 compile errors — `body contains a nested function or class that could
   capture the object environment`.** The deliberately-unbuilt Tier-2 closure
   route (#671 scoping decision, #1387 gate). #4206 measured this cohort
   **downstream** of the runtime one; it is now the single largest item in the
   bucket and is the next thing worth staffing.
2. **6 × `#1: p1 === "x1". Actual: p1 ===1`** (`S12.10_A1.11_T*`,
   `S12.10_A3.11_T*`). NOT a `with` defect: these declare the mutating function
   OUTSIDE the `with` and call it inside, so the body legitimately does not see
   the object environment. The failure is that an implicit-global write
   (`p1 = 'x1'`) performed *inside a function* does not reach the global-object
   property — the #3956/#2726 `sloppyImplicitGlobals` family, one call frame
   deeper than #4231 measured it.
3. **12 × `dereferencing a null pointer in __str_concat()`** (`S12.10_A3.*`).
   The trap is in the *error-message* concatenation (`'…Actual: ' + result`),
   i.e. the assertion had already failed; fixing it converts a crash into a
   legible failure and yields **zero** passes. Mechanism: `__str_concat` does
   `struct.get` on a `ref null $AnyString` operand with no null arm, so a
   `null`/`undefined` operand traps instead of stringifying. The real defect
   these files are reporting is `result = p1` in a `catch` after a `with` body
   threw, which reads `null` — same implicit-global family as (2).
4. **4 × `Expected a SyntaxError but got a TypeError`** (`12.10.1-*-s.js`): a
   `with` in strict-mode code must be an early SyntaxError.
5. **4 compile errors — `Reflect.get with an explicit receiver`** (the
   `*-with-proxy-env` files).
6. **RC-G (#4231) stands**: `with ({foo: 42}) { foo = 'set in with'; }` stores
   `NaN` because the Tier-1 struct field is `f64`. One file (`12.10-0-8.js`).
   Pre-existing and unrelated to the above — it is the Tier-1 twin of RC-1
   (the *field's* carrier rather than the *variable's*), and the fix belongs in
   object-shape widening: a `with` target's field type must accommodate every
   value assigned through the body, or the statement must decline Tier-1.

## Acceptance criteria

- [x] A string-seeded var assigned a with-object function keeps the function.
- [x] `st === parseInt` is false, and agrees with `parseInt === st`.
- [x] A `var` declared in a with body the object owns reads `undefined`, and the
      object receives the write.
- [x] A `var` declared in a with body the object does NOT own still receives its
      own initializer.
- [x] A `var` after an abrupt completion in a with body reads `undefined`.
- [x] A `let` in the body still shadows the object binding.
- [x] Demand-gated: no `with` statement ⇒ unchanged emission.
- [x] Regression tests: `tests/es5-standalone-with-carrier.test.ts`.
- [x] `language/statements/with`: +30 pass, 0 regressions.
