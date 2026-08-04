---
id: 4155
title: "why acorn's types cannot be inferred: 96.6% of `this.<field>` reads are `any` — 44.8% of fnctor slots because the checker truly has nothing (#743), 4.2% because #1712 discards a type it HAS"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
language_feature: objects, classes, compiler-internals
goal: performance
related: [3780, 3927, 3926, 3685, 3683, 2681, 1712, 743, 684, 4074]
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

## Scope

- [ ] Reproduce the #1712 regression as a committed failing test (the acorn
      `Parser.prototype.parse = function () { return new Parser(...) }` shape it
      names), so any fix is measured against a known break rather than a memory.
- [ ] Price option (1): map the checker's fnctor instance type to the registered
      `__fnctor_F` struct, keeping methods on the prototype `$Object`.
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
