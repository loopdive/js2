---
id: 4641
title: "value-rep: bare `return;` in a mixed-return function emits f64.const 0 instead of undefined — every `if (!x) return;` in every compiled program"
status: done
completed: 2026-08-23
assignee: dev-4641
sprint: current
created: 2026-08-23
updated: 2026-08-23
done_scope: "RETURN-slot half only, scalar carriers (f64/i32/i64), function DECLARATIONS. The array-ELEMENT half is DECLINED with a measured reason (one corpus row; the naive fix is +1/-2 observers) and the concrete-ref / local-slot / function-expression halves are pinned residuals. See the decision matrix and the Residuals table."
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: return-completion
goal: value-rep
related: [4640, 4489, 2142, 3580, 4491, 4647]
# (#4641) The widening decision lives at the ONE site that computes a function
# declaration's wasm result type (`collectDeclarations`), so the god-file grows
# by the call + its rationale (+9 LOC / +8 in the function). The mechanism and
# its measurements live in the new leaf module `mixed-return-widening.ts`, not
# here. Without the allowance this borrows #4491's grant, which mis-attributes
# the growth.
loc-budget-allow:
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
origin: "dev-4640 escalation (2026-08-23): pinned it.fails in tests/issue-4640.test.ts (statements/return/S12.9_A5). Filed against the value-rep lane per its recommendation."
---

# #4641 — bare `return;` renders 0 in mixed-return functions

## Problem (measured by dev-4640)

```js
function f(c) { if (c) return; return 5; }
f(true)   // → 0     spec: undefined
```

The function's inferred wasm return type is `f64`, so a bare `return;`
emits `f64.const 0`. This is not one test262 row — it is every
mixed-return function in every compiled program (`if (!x) return;` is
ubiquitous). Pinned `it.fails` at `statements/return/S12.9_A5` in
tests/issue-4640.test.ts.

## Extended family (wave-4 sweep, 2026-08-23, lead-measured on campaign HEAD)

The same representation gap — a numeric slot cannot carry
`undefined`/`null` distinctly — accounts for the largest remaining
`built-ins/Array/prototype` block (17 rows, all re-verified failing on
the campaign head by the lead's sweep):

- `concat/S15.4.4.4_A{1_T2,1_T4,2_T1,2_T2,3_T1,3_T2,3_T3}.js` — an
  `undefined` element crosses concat as `NaN`
  (`Expected SameValue(«NaN», «undefined»)`), and
  `Array.prototype.concat` read as a VALUE throws "not yet callable as a
  value" (A2 pair — reflective-carrier arm, may route to #4647's lane if
  it turns out provider-side).
- `toString/S15.4.4.2_A1_{T2,T4}.js` —
  `Array(undefined,1,null,3).toString()` renders `",1,0,3"`: the `null`
  element materializes as `0` in the f64 slot.
- `toLocaleString/S15.4.4.3_A{1_T1,3_T1}.js` — same, via toLocaleString.
- `filter/15.4.4.20-{5-7,9-b-2,9-b-14,9-b-15,9-b-16}.js`,
  `forEach/15.4.4.18-3-23.js` — callback/hole semantics on arrays whose
  elements were defined via descriptor MOP (verify live: these may
  belong to #4491's lane if the root is the descriptor mirror, not the
  element representation — decide by measurement, hand over whichever
  half is not yours).

The decision matrix below must therefore cover BOTH positions: function
RETURN slots and array ELEMENT slots. A fix that widens only returns
leaves the 17 rows; one that widens only elements leaves the pin.

## Implementation Plan (sketch — architect-level decision required)

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). This is a
   value-representation change with real perf and call-site blast radius:
   the honest fix widens a mixed-return function (some `return;`/fall-off
   + some `return <number>`) to an externref/anyref return carrying the
   #4489 tag-1 undefined singleton, with call sites unboxing.
2. FIRST measure the population: how many functions in the ES≤5 corpus
   (and the perf-benchmark suite) are mixed-return? The decision between
   (a) widen only mixed-return functions (a per-function signature
   decision, cache/ABI implications at call sites), (b) an f64 NaN-boxing
   sentinel for undefined (collides with real NaN semantics — likely
   unsound, measure why), or (c) decline + document, must be made on that
   measurement plus a perf A/B on the benchmark lanes (#1888 floor).
3. The corpus-instrument requirement applies in full (≥500-row stratified
   paired A/B) — this is the hottest ABI in the compiler.
4. Record the decision matrix in this file (#4506's format) BEFORE
   implementing.

---

# Decision matrix (dev-4641, 2026-08-23) — recorded BEFORE implementation

Every number below comes from a run **I executed** in
`/home/user/js2wasm/.claude/worktrees/agent-ae2e6afd3910ce2a4` on branch
`issue-4641`, base `52cb0a6a6` (campaign HEAD). Instruments live in `.tmp/`
(`census-mixed-return.mts`, `census-es5-syntactic.mts`, `census-elem.mts`,
`sweep.mts`) and are named per claim.

## M1 — how big is the mixed-return population, really?

`.tmp/census-mixed-return.mts` builds the compiler's OWN checker
(`analyzeSource`, `strict: true`) per file and classifies every function body by
the shape of its inferred return type. `mixed-scalar` = `T | undefined` where
`T` lowers to a wasm scalar — the #4641 defect. `mixed-ref` = `T | undefined`
where `T` is a reference (already carries `undefined` as `ref.null`).

| corpus                                                     | fn bodies | mixed-scalar | mixed-ref |
| ---------------------------------------------------------- | --------: | -----------: | --------: |
| `website/playground/examples` + `benchmarks/suites` (17 files) |       109 |        **0** |         0 |
| moment + marked(umd) + redux(legacy-esm)                   |       562 |        **0** |        24 |
| lodash 4 (`lodash.js`)                                     |       692 |        **2** |         2 |
| **total real-world**                                       | **1,363** |    **2 (0.15 %)** | **26 (1.9 %)** |

Both lodash hits are `false | undefined` / `true | undefined` — an **i32**
carrier, not f64.

**Correction to my own first reading of this table (measured 2026-08-23, after
the census).** I initially wrote off `mixed-ref` as "already correct — a
reference carrier holds `undefined` as `ref.null`". That is true for
**`externref`** and false for a **concrete `ref`/`ref_null`**. Measured with
`.tmp/probes/ref-mixed-return*.js` (a `string | undefined` return, which
`resolveWasmType` lowers to `ref_null $AnyString` in the native-string lane):

| carrier                 | `typeof`      | `String(v)`   | `v === undefined` | `v === null` | `v + 1` |
| ----------------------- | ------------- | ------------- | ----------------- | ------------ | ------- |
| externref (canonical `undefined`, `.tmp/probes/undef-extern-obs.js`) | `"undefined"` | `"undefined"` | true ✓ | false ✓ | NaN ✓ |
| `ref_null $AnyString` (`ref.null` for a bare `return;`) | `"object"` ✗ | `"null"` ✗ | true ✓ | — | — |
| f64 `UNDEF_F64_BITS` read out of a BRANDED slot (`.tmp/probes/undef-obs.js`) | `"undefined"` ✓ | `"NaN"` ✗ | true ✓ | false ✓ | NaN ✓ |

So the real-world population that answers WRONGLY is **26 + 2 of 1,363
(2.1 %)**, not 2 — the concrete-ref carriers say `null` where the spec says
`undefined`. That half is recorded as a residual with its own pin rather than
folded in here: widening a `ref_null $AnyString` result changes the ABI of
string-returning functions, which is a materially different perf question from
the scalar one and deserves its own census.

The third row is also the measurement that decides **(a) vs (b)**: the f64
sentinel gets four of five observers right — but only when read out of a slot
that carries the `undefSentinel` BRAND (`vec-access-exports.ts`). A raw
`f64.const <sentinel>` returned from a function has no brand, so its `typeof`
answers `"number"` and its `any`-box is a NaN NUMBER (`type-coercion.ts`
#3315). Getting the brand into a function SIGNATURE means adding it to
`funcTypeKey` (the #2795/#2846 precedent for branded i32/i64), which SPLITS the
wasm func type — so a mixed-return function passed as a callback would carry a
different type index than a plain `f64`-returning one, and the two would no
longer be interchangeable at a `call_ref`. The externref carrier needs none of
that and is right on all five.

`.tmp/census-es5-syntactic.mts` scans the test262 corpus syntactically (parse
only, no checker) for the *shape*: a function body with a value-returning
`return <expr>` **and** a bare `return;` or a fall-off-the-end.

| corpus                                       | fn bodies | bare-return mixed | fall-off mixed | files |
| --------------------------------------------- | --------: | ----------------: | -------------: | ----: |
| test262 files carrying `es5id:` (8,115 files) |     5,825 |             **1** |         **66** |    60 |
| all of `language` + `built-ins` + `annexB`    |    75,817 |            **37** |        **264** |   287 |

**Consequence for the decision.** The issue's framing — "every `if (!x) return;`
in every compiled program" — is not what the corpus says. The *syntactic* shape
is 0.4 % of test262 function bodies and 1.2 % of the ES5 subset; the shape that
actually reaches a **scalar** wasm return slot is 0.15 % of real-world function
bodies and **zero** in the perf-benchmark corpus. That is the single most
important input here: **the return ABI is the hottest in the compiler, but the
mixed-return SUBSET of it is empty on every lane we benchmark**, so a
per-function widening cannot move the benchmark lanes at all — it emits
different bytes for zero functions there.

The corollary cuts the other way too: the fix's *reach* is small. It is worth
doing because it removes a wrong ANSWER (`0` where the spec says `undefined`),
not because it moves a large row count.

## M2 — the array-ELEMENT half is one row, not seventeen

`.tmp/census-elem.mts`, same ES5 corpus, over every array-construction site
(`[...]`, `Array(...)`, `new Array(...)` with ≥2 args):

| site shape (numeric literal + …)  | count (of 1,031 sites) |
| ---------------------------------- | ---------------------: |
| … `null` / `undefined`             |                  **1** |
| … an elision `[0, , 2]`            |                     17 |
| … an object / string / boolean     |                      1 |

The single `numeric + nullish` site is `built-ins/Array/prototype/toString/
S15.4.4.2_A1_T2.js` — the failing row itself. The 17 elision sites are the
`$Hole`/`HOLE_F64_BITS` family that **#4491 T8/T11 already shipped**.

I then ran the 17 named rows individually (`.tmp/base-17.json`, 0/17 pass) and
read each error. They do **not** share one root:

| row(s)                                                   | measured error                                                                     | actual root                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `toString/S15.4.4.2_A1_T2`                               | `",1,0,3"` — the `null` element renders `0`                                        | **element rep** (nullish in an f64 vec slot); the only true one       |
| `concat/S15.4.4.4_A1_T2`                                 | `arr[1]` = `NaN`, expected the object `y`                                          | heterogeneous concat into an f64 result vec                           |
| `concat/S15.4.4.4_A1_T4`                                 | `arr[0]` = `NaN`, expected `undefined`                                             | hole marker not resurrected at the `any` box (#3315 note)             |
| `concat/S15.4.4.4_A3_T1,A3_T2,A3_T3`                     | `NaN` where `1` / `undefined` expected                                             | **`Array.prototype[N] = v` inherited index**, not element rep         |
| `concat/S15.4.4.4_A2_T1,A2_T2`                           | `Array.prototype.concat is not yet callable as a value in --target standalone`     | **#4647** reflective-carrier lane                                     |
| `filter/15.4.4.20-9-b-2,-14,-15,-16`                     | `Cannot redefine property: configurable attribute…` / length+element drift          | **#4491** descriptor MOP (`Object.defineProperty(arr,"0",{get})`)     |
| `filter/15.4.4.20-5-7`                                   | `RuntimeError: dereferencing a null pointer in __module_init()`                     | `eval` passed as `thisArg` — **runtime-eval lane**, a CRASH not a value |
| `forEach/15.4.4.18-3-23`                                 | `testResult !== true`                                                              | `length` is an OBJECT needing ToPrimitive — **not** element rep       |
| `toLocaleString/S15.4.4.3_A3_T1`                         | `Array.prototype[1] = obj` seen 2× not 3×                                          | inherited index again                                                 |
| `toLocaleString/S15.4.4.3_A1_T1`, `toString/…_A1_T4`     | callback count / expected throw                                                    | element rep + ToPrimitive, mixed                                      |

Ownership evidence I measured rather than inferred (probes in `.tmp/probes/`,
run through `runTest262File` standalone):

- `foreach-generic.js` — `Array.prototype.forEach.call({1:11,2:9,length:3}, cb)`
  **PASSES**. So `forEach/15.4.4.18-3-23` fails specifically because its
  `length` is an object with a `valueOf`, not because `forEach` is generic and
  not because of element representation. → hand to the ToPrimitive/`length`
  owner, not this lane.
- `het-elem.js` / `het2.js` — `var arr=[0,1,2,"last"]` then `arr[2]`:
  `typeof` is **`"string"`**, `String(arr[2])` is **`"[object Object]"`**,
  `arr[2] === 2` is **false**. A heterogeneous-primitive-union array element is
  boxed tag-5 and never recovered — the #1888 / #2141-S4 tag-5 lie. This alone
  fails `filter/15.4.4.20-9-b-*` **before** any descriptor is involved
  (`filter-plain.js`, no `defineProperty` at all, fails identically). So the
  filter rows are **not** cleanly #4491's either; they sit behind a bigger
  value-rep wall. → recorded as a residual for the #2141-S4 honest-boxing flip.

**Consequence for the decision.** "Fix the 17 array rows" is not an available
option: 16 of them are other lanes' roots, and the one that is genuinely
element representation needs `null` to become distinguishable from `0` in an
f64 vec — a THIRD sNaN payload alongside `UNDEF_F64_BITS`/`HOLE_F64_BITS`, with
its own `=== null` / `typeof === "object"` observer set. That is a
#4491-T8-sized slice of its own, for one row.

## M3 — the mechanisms that already exist (this is what makes option (b) not a strawman)

The issue sketch asks to "measure why an f64 NaN-boxing sentinel is unsound".
It is **not** unsound, and it is **not** hypothetical:

- `src/codegen/value-tags.ts` already defines `UNDEF_F64_BITS =
  0x7FF00000DEADC0DE` (a SIGNALING NaN; JS arithmetic only ever produces the
  QUIET `0x7FF8000000000000`) and `HOLE_F64_BITS` (#4491 T11).
- `ValType` already carries an inert `{ kind:"f64"; undefSentinel?: true }`
  brand (`src/ir/types.ts:251`), consulted at the box site.
- `binary-ops.ts:790` already answers `<f64> === undefined` by comparing the
  sentinel bits (#3369) — **brand-blind**, so it fires for any f64.

So (b) is cheap and partially free. What it does **not** buy, measured against
the code: `typeof` still answers `"number"`, ToString still renders `"NaN"`,
and the generic f64→externref box deliberately refuses to resurrect the
sentinel (`type-coercion.ts` #3315: `Math.abs` preserves the sNaN payload, so
an arbitrary f64 carrying those bits is a computed NaN, not `undefined`).

## M4 — there is already an authoritative decision for this exact question

**#2142 (`status: done`, 2026-06-15) — "Decision (authoritative — arch1)":**

> Widen to externref + host `undefined` when the value must be observable to
> the general nullish/identity/stringify consumer set (`===`, `!==`, `typeof`,
> ToString, `??`). Use the sNaN sentinel ONLY inside the hot f64 carriers whose
> sole consumer is `emitDefaultValueCheck`.

A function's return value is squarely in the first set. One fact in #2142 has
drifted since it was written — it says "`=== undefined` on an f64 is
unconditionally `false`", which #3369 later fixed — but the rule's *reason*
(typeof / ToString / the box site still cannot see the sentinel) still holds,
and I re-verified all three in the tree today.

**#3580 S3 is literally "`number | undefined` → externref"** (`status: ready`,
`sprint: current`, fable/value-rep-substrate lane). #4641's return half is the
**return-slot-scoped instance** of that general slice. This matrix does NOT
take #3580's general `resolveWasmType` change — that one is atomic and has a
recorded floor-breach history (PR #2025, NET −1245 rows, auto-parked).

## The matrix

| # | option | reach | perf blast radius | correctness risk | verdict |
|---|--------|-------|-------------------|------------------|---------|
| **(a)** | Widen mixed-return signatures to a carrier that can hold `undefined` (externref), call sites unbox | the whole `T\|undefined` return family, all observers (`===`, `typeof`, ToString, `??`) at once | **measured zero on the benchmark lanes** — 0 mixed-scalar functions in `website/playground/examples` + `benchmarks/suites`; 2/1,363 real-world, both i32 | changes a function's ABI ⇒ call sites, tail calls, closure/funcref types. Bounded by making the condition narrow (only a union that CONTAINS `undefined`), so a function whose type does not say `undefined` emits byte-identical code | **ADOPTED for the return half, scoped to function DECLARATIONS** |
| (b) | f64 sNaN sentinel (`UNDEF_F64_BITS`) at the two default-value emit sites | `=== undefined` / `== null` only (brand-blind arm already exists) | zero — one constant changes | leaves `typeof` = `"number"`, ToString = `"NaN"`, and the `any` box = a NaN NUMBER. #2142 rejects it for observable slots for exactly this reason. Also **cannot** serve i32 (`boolean\|undefined`) at all | rejected as the primary; **not** unsound, just insufficient |
| (c) | targeted: element-level rep for arrays holding `undefined`/`null` + return widening only where observed | 1 array row + the return family | n/a | the array half needs a third sNaN payload for `null` with its own observer set (`=== null`, `typeof === "object"`) — a #4491-T8-sized slice for ONE corpus row | **element half DEFERRED**, return half taken (that is what (a) scoped is) |
| (d) | decline + document | 0 | 0 | leaves a wrong ANSWER (`0` for `undefined`) in the most ordinary control-flow shape in JS | rejected — the fix is small and the population census shows it is free |

### Adopted scope (what this branch does)

Widen the **wasm result type of a top-level `function` DECLARATION** to
`externref` when, and only when, the checker's return type is a **union that
contains `undefined`/`void`** and the non-nullish part would otherwise lower to
a wasm **scalar** (`f64`/`i32`/`i64`). Nothing else changes:

- Explicitly annotated returns (`function f(): number`) are untouched — TS
  rejects a bare `return;` there, so the union never forms.
- `T | null` already widens (`isNullablePrimitiveType`, #1769/#3666); this is
  the `| undefined` twin at the return position only.
- A union whose non-nullish part is already a REFERENCE keeps its
  `ref_null`/externref carrier — those already answer `undefined` correctly.
- `inferNumericReturnTypes` (#1121) is unaffected: it already drops any
  candidate with a bare return (`sawBareReturn`) and only fires on an
  implicit-**any** return, never on a union.
- Both default-value emit sites already do the right thing for an externref
  return type (`emitUndefined`), so the body needs no new arm:
  `statements/control-flow.ts` (bare `return;`) and `function-body.ts`
  (fall-off-the-end).

### Explicitly NOT in this branch (with owners)

0. **Concrete-`ref` carriers** (`string | undefined` → `ref_null $AnyString`,
   `{…} | undefined` → `ref_null $__anon_N`). Measured wrong (`typeof` =
   `"object"`, `String()` = `"null"`), and 26/1,363 of the real-world census —
   the larger half by count. Held back because widening a string-returning
   signature is a different perf question; pinned as a residual.
1. **Function EXPRESSIONS / arrows / methods / closures.** Their signatures are
   computed on a different path (`closures.ts`,
   `resolveWasmTypeForClosureReturn`). Recorded as a residual with a measured
   pin, not silently skipped.
2. **The array-ELEMENT half.** One corpus row; needs a `NULL_F64_BITS` payload.
   → new slice for the value-rep lane, sized from M2.
3. **Heterogeneous-array element tag-5 lie** (`typeof [0,1,2,"last"][2] ===
   "string"`). Pre-existing, larger than #4641, blocks the `filter/*` rows.
   → #1888 / #2141-S4 honest-boxing flip.
4. **#4647 rows** (`Array.prototype.concat` as a value) and the
   `Array.prototype[N] = v` inherited-index rows → their own lanes.

### Why the array half is not simply "give `null` the sNaN treatment"

Worth writing down, because it looks like a two-line change. Making a `null`
element materialize as `UNDEF_F64_BITS` instead of `f64.const 0` would fix
`toString/S15.4.4.2_A1_T2` — `join` §23.1.3.18 step 4.b renders `undefined` and
`null` identically as `""`. It would also make three other observers WORSE, and
one of them is currently RIGHT BY ACCIDENT:

| observer          | spec for a `null` element | today (`f64.const 0`) | with the UNDEF payload |
| ----------------- | ------------------------- | --------------------- | ---------------------- |
| `join` / ToString | `""`                      | `"0"` ✗               | `""` ✓                 |
| `x[i] === null`   | true                      | false ✗               | false ✗                |
| `x[i] === undefined` | false                  | false ✓               | **true ✗**             |
| `ToNumber(x[i])`  | `0`                       | `0` ✓                 | **NaN ✗**              |

Net: +1 / −2. The principled version needs a THIRD distinct signaling-NaN
payload (`NULL_F64_BITS`, the sibling of `UNDEF_F64_BITS`/`HOLE_F64_BITS`) plus
its own `=== null` / `typeof === "object"` / ToNumber observers — the same
shape and size as #4491 T8/T11, for **one** corpus row (M2). Declining is a
measurement, not a shrug.

---

## Root cause

Two independent facts compose:

1. **`resolveWasmType`'s union arm strips the nullish member.**
   `src/codegen/index.ts` — for a 2-member union with exactly one non-nullish
   part, it returns that part's carrier. `5 | undefined` therefore lowers to
   `f64`, `true | undefined` to `i32`. (`T | null` does NOT take this path:
   `isNullablePrimitiveType` widens it to externref, #1769/#3666. The
   `| undefined` twin was deliberately left out of that arm — see its comment —
   because widening it there also changes struct-field layouts.)
2. **Both "no value" emit sites push the carrier's ZERO.**
   - `src/codegen/statements/control-flow.ts`, `compileReturnStatement`, the
     `else if (fctx.returnType)` arm: a syntactic bare `return;` pushes
     `f64.const 0` / `i32.const 0` / `i64.const 0`.
   - `src/codegen/function-body.ts`, the end-of-body tail: a fall-off-the-end
     does the same.

   Both arms ALREADY do the right thing for an `externref` return type — they
   call `emitUndefined`, which pushes the canonical standalone `undefined`
   (the #2106 S1 tag-1 `$undefined` singleton, or the host `__get_undefined`).

So the defect is not in either emit site. It is that the SIGNATURE never gives
them an `undefined`-capable carrier to work with.

`inferNumericReturnTypes` (#1121) is not involved: it only fires on an
implicit-**any** return and already drops any candidate with `sawBareReturn`.

## Fix

`src/codegen/mixed-return-widening.ts` (new leaf module, ~30 LOC of code and
the rest rationale) + one call in `collectDeclarations`
(`src/codegen/declarations.ts`), at the single site that computes a function
declaration's wasm result type:

```ts
widenMixedUndefinedReturn(rUnwrapped, resolveWasmType(ctx, rUnwrapped))
```

`widenMixedUndefinedReturn` returns its second argument UNCHANGED unless BOTH:
the already-resolved carrier is a wasm scalar (`f64`/`i32`/`i64`), AND the
checker's return type is a **union containing `undefined`/`void`**. In that one
case it returns `{ kind: "externref" }`.

Everything else follows without another line of codegen:

- `function-body.ts` reads the registered signature first
  (`ctx.mod.types[func.typeIdx].results[0]`), so the body agrees automatically.
- Both default-value emit sites take their existing `externref` arm.
- `compileReturnStatement`'s value path coerces `f64 → externref` through the
  ordinary `coerceType`, i.e. `__box_number`.
- Call sites read the same signature, so they see externref and unbox on use.
- `funcTypeKey` distinguishes `externref` from `f64` by KIND, so no
  brand-splitting of wasm func types (the hazard that ruled option (b) out).

Emitted WAT for the issue's own repro, before → after:

```wat
(func $f (param i32) (result f64)          (func $f (param i32) (result externref)
  local.get 0                                local.get 0
  (if (then f64.const 0  return))            (if (then global.get $undefined
  f64.const 5                                          extern.convert_any  return))
  return)                                    f64.const 5
                                             return_call $__box_number)
```

Deliberately NOT done: the general `resolveWasmType` union-collapse reversal.
That is **#3580 S3**, it reaches locals/params/fields as well, and its partial
landings have a recorded standalone-floor breach (PR #2025, NET −1245 test262
rows, auto-parked). Confining the change to the return position is what keeps
this measurable.

## Measured residual found while sweeping (NOT #4641 — routed by the lead to wave-5, related #4645)

Two rows in the mixed-return population are pathologically slow to COMPILE, on
**both** arms, and the cost is superlinear in one array index:

| source                                                | compile+run, base | compile+run, with #4641 |
| ------------------------------------------------------ | ----------------- | ----------------------- |
| `arr = [0,1,true,null,new Object(),"five"]; arr[99] = -6.6; arr.every(cb)`     | —                 | **9.1 s** (pass)        |
| same with `arr[999999] = -6.6`                        | **> 700 s** (SIGTERM) | **> 600 s** (SIGTERM)   |

Rows: `built-ins/Array/prototype/every/15.4.4.16-7-c-ii-2.js`,
`built-ins/Array/prototype/some/15.4.4.17-7-c-ii-2.js`. Probes:
`.tmp/probes/every-sparse.js` (1e6) and `.tmp/probes/every-sparse-small.js`
(1e2), same file otherwise. Both arms measured by me; the base arm was run with
`src/codegen/declarations.ts` reverted from `.tmp/base-declarations.ts`.

Per the lead's ruling these must **not** go into `HANGING_TESTS` — CI already
counts them as `compile_timeout` FAILURES, and skipping would freeze two
fixable failures out of the conformance denominator. They are excluded from
**my** population sweep only (285 of 287 files), which is stated wherever that
number appears.

**A correction to the obvious mitigation:** capping the `timeoutMs` argument of
`runTest262File` does NOT bound this. That argument is applied **post hoc** —
`tests/test262-runner.ts` does `await compile(...)` with no cancellation and
only afterwards checks `if (compileMs > 30_000)`. A 600-second compile still
runs for 600 seconds and only then reports `compilation timeout`. The only
effective cap is an OS-level one on the driver process (`timeout N npx tsx …`),
which is what my chunked sweep uses.

## Test Results

All runs below were executed by me in
`/home/user/js2wasm/.claude/worktrees/agent-ae2e6afd3910ce2a4`, branch
`issue-4641`, base `52cb0a6a6`. Every base ("before") number comes from a run
with `src/codegen/declarations.ts` restored from `.tmp/base-declarations.ts` —
captured at the FIRST edit, so each base arm is one `cp` away and none of these
figures is inherited from an artifact.

**Eval-provider note.** All four sweep arms logged the SAME quickjs adapter key
`1429ec7ecf2163fd`, so the lead's 2026-08-23 stale-adapter finding cannot have
skewed any delta here. The population census touches no provider at all (it
only runs `ts.createSourceFile` / `analyzeSource`).

### 1. Scoped standalone sweep — the issue's named directories (576 rows)

`.tmp/sweep-all.sh` → `.tmp/base.jsonl` vs `.tmp/after.jsonl`,
diffed with `.tmp/diff.mjs`:

```
  23 ->   23 / 69    built-ins/Array/prototype/concat
 198 ->  198 / 242   built-ins/Array/prototype/filter
 144 ->  144 / 190   built-ins/Array/prototype/forEach
   8 ->    8 / 23    built-ins/Array/prototype/join
   4 ->    4 / 12    built-ins/Array/prototype/toLocaleString
   7 ->    7 / 11    built-ins/Array/prototype/toString
  15 ->   16 / 16    language/statements/return
   4 ->    4 / 5     language/types/boolean
   7 ->    7 / 8     language/types/undefined
TOTAL 410 -> 411 / 576   net +1
GAINED (1): language/statements/return/S12.9_A5.js
LOST   (0):
```

**Read this honestly: the Array directories are NOT where the change fires.**
The census (M2) says exactly one array-construction site in the whole ES5
corpus mixes numerics with a nullish, and the return-slot fix touches none of
them — so "0 regressions here" is weak evidence on its own. That is why §3
below sweeps the population where the change DOES fire.

### 2. Host (gc) lane — same three language directories (29 rows)

`.tmp/base-host.jsonl` vs `.tmp/after-host.jsonl` (4th argument OMITTED, per
the campaign brief):

```
  15 ->   16 / 16    language/statements/return
   4 ->    4 / 5     language/types/boolean
   7 ->    7 / 8     language/types/undefined
TOTAL 26 -> 27 / 29   net +1
GAINED (1): language/statements/return/S12.9_A5.js
LOST   (0):
```

Same single flip in both lanes, which is what a signature-level change should
look like: the host lane already had a real `__get_undefined`, it just was
never given an `undefined`-capable return slot to put it in.

### 3. Population sweep — every test262 file that CONTAINS a mixed-return function (285 rows)

This is the regression evidence that matters, because §1's directories barely
exercise the change. The file list is the census output itself
(`.tmp/mixed-return-files.txt`, 287 files across `language` + `built-ins` +
`annexB` whose parse shows a function body with BOTH a valued `return <expr>`
and a bare `return;` or a fall-off), minus the 2 pathological 1e6-sparse-grow
rows documented above → **285 files**. `.tmp/mr-base.jsonl` vs
`.tmp/mr-after.jsonl`, both run by me, base arm with `declarations.ts` reverted.

```
TOTAL 199 -> 200 / 285   net +1
GAINED (1): language/statements/return/S12.9_A5.js
LOST   (0):
```

Per-directory the sweep spans 73 directories including the ones most exposed to
a return-ABI change — `Array/prototype/{every,some,map,filter,reduce,
reduceRight}` (the HOF callback path, where a widened callback signature would
show up as a `call_ref` type mismatch), `language/statements/{function,try,
for,for-in,switch,block}`, `language/expressions/{call,conditional,coalesce,
logical-and,logical-or,tagged-template}`, all 20 `language/statements/with`
rows, and the async/generator families. **Every one of them is unchanged.**

That is the answer to the "hottest ABI in the compiler" concern stated in the
issue's plan: the widening is invisible to 284 of 285 files that contain the
very shape it rewrites, and flips the one row that was wrong.

### 4. `tests/issue-4641.test.ts` — 13 passed (13)

Each fix pin was verified to FAIL with the change reverted, not merely asserted:

| pin                                          | base (reverted)                     | with fix |
| --------------------------------------------- | ----------------------------------- | -------- |
| `language/statements/return/S12.9_A5.js`      | `myfunc3() ===0`                    | pass     |
| `bare-return-value-identity`                  | `"0,10,0,30,"`                      | pass     |
| `bare-return-typeof`                          | `"number,number,"`                  | pass     |
| `bare-return-tostring`                        | `"0,10,"`                           | pass     |
| `bare-return-boolean-carrier` (i32)           | `"false,true,"`                     | pass     |
| `fall-off-value-identity`                     | `"0,10,0,30,"`                      | pass     |
| `mixed-return-arithmetic`                     | `nan === 0`, expected 2             | pass     |
| `unconditional-numeric-return-unchanged`      | pass (control)                      | pass     |
| `every-path-returns-a-value-unchanged`        | pass (control)                      | pass     |

The base run of the whole file was **6 failed | 5 passed (11)** — the 6 being
exactly the fix pins, the 5 being the 2 controls plus the 3 `it.fails`
residuals. After the fix: **13 passed (13)**.

Two pins were REWRITTEN mid-flight, and the reason is itself a result: the
first draft observed through `var v = pick(i)`, which still fails WITH the fix
because a `number | undefined` LOCAL collapses to `f64` and unboxes the widened
result to a plain NaN. The call now sits in the observation position, and the
local-slot collapse is pinned separately as a residual (#3580 S3/S4).

### 5. `tests/issue-4640.test.ts` + `tests/issue-4638.test.ts` (+ 4641)

Final combined run: **`Test Files 3 passed (3)` / `Tests 50 passed (50)`** —
the COUNT, not the exit code (a `describe.skipIf` gate can skip a whole suite
green).

Before the pin flip: **1 failed | 35 passed (36)** — the one failure being
`Expect test to fail` on #4640's `it.fails` for `S12.9_A5`, i.e. the row this
branch fixes. That `it.fails` is now a passing `pinRow` in its own describe
block, with the comment explaining why `S8.1_A2_T2` stays a residual (it reads
the same family through a LOCAL slot, which is #3580, not #4641).

### 6. `tests/equivalence/` — per-file loop, 18 files

`.tmp/equiv-run.sh` (one vitest invocation per file — the directory OOMs in
this container). Selection: every equivalence file containing a syntactic bare
`return;` (7) plus the function/return/closure/hoisting core (11).

16 of 18 files fully green. The two that fail, fail **identically on base**
(measured: `3 failed | 9 passed (12)` on both arms) and for reasons that cannot
involve a wasm result type:

- `new-non-constructor.test.ts` — one test reads a hard-coded
  `/workspace/test262/...` path that does not exist in this container (ENOENT);
  the other compiles a fixture with real TS type errors
  (`isConstructor(Math.ceil)` passes a function where a number is declared), so
  `compile` refuses and the assertion sees `"Empty binary"`. Diagnosed by
  compiling the fixture directly and printing the diagnostics
  (`.tmp/probe-diag.mts`).
- `array-inline-return.test.ts` — `Compile failed: Type 'number | undefined' is
  not assignable to type 'number'`, a TS diagnostic in the fixture's own
  `arr.find(...)` line.

### 7. WASI target

`.tmp/probe-wasi.mts` on an exported mixed-return function: `success: true`,
90,606 bytes, **VALIDATES**, exports `pick` / `main` / `memory` / `__exn_tag`.
Widening an EXPORTED signature to externref does not break the WASI lane.

### 8. Benchmark A/B — deliberately not run, and why (lead-accepted 2026-08-23)

The issue's plan asks for a perf A/B on the benchmark lanes (#1888 floor). I did
not run one, because the census makes it a measurement of byte-identical code:
the perf corpus — `website/playground/examples` (13 files) +
`benchmarks/suites` (4 files), **109 function bodies** — contains **zero**
functions whose inferred return type is `T | undefined` over a scalar carrier,
and **zero** over a reference carrier either (M1). The widening predicate
cannot fire on any of them, so those modules compile to the same bytes before
and after. A benchmark run would report noise around zero and would not be
evidence of anything.

What WOULD be worth measuring, if the follow-on lands: widening concrete-`ref`
carriers (residual 0) puts a coercion on string-returning functions, which the
`strings` / `mixed` benchmark suites do exercise. That one needs the run.

### 9. Gates

`check-loc-budget` OK (+9 on `declarations.ts`, allowance now granted by THIS
issue rather than borrowed from #4491), `check-func-budget` OK (+8 in
`collectDeclarations`), `check-oracle-ratchet` OK (`getTypeAtLocation +0`,
`ctx.checker +0` — the new module takes the already-resolved `ts.Type` and
`ValType` as arguments and consults neither), `check-coercion-sites` OK,
`audit-legacy-reachability --check` OK, `biome lint` clean, `prettier --check`
clean, `typecheck` (tsc7 `--noEmit`) clean.

`git status -- test262` is empty at every commit: this worktree's `test262/`
holds two symlinks (`test`, `harness`) INSIDE the submodule directory rather
than replacing it, so the gitlink is untouched (the #4641-era gitlink hazard in
the campaign brief).

## Residuals

Each is MEASURED on this branch and pinned, not asserted. Pins live in
`tests/issue-4641.test.ts` as `it.fails`, so any of them starting to pass turns
this file red and forces the list to be revisited.

| # | residual | evidence | owner |
| - | -------- | -------- | ----- |
| R1 | A `number \| undefined` **LOCAL** still collapses to `f64`, so `var v = pick(i)` unboxes the widened result to a plain NaN and loses the identity | pin `mixed-return-through-a-local-slot`; also `language/types/undefined/S8.1_A2_T2.js` | **#3580 S3/S4** (union-collapse reversal; partial landings breached the standalone floor, PR #2025 NET −1245) |
| R2 | **Concrete-`ref` carriers**: `string \| undefined` lowers to `ref_null $AnyString` and a bare `return;` pushes `ref.null` = JS **null**. `typeof` → `"object"`, `String()` → `"null"` | pin `mixed-return-concrete-ref-carrier`; probes `.tmp/probes/ref-mixed-return*.js` | **#4641 follow-on** — 26/1,363 real-world function bodies, the larger half by count; needs its own perf census because it touches string-returning ABIs |
| R3 | **Function EXPRESSIONS / arrows / methods**: registered via `closures.ts` / `resolveWasmTypeForClosureReturn`, untouched by this branch | pin `mixed-return-function-expression` | **#4641 follow-on** — same predicate, different signature site |
| R4 | **Array ELEMENT half**: `null` in a `number[]` vec slot materializes as `f64.const 0`, so `Array(undefined,1,null,3).toString()` renders `",1,0,3"` | pin on `built-ins/Array/prototype/toString/S15.4.4.2_A1_T2.js` | **value-rep lane** — needs a third sNaN payload (`NULL_F64_BITS`); the naive "reuse UNDEF" shortcut is +1/−2, see the table above. ONE corpus row (M2) |
| R5 | **Heterogeneous-array element tag-5 lie**: `var arr=[0,1,2,"last"]` → `typeof arr[2]` is `"string"`, `String(arr[2])` is `"[object Object]"`, `arr[2] === 2` is false | pin `heterogeneous-array-element-tag`; probes `.tmp/probes/het-elem.js`, `het2.js` | **#1888 / #2141-S4** honest-boxing flip (measured −788/−794 solo, deliberately deferred). This — not the descriptor MOP — is what actually blocks `filter/15.4.4.20-9-b-*`: `.tmp/probes/filter-plain.js` has no `defineProperty` at all and fails identically |
| R6 | Superlinear COMPILE time on a large sparse grow (9.1 s at `arr[99]` → >600 s at `arr[999999]`, both arms) | `.tmp/probes/every-sparse{,-small}.js` | **wave-5 / #4645** (lead-routed). Also: `runTest262File`'s `timeoutMs` is a POST-HOC check, it cannot cap a slow compile |
| R7 | Handed BACK, not mine: `forEach/15.4.4.18-3-23.js` fails only because its `length` is an OBJECT needing ToPrimitive — `.tmp/probes/foreach-generic.js` (`Array.prototype.forEach.call({1:11,2:9,length:3}, cb)`) **PASSES**. `filter/15.4.4.20-5-7.js` is `eval` as a `thisArg` and CRASHES (`dereferencing a null pointer`). `concat/S15.4.4.4_A2_T{1,2}` are `Array.prototype.concat` read as a value | measured errors in `.tmp/base-17.json` | ToPrimitive/`length` owner · runtime-eval lane · **#4647** |
| R8 | `Array.prototype[N] = v` INHERITED-index rows (`concat/S15.4.4.4_A3_T{1,2,3}`, `toLocaleString/S15.4.4.3_A3_T1`) — the array-proto-hole lookup, not element representation | measured errors in `.tmp/base-17.json` | array-proto-hole lane |

**On the issue's opening claim.** The title says this is "every `if (!x) return;`
in every compiled program". The corpus does not support that framing and the
record should say so: the shape is 0.4 % of test262 function bodies (301 of
75,817), 1.2 % of the ES≤5 subset, 0.15 % of real-world function bodies for the
SCALAR carrier this branch fixes, and 0 % of the perf-benchmark corpus. The fix
is worth having because it removes a wrong ANSWER in the most ordinary
control-flow shape in JavaScript — not because it moves a large row count. It
moves exactly one, in each of two lanes.
