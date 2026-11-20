---
id: 7350
title: "IR foundation: built-in globals as values — one admission on the realm"
status: ready
sprint: current
created: 2026-11-15
updated: 2026-11-16
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7349]
related: [7349, 7352, 7353, 7343, 7189, 7127, 7294, 7106, 7342]
---

# #7350 — IR foundation: built-in globals as values

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). Direction since 2026-11-15 (`CLAUDE.md`, "IR
migration: foundations first"): build the mechanisms many files need.

A built-in global used as a value (`Object`, `String`, `Math`, `Function`,
`parseInt`, …, and their `prototype` objects and members) is the second such
mechanism, after function values (#7349). The IR admits such values through
four separate allowlists in `src/shared/ambient-intrinsics.ts`, each measured
for one issue (#7106 opaque values, #7189 static method values, #7127
prototype method values, #7294 prototype members and descriptor support).
Anything outside them is refused as `expr-ident-not-in-scope`.

All four allowlists already sit on one fact: a built-in global is a property
of the realm object, read with `dyn.member_get(global_object, name)`. The
legacy compiler's bare read shares that identity.

## Measured

Standalone, 2026-11-15, main `ed17563bc2`, with QuickJS and the Temporal
provider built locally. Research record: session scratch
`globfound/research.md` (not in the repository; the tables that matter are
copied here).

**Inventory**, re-compiled on current main: 1,837 ES5 test262 files have a
built-in-name refusal in the test body; 1,832 are still blocked.

| name | files | | position | files |
| --- | ---: | --- | --- | ---: |
| `Function` | 997 (899 only via `propertyHelper.js`) | | `X.prototype.m` as a value | 410 |
| `Object` | 334 | | `X.m(…)` call | 238 |
| `String` | 188 | | `X.prototype.m(…)` call | 86 |
| `Number` | 118 | | `X.prototype` as a value | 82 |
| `Math` | 71 | | `X` as an argument | 76 |
| `RegExp` | 61 | | `X.m` as a value | 73 |
| `JSON` | 54 | | `.call` / `.apply` / `.bind` on a built-in method | 59 (+905 harness) |
| `Array` | 52 | | write `X.m = v` | 50 |
| global functions | about 35 each | | `===` operand | 36 |

- In 272 files this family is the only refusal family.
- `typeof X`, `instanceof X` and `new X` never appear in these rows; they are
  folded today.

**Prototype run on the 272 files** (a throwaway patch: every built-in name
admitted and lowered as a realm read; not merged):

| step | files |
| --- | ---: |
| every unit claimed | 201 |
| compile with zero legacy units | 151 |
| keep their passing verdict | 94 |

All 151 pass on main, where they compile as legacy. The 57 that then answer
wrongly show what the standalone runtime lacks:

| gap | files |
| --- | ---: |
| static methods with no dynamic implementation (`JSON.parse`, `Object.isFrozen`, …) | 21 |
| `[[Prototype]]` links of constructor and prototype objects not set | 12 |
| prototype members not seeded | 12 |
| callability wrong | 4 |
| `Object.getPrototypeOf(primitive)` through the dynamic call | 3 |
| `constructor` back-links | 2 |
| constructor expandos not seen | 2 |
| other | 1 |

Of the 272, 50 claim every unit and then fail after the claim (an `assert`
argument typed dynamic 18, operand families 18, other 14), and 71 stay
refused at selection, mostly `expr-object-static-operand` (39), for example
`Object.isExtensible(Math)`.

**`propertyHelper.js`**: with globals admitted the harness stops at
`var verifyPrimordialProperty = verifyProperty` (#7349 S1a) and at
parameter-carrier refusals. Globals alone free none of the files that include
it. Corrected 2026-11-16 by a measurement on main `8045884222`: 905 ES5 files
include the harness; with this issue's G1 + G4, #7349 S1a, #7353 (parameter
carriers) and #7352 (object literals as open objects) all in place, 151 of
them become IR-only, and the other 748 have refusals of their own.

**Legacy answers wrongly today** on: a built-in called or constructed through
a variable (`var S = String; S(5)` traps), `Object.keys` called as a value,
`Function.prototype` identity of function objects, `Math.constructor`,
`parseInt.length`, and reassigning or deleting a global. Per the direction,
those answers are not preserved.

## Implementation Plan

### Target structure

- **One admission.** A read of a built-in global is admitted when the name
  binds to the library declaration, nothing in the source declares it, and
  the realm is pristine for that name (not written, deleted or shadowed in
  the file; the write scanner that #7339 extended already owns that fact).
  It replaces the four allowlists. The admission lives in one module under
  `src/ir/` that the selector and from-ast both ask.
- **One value.** The value is the realm property: a dynamic-carrier object
  with its own identity, its `prototype` and its members. Every access the
  compiler cannot resolve statically is an ordinary dynamic access on that
  object.
- **Static folds stay, as the optimisation.** `Math.max(…)`, `typeof X`,
  `x instanceof X`, `new X(…)` and the rest keep their direct lowering, used
  only when the receiver is a pristine intrinsic. One predicate answers
  "pristine intrinsic" for the folds and for the admission.
- **Calls and construction through a value** use #7349's single call path
  (`__apply_closure`); this issue adds callable and constructible carriers
  for the built-in constructors, no second call mechanism.
- **Runtime completeness is part of the work.** The prototype graph
  (`[[Prototype]]` links, `constructor` back-links, seeded members,
  callability) is completed in the standalone runtime through the demand
  seeding #7294 introduced, so a value read sees a spec-shaped object.
- **What duplicates it removes.** The four allowlists and their per-issue
  admission functions; the position lists that say where an opaque value may
  appear.

### Slices

Yields are **measured on the 272 only-family files with the throwaway
prototype** (files that end IR-only and still pass). They are upper bounds
for those files; each slice re-measures on current main before it starts.

| slice | content | cumulative files | depends on |
| --- | --- | ---: | --- |
| G1 | the one admission; a bare built-in value in every position (argument, operand, stored, returned) | 22 | |
| G1b | Object-statics operands may be built-ins (`Object.isExtensible(Math)`) | estimate 15 to 20 more | #7338 rows |
| G2 | complete prototype graph and member values (`X.prototype`, `X.prototype.m`, `X.m` as values) | 64 | |
| G3 | member calls: the fold first, the dynamic call where the runtime implements it; refuse the rest | at least 85 | |
| G4 | `.call` / `.apply` / `.bind` on built-in methods | 94 | #7349 S7 |
| G5 | calls and `new` through a built-in value | probes only | #7349 S1a, S6 |
| G6 | realm writes and deletes (`X.m = v`, `delete X.m`) with the folds gated on them | probes only | |

The `propertyHelper.js` harness needs G4 together with #7349 S1a, #7353 and
#7352; that combination frees 151 files (measured 2026-11-16), not the 899
an earlier version of this plan implied.

### Hazards to prove per slice

1. **The provider-owned `%Function%`.** PR #7231 was parked by the merge
   queue because a rule about `Function.prototype` moved 127 Temporal tests
   onto the runtime-eval route. Those tests run only with the Temporal
   provider that CI links. Verdicts are measured with that provider built
   locally, across all editions.
2. **Mixed files.** A legacy unit folds an access (`Math.max`) while an IR
   unit in the same file writes the realm (`Math.max = f`). The pristine
   predicate must be a whole-file fact, asked by both.
3. **Members the runtime never seeded.** A dynamic read of an unseeded member
   answers `undefined` silently. Each slice lists the members it relies on
   and proves them with probes against node.
4. **Refusing at select drags IR callers to legacy.** Measure units newly
   legacy on a wide control set.

### Constraints

- Standalone only; no new host imports; JS-environment output
  byte-identical.
- No test verdict regresses in any edition; no unit that main lowers on IR
  is lost; refuse at select, never claim and then withdraw.
- No selector-side copy of from-ast rules; the admission module is asked by
  both.
- No budget grant for `select.ts` or `from-ast.ts` beyond a dated, justified
  one; removing the four allowlists should shrink them.

## Acceptance criteria

Per slice:

1. Census on the 1,837 carrier files and 500 IR-only control files: files
   gained, files lost 0, units newly legacy 0, new compile errors 0,
   post-claim errors not increased.
2. Verdicts of every routing-changed file, across all editions, with QuickJS
   and the Temporal provider: no pass to fail.
3. A probe matrix against node for the slice's positions and names, at
   module level and inside a function: nothing claimed answers differently.
4. JS-environment output byte-identical on the routing-changed files and on
   200 others.

Code quality:

5. After G2 the four allowlists are gone; one admission and one pristine
   predicate remain.
6. No second call mechanism beside #7349's.
7. A fresh-context adversarial review per slice records its verdict in the
   PR body.

## Slice B2c-1 plan — `parseFloat` / `parseInt` bodies move to the native runtime (2026-11-19)

Lead decision 2026-11-19: before B2b's realm rows can bind the native implementations, move the pure body
builders out of codegen into `src/runtime/wasmgc/values/`, one PR per surface, bytes identical. Inventory of
the surfaces (codegen vs runtime, standalone): the Object constructor and the primitive wrappers already have
realm builders (`object-constructor-body.ts`, `to-object-body.ts`, `primitive-wrapper-bodies.ts`; the legacy
`__new_Number/String/Boolean` store a different representation, so there is nothing to move); `isNaN` /
`isFinite` are single inline operations; the Error constructor body is already shared (`error-bodies.ts`);
Math's transcendental functions are self-hosted from `src/stdlib/math.ts`. `parseFloat` and `parseInt` are the
first surface with real bodies still in codegen.

**Target structure.** `src/runtime/wasmgc/values/parse-number-bodies.ts`, beside `string-number-bodies.ts` and
`decimal-scale-bodies.ts`, which `__str_to_number` already uses: `buildParseFloatDefinition` and
`buildParseIntDefinition`, each `(bindings) → { locals, body }`. Bindings: the native string types, the decimal
power table (`DecimalPowerResources`, parseFloat only) and the argument prologue (`flatString(argLocal)`: the
instructions that leave a flat native string, which codegen supplies with its finalize-filled ToString arm).
`src/codegen/parse-number-native.ts` keeps only what touches the module: the function type, the handle, the
`funcMap` row, the pow10 global and the prologue's pending ToString arm.

**What it removes.** (Corrected after review RV7323b.) The parseFloat digit loops duplicated
`buildDecimalMantissa` (`string-number-bodies.ts`, `__str_to_number`'s) except for local indices and a 4-instruction
`mant = 0; sawDigit = 0` init: they are one exported builder now, taking a locals record, with the init left to
the caller; its dead `strDataTypeIdx` parameter goes. The move itself makes the two bodies bindable by the realm
without a second implementation.

**Acceptance.** Bytes identical on every test262 file whose source names `parseInt` or `parseFloat`, on the
default, standalone and linear targets (measured with a scratch hashing script; review RV7323b asked not to
commit a third byte-identity tool beside `prove-emit-identity.mjs` and `byte-diff-corpus.mts`, and to count
rows that fail on both trees separately from identical binaries);
`parse-number-native.ts` shrinks; the new file joins the `native-runtime` layer. Quality: the builders read
no context, only their bindings.

**B2c-1 measured (2026-11-19, main `89e4748241`).** A scratch hashing script over the 216 test262
files whose source names `parseInt` / `parseFloat` plus a 103-file random control sample (317 files, 925
rows): 0 rows differ. Binaries compared: 291 default and 291 standalone (13 files compile on neither tree, 13
are runner skips). The linear target compiles none of these harness-wrapped files on either tree (the linear
backend has no `try` / `catch`), and nothing under `src/codegen-linear/` imports the moved code, so linear is
unaffected by construction. `buildParseFloatDefinition` stays under the 300-line budget by calling the shared
`buildDecimalMantissa`; the codegen side has an `emitParseFloat` beside `emitParseInt` and `emitStrToNumber`.
`tests/issue-1663.test.ts` (1 row) and `tests/issue-6969-parse-number-tostring.test.ts` (8 parseFloat rows)
fail identically on main `89e4748241`; `issue-2654` and `parseint-edge` pass.
