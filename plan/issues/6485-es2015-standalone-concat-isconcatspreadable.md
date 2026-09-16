---
id: 6485
title: "ES2015 standalone: Array.prototype.concat never performs the @@isConcatSpreadable Get"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
# 2026-09-16 (S1) — the third `Array.prototype.concat` routing gate. Both files
# are already over the 1500-line ratchet threshold, and neither growth is
# relocatable: `context/types.ts` is the single declaration site for every
# module-wide pre-scan flag (+20 lines, 19 of them the doc that records why the
# scan keys on the NAME rather than over-approximating every computed member
# write), and `array-methods.ts` owns the concat dispatch decision the two
# existing gates already live in (+5 lines, 4 of them comment). Putting either
# elsewhere would split a decision that has to be read in one place — the exact
# failure mode `array-concat-carrier.ts` was extracted to prevent.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/array-methods.ts
# 2026-09-16 (S1) — +1 line in `createCodegenContext`: the one initializer for
# the new pre-scan flag. Every module-wide flag is initialized in that single
# object literal; a flag initialized anywhere else would be the desync this
# whole family of flags exists to prevent.
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
---

# `Array.prototype.concat` never performs the `@@isConcatSpreadable` Get

`src/codegen/array-concat-spec.ts` (#4446) implements §23.1.3.1 correctly,
`IsConcatSpreadable` included. The defect is the **routing**: `compileArrayConcat`
(`src/codegen/array-methods.ts:5308`) enters that spec loop only behind two
gates —

```ts
if (concatMustConsultPrototypeChain(ctx) || arraySpeciesActive(ctx)) { … }
```

— and neither of them is about `@@isConcatSpreadable`. A module that installs
that symbol on a non-array operand has no gate of its own, so the call takes a
typed fast path (or the `allArgumentsAreArrays` dynamic path) that copies
backings and never performs `Get(E, @@isConcatSpreadable)`.

## Measured (standalone baseline fetched 2026-09-16 10:46 UTC)

18 of the `built-ins/Array/prototype/concat` rows are non-pass. Three
sub-families, by the error the baseline records:

**F1 — the Get never happens (7 rows).**

| row | observed | expected |
| --- | --- | --- |
| `Array.prototype.concat_spreadable-function.js` | `[1, 2, 3]` | `[]` |
| `Array.prototype.concat_spreadable-boolean-wrapper.js` | `[true]` | `[]` |
| `Array.prototype.concat_spreadable-string-wrapper.js` | the code units | `[]` |
| `Array.prototype.concat_spreadable-reg-exp.js` | `[]` vs `[]` mismatch | per spec |
| `Array.prototype.concat_spreadable-sparse-object.js` | uncaught Wasm-GC exception | per spec |
| `is-concat-spreadable-get-order.js` | reads `[constructor]` | `[constructor, isConcatSpreadable, …]` |
| `Array.prototype.concat_array-like-to-length-throws.js` | no throw | the `length` getter's abrupt completion |

The `get-order` row is the direct proof: the observable Get sequence contains
`constructor` (so `ArraySpeciesCreate` does run) and stops there. The symbol is
never read.

**F2 — an `arguments` object contributes `null` where the spec says a hole (3 rows).**
`Array.prototype.concat_{sloppy-arguments,sloppy-arguments-with-dupes,strict-arguments}.js`
all report `[1, 2, 3, null, null, null]` against `[1, 2, 3, undefined, undefined, undefined]`.
The `$Hole` sentinel discipline `array-concat-spec.ts` documents is not reached
for an arguments carrier.

**F3 — a revoked/plain Proxy operand traps (3 rows).**
`is-concat-spreadable-proxy.js` gives `illegal cast [in __module_init_chunk_0()]`;
the two `*-revoked.js` twins trap inside a closure. A trap is never an acceptable
answer for a spec-mandated TypeError.

The remaining 5 (`large/small-typed-array`, `create-proxy`,
`create-proto-from-ctor-realm-non-array`, `arg-length-exceeding-integer-limit`)
need species/realm machinery and are **out of scope** here — record them as
residuals, do not widen the lane to chase them.

## Implementation Plan

### S1 — a third gate (F1, 7 rows)

1. Add `concatMustConsultIsConcatSpreadable(ctx)` to
   `src/codegen/array-concat-carrier.ts`, beside `concatMustConsultPrototypeChain`
   (line 79) and written to the same shape: `native-first` **and** a pre-scan flag.
2. The pre-scan flag is the work. Model it on `ctx.protoIndexDirty` (#4160): set
   it when the module could make `@@isConcatSpreadable` observable on any value —
   a property write or `Object.defineProperty` whose key is
   `Symbol.isConcatSpreadable` (well-known id 6, see
   `SYMBOL_IS_CONCAT_SPREADABLE_ID` in `array-concat-spec.ts:34` and
   `builtin-value-read.ts:177`), a computed member whose key expression is not
   statically a string/number, or a spread of an object literal that could carry
   one. **Err toward setting the flag**: a false positive costs the spec loop's
   bytes on that module; a false negative is the current silent wrong answer.
   Find where `protoIndexDirty` is set and put this beside it, so there is one
   pre-scan pass, not two.
3. Gate clear ⇒ the flag is never set ⇒ **every existing module's bytes are
   unchanged**. Prove that, do not assert it: compile a corpus with both flags
   off and compare sha256 against the base tree.
4. With the gate on, the call routes to `compileArrayConcatNativeSpec`, which
   already performs the Get in the right order. If a row still fails after
   routing, the defect is inside the spec loop and is yours to fix there — say
   so explicitly in your report with the probe that shows it.

### S2 — the arguments-object hole (F2, 3 rows)

`concat` of an `arguments` object must distinguish an absent index from an
explicit `undefined`. The spec loop's `$Hole` sentinel path exists
(`ensureHoleType` / `holeSentinelInstrs`, and `__extern_has_idx` is consulted
before `Get`). Find why an arguments carrier yields `null` instead: either the
carrier does not answer `__extern_has_idx`, or the output reader maps the
sentinel to `null` rather than `undefined` for this carrier. Fix at whichever of
the two it actually is — diagnose before editing.

### S3 — the Proxy trap (F3, 3 rows), only if S1+S2 are green and measured

An operand that is a Proxy (revoked or not) must not `illegal cast`. The
spec-mandated answer for a revoked proxy is a catchable TypeError. Apply the
same discipline as `recoverRegExpStructFromExternref`
(`regexp-standalone.ts:3107`): brand-test, then throw through the shared
exception-tag path — never widen a cast to make the trap disappear.

## Acceptance

Rows (`COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`):

- S1: the 7 F1 rows fail → pass.
- S2: the 3 F2 rows fail → pass.
- S3 (if attempted): the 3 F3 rows fail → pass.

Controls, 0 lost: the whole `built-ins/Array/prototype/concat` directory (69
rows), `built-ins/Array/prototype/{slice,splice,map,filter,flat,join}`,
`language/expressions/spread`, `language/statements/for-of`.

## Hazards

- **The gate must stay OFF for ordinary modules.** This lane's whole safety
  argument is "flag clear ⇒ not reached ⇒ bytes unchanged". A pre-scan that
  sets the flag on every module turns a conformance fix into a size-and-speed
  regression with no test to catch it. Report the flag's hit rate over
  `playground/examples/`.
- **Never widen a `ref.cast` to silence a trap** — the trap is telling you a
  representation does not hold; answer the spec's TypeError instead.
- Host and gc targets must be byte-identical to the base tree; this lane is
  `semanticProviders === "native-first"` only.

## Validation required before the PR

TS7 typecheck, lint, prettier; the five source-ratchet gates bare and with
`LOC_GATE_BASE=origin/main` (growth grants in this frontmatter, dated, never in
`scripts/*-baseline.json`); all 8 equivalence shards; and a pin file
`tests/issue-6485-concat-isconcatspreadable.test.ts` covering, on standalone with
`result.imports` `[]`: a spreadable function, a spreadable wrapper, a
non-spreadable array (`arr[@@isConcatSpreadable] = false` must NOT spread — the
negative direction, which a fix that always spreads would pass vacuously), the
Get order, and the arguments-object hole.

## Results — S1 landed 2026-09-16 (Opus lane)

Measured with `COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate
<list> --standalone`, `JS2WASM_EVAL_ENGINE=interpreter` (the quickjs artifact is
not built in this container; the SAME engine was used for the before run, so the
delta is comparable — the absolute counts are not CI-comparable).

**`built-ins/Array/prototype/concat`, all 69 rows, before → after:**
`48 pass / 20 fail / 1 compile_error` → `51 / 17 / 1`. **Zero regressions**
(per-row diff of the two non-pass lists).

Rows flipped fail → pass:

| row | fixed by |
| --- | --- |
| `Array.prototype.concat_spreadable-boolean-wrapper.js` | §23.1.3.1.1 **step 1** (`Type(O) is not Object ⇒ false`), which the spec loop never performed |
| `is-concat-spreadable-proxy.js` | the routing gate (was an `illegal cast`; the spec loop handles the operand) |
| `is-concat-spreadable-is-array-proxy-revoked.js` | the routing gate |

The last two are F3 rows the plan scheduled for S3. They came free with S1.

**The gate stays off.** `isConcatSpreadableDirty` hit rate over
`website/playground/examples/` (13 files × {standalone, gc}): **0 / 26**, and
the sha256 of every emitted binary is **byte-identical** to the base tree on
both targets (`diff` of the two sha lists is empty). The flag is not asserted
to be off — it is printed by `JS2WASM_DEBUG_6485` and counted.

**The plan's F1 attribution was wrong for 5 of its 7 rows.** The plan says the
Get "never happens" because of routing. Measured: in an ordinary module
`[].concat(nonArray)` ALREADY reaches the §23.1.3.1 spec loop and already fires
an `@@isConcatSpreadable` getter (`.tmp/6485/js/probe3.js`: `calls=[sym]`). The
real routing defect is the one the plan's Hazards section hints at but its
measured table does not list — a **statically array-typed** operand:

```js
var a = [1, 2], b = [3, 4];
b[Symbol.isConcatSpreadable] = false;
a.concat(b).length;   // base 4, spec 3   (b must be appended whole)
var c = [5, 6]; c[Symbol.isConcatSpreadable] = false;
c.concat().length;    // base 2, spec 1   (the receiver is an operand too)
```

Both are correct after the gate (`.tmp/6485/js/probe5.js`). No test262 row in
the acceptance set exercises that shape, which is why the gate alone flips none
of them; the pin file covers it instead.

## Residuals (not fixed here — each with its own evidence)

- **S2, the arguments hole (3 rows).** The gate DID change these: the operand
  now goes through the spec loop (proved by `.tmp/6485/js/probe12.js`, where a
  sentinel operand's getter fires and the total length is spec-correct), and
  index 3 is reported **absent** (`3 in out === false`). What is still wrong is
  only the VALUE read back: `null` where the spec wants `undefined`. Measured
  side by side in ONE module (`.tmp/6485/js/probe11.js`): an `arguments` source
  with `length` 6 over a 3-slot backing gives `out[3] === null`, while the
  identical plain object `{length: 6, 0:1, 1:2, 2:3}` gives `undefined`. So the
  divergence is per-SOURCE-carrier inside the loop, not the output reader.
  Two candidate fixes were written and **reverted unshipped** because neither
  moved the probe: (a) `fillConcatNativeHoleArms`' `holeGet` uses
  `undefinedExternInstrs` (gated on the default-off #2106 singleton flag, so it
  falls back to `ref.null.extern` = JS `null`) where
  `canonicalUndefinedExternInstrs` is the documented correct helper; (b) the
  #4922 physical-backing guard in `__extern_has_idx` iterates
  `ctx.vecTypeMap`, which never contains the #4658 `$__arguments_vec` subtype.
  Finding worth keeping either way: **`getArgumentsVecTypeIdx` always returns
  -1** — it reads `ctx.argumentsVecTypeIdx`, a field nothing on
  `CodegenContext` ever assigns, so `excludeArgumentsArrayCarrier` is a no-op
  in every compile.
- **`spreadable-function.js` / `spreadable-string-wrapper.js`.** Both now fail
  only on `Get(E, "length")` for a non-plain carrier: a spreadable function with
  `fn.length = 3` and a spreadable `new String("yuck…")` each yield `[]`, i.e.
  `__extern_length` answered 0. Closure / string-object property bags, not
  concat.
- **`spreadable-reg-exp.js`.** A module that writes BOTH an index and `length`
  on a RegExp makes `[].concat(re)` answer `[]` for a pristine `re` earlier in
  the same module; either write alone is harmless (bisected in
  `.tmp/6485/js/{v,w}*.js`). An `IsArray`/carrier defect, not routing.
- **`is-concat-spreadable-get-order.js`.** `Object.defineProperty(arr, Symbol.
  isConcatSpreadable, {get})` on an ARRAY is dropped: the direct read
  `arr[Symbol.isConcatSpreadable]` answers `undefined` and the getter never
  fires, while the same descriptor on a plain object works and a plain
  `arr[Symbol.isConcatSpreadable] = v` assignment on an array also works
  (`.tmp/6485/js/probe2.js`). Symbol-keyed ACCESSOR defineProperty on a vec
  carrier.
- **`array-like-to-length-throws.js`.** Needs the ToLength abrupt completion to
  propagate out of `__extern_length`.
- **`spreadable-sparse-object.js`** still traps (`uncaught Wasm-GC exception`)
  at its first assertion.
- **The `any`-receiver producer.** `__arrprod_concat` (`dyn-array-producers.ts`)
  still omits `@@isConcatSpreadable`; its own doc claims "a module that can
  observe the symbol … does not reach here", which this change makes true for
  the typed path only. Measured: `var base: any = []; base.concat(obj)` with a
  spreadable `obj` answers length 1.
- The 5 species/realm/typed-array rows the plan named are untouched, as scoped.
- **Control rows not RUN:** `built-ins/Array/prototype/{slice,splice,map,filter,
  flat,join}`, `language` spread files and `language/statements/for-of` (1,526
  rows). They are covered by construction rather than by execution: none of the
  1,526 contains `isConcatSpreadable` or `Symbol[`, the test262 harness prelude
  contains neither, and the 7 rows that genuinely call `eval` (which forces the
  flag through the `dynamicCodeDirty` cascade) contain no `.concat(` call and
  include none of the four harness files that do. Flag clear ⇒ the gate is
  never reached ⇒ bytes unchanged.
