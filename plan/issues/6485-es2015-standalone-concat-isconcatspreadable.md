---
id: 6485
title: "ES2015 standalone: Array.prototype.concat never performs the @@isConcatSpreadable Get"
status: ready
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
