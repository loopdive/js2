---
id: 4121
title: "perf: generic carrier unboxing — one `any`-typed definition boxes an entire numeric local, and every carrier needs its own bespoke pass"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
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

## Acceptance criteria

- [ ] A pre-flight report of **which benchmark functions the IR currently
      claims** vs demotes. If `benchMethod` / `parseCookie` are demoted, this
      issue is blocked on #2855 rather than ready, and that finding closes the
      slice on its own.
- [ ] `let i = 0; i = s.indexOf(";") + 1;` in a loop emits an `f64` local with
      **zero** `__box_number` / `__unbox_number` in the loop body.
- [ ] IR-claimed coverage reported alongside every speedup, so a headline number
      cannot hide a shrinking denominator.
- [ ] The standalone `cookie` runtime-dynamic lane improves measurably against
      node, measured same-container interleaved behind a kill switch, with the
      checksum unchanged.
- [ ] The residual box sites in the standalone cookie module are reported
      before/after, by carrier, so the "relocated to the next carrier" failure
      mode is visible rather than silent.
- [ ] No equivalence-suite regressions — confirmed by a **full-capture** run and
      an A/B of the failing set with the kill switch off, not by a count match.

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

## Relationship to adjacent work

- **#4118 / PR #4062** specializes named hot paths (`indexOf`, `find`, counted
  push loops). Complementary: that closes specific kernels, this closes the
  generic carrier boxing underneath all of them.
- **#1624** (`wont-fix`) proposed changing the box *representation* to a WasmGC
  `$Value` struct. Different problem — it still boxes, and its premise (host
  calls) is already solved in standalone, which has zero imports.
- **#2773** is value-rep for struct identity/typeIdx across dispatch, not
  numeric unboxing.
