---
id: 3686
title: "perf: null-check/throw + cast scaffolding dominates WasmGC-lowered field access"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: compiler-internals
goal: performance
sprint: current
related: [3673, 3683, 3685, 1947, 1852]
---

# #3686 — Null-check/throw + cast scaffolding on every field access

## Problem

Two independent #3673 investigations, using different workloads and
different methods, converged on the same dominant cost in WasmGC-lowered
code: **the scaffolding around field access, not the field access.**

**Evidence 1 — opcode census of a hot tokenizer function** (`Lexer_next`,
our `-O3` standalone module):

```
throw 54 · ref.is_null 35 · extern.convert_any 73 · any.convert_extern 19
ref.cast 38 · ref.test 19 · struct.get 57 · struct.set 16 · call 7
array.get_u 5 · i32.trunc_sat_f64_s 5 · f64.convert_i32_u 5 · f64.add 6
```

54 throws and 35 null checks in ONE function; **149 conversion/cast ops
against 5 actual character reads**.

**Evidence 2 — GC vs linear-memory twin of the same parser** (#3673
"Linear memory vs WasmGC"): on the parse+AST workload the linear lane was
5.9x faster, and the mechanism was NOT allocation (that is ~1:1). GC's
`parsePrimary` carries **`ref.cast` ×38 + `ref.test` ×45** re-narrowing
`Node | null` on every field read; **the linear twin has zero casts.**

Both point at the same thing from opposite directions. This is also the
unfinished half of #1947, which observed it statically in 2026-06:
"every typed param is `(ref null $T)` with per-access null-check-throw
blocks; a 6-line function carried four" — but never priced it. It is now
priced, and it is the largest identified remaining cost in the
GC lane for parser-shaped code.

## Why it happens

- A nullable declared type (`Node | null`, or any binding the checker
  cannot prove non-null) lowers to `(ref null $T)`. Every subsequent
  read must re-establish non-nullness, so codegen emits a null test plus
  a throwing branch, then a `ref.cast` to re-narrow the static type it
  already knew.
- Values that round-trip through `externref` (the #1947 laundering
  problem) lose their concrete type and must be re-cast on the way back
  in, which is where the `extern.convert_any`/`any.convert_extern`/
  `ref.cast` triples come from.

## PREREQUISITE (found 2026-07-27 by the #3687 study) — read before starting

**`class Node { left: Node }` — a non-nullable field of the class's own
type, which is exactly the AST shape this issue targets — makes codegen
recurse until stack overflow.** `objectIrTypeFromTsType` ↔
`tsTypeToFieldIr` (`src/codegen/index.ts` ~1081/~1099) have no cycle
guard. The nullable/optional spellings only work because a union misses
the `Object` flag and bails to the legacy path — i.e. today's code
survives *because* it is untyped. **This issue's end state is therefore
not expressible in source yet; the cycle guard is a prerequisite, not an
optimisation.** Fix that first or this work cannot land.

## Revised expectations (same study)

The scaffolding was PRICED with a hand-written WasmGC control: **+10-16 %
on build+walk, +23-29 % on a pure walk** (0.45-0.53 ns/read). That is a
percentage, not the multiple the opening evidence suggested, and
`extern.convert_any` turns out to be a V8 no-op — so the `extern`/`any`
half of the census is cheaper than the raw count implies. Size the work
accordingly.

**A bigger prize sits next door**: the generic `===` ladder. `tk[i] === 40`
with BOTH operands statically `number` emits 4 `__box_number`, 4 unboxes,
**an object→string conversion and a string comparison per token**. That
is #3685/#1584/#1852 territory and, on the measured evidence, worth more
than this issue. Consider sequencing it first.

## Measured 2026-07-31 — on ACORN, `--closed-world` does not remove the
## scaffolding (module-specific negative result)

Before writing any codegen, the cheap hypothesis was tested and **falsified**:
that our `wasm-opt` invocation was leaving Binaryen's WasmGC type-refinement
suite unused. `src/optimize.ts` (~L505-511) passes only
`-O3 --all-features --disable-custom-descriptors` — **no `--closed-world`** —
and a zero-import standalone module is *definitionally* a closed world, so
`TypeRefining` / `GlobalTypeOptimization` / `SignatureRefining` looked like a
free win: refine a field to non-nullable and the `ref.is_null` folds to
`i32.const 0`, taking the throwing branch with it.

Measured on the real 1.7 MB standalone acorn module, three optimizer configs
run from ONE byte-identical pre-opt input (binaryen 125, `--metrics`):

| config | total exprs | RefCast | RefTest | RefIsNull | RefAs | Throw | bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `-O3` (shipped) | 412,849 | 14,833 | 18,191 | 10,057 | 25,959 | 2,243 | 1,100,410 |
| `-O3 --closed-world` | 406,192 | 14,071 | 17,367 | 10,035 | 25,697 | 2,233 | 1,122,573 |
| `-O3 --traps-never-happen` | 411,952 | 14,654 | 18,178 | 10,057 | 25,867 | 2,243 | 1,097,965 |
| `-O3 --closed-world --type-ssa --gufa --optimize-casts` | 408,780 | **14,065** | **17,367** | **10,030** | **25,612** | 2,231 | 1,125,630 |

`--closed-world` buys **1.6 %** of instructions and makes the binary **larger**
(+22 KB); `--traps-never-happen` buys ~0.2 %. **Neither removes the
scaffolding.**

**The fourth row is the strong result.** Binaryen's entire WasmGC optimisation
arsenal — whole-program `--gufa` (Grand Unified Flow Analysis), `--type-ssa`
and the pass literally named `--optimize-casts` ("eliminate and reuse casts"),
all under `--closed-world` so they are permitted to run — removes **6 more
`ref.cast` than `--closed-world` alone** (14,071 → 14,065) and **zero more
`ref.test`**. Against the shipped `-O3` that is `RefCast` −5.2 %, `RefTest`
−4.5 %, `RefIsNull` −0.3 %, and a binary **2.3 % larger**. This was run
precisely because "you didn't try the cast-specific flags" is the obvious
objection to the first three rows; it is now closed. On acorn, the optimizer is
not leaving cast removal on the table — **it cannot prove the types, because we
never gave it them.**

The likely mechanism: a `ref.cast` is not only a check — it also **produces** the
narrowed static type, so Binaryen can only delete one when it can *prove* the
operand already has that type. `ref.is_null` here guards an explicit `throw` (a
JS-level TypeError), not a trap, so `--traps-never-happen` has no purchase on it
at all.

> **SCOPE CORRECTION (2026-07-31, after review).** An earlier draft of this
> section stated the strong form — "`ref.cast` cannot be deleted even when the
> check is free, therefore no optimizer flag can fix this". **That is
> over-general and a counterexample exists.** On the WASI hello-world
> (`console.log("hello world")`, 5,217 B input), the same `wasm-opt` 125 goes
> from `RefCast 6 / RefTest 6 / RefAs 4` at `-O3` to **0 / 0 / 0** with
> `--closed-world`, and the binary shrinks 428 → 254 bytes (−40 %). So Binaryen
> **can** delete these casts when the type graph is provable. The correct claim
> is the module-specific one: **on acorn, `--closed-world` does not remove the
> scaffolding** — which is exactly the regime that matters here, because acorn's
> dynamic shapes are where the proof fails. Both results are true at once; the
> effect is module-dependent. Do not quote the strong version.

**Conclusion (narrow): on acorn this issue is not discharged by `--closed-world`
or `--traps-never-happen`; it needs narrower types emitted in codegen** — what
the Direction below already says. Anyone re-opening the optimizer-flag branch
should do it with a measurement on the *target* module, not on a toy.

### Separately: the shipped pipeline passes no `--closed-world` at all

Worth its own issue regardless of what it does for casts. `src/optimize.ts`
(~L505-511) emits only `-O3 --all-features --disable-custom-descriptors`, yet a
zero-import standalone module is **definitionally** a closed world. On the WASI
hello-world that omission costs **40 % of binary size for free**. On acorn it
goes the other way — the binary gets *larger* (1,100,410 → 1,122,573 bytes,
+2 %), presumably from `TypeSSA`-style type duplication — so this is not a
blanket win and needs a per-lane measurement plus a size/speed policy decision.
Flagged here; not owned by this issue.

## Measured 2026-07-31 — how big is it, honestly

Two sizings, both first-party, and the difference between them matters.

**(a) Static footprint of the shipped binary.** `RefCast + RefTest + RefIsNull
+ RefAs + Throw` = **71,283 of 412,849 expressions (17.3 %)**, against
`StructGet + StructSet + ArrayGet` = **12,080 (2.9 %)** — a ~6:1
scaffolding-to-access ratio, consistent with this issue's opening Evidence 1.
**This number is not a time share** and must not be quoted as one: it averages
over 1,894 functions, most of which never execute.

**(b) Self-time-weighted instruction mix.** Crossing a V8 CPU profile
(standalone acorn, `-O3`, 20,000 parses of a 1,479 B parser-shaped corpus,
**11,071 samples** at `--cpu-prof-interval=100`, 98.2 % of samples matched to a
named wasm function) against `wasm-opt --func-metrics`, i.e. weighting each
function's opcode census by its measured self time:

- scaffolding (`RefCast+RefTest+RefIsNull+RefAs+Throw`): **18.2 %**
- real work (`Struct`/`Array` get-set, `Binary`, `Unary`): **14.0 %**
- calls (`Call`+`CallRef`): **6.1 %**

Per-function, in the hottest compiled bodies, scaffolding as a share of that
body's own instructions: `__closure_170__typed_this` **29.2 %**,
`__closure_168` **28.2 %**, `__closure_540__typed_this` **28.0 %**,
`__closure_530` **28.3 %**, `__closure_184` **25.4 %**, `__closure_339`
**24.5 %**, `__closure_544__typed_this` **24.9 %** — against ~10-12 % real work
in the same bodies.

That hot-code density (~25-29 %) is close to the module-wide static figure
(17.3 %), i.e. hot code is *not* cleaner than cold code — if anything it is
denser in scaffolding.

**What this is and is not.** It is an *instruction-mix* share, not a time share:
`ref.test`/`ref.cast` on a monomorphic site are branch-predicted and much
cheaper per instruction than a load or a call, so 18.2 % of instructions is an
**upper-bound-flavoured** estimate of the time. Read together with this issue's
own hand-written control (+10-16 % build+walk, +23-29 % pure walk) and the
independent finding that **compiled parser bodies are 57-60 % of standalone
parse time** (two independent profiles, below), the plausible end-to-end prize
is high single digits to low double digits — the largest single named lever
currently identified in the standalone lane, but a percentage, not a multiple.
**Do not land a partial chain**: the whole-chain-or-negative law in the
acceptance criteria still governs.

### Two independent profiles agree (cross-validation, 2026-07-31)

Different harnesses, different corpus sizes, different sample counts, taken by
two agents who did not share a methodology:

| bucket | this profile (20,000 parses of 1.5 KB, 11,071 samples) | `dev-acorn-throughput` (30 parses of 226 KB, 1,188 samples) |
| --- | ---: | ---: |
| compiled parser bodies (total) | **59.9 %** | **56.9 %** |
| — of which typed twins | 41.1 % | 37.1 % |
| — of which generic / no twin | 18.8 % | 19.8 % |
| property lookup (`__extern_get`) | 12.6 % (9.69 %) | 10.1 % (8.03 %) |
| value ops / coercion | 6.2 % | 6.4 % |
| call dispatch bridge | 6.1 % | 7.5 % |
| regexp engine | 7.3 % | 4.8 % |
| GC | 1.5 % | 4.3 % |
| string runtime (out-of-line) | 1.5 % | 2.1 % |

Agreement within a few points on every bucket across a 150x difference in
input size is strong evidence the decomposition is real and not a harness
artifact. Both runs were on a **loaded box (load 7-14 on 10 cores)**, so only
the *shares* are quoted — wall-clock from either run is contaminated and is
deliberately not reported here.

## PREREQUISITE — status corrected 2026-07-31

The cycle guard described below **is genuinely missing** but is **latent, not
live**: verified on tip, both `class Node { left: Node }` and the interface
spelling compile clean, because `resolveIrClassShapeFromType` returns
`{kind:"class"}` before the `Object`-flag arm can recurse (and the interface
case bails earlier). It becomes live the moment this issue makes those shapes
typed-and-reachable. **Fold the seen-set into this issue's PR**, where the same
change supplies the repro that proves the guard works — filing it separately
would trip the #2093 gate (no failing repro).

## Cross-box caveat on this issue's ranking (#3780 round 4, 2026-07-31)

Every share quoted in this issue comes from a profile of the standalone acorn
self-parse. A fourth profile, taken on a **4-core Linux container / Node
22.22.2** (rounds 1-3 of #3780 and both cross-validated profiles above were
Node 24 / arm64 macOS), disagrees on one bucket by an order of magnitude:

| bucket | Node 24 / macOS profiles | Node 22 / Linux container |
| --- | ---: | ---: |
| GC | 1.5% and 4.3% | **24-37%** |

The Linux figure is corroborated by an independent, profiler-free measurement
(summing inter-GC heap growth from `--trace-gc`: 22.5 ms of a ~120 ms parse
after #3780 round 4's lowerings, 30.1 ms before). I do not know whether the
cause is the V8 version, heap sizing, or the container.

**Why it matters here:** the non-GC buckets are shares of a denominator that
moves with it. If GC is really ~2% on the reference hardware, this issue's
share is correspondingly *larger* there than the Linux profile suggests, and
allocation-side work (#3921/#3927) is correspondingly smaller. Re-measure on
the target hardware before using any of these shares to sequence work.

## Direction

1. **Hoist the check to the binding, not the access.** A local proven
   non-null once (`ref.as_non_null` at the binding, or a single guarded
   entry) should be typed `(ref $T)` for its whole live range, so
   subsequent reads are bare `struct.get`. This is the same
   "guard per binding, not per access" rule #3685 S4 already identifies
   for receivers — the two should share a mechanism.
2. **Non-null params under `strictNullChecks`** (#1947 item 2): a
   non-optional reference param lowers to `(ref $T)`; callers guarantee,
   callees drop the null blocks entirely.
3. **Stop the externref round trip inside the module** (#1947 item 1),
   which removes the re-cast on the way back.

## Non-goals

- Removing genuinely required null checks. Where a value can actually be
  null, the check stays; this issue is about the ones the compiler can
  prove redundant.
- Changing throw semantics or which errors are raised.

## Acceptance criteria

- `throw` / `ref.is_null` / `ref.cast` counts in the #3673 hot tokenizer
  function drop materially (target: `throw` and `ref.is_null` to
  single digits, from 54 and 35).
- Measured on the #3673 harnesses (`.tmp/parser-shootout.mjs`,
  `.tmp/tokenize-only.mjs`, `.tmp/simd-shootout.mjs`) against the
  established ladder: node ~0.033-0.035 ms, hand-written WasmGC ceiling
  ~0.015 ms, our compiler ~0.100 ms.
- **Whole-chain or negative** (the #3673 law, confirmed three times): a
  partial application that leaves re-widening/re-casting in place will
  measure WORSE. Land the complete chain or do not land it.
- Full `tests/equivalence` failure set identical by test NAME; corpus
  0 real gaps; canaries `imports: ZERO`.
