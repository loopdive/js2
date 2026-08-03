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
area: codegen
language_feature: value-representation
goal: performance
related: [684, 3683, 3754, 3765, 4118, 2773, 1624]
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

## Proposal — assign representations over a carrier graph

Replace the per-carrier wiring with one representation-assignment pass:

1. **Nodes** = every value carrier: locals, parameters, returns, struct fields,
   array elements, and call arguments.
2. **Edges** = the assignments/flows between them (a def, an argument bind, a
   return, a field write). This is the union of what the four existing
   consumers already compute separately.
3. **Solve** for a consistent unboxed assignment: a carrier is `f64` when every
   carrier that flows into it is `f64` and every literal def is numeric —
   a least fixpoint, so cycles carry no evidence and stay boxed (the same
   groundedness argument #3765 needed).
4. **Box only at the frontier** — the edges that cross into genuinely dynamic
   territory (an exported entry point's parameter, a host/dispatch boundary, a
   carrier with a non-numeric def).

The key difference from today is that the verdict is **not per-carrier-kind**,
so a numeric value flowing local → argument → parameter → return → field stays
unboxed for the whole chain instead of being re-boxed at each hop that has no
bespoke pass yet.

### Gate on the emitted slot, not the declared type

Whatever shape the pass takes, the admission gate must key on **the
representation codegen is about to emit**, not on the checker's declared type.
That single change is what makes the `let i = 0; i = s.indexOf(…)` case visible
at all, and it is independent of the rest of the proposal — it may be worth
landing first as its own slice.

## Acceptance criteria

- [ ] `let i = 0; i = s.indexOf(";") + 1;` in a loop emits an `f64` local with
      **zero** `__box_number` / `__unbox_number` in the loop body.
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
