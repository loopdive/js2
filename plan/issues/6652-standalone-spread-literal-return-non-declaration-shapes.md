---
id: 6652
title: "standalone: the spread-literal return-carrier mismatch survives in every callable shape that is not a top-level function declaration"
status: done
completed: 2026-09-21
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/sendev-s71
created: 2026-09-20
---

# The five residual shapes of #6650

[#6650](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6650-standalone-spread-literal-return-null)
fixed the return-carrier mismatch — a spread-built object literal is an open
host `$Object` **externref**, while the enclosing function's Wasm result ABI is
the checker-inferred **concrete struct**, so the emitted return is a guarded
downcast (`ref.test` → `ref.cast` / `ref.null none`) that takes the null arm on
every evaluation — for **top-level function declarations only**.

Measured on the S70 base (`78dd538964`) with `.tmp/s71/probes/solo3.mts`, the
same mismatch remains for five other callable shapes:

| shape | base result |
| --- | --- |
| arrow function — `const m1 = () => { …; return { ...o, days: 9 }; }` | `NaN` |
| function expression — `const P1 = function () {…}` | `NaN` |
| object-literal method — `{ mk() {…} }` | TRAP `illegal cast` |
| class method — `class Q1 { mk() {…} }` | TRAP `dereferencing a null pointer` |
| nested function declaration | TRAP `dereferencing a null pointer` |

The brief expected this to move Temporal rows, on the reasoning that the
minified `@js-temporal/polyfill` uses all five shapes. **It does use them, and
the expectation is still wrong** — see "The Temporal PROVIDER is
byte-identical" below for the measurement and why.

## Root cause — the pre-pass that already covers all six shapes is narrowed to accessors

`wasm-dis` of the arrow shape (`.tmp/s71/probes/wat-arrow.wat`) shows the
identical two halves as #6650: the lifted `$__closure_0` builds the literal with
`__new_plain_object` + `__extern_set` (externref), its funcref type
`$28 (func (param (ref null $12)) (result (ref null $20)))` pins the concrete
struct, and the body ends in

```wat
(return (if (result (ref null $20)) (ref.test (ref $20) …)
  (then (ref.cast (ref null $20) …)) (else (ref.null none))))
```

The compiler already has a **pre-pass** that closes this for every callable
shape: `collectAccessorLiteralReturnCarrierTypes`
(`src/codegen/accessor-literal-return-carrier.ts`, #6614). It runs before
`collectDeclarations`, walks every function-like, and puts the return type into
`ctx.objectHashConsumerTypes`, which `resolveWasmType` answers `externref` for
wherever that type lands (result ABI, local slot, struct field, call-site
binding). Its own doc table lists exactly the six spellings and says the
FunctionDeclaration lane is the only one `declarations.ts` covers.

It was deliberately narrowed to **accessor-bearing** literals ("the other
`objectLiteralForcesHostPath` reasons … are a separate, separately-measured
change"). The SPREAD reason (`objectLiteralSpreadTakesHostPath`, #2804 —
context-driven, not shape-driven) was never added. That is the whole defect: the
predicate, not the plumbing, is missing.

Its `unwrapCarrier` also lacked the **comma-expression** peel that #6650 had to
add to `unwrapReturnCarrierExpression` — and that peel is what actually moved
the polyfill's rows (part 1 alone produced a byte-identical binary), because the
minified `Wr()` returns `zr(…), { ...t.date, days: n }`.

## Fix

1. `src/codegen/declarations/host-carrier-object-literal.ts` — `unwrapReturnCarrierExpression`
   moves here from `declarations.ts` and is exported, so the declaration lane
   and the pre-pass peel the identical set of wrappers (parens / `as` / `!` /
   `satisfies` / comma) by construction rather than by two copies agreeing.
2. `src/codegen/accessor-literal-return-carrier.ts` — the return-carrier
   predicate becomes "accessor literal **or** `objectLiteralSpreadTakesHostPath`",
   and the carrier walk uses the shared unwrapper.

`objectLiteralForcesHostPath`'s other arms are deliberately still NOT consulted
here: several of them read `ctx` state (`_hasRuntimeComputedKey`,
`_hasRealmGlobalObjectValue`) that a pre-pass running before
`collectDeclarations` has not populated. `objectLiteralSpreadTakesHostPath` is
pure — it reads only `ctx.checker.getContextualType` — which is what makes it
safe at this point in the pipeline.

## Measurement

### The five shapes — `.tmp/s71/probes/solo3.mts`, base = a file-copy revert of the three touched files to `78dd538964`

| shape | base | fix |
| --- | --- | --- |
| arrow (`const m1 = () => {…}`) | `NaN` | **9** |
| function expression | `NaN` | **9** |
| object-literal method | TRAP `illegal cast` (see the collision note) | **9** |
| class method | TRAP `dereferencing a null pointer` | **9** |
| nested function declaration | TRAP `dereferencing a null pointer` | **9** |
| controls (param spread · read-inside · non-spread · plain local return · `@returns {any}` · top-level declaration) | correct | unchanged |

The witness `tests/issue-6652-spread-literal-callable-shapes.test.ts` adds the
comma-return spelling for an arrow and for an object-literal method, plus the
concise-arrow-body and named-function-expression spellings. On the reverted base
**all 9 defect rows fail and all 6 controls pass**, so no control can carry the
file green.

### The Temporal PROVIDER is byte-identical — the fix moves rows only through TEST-BODY compilation

This is the result that matters for anyone planning the next Temporal lane, and
it is a refinement of the trap #6650 documented for its own part 1.

| artifact | base `78dd538964` | fix |
| --- | --- | --- |
| standalone Temporal provider | `57781189fa76e796`, 3 491 376 B | `57781189fa76e796`, **3 491 376 B — byte-identical** (`cmp` on the two cache dirs) |
| host Temporal provider | `80f76d0d10577882`, 1 726 098 B | identical (the pre-pass is standalone/WASI-only by construction) |

**Why.** The minified `@js-temporal/polyfill` contains exactly **six**
spread-bearing `return`s. One is `Wr()` — a top-level function declaration,
already fixed by #6650. The other five are class / object-literal methods, and
every one of them spreads a **PARAMETER** (or a local aliased straight from a
parameter): `{...e, month: r, monthCode: o}`,
`({month:a,monthCode:s}=ti(…)), {...o, month:a, monthCode:s}`,
`{...e, day:s, month:i, …}`, `{...e, year:r, eraYear:o, era:i}`,
`{...e, year:o, month:i, monthCode:c, day:s}`. A parameter in untyped JS is
`any`, so the spread result is `any`, so the enclosing method's result ABI was
**already** externref — there was never a concrete-struct mismatch to fix.

Measured directly rather than argued: `.tmp/s71/probes/polyfill-shapes.mts`
transcribes those five to their essential shape and runs them **on the base**:

| polyfill-shaped case | base |
| --- | --- |
| class method spreading a parameter | 9 (correct) |
| class method, comma return, spread of a parameter alias | 9 (correct) |
| object-literal method spreading a parameter | 9 (correct) |
| class method spreading a LOCAL with a concrete inferred shape (#6652 proper) | TRAP `dereferencing a null pointer` |

So the defect is real and the fix is right, but `@js-temporal/polyfill` does not
contain the shape outside the one declaration #6650 already covered. **The value
of this change is user-code correctness, not Temporal conformance** — a lane
looking for Temporal rows should take a different target.

**It is not zero rows, though, and the distinction is the useful part.** A
test262 row compiles TWO things: the provider (identical here) and the TEST
BODY. The `Temporal-rest` chunk-3 base run found **3 fail→pass, 0 pass→fail**,
all of them `compile_error → pass`:

- `Temporal/Instant/compare/argument-zoneddatetime.js`
- `Temporal/Instant/from/argument-zoneddatetime.js`
- `Temporal/Instant/from/subclassing-ignored.js`

Those are harness/test-body shapes, not polyfill shapes. So the rule for the
next lane is: a byte-identical provider bounds the polyfill contribution to
zero, but says nothing about the corpus — the test bodies are ordinary user
code and this defect class hits them.

### Battery — 15 groups, 4 434 rows, 0 pass→fail everywhere, +3 fail→pass

Fresh `cacheHit=false` `--target both` provider per tree; runner
`.tmp/s71/battery/run-batch.mts`.

| group | rows | fix | vs base |
| --- | --- | --- | --- |
| PlainDate | 120 | 120 | 0 / 0 |
| Duration | 120 | 109 | 0 / 0 |
| PlainDateTime | 120 | 117 | 0 / 0 |
| ZonedDateTime | 120 | 117 | 0 / 0 |
| **four-family** | **480** | **463** | unchanged |
| AddSub (`PlainDate`/`PlainYearMonth` add+subtract) | 150 | 138 | 0 / 0 |
| `Temporal-rest` (every `built-ins/Temporal/**` file not in the lists above, first 600 by sorted path) | 600 | 465 | see the caveat below |
| A · B · C · D · E-linked · E-unlinked · F-class · F-methoddef · F-objproto (must-not-move) | 3 104 | 2 622 | 0 / 0 each |

**`Temporal-rest` base-run caveat (coordinator decision, 2026-09-21).** The
group was run in three 200-row chunks. Only **chunk 3 (rows 401–600) has a
reverted-base run**: `matched=200 missing=0 passToFail=0 failToPass=3`
(base 174/200 → fix 177/200). **Chunks 1–2 (400 rows) have a fix-tree
measurement only** — 465/600 overall — because the box was contended by three
sibling lanes and the runs were stopped. What bounds the risk there is the
`cmp`-verified byte-identical provider: with the provider fixed, any delta in
those 400 rows could only come from test-body compilation, the same channel
chunk 3 measured at 0 pass→fail. That is a bound, not a measurement; a lane
that needs certainty should re-run `rest1-files.txt` / `rest2-files.txt`
against a reverted tree.

Corpus `.tmp/s71/corpus-fix.jsonl` vs the S70 base `.tmp/s71/lead-corpus-fix.jsonl`:
`statusFlips=0 shaFlips=0` (94 rows). Equivalence gate: 22 failing / 1 720
passing / 22 known — no new regressions. Witness sweep
(`tests/issue-66*` + 6484 + 6493): 58 files / 365 tests green under **Node 22
and Node 25**.

## Residuals (measured, not fixed)

**An object-literal method and a class method that share a NAME emit an INVALID
module** — `local.set[0] expected type (ref null N), found ref.as_non_null of
type (ref M)` — with no spread anywhere, on the base and on the fix alike.
Reduced to five lines in `.tmp/s71/probes/collide.mts`:

```js
const O1 = { mk() { return { a: 1 }; } };
class Q1 { mk() { return { a: 2 }; } }
export function use() { return O1.mk().a + new Q1().mk().a; }   // expected 3
```

This is why the S70 residual table recorded the object-literal-method row as
TRAP `illegal cast`: the 20-case probe happened to contain both an `O1.mk` and a
`class Q1 { mk }`. Probed alone, or with the class method renamed, the shape
behaves like the others. Unrelated mechanism (the `classMemberFuncKey` /
`__anon_N_mk` vs `Q1_mk` registration pair, #1983 family) — worth its own issue.
