---
id: 3575
title: "default lane: ArraySpeciesCreate / @@species / @@isConcatSpreadable for Array methods (concat/splice/slice)"
status: ready
created: 2026-07-24
updated: 2026-07-24
priority: medium
feasibility: hard
task_type: feature
area: codegen
es_edition: es2015
language_feature: array-methods
goal: builtin-methods
sprint: Backlog
horizon: xl
umbrella: 3185
related: [3185, 3201, 2001]
origin: "2026-07-24 #3201 measurement — largest coherent addressable cluster in the default-lane Array method residue"
---

# #3575 — default-lane ArraySpeciesCreate / @@species / @@isConcatSpreadable

Split out of **#3201** (default JS-host lane Array search + structural
generics). The #3201 fork-per-file measurement (2026-07-24, default gc/"honest"
lane, CI baseline jsonl + faithful re-run for error strings) found this is the
**single largest coherent addressable cluster** in the remaining Array-method
residue: **~42 non-pass** across concat/splice/slice. It is real ES2015
observable-constructor / well-known-symbol work, **architect-scale**, and does
NOT fit a contained dev slice — hence the split.

## Measured cluster (default gc lane, 2026-07-24)

By filename family across concat/splice/slice failing files:

- **ArraySpeciesCreate** — `create-species-*` (~19), `create-ctor-*` (6),
  `create-proto-from-ctor-realm-*` (6), `target-array-*` (4). ~35 files.
- **@@isConcatSpreadable** — `is-concat-spreadable-*` (7), plus the
  wrapper-spreading fails (`Array.prototype.concat_spreadable-boolean-wrapper`,
  `-number-wrapper`, `-reg-exp` etc.): concat currently **spreads** non-array
  objects it should not, and does not consult `Symbol.isConcatSpreadable`.

Representative failing shapes (measured error strings):

- `concat/create-species-abrupt.js` — "a.concat() throws a Test262Error
  exception Expected a Test262Error to be thrown" (species getter side effect
  not observed).
- `concat/create-species-with-non-configurable-property.js` — "arr.concat(1)
  throws a TypeError" (CreateDataPropertyOrThrow on the species result must
  throw).
- `concat/is-concat-spreadable-val-undefined.js` / `-val-falsey.js` — "Cannot
  convert a Symbol value to a number" (we mishandle the `@@isConcatSpreadable`
  symbol lookup).
- `concat/Array.prototype.concat_spreadable-boolean-wrapper.js` — Actual
  `[1,2,3]` vs expected `[true]`: a Boolean wrapper object must NOT spread.
- `splice/create-species-poisoned.js`, `slice/create-species-abrupt.js`,
  `slice/create-ctor-non-object.js` (null species result → TypeError).

## Mechanism (for architect feasibility spec)

The default-lane concat/splice/slice all **eagerly mint a fresh WasmGC vec** for
their result instead of running §7.3.22 **ArraySpeciesCreate(originalArray,
length)**:

1. Let `C` = `Get(originalArray, "constructor")`.
2. If `C` is a constructor with a `@@species` (Symbol.species) property, use
   `Construct(C[@@species], «length»)` to create the result (observable getter
   + constructor call + the resulting exotic/Proxy/non-Array object must be
   honored, incl. its `CreateDataPropertyOrThrow` failures → TypeError).
3. concat additionally consults **`IsConcatSpreadable(O)`** (§23.1.3.1.1):
   `Get(O, @@isConcatSpreadable)`; if not undefined, ToBoolean it; else
   `IsArray(O)`. Only spreadable operands are flattened; everything else is
   appended as a single element.

This needs: observable `constructor`/`@@species` property lookup on the
receiver, `Construct` dispatch on a user constructor, a well-known-symbol
(`Symbol.species`, `Symbol.isConcatSpreadable`) get on arbitrary objects, and
`CreateDataPropertyOrThrow` semantics on the (possibly-exotic) result. Some of
this is **object-model / ctor-dispatch that may be value-rep-adjacent** (shares
surface with the #2001/#3251 array-descriptor-overlay substrate and the
Proxy-deferred boundary) — the architect should scope which sub-parts are
reachable without the full substrate, vs which must wait on it.

## Acceptance (to be refined by architect)

1. concat/splice/slice create their result via ArraySpeciesCreate (observable
   `constructor`/`@@species`), with `@@species === undefined`/`null` falling
   back to the default Array create.
2. concat consults `@@isConcatSpreadable` (symbol get + ToBoolean, else
   IsArray) — no non-array wrapper spreads.
3. `CreateDataPropertyOrThrow` on the species result surfaces a spec TypeError,
   not a Wasm trap.
4. No regression to the default create fast-path for the common
   (no-`@@species`) case.
