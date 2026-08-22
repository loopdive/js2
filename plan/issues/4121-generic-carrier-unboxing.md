---
id: 4121
title: "perf: generic carrier unboxing — one `any`-typed definition boxes an entire numeric local, and every carrier needs its own bespoke pass"
status: in-progress
sprint: current
created: 2026-08-03
updated: 2026-08-21
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: ir, codegen
language_feature: value-representation
goal: ir-full-coverage
related: [684, 1167c, 1168, 2855, 3683, 3754, 3765, 4118, 4122, 2773, 1624]
origin: "measured on upstream/main d369562d7, 2026-08-03, investigating the residual 10x vs node on real npm packages"
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/object-runtime.ts
  # first slice (2026-08-21): the mixed-assignment demotion is minted at four
  # slot sites; two of them live here, and they must resolve the proof at the
  # same point or the hoisted and declared slots disagree.
  - src/codegen/statements/variables.ts
  # second slice (2026-08-21): the stratified level-3 refinement has to live
  # beside the analysis it re-runs (it calls it with one extra host fact), and
  # the declaration-resolved return-carrier predicate beside the return map it
  # reads. Splitting either out would separate a fact from its only producer.
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  # first slice (2026-08-21): +7 lines resolving the unboxing proof inside the
  # existing carrier cascade — extracting it would separate the decision from
  # the cascade it has to stay consistent with.
  - src/codegen/statements/variables.ts::compileVariableStatement
---

# #4121 — generic carrier unboxing

## Where the remaining gap actually is

Measured on `d369562d7`, all legs same container, checksums matching.

The **micro-benchmark axes are at or near parity** — the boxing on those paths
has already been eliminated by #3683 / #3754 / #3765:

| axis      | node | js2  |        |
| --------- | ---: | ---: | ------ |
| numeric   | 2.42 | 2.40 | parity |
| prop      | 1.14 | 1.08 | parity |
| alloc     | 0.24 | 0.24 | parity |
| tokenizer | 0.18 | 0.26 | 1.4x   |
| string    | 0.15 | 0.45 | 3.1x   |
| method    | 0.60 | 3.0  | 4.9x   |

The ≥10x gaps are **entirely in real npm packages**:

| lane                                  | vs node |
| ------------------------------------- | ------: |
| cookie · JS host                      |    570x |
| acorn · JS host                       |    459x |
| acorn · standalone · runtime-dynamic  |   11.5x |
| cookie · standalone · runtime-dynamic |   10.6x |
| clsx · standalone · runtime-dynamic   |   10.3x |

(The published `compile-time static` lane is not a comparison — it reports acorn
parsing a 226 KB bundle in 0.246 µs. That is constant folding, not execution.
Only runtime-dynamic rows mean anything.)

The **JS-host** number has a separate, already-understood cause: one
`parseCookie` call on a 38-character header makes **736 wasm→host calls**
(`--inspect-boundaries`), identically on the second call — `__box_number` 192,
`__host_eq` 119, `__js_array_push` 111, `__js_array_new` 80,
`__extern_method_call` 79, `__unbox_number` 63. That lane delegates JS semantics
to the host per operation. **This issue is about the standalone ~10x**, where
the module has **zero imports** and the same helpers are internal Wasm calls.

## The finding, minimally reproduced

`parseCookie`'s hot loop carries its cursor in a **boxed** local. The emitted
`index = endIdx + 1` is:

```wat
call $__to_primitive
call $__unbox_number   ;; unbox local 5
f64.const 1
f64.add                ;; + 1
call $__box_number     ;; re-box
local.set 5            ;; store to local 5
local.get 5
call $__unbox_number   ;; unbox again, immediately
```

Reduced to the smallest program that shows it:

| source                                  | `$i` slot      | box | unbox |
| --------------------------------------- | -------------- | --: | ----: |
| `let i = 0; i = i + 1;`                 | **f64**        |   0 |     0 |
| `let i = 0; i = s.indexOf(";");`        | **externref**  |   2 |     1 |
| `let i = 0; i = s.indexOf(";") + 1;`    | **externref**  |   2 |     1 |
| `var i = s.indexOf(";"); i = i + 1;`    | **externref**  |   2 |     2 |

**A single `any`-typed definition boxes the whole local, permanently, for every
read and write of it** — even though `String.prototype.indexOf` returns a Number
for a string receiver, and even though the whole-program fixpoint that could
prove it already exists and already runs.

## Why the two existing unboxing routes both miss it

`usageInferredLocalType` is documented as "the SINGLE codegen entry point" for
narrowing an `any` local to f64, and both routes feed it:

- **route 1, use-site (#684)** — every USE is ToNumber-invariant;
- **route 2, definition-site (#3765)** — every DEFINITION is provably a number.

Both sit behind the same admission gate in `analyzeFunctionBody`'s
`collectCandidate`, which requires the declaration's **checker type** to be
`any`/`unknown`. For `let i = 0` TypeScript declares `number`, so the binding is
**never collected as a candidate at all** — verified by instrumenting the
candidate loop: it prints nothing for `i`.

Meanwhile codegen widens that same slot to `externref` because of the later
`any`-typed assignment. So:

> the declared type says `number`, the emitted slot says `externref`, and the
> analysis that exists to reconcile them is gated on the declared type — which
> means **the carrier most in need of unboxing is invisible to the pass designed
> to unbox it.**

Case 4 in the table above (`var i = s.indexOf(";")`, declared `any`, so it *is* a
candidate) still fails, so there is at least a second, independent gap in
proving a string receiver for an unannotated parameter. Both need pinning.

### The demotion has since been pinned to one line — see #4122

An independent bisect of the `method` axis landed on the mechanism behind the
table above: `bindingHasMixedAssignmentCarrier`
(`src/codegen/analysis/mixed-assignment-carrier.ts`, wired at
`src/codegen/statements/variables.ts:150`) demotes a binding to `externref` when
`oracle.staticJsTypeOf` of any assignment is `"mixed"` — which is the oracle's
answer for **unresolvable**, not for **proven cross-domain**. Absence of
evidence is read as evidence of mixing.

#4122 covers that narrow fix (a measured 3.5x regression on the `method` axis).
It is the immediate first slice of this issue and should land independently.
This issue remains the general problem: even once `"mixed"` is read correctly,
the verdict is still consulted **per carrier kind**, so a numeric value flowing
local → argument → parameter → return → field is re-boxed at every hop that has
no bespoke pass yet.

## The structural problem: one analysis, four bespoke consumers

`analyzeNumericPropertyNames` computes one whole-program verdict. It has been
wired into four different carriers, each time by hand, each time in a different
file:

| carrier    | issue     | wiring                                            |
| ---------- | --------- | ------------------------------------------------- |
| fields     | #3683 S4a | `deriveFnctorFields` ← `numericPropertyNames`     |
| returns    | #3754     | `refinedTwinReturnType` in `typed-this.ts`        |
| locals     | #3765     | `isNumericLocal` → `UsageInference`               |
| parameters | follow-on | extended from #3765's route                       |

Each one removes the boxing from its carrier, and the boxing **relocates to the
next unfixed carrier**. The WAT census of the standalone cookie module shows
exactly that — every remaining box is at a carrier boundary, none is redundant
within an expression:

```
14  f64.convert_i32_s -> box -> return       (return of a plain function)
 4  local.get         -> box -> return
 9  f64.const         -> box -> local.set N  (a *literal* boxed into a slot)
 4  f64.add           -> box -> local.set N
 2  local.get         -> box -> call $__call_m_indexOf_2   (argument)
 2  f64.convert_i32_s -> box -> call $__extern_set         (property write)
```

## This is NOT a peephole

The obvious cheap fix — pattern-match `box` immediately followed by `unbox` and
delete both — was tested and **falsified**: of 59 box sites in the standalone
cookie module, **0** are immediately re-unboxed. `src/codegen/peephole.ts` (284
lines) has no box/unbox handling today, and adding one would find nothing.

The round-trip is real but it goes **through a local slot**
(`box → local.set 5 … local.get 5 → unbox`), which is a dataflow property, not
an adjacency property. Pattern-matching cannot see it; the slot's declared type
is what forces both halves.

## Proposal — this belongs in the IR, as a pass

The right home is **not** a fifth AST-side consumer. It is an IR pass, and the
IR already has every piece except the pass itself:

| piece                              | where it already is                                |
| ---------------------------------- | -------------------------------------------------- |
| a boxed/unboxed type vocabulary    | `IrType { kind: "union" }` (#1168)                  |
| `box` / `unbox` / `tag.test`       | first-class IR instructions (#1168)                 |
| type propagation over the graph    | `src/ir/propagate.ts`                               |
| a validated tagged-union registry  | `src/ir/passes/tagged-unions.ts` (#1167c Pass 2)    |
| a pass pipeline to slot into       | `src/ir/integration.ts` — `constantFold`, `deadCode`, `inlineSmall`, `monomorphize` |

`tagged-unions.ts` states the split explicitly: the **producers** of union-typed
values (from-ast / propagation) and the **consumers** (`box`/`unbox` lowering)
"sit on either side of this pass". What is missing between them is the
propagation that decides a carrier can be `f64` rather than boxed. That is
exactly this issue.

So the shape is:

1. Extend `propagate.ts` with a numeric lattice over the IR value graph —
   `⊥ → f64 → boxed`, joined at merge points.
2. A carrier is `f64` when every value flowing into it is `f64`. This is a
   **least** fixpoint, so a cycle carries no evidence and stays boxed unless
   grounded — the argument #3765 needed, and #4122 then had to extend with a
   self-reference rule for the accumulator shape.
3. The existing `box`/`unbox` consumers then simply emit nothing where the
   lattice says `f64`. **No new lowering code** — the deletion falls out of the
   type, which is the whole reason to do it here.
4. Box only at the frontier: exported entry-point parameters, host/dispatch
   boundaries, and carriers with a genuinely non-numeric definition.

Why this is the right level rather than a nicer version of the AST passes:

- **"Carrier" stops being a category you enumerate.** Field, return, local,
  parameter, argument and array element are all just edges in one graph. The
  relocate-to-the-next-unfixed-carrier failure mode cannot happen, because
  there is no per-kind wiring to be missing.
- **It is the documented direction.** `plan/log/ir-adoption.md`'s north star
  (goal `ir-full-coverage`, elevated 2026-07-02) is that all AST kinds route
  through the IR and the direct path is *deprecation-tracked, not a peer*.
  Passes like this are what the IR is for; adding a fifth AST consumer adds to
  the pile the ratchet (#2855) exists to shrink.
- **The duplication disappears.** `isString` exists twice on the AST side —
  once in `makeProver`, once in `collectStringProperties`. When #3765 added
  `Array.prototype.join` the wrong copy was fixed first and the measurement
  came back zero. Syntactic analyses with no shared value graph invite exactly
  that.

### The blocking caveat — do not skip this

An IR pass only applies to functions the IR **claims**. Today a selector
rejection or an IR-build throw demotes the function to direct codegen through
the warning channel (`src/codegen/index.ts`, the two demote sites), and
`ir-adoption.md` still lists many kinds as `mixed` / `direct-only`.

So moving this analysis into the IR **now** would silently stop applying
wherever the IR bails — no wrong answers, but a perf cliff invisible to every
gate. That is precisely the failure #3765 hit from the other direction: a
kill-switch differential of zero that meant "the lever never engaged", not
"the lever is worthless".

Therefore:

- The AST-side fixes (#3683, #3754, #3765, #4122) **stay** until the IR owns
  the relevant node kinds. They are not made redundant by this issue.
- Any implementation must report **IR-claimed vs demoted coverage** for the
  benchmark set alongside its speedup, so a headline number cannot hide a
  shrinking denominator.
- Sequence behind enough of #2855 that the accumulator and string-scanning
  shapes in `benchMethod` / `parseCookie` are IR-claimed. Check first; if they
  are not, that ratchet work is the actual prerequisite and this issue is
  blocked on it rather than ready.

### One slice worth landing first, on either side

The admission gate must key on **the representation codegen is about to emit**,
not on the checker's declared type. `let i = 0` is declared `number` while its
slot is `externref`, so the pass that exists to reconcile them never sees it.
That is a small, independent fix, it is what makes case 2/3 in the table above
visible at all, and it is worth doing regardless of where the analysis
eventually lives.

## 2026-08-09 cookie runtime-dynamic checkpoint

Branch: `codex/cookie-runtime-dynamic-perf-20260809`, based exactly on
`dda0d1dc72f4a701b98c09f74f1edd2573985d26`.

The linked legacy-codegen path now runs the same whole-program local analysis
as a single-source standalone compilation and carries proven string/numeric
arguments through implicit-any helper ABIs. The object runtime also avoids a
flatten helper call for already-flat hash keys and folds the FNV operation for
one-code-unit transient keys.

The exact pinned `cookie@2.0.1` runtime-dynamic artifact A/B used separate Node
processes, two warm-up rounds, nine measured rounds, 120,000 iterations per
round, runtime seed 3751, and an exact checksum of 120,000 on both sides:

| artifact                              | median runtime | binary size |
| ------------------------------------- | -------------: | ----------: |
| base `dda0d1dc`                       |       4.021 us |      49,906 |
| linked-carrier + hash-key checkpoint  |       1.595 us |      46,883 |
| `JS2WASM_NUMERIC_LOCALS=0` control    |       9.623 us |      49,972 |

That is a **2.52x exact artifact speedup** and 3,023 fewer bytes. All artifacts
have zero imports and execute the same host-supplied runtime input; no package,
source-text, or expected-result recognizer is involved. The official harness
measured the checkpoint at 1.9048 us versus Node at 0.4259 us (4.47x behind,
up from the committed ratio near 0.096 to 0.2236). It still reports
`benchmarkUsesIr: false`, so the remaining gap is on the legacy backend.

The pinned correctness harness reports 21/21 operations equal for both the
base and candidate. Its opt-in Vitest wrapper still expects the historical
18/21 state and is therefore a pre-existing exact-base failure, not part of
this compiler checkpoint.

## 2026-08-09 residual cookie return-carrier checkpoint

Stacked branch: `codex/cookie-residual-runtime-perf-20260809`, based exactly on
the updated parent checkpoint `d5f3583e5b65517951dece9cb8538422d75a745f`.
Implementation commit: `1d44e406a17908d5cecc26f9a29b65783a7ba68e`.

An exact CPU profile of the parent artifact showed the residual Wasm time in
generic helpers rather than the package's numeric search kernels:
`__obj_hash` 17.27%, `__extern_strict_eq` 9.79%, `valueSlice` 9.66%,
`__str_flatten` 8.76%, and `__obj_find` 6.70%. Native Node instead spent its
time directly in `eqIndex` (16.14%), `parseCookie` (15.61%), `endIndex`
(8.99%), and `decode` (7.41%). V8's native Wasm code for the generic strict
equality helper was about 3,168 instruction bytes, while the equivalent JS
call sites were JIT-specialized. This made the next generic lever the return
carrier of numeric helpers such as `endIndex(str, min, len)`: the result was
boxed solely because an unrelated parameter was a string.

The new binding-aware, least-fixpoint proof selects `f64`/boolean-branded `i32`
returns independently of parameter carriers. It uses the shared semantic
oracle and grounded numeric-local verdict, resolves every call to its exact
declaration, and declines fallthrough, bare returns, mixed boolean/number
results, generators, async functions, and ungrounded recursion. It contains no
package, source-text, or function-name recognition. `JS2WASM_NUMERIC_RETURNS=0`
(also `off` or an empty value) disables the new proof; default is on.

Final debug artifacts were generated from the rebased tree with optimize level
4 and preserved names:

| mode                      | SHA-256                                                           | bytes  | imports | checksum (1 / 400k) |
| ------------------------- | ----------------------------------------------------------------- | -----: | ------: | -------------------: |
| default-on                | `14d5203cb3fc81b4a28c1fc1d6ab396ec43c45233c551ddb7019ac6ee3596596` | 47,955 |       0 |           1 / 400,000 |
| `NUMERIC_RETURNS=0`       | `d03f2841a422adcbd3134b64606f0fff403526af5790f86494e403d7135d0c48` | 48,022 |       0 |           1 / 400,000 |
| parent artifact `c76358b` | `d03f2841a422adcbd3134b64606f0fff403526af5790f86494e403d7135d0c48` | 48,022 |       0 |           1 / 400,000 |

The switch-off artifact is byte-for-byte identical to the parent artifact. A
same-process A/B used three warm-ups, eleven AB/BA-alternating measured rounds,
400,000 operations per artifact and round, and runtime seed 3751. Median time
fell from 1.9256 us/op to 1.8118 us/op (**5.91% faster**). An independent
five-warm-up, 21-round, 100,000-operation run over the same artifact hashes
measured 3.3064 us/op to 2.8396 us/op (**14.12% faster**); a fresh official
harness pair measured 2.1940 us/op to 1.9305 us/op (**12.0% faster**). The
spread is recorded rather than hidden; all three comparisons are positive and
the same-process runs alternate order.

The candidate also scaled with work instead of measuring setup noise:

| operations | wall time | us/op |
| ---------: | --------: | ----: |
|     25,000 | 46.543 ms | 1.862 |
|     50,000 | 91.648 ms | 1.833 |
|    100,000 | 191.468 ms | 1.915 |
|    200,000 | 382.064 ms | 1.910 |

Under fixed 600,000-operation CPU sampling, the switch-off median was 1,384 ms
and default-on was 1,111 ms (**19.7% faster**). The cast/conversion bucket fell
from 6.19% to 1.21%; self time in `__box_number` fell from 1.68% to zero, and
`__unbox_number` fell from 3.22% to 1.21%.

IR coverage is deliberately unchanged: all eleven tracked units remain on the
legacy path (`benchmarkUsesIr: false`, no IR-compiled functions). The pinned
package API differential is 21/21 equal, zero divergent, in both default-on and
switch-off modes. Focused regression coverage is 17/17, typecheck and the
oracle ratchet pass, and commit hooks pass the LOC/function budgets plus the
24-test dynamic-key, four-test linked-flow, and five-test return-carrier roots.
The unrelated #1120 WAT-name assertion remains 7/8 in both modes; its runtime
and ABI checks pass and the switch-off result is identical.

## Acceptance criteria

- [x] A pre-flight report of **which benchmark functions the IR currently
      claims** vs demotes. If `benchMethod` / `parseCookie` are demoted, this
      issue is blocked on #2855 rather than ready, and that finding closes the
      slice on its own. — done 2026-08-21; both ARE demoted, see "First-slice
      result".
- [ ] `let i = 0; i = s.indexOf(";") + 1;` in a loop emits an `f64` local with
      **zero** `__box_number` / `__unbox_number` in the loop body. — still open;
      the admission gate no longer hides the binding, but both proofs decline
      it (route 1 bails on the argument use, route 2 cannot ground the
      unannotated string receiver). Next slice.
- [x] IR-claimed coverage reported alongside every speedup, so a headline number
      cannot hide a shrinking denominator. — reported and unchanged; no speedup
      is claimed.
- [x] The standalone `cookie` runtime-dynamic lane improves measurably against
      node, measured same-container interleaved behind a kill switch, with the
      checksum unchanged.
- [x] The residual box sites in the standalone cookie module are reported
      before/after, by carrier, so the "relocated to the next carrier" failure
      mode is visible rather than silent. — done 2026-08-21; 19 sites, 13 of
      them into a LOCAL carrier, every bucket flat.
- [x] No equivalence-suite regressions — confirmed by a **full-capture** run and
      an A/B of the failing set with the kill switch off, not by a count match.
      — done 2026-08-21 for this slice: 24 failing / 1,661 passing, failing
      SETS identical by test id across the switch, all 24 baselined.

## What must still decline (hard-won, do not re-derive)

- **Booleans.** `isNumeric` deliberately answers TRUE for booleans. That is safe
  for a FIELD only because #2847 brands boolean fields as i32 and the property
  path defers to the brand. No other carrier has a brand path, so an f64
  boolean carrier makes `` `${b}` `` print `1` where JS says `true`. This
  escaped review on #3765 and was caught only by the full equivalence run.
- **Capture.** A captured binding lives in a ref cell, not a wasm local.
- **Read before definition.** A proof about what every write STORES says nothing
  about a read that precedes them all; an f64 slot reads `0`/NaN where JS says
  `undefined`.
- **bigint.**
- **Greatest vs least fixpoint.** `numericSlots` is a *greatest* fixpoint, so
  `var a = b; var b = a` survives it with no numeric evidence anywhere. Any new
  consumer needs the grounded (least-fixpoint) variant.

## Implementation Plan — first slice only (Fable, 2026-08-21)

**Scope of this dispatch: the pre-flight claim report (AC 1), the
admission-gate slice, and the box-site census (AC 5). Explicitly NOT the IR
lattice pass** — the issue's own blocking caveat stands: the pass would
silently stop applying wherever the IR demotes, and the benchmark shapes'
claim status is unmeasured. The AST-side admission-gate fix is independent of
that question and is called out above as "worth doing regardless of where the
analysis eventually lives".

**Step 0 — pre-flight (AC 1, do this first, it can re-scope the rest):**
compile the benchmark shapes with IR telemetry (`result.irCompiledFuncs` /
`irFirstSkipped`, plus `JS2WASM_IR_SHAPE_DIAG=1` for rejection attribution):
the `method` axis kernel (find it under `benchmarks/` /
`website/public/benchmarks/competitive/programs/`) and the pinned cookie
`parseCookie` (the standalone runtime-dynamic harness under `benchmarks/` —
the 2026-08-09 checkpoints in this file name the harness and seed). Record
claimed-vs-demoted per function IN THIS FILE. If both are demoted (expected,
`benchmarkUsesIr: false` in the last checkpoint), state plainly that the IR
pass half is blocked on #2855-successor coverage and proceed with the
AST-side slice below.

**Step 1 — instrument, reproduce (verified anchors, 2026-08-21):** the
candidate admission the issue describes lives in
`src/codegen/numeric-property-analysis.ts` (1,485 LOC) — the
`any`/`unknown`/`unresolvable` checker-type gate is visible at ~`:811`
(`parameterDefinitionsAgree`) and the local-candidate collection nearby;
`usageInferredLocalType` is consumed at `src/codegen/index.ts:10379` and
`:11049` (note `carrierForcesExternref` guarding the first — read what feeds
it); the mixed-assignment demotion is
`src/codegen/analysis/mixed-assignment-carrier.ts` wired at
`src/codegen/statements/variables.ts:150` (#4122's subject — check whether
#4122 landed first; if it did, re-measure the reduced table before changing
anything). Instrument the candidate loop and confirm the issue's finding
still holds on current main: `let i = 0; i = s.indexOf(";") + 1;` never
becomes a candidate because the DECLARED type is `number`.

**Step 2 — the fix:** admission must key on the representation codegen is
about to emit, not the checker's declared type. Concretely: a local whose
slot codegen is widening to externref (via the any-typed
assignment/mixed-carrier path) is admitted as an unboxing candidate even when
its declared type is a scalar — the existing route-1 (#684 use-site) and
route-2 (#3765 definition-site) proofs then run UNCHANGED and either prove
f64 or leave it boxed. No new proof logic. Add a kill switch consistent with
the family (`JS2WASM_NUMERIC_LOCALS` already exists — extend its scope or add
`JS2WASM_NUMERIC_ADMISSION=0`), default on.

**Step 3 — prove (ACs 2, 5, 6):**
- The reduced case emits an `f64` slot with ZERO `__box_number` /
  `__unbox_number` in the loop body (assert on WAT, like this file's table;
  pin as a test).
- Box-site census of the standalone cookie module before/after, bucketed by
  carrier (return/local/argument/field), appended to this file — the
  "relocated to the next carrier" mode must be visible.
- **Full-capture equivalence run + A/B of any failing set with the switch
  off** — a count match is not acceptance. The "What must still decline"
  list below is load-bearing: booleans (the `${b}` → `1` trap), captured
  bindings, read-before-definition, bigint, and the greatest-vs-least
  fixpoint trap each need an explicit negative test if the admission change
  can reach them.
- Perf: re-run the pinned cookie runtime-dynamic A/B (methodology from the
  2026-08-09 checkpoints: separate processes, warm-ups, alternating order,
  fixed seed, checksum equality) and report the delta with the switch-off
  control. A null result is reportable — the admission fix is about making
  the candidates VISIBLE; if the proofs then decline them, say so and name
  the declining clause.

**Out of scope, do not touch:** the IR `propagate.ts` lattice, new carrier
consumers, peephole (falsified above), and #4122's one-line fix if it has not
landed (do not absorb it — coordinate by checking `git log origin/main`).

## First-slice result (2026-08-21)

Branch `claude/issue-4121-unboxing-admission`, based on `ba151267f`.
Everything below was measured in this container, on this base, with the
kill-switch control run for every claim.

### Step 0 — pre-flight: what the IR claims vs demotes (AC 1)

`JS2WASM_LOG_IR_FALLBACKS=1 JS2WASM_IR_SHAPE_DIAG=1`, `target: standalone`,
`trackFallbacks: true`.

| module                            | units | IR-claimed | demoted |
| --------------------------------- | ----: | ---------: | ------: |
| `benchmarks/cross-engine/axes-core.js` (+ exports) | 12 | 6 | 6 |
| pinned `cookie@2.0.1` `dist/index.js`              |  9 | **0** | 9 |

Per-unit attribution:

| module     | unit                 | reject reason                       | arm                                        |
| ---------- | -------------------- | ----------------------------------- | ------------------------------------------ |
| axes-core  | `benchNumeric`       | *claimed*                           |                                            |
| axes-core  | `benchProp`          | *claimed*                           |                                            |
| axes-core  | `benchAlloc`         | *claimed*                           |                                            |
| axes-core  | **`benchMethod`**    | `constructor-resolution-unsupported`| —                                          |
| axes-core  | `bench_method`       | `call-graph-closure`                | —                                          |
| axes-core  | `P`                  | `body-shape-rejected`               | `tail-unhandled:ExpressionStatement`       |
| axes-core  | `benchString`        | `param-type-not-resolvable`         | —                                          |
| axes-core  | `Tok`                | `body-shape-rejected`               | `nontail-assign-recv:ThisKeyword`          |
| axes-core  | `benchTokenizer`     | `constructor-resolution-unsupported`| —                                          |
| cookie     | **`parseCookie`**    | `body-shape-rejected`               | `expr-new-module-binding-callee:Identifier`|
| cookie     | `stringifyCookie`    | `logical-value-unsupported`         | —                                          |
| cookie     | `stringifySetCookie` | `logical-value-unsupported`         | —                                          |
| cookie     | `parseSetCookie`     | `logical-value-unsupported`         | —                                          |
| cookie     | `endIndex`           | `param-type-not-resolvable`         | —                                          |
| cookie     | `eqIndex`            | `param-type-not-resolvable`         | —                                          |
| cookie     | `valueSlice`         | `body-shape-rejected`               | `expr-prefix-op-++:PrefixUnaryExpression`  |
| cookie     | `decode`             | `body-shape-rejected`               | `tail-unhandled:TryStatement`              |
| cookie     | `defaultEncode`      | `regexp-constructor-unsupported`    | —                                          |

**Both benchmark shapes this issue is about are DEMOTED.** `benchMethod` and
every one of cookie's nine units run on the legacy path, confirming the last
checkpoint's `benchmarkUsesIr: false` and the issue's own blocking caveat: an
IR `propagate.ts` lattice pass would today apply to **zero** of the functions
whose boxing motivated this issue. **The IR half of this issue is blocked on
#2855-successor coverage**, specifically on five distinct reject arms
(`constructor-resolution-unsupported`, `logical-value-unsupported`,
`param-type-not-resolvable`, `expr-new-module-binding-callee`,
`expr-prefix-op-++`, `tail-unhandled:TryStatement`). This finding stands on its
own regardless of anything below.

### Step 1 — the reduced table, re-measured after #4122 landed

#4122 merged on 2026-08-03 (`378892a38`). Re-measured on this base, standalone:

| source (receiver `s` unannotated / implicit-`any`)         | `$i` slot     |
| ---------------------------------------------------------- | ------------- |
| `let i = 0; i = i + 1;`                                     | **f64**       |
| `let i = 0; i = s.indexOf(";");`                            | **externref** |
| `let i = 0; i = s.indexOf(";") + 1;`                        | **externref** |
| `var i = s.indexOf(";"); i = i + 1;`                        | **externref** |
| the loop shape (`while (i < s.length) { … i = e + 1; }`)    | **externref** |

**It still reproduces.** Two corrections to the original table:

- The original cases used an annotated `s: string`. With `s: string` all five
  now emit **f64** — that part was fixed by earlier work. The shape that still
  boxes is the one that actually occurs in `parseCookie`: an **unannotated**
  parameter in a `.js` source.
- The box/unbox column no longer reads in `__box_number` / `__unbox_number`
  calls. Those call sites were inlined into an smi fast path
  (`(if (result externref) (then … ref.i31 …) (else … call $__box_number))`),
  so a census that greps for the helper name now under-reports by ~everything.
  The carrier is unchanged; only its instruction encoding is.

Instrumenting the candidate loop confirms the issue's diagnosis exactly, and
adds a second one:

```
[probe-admission] decl=i declaredType=number admitted=false   ← never a candidate
[probe-mixed]     decl=i initialDomain=number numericLocalVerdict=false
[probe-mixed]     decl=n initialDomain=number numericLocalVerdict=true
```

`i` is invisible to `usageInferredLocalType` (declared `number`), **and**
independently the #3765 whole-program fixpoint cannot ground it, so
`bindingHasMixedAssignmentCarrier` demotes it. `n` — a plain
`n = n + 1` accumulator — is grounded and stays f64.

### Step 2 — the fix

Admission now keys on the representation codegen is about to emit:

- `src/checker/usage-inference.ts` — new `WidenedCarrierOracle`, installed via
  `setWidenedCarrierOracle`. `collectCandidate` admits a binding when its
  declared type is `any`/`unknown` **or** codegen says it is widening that
  slot to a boxed carrier anyway.
- `src/codegen/analysis/mixed-assignment-carrier.ts` — supplies that oracle
  (memoized per declaration), plus `numericProofOverridesMixedCarrier`: a
  mixed-assignment demotion is "could not rule out", a positive unboxing proof
  is "ruled in", and the proof wins. `initForcesExternref` /
  `forInTargetForcesExternref` stay absolute — they describe a value the slot
  must physically hold.
- The four slot-minting sites that consult `bindingHasMixedAssignmentCarrier`
  (`statements/variables.ts` × 2, `index.ts` var-hoister and let/const
  pre-hoister) all resolve the proof to `f64` at the same point, so hoisted and
  declared slots cannot disagree.

**No new proof logic.** Routes 1 (#684 use-site) and 2 (#3765 definition-site)
run unchanged. Kill switch `JS2WASM_NUMERIC_ADMISSION=0` (also `off` / empty),
default on.

### Step 3 — what it actually changes, and what it does not

**It does NOT fix the reduced case.** A/B on all five rows above:
byte-identical output with the switch on and off. The declining clause, named:

```
[probe] fn=parseCookie decl=index declaredBoxed=false poisoned=false
        bailed=true sawEvidence=false defSite=false
```

`parseCookie`'s `index` is the **one** binding in the whole cookie module that
the new gate newly admits (`declaredBoxed=false` — declared `number`, slot
widened). Both proofs then decline it: route 1 **bails** (`index` is passed as
an argument to `endIndex(str, index, len)` and to `str.slice(…)` — neither is
ToNumber-invariant), and route 2 is **false** (its definitions flow through
`endIndex`/`eqIndex` returns whose own parameters are unresolvable). Every
other cookie candidate was already admitted by the old declared-`any` gate.

So this slice does what it was scoped to do — it makes the carrier *visible* —
and the remaining blocker is the second, independent gap the issue already
names at "a second, independent gap in proving a string receiver for an
unannotated parameter". That is the next slice, and it is proof work, not
admission work.

**It does change the shapes where the existing proofs can already close.**
A/B, standalone, `$acc` slot in `f`:

| shape                                                                   | switch off | default on |
| ----------------------------------------------------------------------- | ---------- | ---------- |
| `let acc = 0; acc = s.foo(); return acc * 3 - 1;`                        | externref  | **f64**    |
| loop: `acc = s.next(); acc = acc * 3;` with `next` string-or-number      | externref  | **f64**    |

Both are declared `number`, both are widened by a genuinely cross-domain
assignment, and route 1 carries them because every use applies ToNumber. Values
agree with node in both legs (`20008`, `20`), including when `"12"`, `"zz"`,
`null` or `undefined` is the value assigned into the newly-unboxed slot.

### Box-site census of the standalone cookie module (AC 5)

User functions only — the `$__*` helpers *are* the boxing machinery. One site =
one boxing operation (the whole smi `if`, not each `ref.i31` line).

| carrier                | before (`JS2WASM_NUMERIC_ADMISSION=0`) | after (default on) | delta |
| ---------------------- | -------------------------------------: | -----------------: | ----: |
| local                  |                                     13 |                 13 |    +0 |
| argument               |                                      3 |                  3 |    +0 |
| return                 |                                      2 |                  2 |    +0 |
| other (`local.get`)    |                                      1 |                  1 |    +0 |
| **total**              |                                 **19** |             **19** | **+0** |

Per function, unchanged in both modes: `parseCookie` 5, `parseSetCookie` 5,
`valueSlice` 4, `endIndex` 2, `eqIndex` 2, `decode` 1.

The dominant remaining carrier is the **local** — 13 of 19 — which is exactly
the carrier this issue is named for, and it did not move. Nothing relocated to
another carrier either: every bucket is flat, which is the point of publishing
the census.

### Perf: a null result, and why no timing run was performed

Both cookie artifacts are **byte-for-byte identical**:

| mode                              | bytes   | imports | SHA-256                                                            |
| --------------------------------- | ------: | ------: | ------------------------------------------------------------------ |
| `JS2WASM_NUMERIC_ADMISSION=0`     | 175,248 |       0 | `2efdaf992b29eb3f28c629449c352b2824dbfeaaff603e11ae4f5a97fc9267e0` |
| default-on                        | 175,248 |       0 | `2efdaf992b29eb3f28c629449c352b2824dbfeaaff603e11ae4f5a97fc9267e0` |

An A/B of one artifact against itself measures scheduler noise, not a compiler
change. The hash equality is the stronger claim and it is what is reported.
The pinned runtime-dynamic harness (separate processes, warm-ups, alternating
order, seed 3751, checksum equality) is the right instrument for the NEXT
slice, once an artifact difference exists to measure.

### Equivalence: full capture, A/B by test id (AC 6)

A count match is not acceptance, so both legs captured their failing/passing
sets per test id (`PARTIAL_OUT`) and the sets were diffed:

```
admission ON : 24 failing / 1661 passing
admission OFF: 24 failing / 1661 passing
baseline known failures: 36

failing ONLY with admission ON  (regressions caused by this slice): 0
failing ONLY with admission OFF (fixed by this slice):              0
failing (ON) and NOT in baseline:                                   0

VERDICT: failing sets IDENTICAL across the kill switch; all failures are baselined.
```

The 24 are all pre-existing baseline entries, in 11 files
(`tdz-reference-error` 6, `null-dereference-guards` 5,
`logical-conditional-identity` 3, `new-non-constructor` 2,
`optional-direct-closure-call` 2, and seven singletons).

Note on method: a **single unsharded** `scripts/equivalence-gate.mjs` run dies
on this 4-core/16 GB container — vitest is killed before writing its JSON
report and the gate exits 2 with `vitest produced no JSON report; signal=
null`, which is not a pass. Run it as 8 shards.

One shard reported `1 baseline failure now PASSES`
(`issue-1197.test.ts :: … x | 0 collapses to nothing on an i32-shaped value`).
That is a **stale baseline entry, not this slice**: the test passes with the
switch on AND off (22/22 both ways). The baseline was not ratcheted here.

### Gates, and one pre-existing failure found while running them

Green on this branch: `typecheck`, `check:loc-budget`, `check:func-budget`,
`check:oracle-ratchet`, `check:ir-fallbacks` (no unintended/post-claim/
module-level increases), `check:ir-only` (READY, 38/38 units emitted).

**`check:linear-ir` FAILS — and it fails identically on pristine
`origin/main` `ba151267f`.** Verified by reverting all four changed source
files to their `origin/main` blobs and re-running:

```
linear-ir ratchet: FAIL
  - IR-compiled function count DECREASED: 8 → 6
  - demotion bucket 'illegal:instr-vec.set_length' INCREASED: 0 → 2
  - demotion bucket 'select:string-builder-candidate' INCREASED: 0 → 2
```

Byte-identical output with the change applied, with the change applied and
`JS2WASM_NUMERIC_ADMISSION=0`, and with the change reverted. It is not this
slice's, the baseline was NOT refreshed here, and it wants its own issue.

### Acceptance criteria status after this slice

- **AC 1 — achieved.** Pre-flight table above. Verdict: the IR-pass half is
  blocked on #2855-successor coverage; both benchmark shapes are demoted.
- **AC 2 — NOT achieved.** `let i = 0; i = s.indexOf(";") + 1;` in a loop still
  emits an `externref` slot. The admission gate no longer hides it; both proofs
  decline it, for the reasons quoted above. This is the next slice.
- **AC 3 — achieved (vacuously, and stated as such).** IR-claimed coverage is
  reported above and is **unchanged** by this slice: 6/12 on axes-core, 0/9 on
  cookie, identical in both kill-switch modes. No speedup is claimed, so no
  headline number can be hiding a shrinking denominator.
- **AC 4** — unchanged (earlier checkpoint).
- **AC 5 — achieved.** Census above, before/after, by carrier.
- **AC 6 — achieved.** Full-capture equivalence run + kill-switch A/B; see the
  PR body for the run output.

## Implementation Plan — slice 2: interprocedural definition/use proofs (Fable, 2026-08-21)

Slice 1 (PR #4695) made the admission gate see `parseCookie`'s `index`; both
existing proofs then declined it. This slice closes the two measured decline
arms, reusing machinery that already exists rather than adding a fifth pass.

**Verified anchors (2026-08-21):**
`inferBindingAwareNumericReturnTypes` (`src/codegen/declarations/param-return-inference.ts:1142`)
already computes a grounded least-fixpoint `Map<string, ValType>` of
proven-numeric RETURN carriers (the #4121 2026-08-09 "residual return-carrier
checkpoint", kill switch `JS2WASM_NUMERIC_RETURNS`, wired at
`src/codegen/index.ts:4651`/`:7886`, consumed at `declarations.ts:588`).
Route 2 (definition-site, #3765) does NOT consult it: a definition that is a
direct call (`i = endIndex(str, index, len)`) contributes no numeric
evidence when the callee's own params are unresolvable — exactly slice 1's
measured decline.

**Step 1 — route-2 call-definition arm.** In the route-2 definition prover
(`numeric-property-analysis.ts`), a definition whose value is a direct call
to a binding present in `ctx.bindingAwareNumericReturnTypes` with an f64 (or
i32-boolean-branded — but see the boolean trap below) carrier is proven
numeric. Groundedness is inherited: the return map is itself a grounded
least fixpoint that declines ungrounded recursion, so this cannot launder a
cycle. Kill switch: fold under `JS2WASM_NUMERIC_RETURNS` (the fact source)
plus the slice-1 admission switch; no new env var.

**Step 2 — route-1 argument-use arm.** Route 1 (use-site, #684) bails when
the local is passed as an ARGUMENT (`endIndex(str, index, len)`,
`str.slice(index)`). Two sub-cases, in order of safety:
(a) the callee's corresponding param is itself proven-numeric via the
callsite-param inference (#2803's `inferBindingAware…` param twin in
`param-return-inference.ts`) — then an f64 argument is representation-exact,
no boxing needed; (b) otherwise the use is ToNumber-neutral only if a box is
emitted at the call frontier — which the "box only at the frontier" rule
already sanctions. Implement (a); for (b) only count the use as
non-blocking when the existing frontier-boxing path provably fires (measure
first; if the plumbing is absent, record it and leave (b) declined).

**Step 3 — prove.** (i) The reduced case
`var i = s.indexOf(";"); i = i + 1;` (table row 4 — the case slice 1 left
red) emits an f64 slot with zero box/unbox in the loop; pin as a WAT test
next to slice 1's. (ii) `parseCookie`'s `index` specifically: report
claimed→proven with the box-site census delta by carrier (the 13 local-carrier
sites are the target). (iii) Full-capture equivalence A/B by test id across
the kill switch — the "What must still decline" list is unchanged and
load-bearing; booleans stay OUT of the step-1 arm (an i32-branded return
assigned into a numeric local is exactly the `${b}` → `1` trap — decline
mixed boolean/number, as the return-map's own prover already does).
(iv) The pinned cookie runtime-dynamic A/B per the 2026-08-09 methodology,
switch-off control, checksum equality; report honestly including a null
result.

**Out of scope:** the IR lattice pass (still blocked on coverage — the
pre-flight table in slice 1 stands), new carrier kinds, peephole.

## Slice-2 result (2026-08-21)

Branch `claude/issue-4121-interprocedural-proofs`, based on `3c976394a`.
Every claim below was measured in this container, on this base, with the
kill-switch control run for it.

### Anchor drift (the plan's line numbers had moved)

| plan said | actually on `3c976394a` |
| --------- | ----------------------- |
| `inferBindingAwareNumericReturnTypes` at `param-return-inference.ts:1142` | `:1163` |
| wired at `index.ts:4651` / `:7886` | `:4753` / `:8106` |
| consumed at `declarations.ts:588` | `:700` |

### The ordering fact the plan did not have

`inferBindingAwareNumericReturnTypes` **reads** `ctx.numericLocalVerdict`
(`param-return-inference.ts:1167` bails without it), and that verdict is
produced by the local fixpoint the plan wanted to feed the return map INTO. So
the two cannot be one pass. They are stratified instead:

| level | pass | grounded in |
| ----- | ---- | ----------- |
| 1 | `analyzeNumericPropertyNames` → grounded slot verdict | itself (least fixpoint) |
| 2 | `inferBindingAwareNumericReturnTypes` → return carriers | level 1 |
| 3 | `refineNumericLocalsWithCallReturns` → re-run of level 1 with the level-2 fact | level 2 |

Nothing feeds level 3 back into level 2, so no carrier can be laundered
through a cycle. Level 3 is **gated**: `bindingAwareNumericCallEvidence`
answers `undefined` — no second pass, byte-identical output — unless the return
map names an `f64` carrier the level-1 `numericFunctions` set does not already
have.

### Step 1 — the route-2 call-definition arm: landed, and narrower than hoped

Route 2 **already had** a direct-call arm: `sets.numericFunctions.has(callee.text)`.
It is a whole-program *greatest* fixpoint and is broader than the return map in
almost every respect. The one thing it cannot do is tell two same-named
functions apart, because it is keyed by NAME:

```js
const o = { g: function(){ return "s"; } };
function g(x){ return x + 1; }
function f(){ var i = g(1); i = i + 1; return o.g().length + i * 2; }
```

`o.g` withdraws the name `g` for every declaration sharing it, so `i` stayed
boxed. `inferBindingAwareNumericReturnTypes` resolves the callee to its exact
declaration and keeps the verdict. Measured A/B on that shape:

| | `$i` slot |
| --- | --- |
| default-on | **f64** |
| `JS2WASM_NUMERIC_RETURNS=0` | externref |
| `JS2WASM_NUMERIC_ADMISSION=0` | externref |

Value agrees with node (`7`) in all three legs. Kill switches compose as the
plan required; no new env var.

**On the target module it does nothing, and the reason is measurable.** For the
pinned `cookie@2.0.1` module the return map is **EMPTY**
(`inferBindingAwareNumericReturnTypes` returns 0 entries) and `numericFunctions`
is **EMPTY** too; the grounded slot set is `{i, min, min, min, start}`. Both
fact sources are silent about `endIndex`/`eqIndex`, so there is nothing for the
arm to import. Root cause is one level up: `endIndex`'s `len` parameter is fed
`str.length` where `str` is the unannotated parameter of the exported
`parseCookie`, so nothing proves it is a string, so nothing proves `len` is a
number. That is the issue's own "second, independent gap in proving a string
receiver for an unannotated parameter", and it is upstream of both of this
slice's arms.

### Step 2 — the route-1 argument-use arm: DECLINED, with the measurement

Sub-case (b) was already conditional in the plan. Sub-case (a) is declined too,
on two independent grounds.

**(1) Its yield on both benchmark modules is zero — measured as an UPPER BOUND,
not argued.** A deliberately unsound probe was applied that classifies EVERY
call-argument use as ToNumber-invariant (strictly more permissive than any
sound version of (a) could be), and the emitted output was diffed:

| module | default | every argument use assumed safe | diff |
| ------ | ------: | ------------------------------: | ---- |
| pinned `cookie@2.0.1` | 175,932 bytes | 175,932 bytes | **identical** |
| `benchmarks/cross-engine/axes-core.js` | 140,867 bytes | 140,867 bytes | **identical** |

The reason is visible in the per-use bail census for `parseCookie`'s `index`:

```
index  CallExpression       endIndex(str, index, len)      ← argument
index  CallExpression       eqIndex(str, index, len)       ← argument
index  CallExpression       valueSlice(str, index, eqIdx)  ← argument
index  BinaryExpression     index < len                    ← relational, NOT an argument
index  BinaryExpression     index === -1                   ← strict equality
```

Clearing the three argument bails leaves `index < len` — a relational whose
other operand (`len`) is itself a boxed local, so it is not statically numeric.
`endIdx` likewise keeps `endIdx + 1` (`+` is a hard bail by design). **Every
candidate in the module has at least one non-argument bail**, so the argument
arm cannot flip any of them.

**(2) The only fact that would make (a) sound is circularly defined.** An f64
argument is representation-exact exactly when the callee's parameter is emitted
as f64. That ABI is decided by `inferParamTypeFromCallSites`
(`param-return-inference.ts:438`), which decides it *by asking
`ctx.usageInference.scalarForDecl(arg)`* — the very verdict the argument rule
would be computing. Wiring it would make the answer depend on which declaration
is collected first (`UsageInference` memoizes per function, so the first query
pins it), which is a determinism hazard in the emitted bytes, not just a
precision one. The grounded param-slot verdict is a non-re-entrant alternative
but is NOT the same fact — `parameterDefinitionsAgree` admits a slot on a
ToNumber trust boundary even when some argument is opaque, so it does not imply
the f64 ABI.

Recorded rather than attempted. Closing it wants the param-ABI decision lifted
out of the usage-inference query, which is its own piece of work.

### Box-site census of the standalone cookie module, before/after

Site definition: one boxing operation = one smi fast-path
`(if (result externref) (then … ref.i31 …) (else …))` in a USER function
(`$__*` helpers ARE the boxing machinery). This scanner is not slice 1's, so
the absolute counts are not comparable with the 19/13 reported there; the
before/after DELTA is measured with the identical scanner on both legs.

| carrier | before (base `3c976394a`) | after | delta |
| ------- | ---------------------------------: | ----: | ----: |
| local | 12 | 12 | +0 |
| argument | 4 | 4 | +0 |
| other | 16 | 16 | +0 |
| **total** | **32** | **32** | **+0** |

Per function, unchanged: `parseCookie` 8, `valueSlice` 8, `parseSetCookie` 7,
`endIndex` 4, `eqIndex` 4, `decode` 1. Nothing relocated to another carrier
because nothing moved at all.

### Perf: a null result on the pinned lane, stated as an artifact identity

The pinned runtime-dynamic artifact was rebuilt exactly as
`perfCookieStandaloneDynamic` / `compileStandaloneLane` builds it — `compileMulti`
over `{cookie.js, __npm-compat-benchmark.mjs}`, `target: standalone`,
`deferTopLevelInit`, `optimize: 4`, runtime seed 3751 — and hashed:

| leg | bytes | imports | checksum (120,000 @ 3751) | SHA-256 |
| --- | ----: | ------: | ------------------------: | ------- |
| base `3c976394a` (the four changed files reverted in place) | 57,467 | 0 | 120,000 | `517a92ee758042df832249c860b31214d62cd1c94393798498a59eb24807cf05` |
| this slice, default-on | 57,467 | 0 | 120,000 | `517a92ee758042df832249c860b31214d62cd1c94393798498a59eb24807cf05` |
| this slice, `JS2WASM_NUMERIC_ADMISSION=0` | 57,467 | 0 | 120,000 | `517a92ee758042df832249c860b31214d62cd1c94393798498a59eb24807cf05` |
| this slice, `JS2WASM_NUMERIC_RETURNS=0` | 57,840 | 0 | 120,000 | `387b4920c8cb8b5015517d283d574dc5979237e059a077952f85f62dcd1eb805` |

The first three are **byte-identical**, so the 2026-08-09 timing methodology
(separate processes, warm-ups, alternating order, seed 3751, checksum equality)
would be measuring one artifact against itself — scheduler noise, not a
compiler change. The hash equality is the stronger claim and it is what is
reported. (The fourth row is the pre-existing 2026-08-09 return-carrier
checkpoint, not this slice; it is included so the switch is not mistaken for a
no-op in general.)

The single-source cookie compile is byte-identical too
(175,932 bytes, `d29b00d6ef83925279bf46f2b99958ca92da4379eefa966f2ac570ede37526c0`
before and after), as is `axes-core` (140,867 bytes).

### Equivalence: full capture, A/B by test id (AC 6)

Both legs captured their failing/passing sets per test id (`PARTIAL_OUT`), 8
shards each — a single unsharded run is still OOM-killed on this
4-core/16 GB container and exits 2 with "vitest produced no JSON report",
which is not a pass (slice 1's method note, re-confirmed). All 16 shards
reported "No new equivalence regressions".

```
slice ON : 24 failing / 1661 passing
slice OFF: 24 failing / 1661 passing        (JS2WASM_NUMERIC_ADMISSION=0)
baseline known failures: 36

failing ONLY with the slice ON  (regressions caused by this slice): 0
failing ONLY with the slice OFF (fixed by this slice):              0
failing (ON) and NOT in baseline:                                   0

VERDICT: failing sets IDENTICAL across the kill switch; all 24 baselined.
```

**12 baseline entries now PASS and were NOT ratcheted here** — the baseline is
stale relative to current `main`, not to this slice (each passes with the
switch on AND off): `issue-1197` (1), `math-pow-test262-pattern` (1),
`spec/coercion-arithmetic-add` (8), `symbol-basic` (2). Slice 1 saw one of
these; the set has grown as `main` advanced. Ratcheting them belongs to
whoever owns the baseline, not to a perf slice.

### Two pre-existing divergences found while writing the negative tests

Neither is caused or fixed by this slice — both reproduce identically with
`JS2WASM_NUMERIC_ADMISSION=0`, with `JS2WASM_NUMERIC_RETURNS=0`, and on plain
`origin/main`. Recorded here rather than worked around silently:

| minimal repro (standalone) | node | js2 |
| -------------------------- | ---: | --: |
| `function m(x){ if (x>5) return true; return x+1; } var v = m(9); \`${v}\`.length` | 4 | **1** |
| `var u; (typeof u).length` | 9 | **NaN** |

The first is the `` `${b}` `` → `1` trap appearing on a **boxed** carrier —
`var v = true` alone prints `"true"` correctly, so it is specific to a boolean
arriving through a call into an `any` local. The second has no call and no
boolean in it at all. Both want their own issues.

### Acceptance criteria status after this slice

- **AC 1** — unchanged (slice 1). The IR-pass half stays blocked on
  #2855-successor coverage.
- **AC 2 — NOT achieved, and now with the blocker named precisely.**
  `var i = s.indexOf(";"); i = i + 1;` still emits `externref` when `s` is the
  unannotated parameter of an exported function. Neither this slice's landed arm
  (call-return) nor its declined arm (argument-use) touches the cause: nothing
  proves `s` is a string. Pinned as an explicit `it("still declines row 4 …")`
  so the next slice has to flip it deliberately. Note the row is receiver-
  dependent: with a visible `f("a;b")` call site it is **already f64** today.
- **AC 3 — achieved (vacuously, and stated as such).** IR-claimed coverage is
  unchanged by this slice — every artifact above is byte-identical, so the
  denominator cannot have moved. No speedup is claimed.
- **AC 4** — unchanged (earlier checkpoint).
- **AC 5 — achieved.** Census above, before/after, by carrier, same scanner.
- **AC 6 — achieved.** Full-capture equivalence run + kill-switch A/B by test
  id; see the PR body for the run output.

## Relationship to adjacent work

- **#4118 / PR #4062** specializes named hot paths (`indexOf`, `find`, counted
  push loops). Complementary: that closes specific kernels, this closes the
  generic carrier boxing underneath all of them.
- **#1624** (`wont-fix`) proposed changing the box *representation* to a WasmGC
  `$Value` struct. Different problem — it still boxes, and its premise (host
  calls) is already solved in standalone, which has zero imports.
- **#2773** is value-rep for struct identity/typeIdx across dispatch, not
  numeric unboxing.
