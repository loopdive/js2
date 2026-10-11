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
# 2026-09-16 (adversarial-review R3) — +5 lines in `object-runtime.ts`: the
# import of, and the call to, `buildVecNumericKeyHasArm`. The arm itself (the
# §13.10.1 ToPropertyKey delegation for a numeric `in` key) is a NEW subsystem
# module, `src/codegen/vec-numeric-key-presence.ts`, precisely so the god-file
# does not absorb it — inline it was +68. The 5 that remain cannot move: the
# string-key delegation they sit beside is built inside
# `fillDynamicForinVecArms`, against that function's own appended locals, and
# the two halves of one `in` answer have to be read together.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/array-methods.ts
  - src/codegen/object-runtime.ts
# 2026-09-16 (S1) — +1 line in `createCodegenContext`: the one initializer for
# the new pre-scan flag. Every module-wide flag is initialized in that single
# object literal; a flag initialized anywhere else would be the desync this
# whole family of flags exists to prevent.
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
# 2026-09-16 (adversarial-review R3) — +3 lines in `fillDynamicForinVecArms`:
# a two-line comment and the one-line call that splices the numeric-key arm in
# beside the string-key one. Same argument as the LOC grant above — the body of
# the arm already lives in its own module.
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
# 2026-09-16 (adversarial-review R3) — `__unbox_number` +1, in the NEW file
# `src/codegen/vec-numeric-key-presence.ts`. It is not a hand-rolled coercion
# matrix: §13.10.1 step 6 is `HasProperty(rval, ToPropertyKey(lval))`, and for a
# Number key ToPropertyKey needs exactly one f64 out of the box before the
# canonical-index test. It routes through the shared `__unbox_number` helper —
# the same one `array-filter-spec-access.ts` and `array-methods.ts` use — rather
# than re-deriving ToNumber, and it is guarded by `__typeof_number` so ToNumber
# is never applied to a non-Number key.
coercion-sites-allow:
  - src/codegen/vec-numeric-key-presence.ts
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
`website/playground/examples/` (13 files × {standalone, gc}): **0 / 26**. The
flag is not asserted to be off — it is printed by `JS2WASM_DEBUG_6485` and
counted. (Re-measured after the review widened the scan — see below. The
byte-identity claim that used to sit in this paragraph was WRONG about the
commit as a whole and is corrected there.)

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
  sentinel operand's getter fires and the total length is spec-correct).
  ~~index 3 is reported **absent** (`3 in out === false`)~~ — **that half was an
  artefact of the R3 defect, not a correct answer.** `in` with a numeric key
  consulted nothing at all for an externref receiver, so "absent" was what the
  named-key tail returned, not what the carrier said. With R3 fixed, presence
  agrees with the stored value and reads `true`; both halves are wrong, and both
  are the same defect. What is wrong is the VALUE stored: `null` where the spec
  wants a `$Hole` that reads back `undefined`. Measured
  side by side in ONE module (`.tmp/6485/js/probe11.js`): an `arguments` source
  with `length` 6 over a 3-slot backing gives `out[3] === null`, while the
  identical plain object `{length: 6, 0:1, 1:2, 2:3}` gives `undefined`. So the
  divergence is per-SOURCE-carrier inside the loop, not the output reader.
  Three candidate fixes were written and **reverted unshipped** because none
  moved the probe: (a) `fillConcatNativeHoleArms`' `holeGet` uses
  `undefinedExternInstrs` (gated on the default-off #2106 singleton flag, so it
  falls back to `ref.null.extern` = JS `null`) where
  `canonicalUndefinedExternInstrs` is the documented correct helper; (b) the
  #4922 physical-backing guard in `__extern_has_idx` iterates
  `ctx.vecTypeMap`, which never contains the #4658 `$__arguments_vec` subtype;
  (c) **adding that subtype to the guard's carrier list — tried 2026-09-16 and
  INERT.** The arm emits (`.tmp/adv/args1.wat`, `ref.test (ref 53)`) and changes
  nothing, because the guard fires on `idx < length && idx >= array.len(data)`
  and by then field 0 is already 6 AND the backing array has already been grown
  to match. The tail slots hold plain wasm `null`, indistinguishable from a
  stored `undefined`. **So S2 is a GROW-path defect — what fills a widened
  backing — not a presence-guard one.** That is the next lane's starting point;
  (b) and (c) are closed.
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
- ~~**Control rows not RUN.**~~ **Withdrawn — the argument was false and the
  rows have now been run.** See "Adversarial review" below.

## Adversarial review — three findings, all closed 2026-09-16 (Opus lane)

A reviewer reproduced three defects against the S1 commit. All three were real.
Two of them turned out to be symptoms of a defect that is **already on main**,
which is why the fixes also move base-tree behaviour.

### R1 — the gate matched the NAME, not the intrinsic (major)

`isIsConcatSpreadableObservable` fired only on the literal text
`isConcatSpreadable`, or on an element access whose base was the BARE identifier
`Symbol`. Aliasing the intrinsic defeated both, and the doc comment claimed the
match was complete:

```js
var S = Symbol;                       // the intrinsic ESCAPES here
var k = S["isConcat" + "Spreadable"]; // …and the name is never spelled
var b = [3, 4]; b[k] = false;
[1, 2].concat(b).length;              // 4 — spec says 3
```

Reproduced on the commit tree (`.tmp/adv/p/b3.ts`, `.tmp/adv/p/b2.ts`, the
second passing `Symbol` across a function boundary): flag clear, length 4.

**Fix.** A second trigger in `array-holes.ts`: the `Symbol` intrinsic used as
anything other than the base of a static property access. `var S = Symbol`,
`f(Symbol)`, `Symbol[k]` and `Symbol(d)` arm; `Symbol.iterator`,
`Symbol.for(…)`, `Symbol["iterator"]` and `typeof Symbol` do not. That exclusion
is deliberate and load-bearing: those four are exactly what the test262
`testTypedArray.js` harness prelude uses, and arming there would route ~2,080
rows onto the spec loop for nothing. After: both probes arm and answer 3; the
harness-shaped control (`.tmp/adv/p/b4.ts`) stays clear.

**Still not complete, and now said so in the code.** Two routes survive, both
needing value-flow a syntactic pre-pass cannot do, both costing 0 rows today:
re-deriving the intrinsic through a static-named property of a symbol value
(`Symbol.for("x").constructor[k]`), and a Proxy operand whose `get` trap answers
for the symbol without the module mentioning it. Widening to catch them means
arming on every `o[k] = v`, which fires on ordinary loop code.

### R2 — "flag clear ⇒ bytes unchanged" was false for the COMMIT (major)

The claim is true of the **gate** and false of the **commit**. The §23.1.3.1.1
step-1 fix in `array-concat-spec.ts` (`Type(O) is not Object ⇒ false`, plus its
two `ensureLateImport`s) has no gate and never could have one, so every module
that already reached the spec loop — via `concatMustConsultPrototypeChain` or
`arraySpeciesActive` — emits different bytes with the flag clear. The 13-file
playground corpus behind the 0/26 hit rate cannot see this: only one of those
files contains the string "concat" and it is a string concat.

The withdrawn "covered by construction" bullet inferred the 1,526 control rows
from that false premise. They have now been **run, on both trees**, as have 150
`built-ins/TypedArray/prototype` rows whose harness (`testTypedArray.js`) does
call `.concat(` — the population the construction argument would have had to
cover. Results below.

### R3 — `in` answered ABSENT for present indices of a concat result (minor→real)

Arming the gate flipped `0 in [].concat(undefined)` from true to false. Chasing
it found a bigger, **pre-existing** defect, reproduced on the base tree with no
flag set (`.tmp/adv/p/e6.js`):

```js
var m = [1].concat([2], [3]);  // >1 arg ⇒ the #4655 dynamic carrier
0 in m;   // false — every index, including plain present numbers
m[0];     // 1     — the value side was right the whole time
```

Cause, and it is not the carrier: §13.10.1 step 6 is
`HasProperty(rval, ToPropertyKey(lval))`, and the call site does not perform
that coercion — `binary-ops-in.ts` boxes a numeric key with
`coerceType(…, externref)`, so `0` arrives as a boxed **Number**. Every index
delegation in `__extern_has` sits behind `ref.test $AnyString`, so the key
skipped it and fell to the named-key tail. A vec-TYPED receiver never showed it
(that site folds to an inline `idx < length` compare); only a receiver whose
slot is externref reaches the helper, which is why the dynamic-carrier concat
result is where it surfaces.

**Fix.** A numeric-key arm beside the string one, built by a new subsystem
module `src/codegen/vec-numeric-key-presence.ts` (inline in the god-file it was
+68 lines; as a module the call site is +3). Guarded twice: `__typeof_number`
(not a bare `__unbox_number`, or `true in arr` would become `1 in arr`) and a
canonical-index test `n === trunc(n) && n >= 0` (or `1.5 in [0,1]` would truncate
to index 1 and report present). Ten cases measured against Node in one module
(`.tmp/adv/p/e7.js`), all matching: `0,2,3,1.5,-1,-0,true,"length","1"` in a
3-element concat result, plus `0 in [].concat(undefined)`.

The armed/unarmed pair the reviewer used (`.tmp/adv/p/d5.js` / `d6.js`) now give
identical, Node-identical answers, including the hole case
`2 in [1].concat([1,,3]) === false`.

**One observable got WORSE, and it is S2 wearing a new hat.** The pin
"spreads an arguments object … absence included" asserted
`3 in [].concat(args) === false` for an `args` whose `length` was raised to 6
over a 3-slot backing, and it passed — but only because `in` with a numeric key
consulted nothing at all. It was an accidental right answer sitting on a wrong
stored value: `__extern_has_idx` reports that index PRESENT on an arguments
carrier, so the spec loop performs the `Get` and stores `null` where the spec
wants a `$Hole`, and `out[3] === null` (S2, already recorded). With the numeric
key now routed, presence agrees with that wrong value and reads `true`.

Chased and not fixed, with the dead end recorded so the next lane does not
repeat it: adding `$__arguments_vec` to the `fillConcatNativeHoleArms`
physical-backing carrier list — the fix the previous lane's residual note
predicted — is **inert**. The arm emits (visible in
`.tmp/adv/args1.wat`, `ref.test (ref 53)`) and changes nothing, because field 0
of that carrier is already 6 and its backing array has already been grown, so
`idx < length && idx >= array.len(data)` is false. The tail slots hold plain
wasm `null`, indistinguishable from a stored `undefined`; S2 is a GROW-path
defect (what fills a widened backing), not a presence-guard one. The change was
reverted rather than left in as unexercised code.

No test262 row scores this: the three F2 rows compare VALUES
(`null` vs `undefined`) and fail either way. The pin now asserts the shape and
records both halves in prose rather than pinning the accident.

### Measurements after the review (all on this tree, 2026-09-16)

**Rows — `--standalone`, `COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <chunk>`,
13 chunks, quickjs runtime-eval provider present.** Compared per-test against
`.test262-cache/test262-standalone-current.jsonl` (the committed standalone
baseline, timestamped 15.9.2026 — the artifact, named, not a run of my own; the
concat directory was additionally re-run on the base tree and agreed).

| set | rows | result |
| --- | --- | --- |
| `built-ins/Array/prototype/concat` (acceptance + control) | 69 | 51 pass / 17 fail / 1 CE — **+3, 0 lost** |
| `built-ins/Array/prototype/{slice,splice,map,filter,flat,join}` + `language/expressions/spread` + `language/statements/for-of` | 1,526 | **0 lost** |
| `built-ins/TypedArray/prototype` (the `testTypedArray.js` harness — the R2 surface) | 150 | **0 lost** |
| **total scored** | **1,745** | **0 regressions**, 3 improvements |

The 3 improvements are the S1 rows (`concat_spreadable-boolean-wrapper`,
`is-concat-spreadable-proxy`, `is-concat-spreadable-is-array-proxy-revoked`),
all three recorded `fail` in the baseline.

**Gate hit rate.** `isConcatSpreadableDirty` over `website/playground/examples/`
with the WIDENED scan: **0 / 39** (13 files × {standalone, gc, wasi}), counted
from the `JS2WASM_DEBUG_6485` line, not asserted. Also clear on the three cost
probes, including `row1.js` — assert.js + compareArray.js + **testTypedArray.js**
+ a real TypedArray row, 757 lines, 4 `.concat(` calls in the harness. That
module staying clear is the whole reason the `Symbol.iterator` / `typeof Symbol`
exclusion exists.

**Bytes — the claim the review demolished, re-measured properly.** Flag clear on
every row below; `.tmp/adv/probe-sha.mts`, sha256 of the emitted binary.

| module | target | base | +R3 only | full | total Δ |
| --- | --- | --- | --- | --- | --- |
| `cost-loop.js` (reaches the spec loop) | standalone | 149,767 | 149,808 | 149,908 | +141 |
| | wasi | 107,939 | 107,939 | 108,039 | +100 |
| | gc | 3,408 | 3,408 | 3,408 | **0** |
| `cost-fast.ts` (typed operands, 2-arg merge) | standalone | 139,011 | 139,052 | 139,172 | +161 |
| | wasi | 103,653 | 103,653 | 103,773 | +120 |
| | gc | 3,072 | 3,072 | 3,072 | **0** |
| `row1.js` (real test262 module) | standalone | 1,112,475 | 1,112,516 | 1,112,706 | +231 |
| | wasi | 430,215 | 430,215 | 430,215 | **0** |
| | gc | 71,915 | 71,915 | 71,915 | **0** |

"+R3 only" is the base tree with ONLY `object-runtime.ts` swapped in (file copy,
no git refs touched), which isolates the numeric-key arm: **+41 bytes flat,
standalone only**, independent of module size. The rest is S1's ungated step-1
fix, in every module that reaches the spec loop.

Over the playground corpus the same +41 shows up on **4 of 13 standalone**
binaries (`benchmarks.ts`, `benchmarks/helpers.ts`, `js/algorithms.ts`,
`js/async.ts`); the other 25 non-CE binaries are byte-identical, **gc included on
all 13**. So:

- **gc is byte-identical everywhere measured** — the lane's hazard holds.
- **standalone / wasi are NOT byte-neutral, and saying so is the point.** R3
  fixes a shared MOP helper (`__extern_has`), so it costs a constant 41 bytes in
  any standalone module that builds the object runtime. That is not a gate that
  can be switched off; it is the price of `k in arrayLike` answering §13.10.1.

**Equivalence — all 8 shards, `tests/equivalence/*.test.ts` (238 files).** The
failing set is **identical to the base tree's**: the same 22 pre-existing
failures, none added, none fixed (`.tmp/adv/eq-base.norm` vs
`.tmp/adv/eq-new.norm`, `diff` empty). Shard `eqc-04` crashes its forked worker
with `ERR_IPC_CHANNEL_CLOSED` on BOTH trees and truncates its own report; it was
re-run with `--pool=threads` (11 failed / 219 passed) to get a complete list.

**Pins.** `tests/issue-6485-concat-isconcatspreadable.test.ts`, 13 tests, all
green, every one asserting `result.imports` is `[]`. Four are new: the two alias
shapes (both the NEGATIVE direction, so an always-arm gate could not pass them
vacuously), the harness-shaped control that must stay clear, and `in` on a
concat result with and without the gate armed.

**Gates.** All five source ratchets green bare and with
`LOC_GATE_BASE=66405a1244` (CI's base): loc, func, coercion-sites, oracle-ratchet,
dead-exports. TS7 typecheck clean, biome lint clean, prettier clean.

### One more residual the R1 probes exposed (not a regression, not fixed)

In an `any`-TYPED module the non-spread operand's IDENTITY does not survive the
result: `.tmp/adv/p/b3.ts` answers `len=3` (spec-correct — `b` is appended whole)
but `out[2] === b` reads **false**, while the CONTENTS are right
(`out[2].length === 2`, `out[2][0] === 3`).

It is not the alias fix. `.tmp/adv/p/b5.ts` is the same program with the symbol
spelled DIRECTLY as `b[Symbol.isConcatSpreadable] = false`, and it gives the
identical `elem2IsB=0`. The pin file's statically-typed twin
(`var b = [3, 4]` inferred `number[]`) asserts `out[2] === b` is true and passes.
So this is an `any`-lane boxing-identity question at the `$ObjVec` boundary,
orthogonal to routing — the same family as the `__arrprod_concat` residual above.
No test262 row scores it.

## Second adversarial review — two findings, both closed 2026-09-16 (Opus lane)

Both were real and both reproduced. One was a gap in what the report DISCLOSED;
the other was a defect in the gate's exclusion test. Neither cost a test262 row.

### r2-1 — the `in` fix flips hole-presence on three shapes, not one

The R3 note above named a single casualty, the `arguments` pin. Measured on this
tree (`.tmp/r3/f1.ts`, `.tmp/r3/a5.ts`, standalone, `imports` `[]`), routing a
numeric key to `__extern_has_idx` changes the answer on **three common shapes**,
all in the same direction — `false` → `true` where Node says `false`:

| probe | pre-#6485 base | this tree | Node |
| --- | --- | --- | --- |
| `2 in new Array(5)` | 0 | 1 | 0 |
| `3 in b` after `b = [1,2]; b.length = 5` | 0 | 1 | 0 |
| `5 in m` after `m = [1].concat([2],[3]); m[7] = 9` | 0 | 1 | 0 |
| `0 in b`, `1 in b` (real elements) | 0 | 1 | 1 |

**Not fixable in this lane, and the evidence says why.** The carrier keeps no
hole record for those indices at all, and the rest of the MOP already said so on
BOTH trees — `.tmp/r3/f2.ts` is byte-for-byte identical base vs this tree:
`hasOwnProperty.call(new Array(5), 2)` is `1`, `Object.keys(new Array(5)).length`
is `5`, `hasOwnProperty.call(m, 5)` is `1`; Node answers `0`, `0`, `0`. A grown
backing's tail slots hold plain wasm `null`, which is also how a stored
`undefined` looks, so a slot test cannot separate them — that is the same #6485
S2 GROW-path defect, and testing for null instead would break the pinned
`0 in [].concat(undefined) === true`.

So `in` was answering `false` only because it consulted nothing. The fix made it
**consistent** with the rest of the MOP rather than newly inconsistent; making
all of them right is S2's job. Recorded here, in the arm's own doc
(`vec-numeric-key-presence.ts`), and pinned — the pin asserts the INVARIANT that
survives the S2 fix (`in`, `hasOwnProperty` and `Object.keys` must agree on such
a carrier), so an S2 lane flips them together and the pin stays green, while a
change that moves `in` alone goes red.

**Row cost: none.** `language/expressions/in` + `built-ins/Object/prototype/hasOwnProperty`
(99 rows) measured below, and the concat directory is row-identical between this
tree and the previous commit.

### r2-2 — `symbolIntrinsicEscapes` armed on three non-escaping shapes

The test read only the identifier's IMMEDIATE parent and matched on the text
`Symbol`, so it armed where the intrinsic provably does not escape — including
the one case its own doc claimed it excluded. All three reproduced on
b3894b8868 via `JS2WASM_DEBUG_6485`, all three are clear now
(`.tmp/r3/{c0,c1,g2,h5,h6}.ts`):

| shape | b3894b8868 | this tree |
| --- | --- | --- |
| `var o = { Symbol: 1 }; o.Symbol` — a property NAME | armed (+949 B vs the renamed twin) | clear (+9 B, the name length — the base tree's figure) |
| `function f(Symbol) { return Symbol + 1 }` — a SHADOW | armed | clear |
| `(Symbol as any).iterator` — a cast before a static member | armed | clear |

**Fix.** `symbolIntrinsicEscapes` now asks three questions in order instead of
one: is this occurrence a NAME rather than a reference (property name,
declaration name — `{ Symbol }` shorthand excluded, it IS a reference); is the
binding SHADOWED by a local in an enclosing scope; and only then, does the
reference escape — with the escape test seeing through `(…)`, `as`, `<T>` and
`!` wrappers.

**The narrowing gained a case too.** `globalThis.Symbol` / `window.Symbol` IS
the intrinsic, so a `.Symbol` whose base is the global object re-enters the
analysis with the whole property access as the reference:
`globalThis.Symbol[k]` arms, `globalThis.Symbol.iterator` does not. The old code
armed on both — by accident, via the name match.

**The exclusion set is now pinned non-vacuously.** The old pin named for it
asserted concat BEHAVIOUR, which is identical armed and unarmed, so an
implementation that armed on everything passed it. The new
`#6485 the @@isConcatSpreadable pre-scan gate` block reads the flag itself off
the pre-scan's `JS2WASM_DEBUG_6485` line — 7 arming shapes and 8 clear ones.
Verified non-vacuous: with `array-holes.ts` reverted to b3894b8868 (file copy,
no git refs touched) **5 of the 8 clear pins go red**; with the fix they pass.
Binary size was tried first and rejected as an instrument: adding an arming
construct to an already-armed module still moves the binary 1,008–2,577 bytes,
which overlaps the 1,480 a genuinely clear module moves.

**Residual, widened and named rather than papered over.** Re-deriving the
intrinsic through a property of some OTHER object — `var S = shim.Symbol;` or
`var g = globalThis; g.Symbol[k]` — does not arm. Only the *literal* global
object base is recognised, because `o.Symbol` on an arbitrary `o` is far more
often an ordinary property than the intrinsic. That joins the two value-flow
residuals R1 already recorded. Measured cost today: **zero rows** — no file in
`test262/test` and no file in `test262/harness` combines `.concat(` with any of
the four now-excluded shapes (`grep` over the 166 corpus files that call
`.concat(`).

### Measurements after this review (all on this tree, this container)

**Rows — `--standalone`, `COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <chunk>`.**
Three trees, one session, one eval engine, so the deltas are comparable:

| set | rows | pre-#6485 `66405a1244` | b3894b8868 | this tree |
| --- | --- | --- | --- | --- |
| `built-ins/Array/prototype/concat` | 69 | 47 pass / 21 fail / 1 CE | 50 / 18 / 1 | **50 / 18 / 1** |

**+3, 0 lost**, and the non-pass sets of the last two columns are identical
row-by-row (`comm` over the sorted lists). The three rows are the ones S1 already
claimed: `concat_spreadable-boolean-wrapper`, `is-concat-spreadable-proxy`,
`is-concat-spreadable-is-array-proxy-revoked`.

**Correction to the S1 report's absolute numbers.** It recorded
`48/20/1 → 51/17/1`; this container measures `47/21/1 → 50/18/1` for the same
two trees. The DELTA reproduces exactly; the absolute is one row lower here, an
environment difference (runtime-eval provider), not a regression. An absolute
pass count from a scoped local run is not CI-comparable — the delta is the
measurement.
