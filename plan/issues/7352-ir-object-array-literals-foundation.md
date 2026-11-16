---
id: 7352
title: "IR foundation: object literals are open objects; array literals share the typed vec slot"
status: blocked
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
# 2026-11-16 (O1, verification round): select.ts also takes the one-line wrap of
# the selection options at each selector entry (open-object-field-reads.ts) and
# the typed-return rule (isPhase1ReturnValue, shared by both return arms);
# planIrCompilation +1 for the wrap. The evidence adapter is its own module.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - src/codegen/declarations/object-shape-widening.ts::scanStatements#2
  - src/ir/select.ts::planIrCompilation
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

## Parked 2026-11-16

Parked by owner decision: the program goal moved to the prepared-program IR path
(`TEST262_COMPILER_PATH=ir`, #7188). O1 works in the ordinary pipeline's selector,
resolver and legacy storage, so it does not move that metric. Branch `claude/7352-o1`,
head `730979fe30`. It is based on main `78c2ea48c4` plus the plan docs `58c731c93c`.
No PR.

### What O1 builds

The change has three parts:

- **One home decision.** `isStandaloneOpenObjectLiteral`
  (`src/codegen/declarations/open-object-literal-home.ts`) applies to a top-level
  script `var` on standalone whose initializer is a data-only literal.
  - A data-only literal is what `openObjectLiteralFields` in
    `src/shared/object-literal-fields.ts` accepts: static names, no array-index
    key, no `__proto__` / `toString` / `valueOf` key, and no function, class,
    object or array value.
  - For such a `var`, legacy's widening pre-pass builds the open `$Object`
    instead of a struct.
- **IR side.**
  - The selector admits the literal on the dynamic home: `isPhase1ObjectLiteral`
    together with `admitCarrierValues`.
  - from-ast builds it in `lowerObjectLiteral` by calling `emitOpenCarrierObject`
    with the field values (`openLiteralFieldValues`).
  - #7335's served-use proof takes such a binding the same way it takes `{}`.
- **Verification round (`730979fe30`).**
  - `src/ir/open-object-field-reads.ts` wraps the selection options at both
    selector entries. For any expression that reads an open-object binding:
    - the primitive classifiers, the resolver's `scalarExpressionFamily` and
      `bindingValueMatches` answer nothing;
    - a non-carrier slot takes no such value;
    - a typed return refuses it (`isPhase1ReturnValue`).
  - Legacy: on standalone, `Object.values` / `Object.entries` join the #6770 S5
    own-key list calls (`object-own-key-order.ts`). This fixes
    `Object.values(o).reverse()`, which hit an illegal cast and was also broken
    on main for literals widened by an expando.

**Where it lives.** Only `lowerObjectLiteral`'s open-literal arm, `openLiteralFieldValues`
and `emitOpenCarrierObject(fields)` are in from-ast / lowering, the code the prepared
path shares. Everything else is selector, resolver or legacy-codegen only.

### Measured (standalone, against main `78c2ea48c4`)

| measurement | result |
| --- | --- |
| Seeded all-edition sample (3,000 files) | 34 binaries changed. 17 of them are compile-process noise: identical when recompiled in a fresh process. Verdicts on the 34: 0 pass→fail. |
| Candidates: every file whose harness plus test has an O1 literal (1,057 of 53,575; one file skipped, >570 s on main) | IR-only files 2 → 91 (+89), 0 lost, 0 units newly legacy, 0 new compile errors, post-claim errors 2 → 2. 357 binaries changed. |
| Verdicts on those 357 (QuickJS + Temporal per tree, `TEST262_FULL_RUNTIME_EVAL=1`) | **7 pass→fail**, 5 fail→pass. |
| Probe matrix (79 programs, module level and inside a function) | 0 post-claim errors that main lacks; +20 claimed; 0 lost; every wrong answer on head is also wrong on main. |
| `tests/issue-7352.test.ts` | 18/18 pass. |

### Known open defects (the 7 pass→fail rows)

Both classes are pre-existing legacy gaps for open objects. They already fail on main
for a literal widened by an expando; O1 makes them reachable for every data-only literal.

1. **Literal properties are stored with `[[Set]]` instead of CreateDataProperty.**
   - Rows: `language/expressions/object/11.1.5_3-3-1.js` and `11.1.5_4-5-1.js`.
   - Both legacy `compileObjectLiteralAsExternref` (`__extern_set`) and the IR's
     `emitPlainObjectWithFields` do this. A non-writable or setter
     `Object.prototype.prop` then blocks the own property.
   - Planned fix:
     - keep the home closed when `sourceMayPatchPrototype(file, "Object")` or
       `sourceNamesReflectiveRoute(file)` holds. A `[[Set]]` into a fresh object
       equals a define only while `Object.prototype` is the realm's own;
     - or switch legacy to `__defineProperty_value(obj, key, v, 0xbf)` on standalone.
2. **Destructuring assignment from an open object.**
   - Rows (all under `language/expressions/assignment/dstr/`):
     `obj-prop-name-evaluation.js`, `obj-rest-computed-property.js`,
     `obj-rest-computed-property-no-strict.js`, `obj-rest-same-name.js`,
     `obj-rest-valid-object.js`.
   - In `compileDestructuringAssignment`, the struct path is chosen from the
     checker's literal type even though the value is externref. Constant computed
     keys and `...rest` then read nothing.
   - Planned fix: send an externref source to the externref arm, which already
     has `emitObjectRestAssignment` and `__extern_get`. Variable-declaration
     destructuring already handles rest from an open object.

### Not measured

- Census on the plan's 1,704 carrier files plus 500 IR-only controls (the
  candidate census above covers the O1 population).
- JS-environment bytes. Every change is gated to standalone, but no hash run was
  done.
- Playground benchmark size and timing.
- Equivalence gate, and quality steps 13–49. Steps 1–12, the LOC / function /
  import-cycle / boundaries gates and the 7352 test file are green at `730979fe30`.
- How much O1 frees in the 322 / 10 / 109 sets.

### Resume steps

1. Merge `origin/main` into `claude/7352-o1`, then re-measure the candidate list.
   Scratch tools are in `scratchpad/o1/`:
   - `prefilter.mts` builds the candidate list;
   - `hchunk.sh` runs the hash census;
   - `hcmp.py` and `cmp2.py` compare results;
   - `verd.sh` runs verdicts (rebuild the compiler bundle and QuickJS/Temporal
     providers per tree first);
   - `pk.sh` runs the probe matrix, with cases in `cases-*.mjs`.
2. Fix defect classes 1 and 2. Re-run verdicts on the changed binaries until
   there are 0 pass→fail.
3. Run the unmeasured checks above. Then run a fresh-context review and open the PR.
