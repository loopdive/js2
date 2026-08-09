---
id: 4155
title: "why acorn's types cannot be inferred: 96.6% of `this.<field>` reads are `any` — 44.8% of fnctor slots because the checker truly has nothing (#743), 4.2% because #1712 discards a type it HAS"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-06
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
language_feature: objects, classes, compiler-internals
goal: performance
related: [4157, 3780, 3927, 3926, 3685, 3683, 2681, 1712, 743, 684, 4074]
origin: "2026-08-02 — asked to find why types cannot be inferred for acorn. They largely can be; the binary discards them."
oracle-ratchet-allow:
  # (+2 `ctx.checker.typeToString`, in the census module itself.) The census
  # reports WHAT THE CHECKER SAID for each field slot — "checker said TokenType,
  # emitted externref" — and `ctx.oracle` deliberately cannot express that: its
  # `TypeFact` union is registry-free and lossy about type NAMES by design
  # (`{ kind: "class"; name }` at best, `unresolvable` otherwise), so routing
  # through it would erase the exact distinction the census exists to draw — a
  # named `TokenType` vs a genuine `any`. Both calls sit behind the
  # `JS2WASM_FNCTOR_FIELD_PROVENANCE` gate and consume `ts.Type` values
  # `deriveFnctorFields` had already computed for its own lowering decision, so
  # the compile path is untouched when the census is off.
  - src/codegen/fnctor-field-provenance.ts
loc-budget-allow:
  # +3: one import and one two-line call in `deriveFnctorFields`, which is the
  # single place a fnctor field slot is chosen and therefore the only place the
  # census can observe. Everything else — the classifier, the record store, the
  # reporter, and the two `typeToString` calls — went into the new
  # `fnctor-field-provenance.ts` module rather than the god-file, per this
  # gate's own guidance.
  - src/codegen/fnctor-escape-gate.ts
  # +2 (Phase 1): one import, plus turning the `return { kind: "externref" }` at
  # the #1712 resolution site into `resolveFnctorInstanceType(...) ?? { kind:
  # "externref" }`. That site IS the single externref-ization point for fnctor
  # instance types, so the hook cannot live anywhere else; all of the decision
  # logic (flag, standalone check, gate-approval check, reserved-index lookup)
  # is in the new `fnctor-typed-instances.ts` module.
  - src/codegen/index.ts
  # Phase 2 wiring (2026-08-06): all decision + emission logic lives in the new
  # `fnctor-typed-reads.ts` module; the god-files get only the hook calls, and
  # the hooks can live nowhere else — the admission is on the receiver's
  # COMPILED ValType, so each call must sit at the exact point where the
  # dynamic path is about to erase that type to externref:
  # +11: `finalizeStructAndDynamicMemberGet`'s isExternObj arm (import + one
  # try-call between the receiver compile and `extern.convert_any`).
  - src/codegen/property-access-dispatch.ts
  # +9: `tryEmitPinnedStructMemberGet`, before `reserveMemberGetDispatch`
  # (import + one try-call).
  - src/codegen/property-access.ts
  # +20: `compilePropertyAssignmentExternSet` write twin (import + one guarded
  # try-call; the guard keeps `forceRuntimeSet`/runtime-eval routes dynamic).
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  # +1 line in `resolveWasmType` (354 > 353). Same two-line hook as the LOC
  # grant above: the #1712 `return { kind: "externref" }` becomes
  # `resolveFnctorInstanceType(...) ?? { kind: "externref" }`. `resolveWasmType`
  # IS the single type-resolution switch, so a resolution change necessarily
  # lands inside it; splitting the function is a separate refactor (#3399) and
  # doing it under a flag-gated behavior change would make both harder to
  # review. All decision logic lives in `fnctor-typed-instances.ts`.
  - src/codegen/index.ts::resolveWasmType
  # +10 (Phase 2): the read hook in the isExternObj arm — see the
  # `property-access-dispatch.ts` LOC grant above. The arm is inside this one
  # (already-oversized, #3399) function; splitting it is a separate refactor
  # that should not ride along with a flag-gated behavior change.
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
---

# #4155 — the type is known and thrown away

## Summary

Compiled acorn is 9.6x slower than native Node (#3780), and ~63% of that is
representation overhead. This issue answers *why the types cannot be inferred*,
with the measurements, and — as much to the point — records **three
cheap-looking fixes that were measured and do not work**, so the next session
does not spend a window rediscovering them.

Headline, from the census this issue ships (`JS2WASM_FNCTOR_FIELD_PROVENANCE=1`,
96 fnctor field slots in acorn):

| | slots | cause | lever |
| --- | ---: | --- | --- |
| `typed` | 49 (51.0%) | syntactic ctor-seed rule worked | — |
| `unknown` | 43 (44.8%) | checker genuinely has nothing | **#743** param inference |
| `discarded` | 4 (4.2%) | checker HAS a type; #1712 drops it | shape reconciliation |

So the dominant answer to "why can't types be inferred" is Cause B below —
untyped constructor parameters poison everything downstream, and only
whole-program call-site inference fixes it. The `discarded` bucket is small by
slot count but contains `Parser.type`, the tokenizer's hottest field at 141
reads, so it wins on read frequency, not on breadth.

## Measured chain

### 1. Inference IS running

`src/checker/language-service.ts:245` sets `allowJs: true, checkJs: true,
strict: true` for any `.js`/`.mjs` input. "We compile acorn as untyped JS and
never ask TS anything" is false.

### 2. But 96.6% of `this.<field>` reads come back `any`

Over acorn 8.16.0's 242 KB dist bundle, all 2,236 `this.<field>` reads:

| resolved type | count | share |
| --- | ---: | ---: |
| **`any`** | **2,161** | **96.6%** |
| null/undefined | 31 | 1.4% |
| number | 16 | 0.7% |
| object / boolean / string / union | 28 | 1.2% |

Two independent causes, split by receiver:

| receiver | reads | `any` fields |
| --- | ---: | ---: |
| `this` is `any` (alias-defined method) | 1,485 | 100% |
| `this` correctly typed | 751 | **90%** |

**Cause A — the prototype-alias pattern.** acorn's rollup output never writes
`Parser.prototype.m = …`; it aliases first (`var pp$9 = Parser.prototype;
pp$9.parseTopLevel = function(){…}`), 10 aliases, **257 alias-defined methods vs
13 direct**. TypeScript's checkJs recognizes the direct form and not the alias.
Positive control, three fixtures differing in one line:

| pattern | `this` | `this.pos` |
| --- | --- | --- |
| `P.prototype.next = function(){}` | `this` | **`number`** |
| `var pp = P.prototype; pp.next = …` | **`any`** | **`any`** |
| `class P { next(){} }` | `this` | **`number`** |

**Cause B — untyped entry points.** `function Parser(options, input, startPos)`
takes untyped params; with `noImplicitAny: false` they become `any`, and every
field seeded from one inherits it. This is why 90% of the *correctly-typed*
receiver's fields are still `any`.

### 3. js2wasm already compensates — twice — and it is not enough

- **Shape recovery.** `fnctor-escape-gate.ts` scans `this.x = …` syntactically
  and builds `__fnctor_<F>`, independent of TS. This is why acorn does not
  degrade to a pure hash-map object model.
- **Alias following is ALREADY IMPLEMENTED** (#2681) —
  `receiver-flow-analysis.ts:184` "Pass 1b: prototype ALIAS map",
  `fnctor-escape-gate.ts:560`, `context/types.ts:1109`. **Do not re-implement
  it.** The binary carries 236 `__closure_N__typed_this` twins against ~270
  methods, which is that machinery working.

Field *types* are still seeded from the constructor only
(`src/codegen/index.ts:7656`: "built from ctor `this.*` writes only"), and the
seed rule is visible in the binary — `$12` = `__fnctor_Parser`, 36 fields, field
order matching the constructor line for line:

| constructor line | slot |
| --- | --- |
| `this.options = getOptions(options)` | `externref` |
| `this.input = String(input)` | **`(ref null $0)`** native string |
| `this.containsEsc = false` | **`i32`** |
| `this.pos = … 0` | **`f64`** |
| `this.type = types$1.eof` | `externref` |
| `this.value = null` | `externref` |

A field keeps a machine type only when the ctor seeds it with a literal or a
known builtin call.

| fnctor | struct | fields | externref | i32 | f64 |
| --- | --- | ---: | ---: | ---: | ---: |
| Parser | `$12` | 36 | 17 (47%) | 4 | 11 |
| Node | `$13` | 130 | 63 (48%) | 63¹ | 2 |
| Token | `$17` | 9 | 4 (44%) | 2 | 2 |
| TokenType | `$25` | 11 | 5 (45%) | 6 | 0 |

¹ presence flags, not data — `Node` is ~97% boxed on its real fields.

### 4. The obvious next fix is worth 2 fields — MEASURED, do not attempt it

"Seed field types from all write sites, not just the ctor" looks like the lever.
Per-owner census over acorn (every `this.<f> = expr`, attributed to the fnctor
whose ctor or prototype/alias method encloses it):

| owner | fields | ctor-unresolved | rescuable |
| --- | ---: | ---: | ---: |
| Parser | 36 | 24 | **2** |
| Node | 6 | 4 | 0 |
| RegExpValidationState | 18 | 5 | 0 |
| TokenType | 10 | 4 | 0 |
| Token | 6 | 6 | 0 |
| others | 21 | 13 | 0 |
| **total** | **97** | **56** | **2 (4%)** |

A first cut of this census reported **25** rescuable. That number was an
artifact: the enclosing-function test only recognized `Parser`, so every other
class's *constructor* writes were counted as *method* writes. Once ownership is
correct the win collapses to 2. **Recorded because the wrong number is the
seductive one** — it says "36% of unresolved fields are rescuable by a cheap
syntactic pass," and it is false.

The reason it collapses: the method write sites are `any` too. The `any` is not
scattered where we failed to look; it is genuinely absent from the program,
because every value traces back to an untyped constructor parameter.

### 5. …and for the hottest fields the type was never missing

The Parser constructor's own seeds, per the checker:

```
this.options  = getOptions(options)   ::  { ecmaVersion: number; allowReserved: boolean; … }
this.input    = String(input)         ::  string
this.type     = types$1.eof           ::  TokenType
this.value    = null                  ::  null
this.context  = this.initialContext() ::  any
```

`this.type` — **141 reads, the tokenizer's hottest field** — resolves to
`TokenType`. `this.options` resolves to a full object shape. Both are
`externref` in the binary.

They are discarded on purpose. `src/codegen/index.ts:7654` (#1712):

> Function-style-constructor instance types resolve to EXTERNREF, never to a
> synthesized checker-shape struct. The runtime instance struct
> (`compileFnctorNew`, `__fnctor_<name>`) is built from ctor `this.*` writes
> only, while the checker's shape adds prototype-assigned methods as members —
> the two shapes have no subtype relation, so any value typed with the checker
> shape guard-casts to null and downstream `struct.get` / `ref.as_non_null`
> traps. […] resolving to the CTOR struct here instead was tried and regressed.

## Root cause

**There are two models of a fnctor instance and they do not agree.**

| | built from | contains |
| --- | --- | --- |
| runtime struct `__fnctor_F` | ctor `this.*` writes (syntactic) | data fields only |
| checker instance type | TS checkJs | data fields **+ prototype methods** |

No subtype relation, so a value typed with one cannot be cast to the other.
#1712 resolved the conflict by discarding the checker type — every fnctor
instance flows as `externref`, so every field read is `__extern_get` (a 14,035-line
function: 1,080 `if`s, 463 `ref.test`, 303 `__str_equals`, **zero `br_table`**)
and every use pays a cast.

That decision is *a* mechanism behind the numbers in #3780 (42,930
`ref.test`/`ref.cast`/`ref.is_null` and 24,288 representation conversions against
22,003 calls; 19.9% of instructions in the hottest compiled functions are casts
and conversions while real field access is 4.1%) — but the census below shows it
is **not the dominant one by slot count**, and this issue was drafted claiming
otherwise before the census existed.

### 6. What the shipped census actually measures — read this before scoping

`JS2WASM_FNCTOR_FIELD_PROVENANCE=1` over acorn, standalone lane, 96 field slots:

| verdict | slots | share |
| --- | ---: | ---: |
| `typed` — machine slot | 49 | 51.0% |
| **`discarded`** — boxed, checker named a real type | **4** | **4.2%** |
| `unknown` — boxed, checker had nothing | 43 | 44.8% |

The whole discarded bucket is: `Parser.type` (`TokenType`), `Parser.options`
(object shape), `Node.loc` and `Token.loc` (`SourceLocation`).

A first run reported **10** discarded. Six of those were bare `this.x = null`
seeds, which name a real type but say nothing about what the field will hold;
the classifier now counts them as `unknown`. **That was a 2.5x error in exactly
the number this issue prioritises by** — recorded because the inflated number is
the one that flatters the thesis.

**Consequence for scoping, stated plainly:** by slot count the dominant bucket
is `unknown` at 44.8%, which is Cause B — untyped constructor parameters — and
therefore **#743, not shape reconciliation**. Option (1) below is worth doing
because `Parser.type` is the tokenizer's hottest field at 141 reads, i.e. it
wins on read frequency rather than on slot count. Do not sell it as the fix for
the 9.6x; the census does not support that.

## Fix direction — reconcile the two models, do not re-pick a winner

#1712 chose one model over the other and that is why it is stuck. The options,
roughly in increasing order of ambition:

1. **Map the checker instance type ONTO the existing `__fnctor_F` struct**
   rather than synthesizing a shape from the checker. Methods live on the
   prototype `$Object`, not in the struct, so the data-field subset is what a
   value needs. The guard-cast then targets a type that actually exists at
   runtime.
2. **Include prototype-assigned methods in the struct's model** (as a prototype
   ref field, not per-method slots) so the two shapes become relatable by the
   existing prefix/subtyping rule (`$__vec_base`).
3. **#743 whole-program parameter inference from call sites.** The only thing
   that fixes Cause B, and the prerequisite for the 90%-of-typed-receiver
   residue. XL on its own.

(1) is the smallest change that could plausibly move the 9.6x and should be
priced first. **Whatever is attempted, the #1712 note says the naive version
regressed — reproduce that regression as a test before changing anything.**

## Implementation Plan

Option (1), standalone lane first, staged so every phase is independently
mergeable and the prior regression is a committed test before any behavior
moves.

### Load-bearing facts the plan builds on (verified in source)

- `compileFnctorNew` **already returns the struct ref** at the allocation
  site — `src/codegen/expressions/new-super.ts:1626`
  `return { kind: "ref", typeIdx: structTypeIdx }`. The instance is only
  boxed when it flows into a position whose type comes from `resolveTsType`,
  which is the single externref-ization point: `src/codegen/index.ts:7654-7688`.
  Nothing needs to change at the `new` site.
- Standalone **pre-reserves struct indices before compilation** —
  `ctx.fnctorReservedTypeIdx` (`new-super.ts:1469`), populated by the escape
  gate for every approved fnctor. So resolution can name the struct type
  *before* the first `new F()` compiles, which kills the JS-host-mode ordering
  problem (`funcConstructorMap` is populated lazily) for the standalone lane.
- The documented regression is in **member-call dispatch**, not typing:
  index.ts:7664 "the member-call static/dynamic split keys off this type, so
  only the always-dynamic externref resolution is safe." Methods live on the
  per-fnctor prototype `$Object` (#2660 S2, `context/types.ts:3369`), never in
  the struct — a struct-typed receiver must NOT flip method calls to the
  static path.

### Phase 0 — commit the regression as a test (no behavior change)

`tests/issue-4155-fnctor-shape-regression.test.ts`, both lanes:

- The exact #1712 shape: `Parser.prototype.parse = function () { return new
  Parser(...); }` — a prototype method returning a fresh instance, then
  `p.parse().field` and `p.parse().method()` at the call site.
- A fnctor instance stored to a field, passed as a param, and returned from a
  plain function, each followed by a member call (the guard-cast-to-null
  paths the #1712 note names).
- Assert **execution results**, not representation — these must pass before
  and after every later phase. This is the test `.tmp/dbg15.mts` G4/G5 never
  became.

### Phase 1 — resolve approved-standalone fnctor instance types to the reserved struct

At index.ts:7672-7688: for `approvedStandaloneFnctor`, return
`{ kind: "ref_null", typeIdx: ctx.fnctorReservedTypeIdx.get(sym.name) }`
instead of `{ kind: "externref" }`. JS-host / wasi keep externref (the host
MOP needs `$Object` identity; separate pricing later, if ever).

- `ref_null`, not `ref` — the checker type reaches positions (uninitialized
  locals, `null` seeds) where a non-nullable ref cannot be materialized.
- Behind `JS2WASM_FNCTOR_TYPED_INSTANCES=1` until Phase 2 lands green, so the
  flag flip is one line and A/B measurement is `env` only.
- `coerceType` already handles `ref_null → externref` (`extern.convert_any`);
  the reverse boundary (externref position → struct-typed position) is a
  guarded `any.convert_extern` + `ref.cast` **that now targets a type that
  exists at runtime** — the precise thing #1712's synthesized-shape cast got
  wrong.

### Phase 2 — member dispatch on a struct-typed receiver (where the old attempt died)

Split by *member kind*, defaulting dynamic:

- **Data fields present in `deriveFnctorFields`' list**
  (`fnctor-escape-gate.ts:1413`): direct `struct.get` / `struct.set`,
  honoring the #2847 presence flag when one exists. This is the payoff —
  today each of these reads is a `__extern_get` call (14,035 lines, linear
  scan).
- **Everything else** — prototype methods, fields not in the struct,
  computed names: box the receiver (`extern.convert_any`) and take the
  **existing** dynamic path (native dispatcher receiver arm + per-fnctor
  prototype `$Object`). Zero new dispatch machinery; the receiver arm for
  `__fnctor_<name>` already exists (index.ts:7667-7670).
- Touch points: `member-get-dispatch.ts`, `member-set-dispatch.ts`,
  `expressions/call-receiver-method.ts`. The rule that must survive review:
  **a member call is NEVER static off the struct type** — only data-field
  access is.

### Phase 3 — field slots retype themselves (the acceptance criterion)

No new code — a dependency to verify. Once Phase 1 lands,
`recordThisField`/`deriveFnctorFields` sees `this.type = types$1.eof ::
TokenType` resolve to `(ref null $__fnctor_TokenType)` instead of externref,
because slot typing goes through the same `resolveTsType`. Cross-fnctor
ordering is safe for the same reason Phase 1 is: all approved fnctors'
indices are reserved before any body compiles. Expected on acorn:
`Parser.type`, `Parser.options`, `Node.loc`, `Token.loc` — exactly the
census's `discarded` bucket → 0.

### Phase 4 — measure, then decide about the flag

- Census re-run: `discarded` 4 → 0, `unknown` unchanged (43 — that residue
  is #743's, not this issue's).
- `__extern_get` self-time vs the 5.6% #3780 baseline, same corpus and lane;
  per-parse `--trace-gc` delta.
- Standalone test262 in `merge_group` — the real gate; PR-level green is a
  designed no-op.
- Flag default flips on only with all of: Phase 0 tests green, no standalone
  regression, measured win reported in this issue.

### Risks

| risk | containment |
| --- | --- |
| the unrecorded G4/G5 regression had a second mechanism | Phase 0 fixtures cover field/param/return flow, not just the named shape; any trap after Phase 1 bisects to one phase |
| methods writing fields the ctor never seeds | not in the struct's field list → stays on the dynamic path by the Phase 2 default |
| `instanceof`, `Object.create(F.prototype)`, ctor identity | untouched: registration (`__register_fnctor_instance`) and `compileFnctorNewAsObject` keep operating on the boxed form at those sites |
| oracle-ratchet | resolution-site changes live in existing dispatch files; any new checker query routes through `ctx.oracle`, and slot typing reuses types already computed |

Sequencing: Phase 0 is its own small PR (pure tests, lands regardless).
Phases 1+2 land together behind the flag. Phases 3+4 are verification.
Overall XL per the frontmatter; Phase 0 alone is S.

## 2026-08-04 — Phases 0 and 1 implemented; two plan corrections

Both landed behind `JS2WASM_FNCTOR_TYPED_INSTANCES=1` (default OFF ⇒ the
compile path is byte-identical). What implementing them changed about the plan:

### Correction 1 — Phase 0 found three PRE-EXISTING bugs, and the cited shape is not one of them

The plan assumed the #1712 fixtures would be a green baseline to protect. They
are not. Of 10 standalone fixtures written against `main` @ `61ff9cc7a`, **3
fail today**, and the shape #1712 actually names **passes**:

| fixture | expected | main |
| --- | ---: | ---: |
| `F.prototype.m = function(){ return new F(…) }` + field read | 42 | 42 ✓ |
| …+ method call at the call site | 42 | 42 ✓ |
| instance in another fnctor's field, read via method | 42 | 42 ✓ |
| instance passed as a parameter | 42 | 42 ✓ |
| prototype-ALIAS definition (acorn's real shape) | 42 | 42 ✓ |
| **instance returned from a plain function, then member-called** | 42 | **0** |
| **instance round-tripped through an array element** | 42 | **0** |
| **field added by a method, never seeded in the ctor** | 42 | **NaN** |

All three are valid JS, all three are the #2660 S3 mechanism: an instance whose
`new F()` site the gate does not classify `reconstruct` keeps a bespoke struct
with **no `$proto`**, so dynamic reads miss the prototype walk and yield
0/undefined instead of trapping. The gate classifies from the *syntactic* uses
of the `new` expression, so an instance leaving through a return, a collection,
or a late-added field escapes its analysis entirely.

Committed as `it.fails` in `tests/issue-4155-fnctor-shape-regression.test.ts` —
they assert the bug still exists, so whoever fixes one gets a RED test telling
them to promote it. Two of the three (return position, collection round-trip)
are shapes acorn uses constantly, so **Phase 1 cannot be called done while they
are broken**.

### Correction 2 — the #1712 branch is nearly unreachable, and only field slots reach it

The plan (and this issue's own §5) implied the branch fires wherever a fnctor
instance flows. Measured, it does not:

- In **standalone** the branch is gated on `approvedStandaloneFnctor` — a
  gate-**approved** (`reconstruct`) fnctor. Non-approved (`keep-typed`) fnctors
  never enter it and **already** carry their closed struct.
- More decisive: it needs `resolveTsType` to be called **with the instance
  type**. For a *binding* it is called with the binding's declared type, which
  in acorn-shaped code is `any` — so the branch is skipped for essentially every
  local. Three separate fixtures confirmed byte-identical output with the flag
  on before one finally reached it.
- The position that **does** reach it is the one the census measured: a
  **field slot**, where `deriveFnctorFields` passes the RHS type directly. And
  it only carries a name under `.js` + `checkJs` (TS synthesizes an instance
  type from the ctor's `this.*` writes); the same fixture written in `.ts`
  reports `rhs:any` and is `unknown`, not `discarded`.

So "#1712 discards a type it HAS" is true, but its blast radius is **field slots
in checkJs sources**, not instance flow generally. That is consistent with the
census's 4/96 and further narrows it.

### What Phase 1 does, measured

On the acorn configuration (`.js` + `checkJs` + standalone):

```
flag off:  P.type = externref  [rhs: TokenType]     95,013 bytes
flag on:   P.type = ref_null   [rhs: TokenType]     95,054 bytes   ← reserved __fnctor_TokenType
```

Census `discarded` 1 → 0 on that fixture; execution unchanged. 54 tests across
the four `#2660` fnctor suites plus the Phase 0 suite pass **with the flag on**,
so the #1712 regression does **not** reproduce from the resolution change alone.
That is a real result but a bounded one: Phase 2 (member dispatch on a
struct-typed receiver) is where the note says it died, and Phase 2 is not
written yet.

### Measured on REAL acorn (2026-08-04), not a fixture

`tests/dogfood/acorn-standalone-compile.mjs`, standalone, flag off vs on:

| | flag off | flag on | delta |
| --- | ---: | ---: | ---: |
| binary | 943,140 B | **866,627 B** | **−76,513 (−8.1%)** |
| function imports | 0 | 0 | — |
| canaries (runtime/parseExprAt/tokenizer/fnBody) | 2,3,4,5 | 2,3,4,5 | — |
| census `typed` | 49 | **52** | +3 |
| census `discarded` | 4 | **1** | **−3** |
| census `unknown` | 43 | 43 | — |
| IR-path fallbacks | 3 | 3 | — |

- The three recovered slots are `Parser.type` (141 reads), `Node.loc`, `Token.loc`.
- The one that remains is `Parser.options`, and it is correctly **out of scope**:
  it is boxed by the #2937 object-hash-consumer path, not by #1712. So this
  lever is now **exhausted at the slot level** — there is no fifth slot to get.
- `unknown` did not move, confirming that bucket is #743's and not reachable
  from here.
- **The 3 IR-path fallbacks are PRE-EXISTING** (`parse`, `parseExpressionAt`,
  `tokenizer`, `typeIdx parity mismatch`) — they appear identically with the
  flag OFF. An earlier draft of this section attributed them to Phase 1 before
  the baseline run existed; it was wrong.
- **Loose end worth a look:** `tests/issue-1712-standalone.test.ts` asserts
  `report.errors` is `[]`, and this baseline run of the same script produced 3.
  Either the test is currently red on main or its invocation differs from a bare
  run. Not investigated here.

The −8.1% is a code-size result, not a speed result. It is consistent with
reads losing cast/dispatch scaffolding, but **no runtime measurement has been
taken** — `__extern_get` self-time vs the #3780 5.6% baseline is still Phase 4
and still unmeasured. Do not quote the 8.1% as a speedup.

### The prototype-alias bucket has NO headroom — verified at the instruction level

§2's "Cause A" reports that acorn defines 257 of 270 methods through a
prototype alias and that checkJs cannot follow it, which makes `this` — and so
100% of the 1,485 reads through it — `any`. That is true **of the TypeScript
checker** and has been repeatedly restated as if it were a live compiler cost.
It is not. Compiling the two forms and diffing the emitted twin proves it:

```wasm
;; IDENTICAL for `P.prototype.step = …` and `var pp = P.prototype; pp.step = …`
(func $__closure_0__typed_this (type 108)
  local.get 0
  struct.get 17 0      ;; this.pos — direct, unboxed, f64
  f64.const 1
  f64.add
  struct.set 17 0
  local.get 0
  struct.get 17 0
  return)
```

Whole-module: 93,179 B (direct) vs 93,188 B (alias), same twin count, same
dispatcher count, same result. #2681's alias map recovers the receiver
**completely**, and the twin reads its fields with a bare `struct.get` — there
is no cast, no dispatcher, and no `__extern_get` to remove.

**So do not open an issue to "fix prototype-alias inference."** The receiver is
already recovered. What remains boxed is not the receiver but *what the slot
holds*: a `struct.get` of an `externref` field is still a boxed read, and 43 of
96 acorn slots are `externref` because they are seeded from untyped constructor
parameters. That is #743, and it is the only bucket left with real size.

### The 43-slot `unknown` bucket cannot be shortcut — checked, do not try

The obvious cheap move on the remaining bucket is: when a field is seeded from
an untyped ctor parameter, infer that parameter's type from the module's own
`new F(...)` call sites (the escape gate already holds every site in
`sites: ReadonlyMap<ts.NewExpression, FnctorGateClass>`, so the data is right
there) and use it for the slot. It is a module-local #743 and looks tractable.

**It is unsound as stated.** Typing the *field* without typing the *parameter*
puts an `externref` param local into an `f64` slot, so every ctor store needs a
runtime unbox — cost moved, not removed, and a new failure mode when the value
is not actually a number. Typing the *parameter* instead changes the ctor's wasm
signature, which is ABI-affecting and has to agree with every call site.

That is not a new discovery: `src/checker/usage-inference.ts` already scopes
itself out of exactly this, in its header — parameters are *"ABI-affecting,
needs a call graph — deferred to #743"* — and it handles only function-local
identifier bindings for that reason. So the bucket is #743's by construction,
and a shortcut here would be re-litigating a decision the codebase already made
with the same evidence.

### Evidence supporting a default flip (gathered 2026-08-04)

| check | result |
| --- | --- |
| acorn standalone, flag on | 943,140 → 866,627 B (−8.1%), 0 imports, canaries 2,3,4,5 |
| acorn census | `discarded` 4 → 1, `unknown` 43 unchanged |
| 4 × `#2660` fnctor suites + Phase 0, flag on | 54 passed |
| 26 object/struct/class/prototype equivalence files, flag on | **140 passed, 0 failed** |
| full `tests/equivalence/`, either flag | OOMs in a 16 GB container — not a usable signal, do not re-attempt |

Not yet covered: standalone **test262**, which only runs in the `merge_group`
re-validation. That is the reason the flip should land as its own PR — if it
parks, attribution is unambiguous — and the reason
`JS2WASM_FNCTOR_TYPED_INSTANCES=0` must remain a one-variable revert.

### Revised next steps

1. **Phase 2** — member dispatch, data-fields-only static, everything else
   dynamic. Unchanged from the plan.
2. **Fix the three Phase 0 failures** — promoted ahead of Phase 3. They are
   independent of the flag (they fail with it off) and they block any honest
   claim that instance typing works.
3. **Phase 3/4 as written**, with the census's `discarded` bucket measured on
   real acorn rather than a fixture.

## 2026-08-06 — Phase 2 implemented (typed fnctor field reads), census-first

**Verdict: coverage is real but small (78 sites) and the A/B is a wash →
`JS2WASM_FNCTOR_TYPED_READS` stays OFF by default.** The lever is
representation-correct and fully wired/tested; it just does not move the acorn
benchmark, because the sites it converts are not where the time goes.

### What landed

`src/codegen/fnctor-typed-reads.ts` (written at the 90b26f5ef checkpoint) is
now wired at three call sites, all admission-after-receiver-compile, all
flag-gated, all census-instrumented independently of the flag
(`JS2WASM_FNCTOR_TYPED_READS_DEBUG=1`):

- read: `finalizeStructAndDynamicMemberGet`'s `isExternObj` arm
  (`property-access-dispatch.ts`), between the receiver compile and the
  `extern.convert_any` erase;
- read: `tryEmitPinnedStructMemberGet` (`property-access.ts`), before
  `reserveMemberGetDispatch`;
- write: `compilePropertyAssignmentExternSet` (`expressions/assignment.ts`),
  gated on `!forceRuntimeSet && !wrapRuntimeEvalCallable` so the
  accessor-descriptor and runtime-eval routes stay dynamic.

Flag-off byte-identity was asserted, not assumed: unoptimized standalone acorn
sha256 `e820698f…baa8` (1,578,609 B) identical between the wired tree
(flag off) and the unwired checkpoint.

### Census (standalone acorn 8.16.0, flag-independent)

74 candidate gets + 4 sets. Every one is a SECOND-HOP access through a
Phase-1-typed slot — the predecessor's hypothesis, confirmed:

| site | count | field slot |
| --- | --- | --- |
| get `TokenType.keyword` | 40 | externref |
| get `TokenType.binop` | 8 | externref |
| get `SourceLocation.start` | 8 | f64 |
| get `TokenType.isLoop`/`prefix`/`postfix`/`startsExpr` | 4 each | i32 |
| get `TokenType.isAssign` | 2 | i32 |
| set `RegExpValidationState.switchN` | 4 | i32 |

Declines are exclusively `nofield:__fnctor_Parser.*` (ctor-unseeded flags like
`inAsync`, `canAwait` — correctly refused; #743 territory). The counts are all
even (each site visited twice by the dual/speculative compile), so ~39 distinct
emission sites. First-hop receivers (`this.options.*`, 95 sites) remain
#2937-externref and never reach the hook — the receiver-representation story
from the checkpoint's WAT sampling stands.

### Why the reads reach the dynamic path at all (fixture recipe)

The checker cannot bind `this` in acorn's `var pp = Parser.prototype;
pp.m = function () { … this.type.keyword … }` idiom, so the read compiles down
the DYNAMIC member path — but codegen's typed-this twin still compiles the
receiver (`this.type`) to `(ref null $__fnctor_TokenType)`. That mismatch
(static any / compiled struct) is exactly what the fast path consumes.
`tests/issue-4155-phase2-typed-reads.test.ts` reproduces it in six behaviors:
fast-path read (WAT drops `__get_member_*`, mutation-checked against flag-off),
write twin (assignment evaluates to RHS), member call stays dynamic,
ctor-unseeded property stays dynamic, presence-tracked/conditional field still
answers undefined, null receiver still throws the catchable TypeError.

### A/B (`benchmark:acorn:standalone-dynamic`, 3 pairs back-to-back, same container)

| run | flag OFF ratio (std) | flag ON ratio (std) |
| --- | --- | --- |
| 1 | 0.1142 (±0.026) | 0.1107 (±0.023) |
| 2 | 0.1141 (±0.024) | 0.1185 (±0.041) |
| 3 | 0.1251 (±0.027) | 0.1175 (±0.014) |
| mean | **0.1178** | **0.1156** |

Statistically indistinguishable (mean delta −1.9%, per-run std ±12–35%).
Dogfood canaries flag-on: unchanged (2, 3, 4, 5), `functionImports: []`,
errors exactly the 3 pre-existing IR-FALLBACKs. Optimized binary 866,718 →
867,182 B (+464 B, +0.05%) — the per-site null guards, no dispatcher bodies
saved because other props still reserve them.

Suites flag-on, all green: the 4 × #2660 fnctor suites + Phase 0 shape
regression (54), `issue-4123` + 17 object/struct/proto/super/private
equivalence files (110), plus the 6 new Phase 2 tests.

### Default decision and the successor lever

Per this module's own rule — the default is set by measurement — a wash does
not justify ON: it buys no measured perf, costs +464 B, and adds
standalone-test262 exposure that only the `merge_group` can validate. The flag
stays available as a one-variable enable for future coverage growth.

The reason coverage is small is upstream of this hook: at most member sites the
receiver has ALREADY been erased to externref (locals, params, `this.options.*`)
before any read is compiled, so the admission — correctly — never sees a struct
type. The next lever is retyping those BINDINGS (#2660 S3b territory: locals /
params / return slots carrying `(ref null $__fnctor_F)` instead of externref),
which would multiply the sites this already-wired fast path converts. Phase 2's
hook then becomes the consumer that makes binding retype pay.

## 2026-08-06 — #2660 S3b binding retype implemented; the multiplier is real, the A/B is still a wash

**Verdict: candidate sites 78 → 424 (5.4x), suites green, and the
`standaloneDynamic` A/B is STILL statistically indistinguishable →
`JS2WASM_FNCTOR_TYPED_BINDINGS` (and the reads flag) stay OFF.** The
representation lever now covers the bindings; the remaining time is not in the
member-access ladders these convert.

### What landed (`src/codegen/fnctor-typed-bindings.ts`, branch `claude/issue-2660-s3b-typed-bindings`)

A function-local binding whose every write provably yields ONE gate-approved
fnctor's instance gets the reserved `(ref null $__fnctor_F)` slot instead of
externref. Admission (all sound-by-refusal, census under
`JS2WASM_FNCTOR_TYPED_BINDINGS_DEBUG=1`):

- Slice 1: direct `new F(...)` initializer, callee resolved by DECLARATION
  IDENTITY (shadows can't spoof), F approved + reserved, S3a
  empty-body-reconstruct sites carved out.
- Slice 2: `this.m(...)` initializer where `m` has a #3683 S1 WRITE-ONCE
  verdict on the enclosing prototype's fnctor and single-returns a direct
  `new F(...)`. The own-shadow half is NOT the global `otherNameWrites`
  sentinel (acorn trips it with `keywordTypes[name] = …`) but the
  closed-struct receiver argument #3683 S3 documents in typed-this.ts —
  standalone fnctor instances are closed structs with no expando sidecar, so
  a shadow can only be a declared field/accessor, rejected by name. Owners
  with empty ctor bodies ($Object-reppable) and class-extended owners refuse.
- Uses: linear dominance (same statement list, at-or-after the decl — admits
  loop/block bodies, declines sibling-branch/post-loop/catch/cross-clause
  reads, which would otherwise observe null instead of undefined once the
  hoisted seed is dropped), same-function only, every write same-F-proven;
  compound/destructuring/for-in-of/++/redecl/eval refuse. **Null reassignment
  refuses the retype** (test-pinned) — the slot stays externref, semantics
  untouched.

Consumers (the Phase 2 machinery, extended):

- presence-tracked EXTERNREF slots are now ADMITTED by the typed read
  (presence-bit test → slot : `undefined` — #3685's exact inline shape) and
  the typed write (`struct.set` + `presenceSetInstrs`); non-externref
  presence slots stay refused (`undefined` has no f64/i32 representation).
- the pinned member-SET path (`tryEmitPinnedStructMemberSet`) gets the same
  receiver-typed hook the pinned GET already had.
- the `name` reserved-prop refusal narrowed to require-declared-field: the
  blanket rule protects *Function*.name; an instance struct's declared `name`
  field (acorn `Identifier.name`, 32 sites) is an ordinary slot.

### Measured on real acorn (standalone, 2026-08-06)

| | flags off | flags on (bindings+reads) |
| --- | ---: | ---: |
| bindings retyped | 0 | **43** (all `Node`, all Slice-2 `this.startNode()`-shape) |
| Phase-2 sites | 78 (74 get + 4 set) | **424 (86 get + 338 set)** |
| optimized binary | 866,718 B | 891,749 B (+25,031, +2.9% — presence RMW inline) |
| canaries / imports / IR-fallbacks | 2,3,4,5 / [] / 3 | 2,3,4,5 / [] / 3 |

Remaining declines: `presence-nonextern:__fnctor_Node.loc` (f64-adjacent,
correctly refused) and `nofield:__fnctor_Parser.*` (#743 ctor-unseeded
flags). The `call-not-proven:*` census bucket (~50 bindings:
`parseExpression` etc.) is chain-returning methods whose single return is
another call — a depth-2 write-once fixpoint would be the next coverage
lever, but see the verdict below before building it.

### The decisive A/B (`benchmark:acorn:standalone-dynamic`, 3 back-to-back pairs)

| pair | flags ON ratio (std) | flags OFF ratio (std) |
| --- | --- | --- |
| 1 | 0.1184 (±0.017) | 0.1165 (±0.005) |
| 2 | 0.1133 (±0.009) | 0.1212 (±0.014) |
| 3 | 0.1185 (±0.014) | 0.1178 (±0.011) |
| mean | **0.1167** | **0.1185** |

Statistically indistinguishable (mean delta −1.5%, inside every per-run std;
differential workload `divergent: 0` both ways). **Converting 5.4x more sites
moved nothing** — consistent with the Phase 2 wash and with #3780's profile:
the converted sites are AST-node field writes whose VALUES stay boxed
externref either way; only the dispatch ladder is removed. The dominant costs
remain `__extern_get` on Parser's #743-territory fields, casts/conversions on
VALUES (not receivers), and string internals. Workstream 1's slot/receiver
levers are now BOTH implemented and BOTH measured null on this corpus — the
next speed lever is Workstream 2 (#3926 `__extern_get` dispatch, #3927
per-shape splitting) and #743 value typing, not more receiver coverage.

### Suites (flags on): all green

4 × #2660 fnctor suites + Phase 0 + Phase 2 + provenance (68), 33 targeted
object/struct/proto/super/private equivalence files (219 tests), new
`tests/issue-2660-s3b-typed-bindings.test.ts` (11: representation pins
mutation-checked, hook fire-count deltas, dynamic member call, null/foreign
reassignment refusal, externref-position boxing, dominance refusal,
presence round-trip, 3 Phase-0 shapes flag-invariant). The three Phase 0
`it.fails` are NOT promoted — their fnctors are gate-unapproved by
construction, so S3b correctly refuses them; they remain #2660-S3/#4155
correctness work.

## Scope

- [ ] Reproduce the #1712 regression as a committed failing test (the acorn
      `Parser.prototype.parse = function () { return new Parser(...) }` shape it
      names), so any fix is measured against a known break rather than a memory.
      → Implementation Plan Phase 0.
- [ ] Price option (1): map the checker's fnctor instance type to the registered
      `__fnctor_F` struct, keeping methods on the prototype `$Object`.
      → Implementation Plan Phases 1-2 (priced: standalone lane first, flag-gated).
- [x] Env-gated census of fnctor field-type provenance (house style of
      `alloc-census.ts` / `proven-receiver-stats.ts`) reporting, per field:
      checker type vs slot actually emitted. **Landed** as
      `src/codegen/fnctor-field-provenance.ts` +
      `tests/issue-4155-fnctor-field-provenance.test.ts`
      (`JS2WASM_FNCTOR_FIELD_PROVENANCE=1`); §6 is its output. Census only —
      asserted byte-identical binaries with the gate on and off.
- [ ] Re-measure the #3780 standalone runtime-dynamic lane and the per-parse
      `--trace-gc` delta.

## Acceptance criteria

- [ ] `__fnctor_Parser`'s `type` and `options` slots carry a type other than
      `externref`, or the issue records *measured* evidence that they cannot.
- [ ] The provenance census's `discarded` bucket for acorn drops from 4, and the
      `unknown` bucket (44.8%, the #743 territory) is reported alongside it so
      the two levers are never conflated again.
- [ ] `__extern_get` self time drops from its 5.6% baseline, reported against
      the #3780 profile with the same corpus and lane.
- [ ] The reproduced #1712 regression test passes.
- [ ] No standalone test262 regression.
- [ ] The negative results in §4 stay recorded — a future session must not
      re-derive the 25-field number and act on it.

## Dupe check

- **#3927** (per-shape fnctor splitting) — about the struct being the *union of
  all shapes*. This is about the struct's type being *discarded at the use
  site*. Splitting a struct nobody is typed with does not help. Complementary.
- **#3926** (`__extern_get` linear scan) — the symptom. Perfect-hashing the key
  makes the fallback cheaper; this removes uses of the fallback. Both worth
  doing, independently.
- **#3685 / #3683** (typed-`this` twins) — recover a typed receiver for the
  *method's own* `this`, which is why 236 twins exist. They do not change the
  type of a fnctor instance held in a variable, field, or parameter. Not a dupe.
- **#2681** — already implemented the prototype-alias resolution. Cited here so
  nobody re-implements it; §3 records that check.
- **#743 / #684** — the whole-program flow analysis this needs for Cause B.
  Option (3) is that work, not a duplicate of it.
- **#4074** — reads a shipped `.d.ts` as a declared shape partition. Orthogonal:
  it supplies shapes, this issue is about the shape being ignored.
