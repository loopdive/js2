---
id: 7352
title: "IR foundation: object literals are open objects; array literals share the typed vec slot"
status: in-progress
sprint: current
created: 2026-11-16
updated: 2026-11-16
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7349, 7350, 7353, 7335, 7280, 7338, 7339, 7292]
# 2026-11-16 (O1): select.ts +7, the data-only literal arm beside the `{}` arm in
# isPhase1ObjectLiteral; from-ast.ts +4, the field values passed to the open
# carrier; object-shape-widening.ts +2 (import, and the one call to the shared
# home decision inside collectGrowableObjectLiterals' scanStatements). The
# decision, the builder and the field reader live in their own modules.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - src/codegen/declarations/object-shape-widening.ts::scanStatements#2
---

# #7352 — IR foundation: object and array literals

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). Direction since 2026-11-15 (`CLAUDE.md`, "IR
migration: foundations first"). This is the third foundation, after function
values (#7349) and built-in globals (#7350).

On standalone the legacy compiler stores `var o = { a: 1 }` in a closed-struct
slot and switches to the open object only when the object later gets
expandos, accessors or computed keys. It stores arrays in typed vec slots.
The IR has no binding for either slot, so it refuses the declaration
(`vardecl-module-storage-unrepresentable`). The IR's own closed struct cannot
reach a dynamic consumer at all: `Object.keys(o)` is refused, and
`o.hasOwnProperty("a")` is claimed and then withdrawn on main.

The only literal the IR can hold as an open object is `{}` (#7335), with the
Object statics table (#7338) and the own-property rows (#7339) acting on it.

## Measured

Standalone, 2026-11-16, main `8045884222`. Research record: session scratch
`objfound/research.md` (not in the repository; the tables that matter are
copied here).

**Inventory** (2026-11-14 census rows, confirmed by recompiling a 387-file
sample): 1,704 blocked ES5 files carry an object- or array-literal refusal.
In 109 it is the only refusal family; all 109 are still blocked.

| module `var` initialiser | files | only family |
| --- | ---: | ---: |
| `[]` | 357 | 10 |
| data-only object | 322 | 10 |
| array of primitives | 191 | 20 |
| object with function values | 159 | 33 |
| numeric keys | 26 | 1 |
| array with holes | 20 | 2 |

In expression position: `{ toString / valueOf }` objects 93 files (11 only
family), `{}` as an argument 65 (9), getters and setters 53 (8), an object
literal of module values 83.

**How the objects are used** (2026-11-15 tally of 492 module-level
object-literal bindings): 378 are passed as an argument to a built-in
(`String(o)`, `Object.*(o, …)`, `Array.prototype.x.call(o)`). A closed struct
that only static code can read is the wrong representation for them.

**What works across the boundary today:** the native runtime reads a legacy
struct handed to an IR unit (`__extern_get`, `__object_keys` cover every
registered struct type; boxing keeps identity).

**Ceiling** (throwaway tree: this family's refusals, and reads of
literal-initialised variables, admitted at selection) on the 109 only-family
files:

| outcome | files |
| --- | ---: |
| claim every unit | 3 |
| pass selection; fail only because the variable has no binding (the missing home) | 65 |
| pass selection; from-ast then withdraws (operand types 6, function-valued properties 6, dynamic initialiser 2, empty-array hint 1) | 15 |
| still refused at selection (element store 7, callable or ambiguous value type 8, borrow or predicate receivers 6, other 5) | 26 |

On the 194 `propertyHelper.js` files whose first own refusal is this family
(the harness itself stays refused): 81 are left with only the harness's own
refusals; 77 next stop at `Object.defineProperty(obj, "foo", desc)` with
`desc` held in a variable; 15 at function values; 21 other.

Also found: `var o = { a: 1 }; o.b = 2` is claimed and then withdrawn on main
("proven dynamic binding 'o' initializer has no supported carrier").

## Implementation Plan

### Target structure

Two representations, each with one owner, and no shape that the IR has to
copy from legacy.

- **Objects are built open from the start.** On standalone, a script `var`
  initialised with an object literal gets the dynamic home, for legacy and IR
  alike. Legacy's widening pre-pass (the one that widens when it sees
  expandos) widens every such literal. The slot is then `externref`, which
  the existing dynamic home already binds: no new binding kind. The IR builds
  the object with the `{}` carrier and the own-property write path that
  exist.
  - Rejected alternative: the IR binds legacy's closed struct and boxes it at
    each dynamic use. It is sound, but the IR would have to reproduce
    legacy's struct shape for every literal, which is a copy of legacy's
    shape inference.
  - Cost, accepted: a hash lookup where legacy had a struct field read, and
    no static `Object.keys` / `hasOwnProperty` fold for these bindings.
  - Side effect: legacy's struct-typed parameter refinement disappears for
    these values, which removes one of the parity mismatches #7353 describes.
- **Arrays keep legacy's typed vec slot, as a binding kind.** The string-vec
  home (#7292, `src/ir/module-binding-vec.ts`) is extended to number vecs and
  "any" vecs. The slot's element type is the whole contract and
  `scriptVarHome` already reports it, so nothing is mirrored. `[]` followed
  by pushes takes its element type from the slot. The IR boxes the vec at a
  dynamic use.
- **What it reuses.** The dynamic home, the open-object carrier, the
  own-property write path, the Object statics table, the vec home.
- **What duplicates it removes.** The closed-struct special cases for script
  `var` object literals on standalone, in legacy and in the IR's refusals;
  the `string`-only restriction of the vec home.

### Slices

"Estimate" means not measured; each slice re-measures on current main before
it starts and reports compiled results.

| slice | content | yield | depends on |
| --- | --- | --- | --- |
| O1 | data-only module-level object literals, open on both sides | estimate 10 to 20 only-family files | |
| A1 | `vec<f64>` and `vec<any>` homes; `[]` typed from the slot | estimate about 30 only-family files | |
| O2 | open literals in any value position (argument, operand, return, property value) | 9 only-family files | O1 |
| O3 | a descriptor held in a variable, in the Object statics table | 77 `propertyHelper.js` files reach "harness only" | O1 |
| O4 | function-valued properties (`toString`, `valueOf`, methods) | 33 + 11 only-family files | #7349 S1b |
| O5 | getters and setters | 8 only-family files | #7349 S1b |

O1 + A1 + O2 have a measured ceiling of 68 of the 109 only-family files.
O1 + O3 bring 158 of the 194 `propertyHelper.js` files down to "harness
only"; they pay out when #7350 G4, #7349 S1a and #7353 have also landed.

### Hazards to prove per slice

1. **Changing what legacy stores changes legacy verdicts.** O1 touches every
   standalone program with a script `var` object literal, in every edition.
   Measure verdicts across all editions for every file whose standalone
   binary changes, with QuickJS and the Temporal provider built locally. No
   pass to fail.
2. **Legacy fast paths lose their precondition.** List each legacy fold that
   assumed the closed struct (`Object.keys`, `hasOwnProperty`, `for-in`,
   `in`, descriptor reads, `String(o)` with `toString`) and prove with probes
   against node that the open path answers the same.
3. **Performance.** Report the size and a timing of the playground benchmarks
   that use object literals in script variables, before and after. A
   regression is reported, not hidden; the JS environment is unaffected.
4. **Property order and numeric keys.** An open object must enumerate in
   specification order (integer keys ascending, then insertion order). Probe
   it.
5. **Refusing at select drags IR callers to legacy.** Measure units newly
   legacy on a wide control set.

### Constraints

- Standalone only; no new host imports; JS-environment output
  byte-identical.
- No test verdict regresses in any edition; no unit that main lowers on IR
  is lost; refuse at select, never claim and then withdraw.
- No copy of legacy's struct shape inference in the IR.
- No budget grant for `select.ts` or `from-ast.ts` beyond a dated, justified
  one.

## Acceptance criteria

Per slice:

1. Census on the 1,704 carrier files and 500 IR-only control files: files
   gained, files lost 0, units newly legacy 0, new compile errors 0,
   post-claim errors not increased.
2. Verdicts across all editions for every file whose standalone binary
   changes: no pass to fail.
3. A probe matrix against node for the slice's shapes and consumers, at
   module level and inside a function: nothing claimed answers differently,
   and nothing legacy answered correctly is now wrong.
4. JS-environment output byte-identical on the changed files and on 200
   others.

Code quality:

5. One home decision per literal kind, asked by legacy and IR; no
   closed-struct agreement check left for script `var` object literals on
   standalone.
6. The vec home is one module for all element kinds.
7. A fresh-context adversarial review per slice records its verdict in the
   PR body.
