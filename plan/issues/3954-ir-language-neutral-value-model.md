---
id: 3954
title: "Name the IR's ambient ECMAScript assumptions: factor the JS value model behind a tag-domain seam"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-17
assignee: "ttraenkler/claude-js-ir-generalization"
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: backend-agnostic-ir
# (#3102) Phase 1's growth in these five files is the seam itself plus the
# comments that make it legible — the change is behaviour-neutral (emitted
# bytes verified identical) and NET-REMOVES logic from them: the payload-shape
# and tag-naming tables they used to read directly now live in the new
# `src/ir/tag-domain.ts` / `src/ir/js-tag-domain.ts` leaves. The +24 in
# nodes.ts and +9 in verify/builder are the documented rationale for the
# `TagId` leaf and the domain calls that replaced `jsTagUnboxKind`/`JsTag[…]`.
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/verify.ts
  - src/ir/lower.ts
# (#3400) +6 lines in lower.ts's `box`-to-dynamic arm: the one explicit
# TagId -> JsTag crossing plus the four-line note saying why it exists and
# what it refuses. Splitting `emitInstrTree` is a real and separate task
# (#3399); paying for it inside a behaviour-neutral seam change would make
# this PR unreviewable against its own byte-identity claim.
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
---

# Name the IR's ambient ECMAScript assumptions

## Problem

**The IR's ECMAScript assumptions are ambient rather than named.** `IrType` does
not have "a dynamic value type" — it has *ECMAScript's* dynamic value type,
spelled as a closed enum, and nothing in the tree marks it as such. The type
lattice, the propagation rules, the truthiness and numeric-coercion predicates
all encode ECMA-262 semantics as if they were facts about compilation in
general.

That is a maintainability defect in the JavaScript compiler, independently of
whether a second front-end ever exists:

- **You cannot tell a spec decision from an engineering decision by reading the
  code.** When `dynTruthy` treats a value a particular way, is that ECMA-262
  §7.1.2 or a lowering convenience? Today the only way to know is to already
  know. Every future change to dynamic-value handling re-litigates that
  question from scratch.
- **There is no boundary to violate, so nothing can be reviewed against one.**
  New JS-specific behaviour lands anywhere in the IR without friction, because
  no rule says where it belongs. The neutral half and the ECMAScript half are
  interleaved by accident of authorship.
- **The two halves have different change rates and different owners.** The
  neutral half (control flow, calls, closures, layout) is stable compiler
  infrastructure; the ECMAScript half tracks spec conformance and moves with
  test262. Interleaving them means conformance churn touches infrastructure and
  vice versa.

Naming the boundary is the deliverable. A second source language becomes
*possible* as a side effect, but that is a secondary benefit and this issue
should not be scheduled or descoped on it — see "Second front-end: honest
scoping" below.

### The boundary is already half-built

**Downward, the boundary is real and deliberate.** `docs/ir/ir-contract.md`
(frozen #3030-T1) consistently says **"producer"**, never "the TypeScript
front-end"; `docs/architecture/target-architecture.md` draws an explicit
"IR INTERCHANGE BOUNDARY — serializable, versioned (#3030)"; and the five-part
backend contract (`src/ir/backend/`, frozen #3029-S1) already has three
in-tree realizations plus `backend/porffor/`. A non-TypeScript producer is
contemplated by the architecture and partly paid for.

**Upward, the JS value model is hardcoded into the IR's own type system.**
Measured on `main` at 2026-08-01:

| Signal | Value |
| --- | --- |
| `IrInstr` kinds in `src/ir/nodes.ts` (union arms) | **78** |
| …that are language-neutral (control flow, calls, objects, closures, vecs, slots, refcells, try/throw) | **~40** |
| …that encode ECMAScript semantics (`dyn*`, `tagTest`, `string.*`, `iter.*`/`gen.*`/`forOf.*`, `await`/`async*`, `extern.*`, `regexp`, `class.super*`) | **~35** |
| `ts.` references in `src/ir/lower.ts` | **23** (in 4,013 lines — effectively decoupled) |
| `ts.` references in `src/ir/from-ast.ts` / `select.ts` | **785** / **1,055** |

The load-bearing defect is one type. `JsTag` (`src/ir/js-tag.ts:42`) is a
**closed enum** — `NumberI32 | NumberF64 | Boolean | String | Object |
Function | Null | Undefined` — and it is baked directly into the IR's type
lattice as `IrType = … | { kind: "dynamic"; tag?: JsTag }`
(`src/ir/nodes.ts:358`). Every dynamic instruction (`tagTest`, `dynTruthy`,
`dynToNumber`, `dynEq`, `dynMemberGet`, `dynMemberSet`) and the propagation /
evidence machinery (`propagate.ts`, `type-evidence.ts`, `analysis/lattice.ts`)
dispatch on that fixed set.

So the IR does not have "a dynamic value type" — it has *ECMAScript's* dynamic
value type, spelled as an enum no other language can extend. Python's
`int`/`float`/`str`/`bytes`/`tuple`/`list`/`dict`/`set`/`None`/instance
partition cannot be expressed at all.

**There is a working counterexample in-tree, which is why this is a refactor
and not a research project.** Strings are *already* parameterized:
`IrStringEncoding = "ascii" | "utf8-guaranteed" | "wtf16"`
(`src/ir/string-runtime.ts:7`). The string half of the value model took the
shape this issue proposes for the tag half, and nothing broke.

### Why now, and why `high`

The cost is **strictly monotonic in time** and this issue is cheap today and
expensive later:

- Routing tag reads through a seam is mechanical *now* (one enum, a bounded set
  of dispatch sites). After another ~40 IR instruction kinds land under
  `ir-full-coverage`, it is a tree-wide rewrite.
- It does **not** compete with `ir-full-coverage` for the same files. The
  adoption work is concentrated in `from-ast.ts`/`select.ts` (the TS-coupled
  producer); this issue touches `js-tag.ts`, `nodes.ts`, `propagate.ts`,
  `type-evidence.ts`, `analysis/lattice.ts` — the consumer side.
- Phase 1 alone is a **behaviour-neutral** change: JS stays the only tag domain,
  the emitted bytes must not move. That makes it safely interleavable with
  in-flight IR work in a way a later big-bang factoring would not be.
- The ratchet is the durable part. Once the gate exists, the boundary stops
  eroding whether or not anyone ever writes a second front-end — which is
  precisely why the justification does not rest on one.

### Second front-end: honest scoping

The original framing of this issue led with "prepare for Python." That
overstates the payoff and is not why it should be scheduled. For the record, so
nobody picks this up expecting a bigger prize than there is:

- **Python's structural fit is good.** PEP 484 type hints are to Python what
  TypeScript is to JavaScript, which is exactly the precondition that makes
  js2wasm's AOT bet tractable; mypyc already demonstrates the speedup is real.
  The WasmGC precedents (Kotlin, Dart, Java, OCaml, Scheme) are all typed or
  already-GC'd languages, and "typed Python" has that shape.
- **But the addressable niche is narrow.** Essentially every existing
  Python→Wasm effort (Pyodide, CPython wasm32, componentize-py, RustPython,
  MicroPython, and py2wasm via Nuitka) ships an interpreter. They do that
  because the C-extension ecosystem — numpy, scipy, pandas, torch — is written
  against the CPython C API and a flat `PyObject*` heap. A WasmGC AOT compiler
  **cannot** run those, not "cannot yet": the object representation is
  incompatible by construction. For most people asking for Python-in-Wasm, the
  answer they need is numpy.
- **What is genuinely unoccupied** is typed Python → standalone WasmGC module,
  no interpreter, no CPython: edge functions, plugin sandboxes, embedded
  scripting. Real, but small, and entered behind Codon (LLVM/native-first) and
  mypyc (needs CPython).
- **Where the design does clearly beat the interpreter ports:** module size and
  startup (no runtime to ship), and host-GC integration — WasmGC objects are
  collected by the host, whereas a linear-memory Python heap is invisible to the
  host collector, so cycles spanning the boundary leak. That is a structural tax
  the interpreter ports cannot retrofit away.

**A C++ front-end is not on this axis at all** and is a hard non-goal — see
Non-goals.

## Progress

**Phase 1 (the tag-domain seam) — IMPLEMENTED 2026-08-19.**

New files: `src/ir/tag-domain.ts` (the neutral interface, ZERO imports),
`src/ir/js-tag-domain.ts` (`JS_TAG_DOMAIN`, the sole implementation),
`src/ir/producer.ts` (the single wiring point),
`scripts/check-jstag-seam.mjs` + `scripts/jstag-seam-baseline.json` (the
ratchet, wired into `quality`), `tests/issue-3954-tag-domain.test.ts`.

- `IrType`'s dynamic leaf is `{ kind: "dynamic"; tag?: TagId }`. `TagId` is a
  **branded** number, so `JsTag.String` is no longer assignable and the IR core
  cannot *write* an ECMAScript partition into a dynamic type. The JavaScript
  producer (`from-ast.ts`) names them through `JS_TAG_IDS`, which is in-layer.
  **Corrected 2026-08-19 by phase 3 (W4): the brand is ONE-DIRECTIONAL.**
  TypeScript assigns a branded `number` to a numeric enum, so `JsTag -> TagId`
  is blocked (verified) while `TagId -> JsTag` needs **no cast at all** — a
  foreign producer's tag flows into `JsTag`-typed code silently and fails at
  RUN time, not compile time. Phase 1's guarantee therefore covers the
  direction that stops core code writing a JS tag, and **not** the direction a
  second producer actually takes. Earlier phrasings of this line ("the IR core
  literally cannot name an ECMAScript partition") overstate it.
- **Every ECMA-262 predicate behind the seam cites its clause**
  (ToBoolean §7.1.2, ToNumber §7.1.4 incl. §7.1.4.1 StringToNumber and §7.1.1
  ToPrimitive, `typeof` §13.5.3, Annex B §B.3.6 `[[IsHTMLDDA]]`), and the
  transcription is cross-checked against a real engine in the test rather than
  merely restated. `numericCoercionOf` separates the arms that can run USER
  CODE (Object/Function → ToPrimitive) from the pure ones — the distinction an
  optimizer actually needs and the one the old code could not express.
- Carrier kinds **delegate** to `jsTagUnboxKind`; no second tag table (D4).
- Direct `JsTag` value usage under `src/` measured with the gate's own counter:
  **HEAD 4 files / 4 value imports / 57 refs → 2 files / 2 / 42.** The two that
  remain are deliberate: `from-ast.ts` (the JS producer) and `integration.ts`
  (the WasmGC lowering, which emits these integers as `$AnyValue.tag`
  constants). `verify.ts` and `builder.ts` now ask the domain
  (`carrierKindOf` / `nameOf`) and hold `JsTag` as a TYPE only.
- Behaviour-neutral, verified by running BOTH arms: sha256 of the emitted
  binary for `website/playground/examples` × {gc-host, gc-native-strings,
  standalone, wasi} (44 rows) and for 32 dynamic-path snippets × 3 modes
  (96 rows, all compiling) — **identical before and after**.
- The ratchet was negative-tested before being wired in (a deliberate
  `import { JsTag }` + two reads in `src/ir/propagate.ts` fails it with a
  file-and-field report; restored, green again).

**Deliberately NOT converted in phase 1** — recorded so the next slice does not
read the remainder as an oversight:

- The **instruction-level** `jsTag` fields (`nodes.ts` `unbox` / `tag.test`)
  and the `IrDynamicLowering` handle contract (`backend/handles.ts`, frozen
  #3029-S1) still speak `JsTag`. The issue's phase-1 text scopes the change to
  `IrType`'s dynamic leaf; widening it to the frozen backend contract is a
  larger, separately-reviewable move. `jsTagOf` / `tagIdOfJsTag` are the two
  explicit crossings.
- `check-jstag-seam.mjs` is **not** wired into the post-merge banking job
  (`baseline-summary-sync.yml`), matching `check:ir-fallbacks`, which is not
  either. `--update-on-decrease` exists and was exercised locally.

**Corrections to phase 1's own text**, from measuring it:

- "58 `JsTag.` references across 24 files" conflates two counts. On `main`
  there were **58 `JsTag.` member reads in 7 files**; 24 files mention `JsTag`
  at all, and several of those are the **oracle's unrelated same-named type**
  (`src/checker/oracle.ts` exports a `JsTag` string union). The ratchet
  excludes it explicitly.
- `propagate.ts`, `type-evidence.ts` and `analysis/lattice.ts` are named as
  consumers to convert; **none of them references `JsTag` at all**. `lattice.ts`
  is the ownership/access lattice (#1587) and is unrelated to tags.
- "the truthiness / numeric-coercion predicates that `dynTruthy` /
  `dynToNumber` currently hardcode" — there was **nothing per-tag to move**.
  `dyn.truthy` / `dyn.to_number` delegate wholesale to runtime helpers
  (`__any_unbox_bool` / `__any_to_f64` / `__is_truthy` / `__unbox_number`); the
  only TypeScript-side ToBoolean table is `lowerToBooleanForCondition`, keyed
  on the **carrier kind**, not the tag. So the domain's predicates are newly
  *stated* rather than relocated, and phase 1 keeps them non-load-bearing on
  purpose: consuming them (folding `if (x)` when `x` is a proven Object) would
  move bytes, which phase 1 forbids.

**Phase 2, first slice — LANDED 2026-08-17** (sequenced ahead of phase 1 by
project-lead decision, on the cost-of-delay measurement in #4551: phase 2 is
O(instruction kinds), and kinds went 51 -> 78 in the three months to
2026-08-01, with `ir-full-coverage` expected to add ~40 more).

- `src/ir/dialect/js.ts` holds the **23 uncontested** ECMAScript kinds:
  `dyn.*` (5), `iter.*` + `forof.iter` (6), `gen.*` (4), `await`/`async.*` (3),
  `extern.*` incl. RegExp (5). `nodes.ts` 3,441 -> 3,032 lines.
- Declaration moves and re-exports only. All 54 importers of `nodes.js`
  unchanged; `import type` throughout, so the core<->dialect cycle has no
  runtime edge.
- `scripts/check-ir-dialect.mjs` enforces both rules (single core->dialect
  edge; every dialect name re-exported), wired into `quality`. Both rules were
  negative-tested against deliberate violations before being wired in.
- Verified: repo typecheck clean; `tests/ir-*.test.ts` run serially shows the
  same 2 failures as base (`ir-bytecode-proof` OP.CALL, `ir-scaffold` selector
  shape) -- both pre-existing on `main`, neither touched by this change.

**Deliberately NOT moved**: `vec.*`, `class.*`, `object.*`, `string.*`,
`box`/`unbox`/`tag.test`, `forof.vec`/`forof.string`, `coerce.to_externref`.
Whether those are neutral is genuinely unsettled -- spot-checks reversed the
intuitive reading more often than they confirmed it. **#4551** owns the
per-kind verdict; an unresolved kind stays in core rather than being placed on
a hunch.

Phase 1 (the `TagDomain` seam) is untouched and still the larger correctness
win; its surface is 58 `JsTag.` member reads in 7 files (see the phase-1
notes: the earlier "24 files" figure counted files merely mentioning the name,
including an unrelated same-named type in `src/checker/oracle.ts`).

**Phase 2, remaining move plan — settled 2026-08-19 by #4551's gate.**

`scripts/check-ir-kind-neutrality.mjs` now carries a per-kind verdict with a
cited `{file, quote}` for each, re-verified every run (a rotted citation fails
rather than reporting a stale answer). Population pinned at **82** = 78
`IrInstr` arms + 4 `IrTerminator` arms; the 3 symbolic-reference kinds
(`IrFuncRef`/`IrGlobalRef`/`IrTypeRef`) are excluded and the 85 `readonly kind:`
fields are reconciled explicitly. Current output: **53 neutral · 26 js · 3
unresolved**, 59 in core / 23 in dialect.

That collapses the seven contested families above to a **three-kind move list**
and two open questions. Most of the "deliberately NOT moved" set came back
**neutral**, which is the outcome worth recording — the intuitive reading was
wrong more often than right, exactly as the spot-checks predicted:

| family | verdict | what settled it |
| --- | --- | --- |
| `vec.*` (5) | neutral | the IR **refuses** holes, and `src/codegen/array-holes.ts` has no importer anywhere under `src/ir/` — asserted as a standing absence check, not a one-time grep |
| `class.*` (8) | neutral | nominal, closed-world, tag-based `instanceof`, allocate-then-init — not ECMAScript's `[[Construct]]`/prototype protocol |
| `object.*` (3) | neutral | declared record layout; the open-map half is `dyn.member_*`, already in the dialect |
| `box`/`unbox`/`tag.test` (3) | neutral | the residual is the tag vocabulary itself, which phase 1's `TagDomain` now owns — as #4551 anticipated |
| `coerce.to_externref` (1) | neutral | host-boundary, not language |
| `string.*` (6) | 3 neutral / 2 js / 1 unresolved | the JS shape is in the **operation set**, not the encoding (`IrStringEncoding` already parameterizes that) |
| `forof.vec` / `forof.string` (2) | neutral / js | they are not the same call |

**Slice A — the move list, exactly 3 kinds**: `string.char_at`,
`string.char_code_at`, `forof.string` → `src/ir/dialect/js.ts`. Same shape as
the first slice: declaration moves plus re-exports, `import type` only, no
importer changes. Acceptance is the gate's own counter — `jsInCore` **3 → 0**,
verdict totals otherwise unchanged, typecheck clean, `tests/ir-*.test.ts` at
the same 2 pre-existing failures.

**Slice A LANDED 2026-08-19.** `jsInCore` 3 -> 0; placement 59-core/23-dialect
-> 56/26; verdict totals unchanged at 53/26/3, which is the acceptance signal
that nothing was reclassified in passing. `tests/ir-*` at the same 2
pre-existing failures (327 passed).

Two things the plan did not anticipate, recorded because **the first recurs on
every future slice**:

1. **A verdict's citation follows its declaration.** The neutrality gate
   re-verifies each `{file, quote}` as a literal substring, and all three moved
   kinds cited quotes that live *inside* the declarations being moved — so the
   gate fails with "the cited evidence is gone from `src/ir/nodes.ts`" until the
   citation's `file` is retargeted to `dialect/js.ts`. That is a feature working
   as designed (a rotted citation is supposed to fail), but it means **a move is
   never confined to `nodes.ts` + the dialect + the baseline**: it always also
   edits the verdict table. Expect it on slice B.
2. **The dialect now has a downward import**: `IrStringEncoding` from
   `../string-runtime.js`, type-only. `string-runtime.ts` sits *below* the node
   layer, so this is an ordinary downward edge rather than a second
   core<->dialect one — R1 constrains who imports *into* `dialect/`, not what
   the dialect imports. Worth a reviewer's eye anyway (#4552), since it is the
   first time the dialect depends on anything but `nodes.ts`.

**Slice B — the payload-vocabulary leak**, which is a shape neither this issue
nor #4551's contested list anticipated. `binary` and `intrinsic` are
**unresolved**, and no declaration move fixes them: the *interface* is neutral
while the *payload enum* is ECMAScript-tainted. `IrBinop` carries six `js.*`
ToInt32 composites; `IntrinsicId` carries the `math.*` set. A dialect rule
phrased over declarations passes both R1 and R2 while the leak sits inside the
operand vocabulary. The unit of the fix is therefore the **enum**, not the
file — either a dialect-tagged op namespace (which is the same open-namespace
question #4552 raises for `instrKind` in the schema) or a split enum with the
JS composites behind the dialect. That is a design call, not a mechanical move,
and it belongs to #4552's reviewer.

**Still open, one policy call**: `string.len` — code units or code points is a
language decision, not a placement one, and the gate records it `unresolved`
rather than guessing.

**This slice was implemented by the Opus lane, not by this issue's owning
lane.** `backend-agnostic-ir` is Lane B (fable) per
`plan/method/lane-partition.md`; the cross-lane implementation was directed by
the project lead. **#4552** tracks the Fable-lane architect review of it. PR
#4644 was held as a draft to gate on that review; the lead's call was to
un-draft it once it was a working checkpoint, and it **merged 2026-08-17**, so
the review is post-merge. #4552's scope has since widened to cover #4551's gate
and phase 1 as well.

**Phase 3 (the falsification) — RUN 2026-08-19. Verdict: the seam is REAL for
the type lattice and NOMINAL for every operation on a dynamic value.**

`tests/issue-3954-phase3-nonjs-domain.test.ts` (18 tests) builds **Abacus**, an
exact-arithmetic language with six partitions numbered 1001–1006 — deliberately
disjoint from `JsTag`'s 0–7, so a JS assumption fails loudly instead of
reinterpreting an Abacus partition as a JavaScript one:

| tag | carrier | why JS cannot produce it |
| --- | --- | --- |
| `Unit` | — (singleton) | ECMAScript has **two** nullary values; Abacus has one |
| `Rune` | i32 | a Unicode scalar as a first-class **scalar**; JS has no character type, and U+1F600 is *two* JS code units |
| `Nat` | ref | arbitrary-precision natural |
| `Int` | ref | arbitrary-precision integer, with a genuine **`Nat <: Int`** so `joinTags` returns a supertag rather than top |
| `Text` | ref | codepoint-indexed, and **refuses** numeric coercion where §7.1.4.1 StringToNumber accepts it |
| `Cap` | i32 | an **affine** capability — used once, never copied; no ECMAScript analogue at all |

The single cleanest proof it is not JavaScript wearing a hat: **no partition has
an `f64` carrier and none coerces to a numeric constant**, so there is no `NaN`,
no `-0` and no `Infinity` anywhere in the model. ECMAScript cannot avoid f64 —
`Number` *is* a double (§6.1.6.1).

**What worked (the seam is real here).** An Abacus program whose parameter and
result types are **derived from `ABACUS_TAG_DOMAIN.carrierKindOf`** — not
hand-written — passes `verifyIrFunction`, passes `verifyIrBackendLegality(…,
"bytecode")`, is lowered by the production `lowerIrFunctionBody` through
`BytecodeEmitter`, and **executes on the real `runProgram`**, returning
arbitrary-precision (`bigint`) answers via handles across a two-frame `OP.CALL`.
A `box` whose target carries an Abacus partition also verifies clean —
`verify.ts`'s box-to-dynamic rule never reads the refinement.

**What did not (the seam is nominal here).** Six walls, each pinned by an
assertion in the test rather than described, so closing one turns an expectation
red:

| # | site | what it is |
| --- | --- | --- |
| W1 | `src/ir/backend/legality.ts:451` / `:300` | **The bytecode backend rejects the `dynamic` IrType outright**, and the `box`/`unbox`/`tag.test` instructions with it. This is a *backend-capability* wall, not a seam wall — a JS-domain dynamic is rejected identically (asserted as a control) — but it means **phase 3's literal vehicle cannot carry a tag-bearing value at all**, for any domain. |
| W2 | `src/ir/lower.ts:1764` | `jsTagOf(instr.toType.tag)` is unconditional, so box-to-dynamic with an Abacus refinement throws `tag id 1003 is not an ECMAScript partition`. Control: the identical function with the refinement **dropped** reaches the backend handle. The tag is the only thing in the way. |
| W3 | `src/ir/verify.ts:673` | `defaultTagDomain()`. `verifyIrFunction(func)` takes one argument and `IrFunction` carries no producer/domain field, so **there is no channel by which the verifier could be told which domain the IR belongs to.** |
| W4 | `src/ir/nodes.ts:1072` / `:1093` | `unbox.jsTag` / `tag.test.jsTag` are typed `JsTag` — **and the brand is one-directional.** TypeScript assigns a branded `number` to a numeric enum, so `TagId → JsTag` is silently legal (no cast, no `@ts-expect-error` needed) while `JsTag → TagId` is correctly blocked. The direction the brand does *not* cover is exactly the one a second producer takes; the failure lands at run time in W3 instead of at compile time. |
| W5 | `src/ir/builder.ts:481` | `emitUnbox(value, jsTag: JsTag)` — the only construction API for the instruction takes the ECMAScript enum, and computes the result ValType from the JS domain. |
| W6 | `src/ir/backend/handles.ts:283/300/308/319` | the frozen (#3029-S1) `IrDynamicLowering` is `JsTag`-typed member by member, and `emitToBoolean`/`emitToNumber` are §7.1.2/§7.1.4 **by definition**, not by parameter. |

**Quantified**: of the four things a `TagDomain` owns (partition set, carrier
kinds, refinement lattice, coercion predicates), the first three ride the IR
end-to-end and the fourth is inert — nothing under `src/` reads
`truthinessOf`/`numericCoercionOf`/`classOf`. Of the three tag-bearing
instructions, **zero** can be built, verified or lowered in a non-JS domain.

**One source change, and only one.** `TagTruthiness` gained a
`"not-coercible"` arm (`src/ir/tag-domain.ts`; zero imports preserved). Abacus
has no implicit boolean coercion, and the union offered only three
ECMAScript-shaped answers — so the synthetic domain could not state its own
semantics without lying. `TagNumericCoercion` already had `"throws"` for "this
language refuses"; truthiness did not, and that asymmetry is the tell. Nothing
under `src/` consumes the predicate, so widening the union moves no bytes.

**Reported, deliberately NOT fixed** (each has consumers or is a design call, so
fixing on a test-writing slice would be scope creep with a latent bug):

- `TagCarrierKind` has no `"i64"`. It is exactly `$AnyValue`'s payload set, so a
  language with a machine-int64 partition cannot state its carrier — and adding
  the arm needs a matching `builder.ts:487` change, where an unknown carrier
  currently falls through to `externref`.
- `TagNumericCoercion.constant.value` is a JS `number`, so a domain whose
  numeric tower does not fit in an f64 cannot express a constant coercion.
- `verifyIrFunction` / `IrFunctionBuilder` / `lowerIrFunctionBody` should take
  the domain (defaulting to `defaultTagDomain()`) rather than reaching for the
  global. That alone does **not** unblock the falsification — W4's field type
  still forces `JsTag` — but it is the prerequisite for W3.
  *(Done for `verifyIrFunction` and `IrFunctionBuilder` in the phase-3 follow-up
  below. `lowerIrFunctionBody` still does not take one, deliberately: its only
  domain question is the `TagId → JsTag` crossing into the frozen
  `IrDynamicLowering` contract, so giving it a domain parameter before W2/W6
  would add a channel nothing could yet use.)*

**What closing this would cost**, in dependency order: widen `unbox`/`tag.test`'s
`jsTag` to `TagId` (W4) → thread the domain through verify/builder (W3, W5) →
widen `IrDynamicLowering` to `TagId` and move the `jsTagOf` crossing *into*
`integration.ts`, where `$AnyValue.tag` actually lives (W2, W6). That last step
edits a contract frozen by #3029-S1 and is the "larger, separately-reviewable
move" phase 1 named. W1 is orthogonal and would be closed by giving the bytecode
VM a boxed-value representation, which is #1584's business, not this issue's.

### Phase 3 follow-up — W4, W5 and W3 CLOSED (2026-08-19)

The first three steps of that dependency order are done. **W2, W6 and W1 are
untouched and remain open**, for the reasons the table already gives.

| wall | before | after |
| --- | --- | --- |
| W4 | `unbox.jsTag` / `tag.test.jsTag`, typed `JsTag` (`nodes.ts`) | `unbox.tagId` / `tag.test.tagId`, typed `TagId`. `nodes.ts` no longer imports `js-tag.ts` **at all** — not even as a type. |
| W5 | `emitUnbox(value, jsTag: JsTag)`, result ValType computed from `defaultTagDomain()` reached inside the method | `emitUnbox(value, tagId: TagId)` / `emitTagTest(value, tagId: TagId)`, answering from a `TagDomain` the builder **holds** (5th ctor arg, default `defaultTagDomain()`) |
| W3 | `verifyIrFunction(func)`, `defaultTagDomain()` at the point of use | `verifyIrFunction(func, domain = defaultTagDomain())`, threaded → `verifyBlock` → `verifyInstrStructure` |

**Renamed, not just re-typed — and the rename was free.** The brand blocks
`JsTag → TagId`, so *every* construction site had to change the moment the field
type widened; renaming `jsTag` → `tagId` on those same lines cost no extra sites.
Leaving the name would have kept an ECMAScript word on a core-neutral node while
the type underneath said otherwise, which is precisely the kind of half-closed
seam #3954 exists to remove.

**The one-directional brand is STILL OPEN at the language level — the widening
made it unreachable at these three sites, it did not close it.** TypeScript
still assigns a branded `number` straight to a numeric enum, so `TagId → JsTag`
compiles with no cast anywhere. What now stands on that is the `IrDynamicLowering`
contract (W6): `lower.ts` routes each crossing through `jsTagOf`, whose **runtime**
check is the actual guard. The phase-3 test pins this explicitly rather than
letting the closed walls imply it is gone. Closing it at the type level would
mean branding `JsTag` too (`js-tag.ts` is ABI — the enum's numeric values are
`$AnyValue.tag` constants asserted by tests, so it must stay a numeric enum) or
making `TagId` not structurally a `number` (an opaque object/symbol, which costs
the free `===` comparisons the lattice helpers and every `switch (tagIdValue(t))`
rely on). Neither is worth it while W6 is the only consumer; the honest answer is
that W2/W6 removes the last crossing, and *that* closes it by deletion.

**Behaviour-neutral, measured not assumed.** A 180-compile corpus (the 9 repo
example files × 5 option modes + 13 hand-written dynamic-path snippets × 5 modes;
153 produce a binary) was compiled on the base commit and again after the change:
**every sha256 identical, byte for byte.** The corpus was checked to actually
reach the changed instructions — an instrumented run counts 3 `emitUnbox`,
33 `emitTagTest` and 12 refined `box`-to-dynamic constructions, so the paths are
exercised rather than merely present. (`unbox` is reachable from the JS producer
at exactly ONE site — the standalone primitive-wrapper `instanceof` helper,
`from-ast.ts:11348` — and only under `target: "standalone", fast: true`.)

**Gate counters.** `check:jstag-seam` went **`valueImports 2 → 1`, `refs 42 → 38`**
— `from-ast.ts` drained completely, because its four `JsTag.X` reads became
`JS_TAG_IDS.X`; `integration.ts` (the WasmGC lowering, which emits these integers
as `$AnyValue.tag`) is now the sole remaining consumer. Banked with
`--update-on-decrease`. `check:ir-kind-neutrality` verdict totals are **unchanged**
(53 neutral / 26 js / 3 unresolved, 56 core / 26 dialect, 8 residuals); the
`unbox` evidence citation was retargeted from `readonly jsTag?: JsTag;` to
`readonly tagId?: TagId;` and the `box`/`unbox`/`tag.test` residual prose now
names the *remaining* residual (the `TagId → JsTag` crossing in the lowering
pass) instead of the operand type, which is no longer ECMAScript.

**Two corrections to this issue's own working assumptions, both verified on the
base commit rather than inferred:**

- `tests/issue-2949` carries **7** pre-existing failures, not the 2 that had been
  named. `issue-2949-s5-5-dyn-arith.test.ts` has 2, and
  `issue-2949-slice2-dynamic-producers.test.ts` (3) and
  `issue-2949-slice3b-any-dynamic.test.ts` (2) have the rest. All 7 reproduce on
  the base with none of this work applied. They are unrelated to the tag seam and
  want their own look; the figure is recorded here so the next slice does not
  mistake a stale baseline for a regression it caused.
- **No CI gate typechecks `tests/`.** `tsconfig.json` sets
  `include: ["src/**/*.ts"]` and `exclude: [… "tests"]`, `tsconfig.ts7.json`
  extends it without overriding either, and there is no `typecheck:tests` script.
  The consequence for this issue specifically: the `@ts-expect-error` markers in
  `tests/issue-3954-phase3-nonjs-domain.test.ts` that pin the brand's
  directionality are **documentation, not an enforced assertion** — an
  `@ts-expect-error` that no lane compiles cannot fail when the thing it expects
  stops erroring. If the brand assertion is meant to be load-bearing (and W4's
  finding is the argument that it should be), it needs a lane that actually runs.
  Out of scope here; recorded so it is not assumed.

## Non-goals

- **Not** a Python front-end, and **not justified by one**. This issue adds no
  `from-python.ts`, no Python parser, no Python runtime. It makes a second
  producer *possible* as a side effect; do not schedule, descope, or cancel this
  issue based on whether a Python front-end is wanted. *(Reaffirmed 2026-08-18: Python is
  descheduled and gated on the linear backend; phases 1–3 proceed now on this
  issue's own justification. See phase 4.)*
- **Not** a C++ front-end, now or later. C++ needs value semantics,
  copy/move/destructors, RAII scope-exit lifetimes, raw pointers and pointer
  arithmetic, precise struct layout/ABI, unsigned integer types, and template
  monomorphization. `IrType`'s `object`/`class`/`boxed` kinds all assume
  GC-managed reference identity and cannot express "destroyed at scope end".
  A C++ front-end should target LLVM. Explicitly out of scope — do not design
  for it.
- **Not** a change to the backend axis. WasmGC vs linear stays exactly as
  `docs/architecture/codegen-axes.md` describes.
- **Not** a behaviour change in phase 1. Output must be byte-identical.

## Proposal

Four phases, each independently mergeable. Phases 1–2 are the whole point;
phases 3–4 are only worth starting once a real second producer is funded.

### Phase 1 — the tag-domain seam (M, behaviour-neutral) ← the actual ask

Replace direct `JsTag` enum reads with an indirection, while JS remains the
only implementation:

- Introduce a `TagDomain` interface in a dependency-free leaf beside
  `js-tag.ts`: the set of tags, each tag's Wasm-carrier kind (generalizing
  `jsTagUnboxKind`), the subtyping/join lattice, and the truthiness / numeric
  coercion predicates that `dynTruthy` / `dynToNumber` currently hardcode.
- Make `IrType`'s dynamic leaf carry an opaque tag id resolved against a
  module-level `TagDomain`, not a bare `JsTag` member.
- Provide `JS_TAG_DOMAIN` as the sole implementation and wire it at the single
  place the producer is chosen.
- Ratchet it: a CI gate (same shape as `check:ir-fallbacks` /
  `check:oracle-ratchet` — committed baseline, growth fails,
  `--update-on-decrease` banks improvements) counting direct `JsTag` value
  imports outside the domain leaf, so the seam cannot silently re-erode.

Acceptance: emitted binaries byte-identical across the change; test262 host and
standalone pass counts **identical**, not "within tolerance".

### Phase 2 — dialect split of `nodes.ts` (M, mechanical)

Split the 3,271-line `nodes.ts` into a neutral core and a `js` dialect
(MLIR-style), enforced as a dependency-lint rule rather than a convention.
This makes "is this instruction neutral?" answerable per instruction by path
instead of by argument, and it is the artifact that keeps phase 1's win from
decaying. No behaviour change — declaration moves and re-exports only.

### Phase 3 — prove neutrality without a new front-end (M)

Do **not** validate the seam by writing a Python producer. Validate it with the
existing `backend/bytecode-vm.ts` plus a synthetic non-JS tag domain
constructed in tests: build IR carrying a tag domain JS could not produce
(e.g. arbitrary-precision int, codepoint strings) and assert it lowers and
verifies. This is the cheap falsification test — if it can't be written, the
seam is nominal.

### Phase 4 — Python producer, out-of-tree, via the #3030 serialized contract

**NOT SCHEDULED. Gated on the linear-memory backend (project-lead decision,
2026-08-18).** Two calls, recorded together because the second follows from the
first:

1. **Phases 1–3 proceed now**, on their own maintainability justification —
   unchanged, and explicitly not contingent on Python.
2. **Python is deferred and now depends on the LINEAR backend**, not WasmGC.
   This supersedes the 2026-08-17 note that scheduled a Python PoC directly
   after phases 1–3, and it resolves the WasmGC-vs-linear fork that note left
   open.

#### What choosing linear decides

- **The "impossible by construction" objection dissolves.** The reason a
  WasmGC AOT compiler cannot serve the C-extension ecosystem is that numpy et
  al. are written against a flat `PyObject*` heap and the CPython C API. Linear
  memory *is* a flat heap. That does not deliver numpy — the CPython C **ABI**
  (struct layouts, refcount macros, `PyTypeObject`, the buffer protocol) is a
  far larger surface than the compiler — but it moves the question from
  impossible to expensive.
- **It becomes the #4538 engine-link program applied to CPython**, not an IR
  project. It would reuse #4539's shared-memory link topology, #4540's heap
  coexistence, and #4542's refcount/handle-scope discipline — CPython is
  refcounted like QuickJS, so that pass transfers almost directly. Most of the
  cost lands outside `src/ir/`.
- **It forfeits host-GC integration, and that is an accepted cost, not an
  oversight.** This issue's own analysis names host-GC integration as one of
  two things the WasmGC design beats the interpreter ports on: a linear-memory
  Python heap is invisible to the host collector, so cycles spanning the
  boundary leak. Choosing linear means taking that tax rather than being
  differentiated by avoiding it. Module size and startup — the other
  differentiator — survive.
- **It inherits the linear lane's maturity problem.** #2956 only recently wired
  the linear backend onto the IR front-end, and #4550 measured a **0 % claim
  rate on five real npm entry modules**. A producer on a lane that claims none
  of the real code is not viable; that gate has to close first.
- **It inherits #3299's non-goal, which linear makes harder to hold.** Do not
  adopt an external engine's object layouts, builtins or GC wholesale; ADR-0020
  is a deliberately *scoped* exception for the dynamic residue. The pull to
  exceed that scope is much stronger when the goal is C-extension
  compatibility.

When phase 4 is eventually scoped it should be filed as its own issue under the
standalone/linear program with an explicit `depends_on` covering #2956, #4550
and the #4538 family — not carried as a phase of an IR-neutrality issue, whose
justification is independent.

#### Corrections to the 2026-08-17 note

Two things that note claimed became false when Python was descheduled, and are
corrected rather than left standing:

- **The `instrKind` namespace is NOT a hard dependency.** With no scheduled
  out-of-tree producer, opening it (`anyOf: [enum, dialect.op pattern]`) is an
  option-preserving move, not a blocker. What is unchanged is that it is cheap
  **now** and stops being cheap once anything consumes `IR_FORMAT_VERSION` 5.x
  — so it still has an expiry, just not a dependent. See #4552's "two schema
  questions".
- **#4551 is not on a Python critical path.** Its verdicts on the contested
  families (`vec.*`, `object.*`, `string.*`, `class.*`) stand on the dialect
  boundary's own terms; they are not owed to a producer that is not scheduled.

**Phase 3 is now the ONLY validation of neutrality**, which raises rather than
lowers its importance: with no real second producer coming, the synthetic
non-JS tag domain through `backend/bytecode-vm.ts` is the whole falsification
story. It was already the better *test* (Python is dynamically typed and
duck-typed, so it exercises largely the same IR paths JS does and would never
stress `union`/`box` with sum types or `try`/`throw` with `Result`-style
errors — a better demo, a worse test). Do not descope it.

#### If and when it happens

It consumes the serialized IR as an out-of-tree producer — no changes to
`from-ast.ts`.
Known gaps to solve **there**, not here: arbitrary-precision `int` (nothing in
`IrType` expresses it — on linear this is an ordinary bignum runtime or a
linked one); `__getattribute__` + descriptor protocol vs JS property lookup on
`dynMemberGet`; MRO / multiple inheritance vs single-inheritance
`IrClassShape`; codepoint vs UTF-16 string indexing (partly covered by
`IrStringEncoding`).

## Acceptance criteria

- [x] A `TagDomain` seam exists; `IrType`'s dynamic leaf no longer names
      `JsTag` directly. (`src/ir/tag-domain.ts`; the leaf carries a branded
      `TagId`.)
- [x] `JS_TAG_DOMAIN` is the only implementation and is wired at one place.
      (`src/ir/js-tag-domain.ts`, chosen in `src/ir/producer.ts`.)
- [x] A ratcheted CI gate bounds direct `JsTag` value imports outside the domain
      leaf, with a committed baseline and an `--update-on-decrease` mode.
      (`scripts/check-jstag-seam.mjs`, in `quality`; negative-tested.)
- [x] Emitted binaries are byte-identical across phase 1 on the
      `website/playground/examples` corpus. (Also on 32 dynamic-path snippets;
      both arms run.)
- [ ] test262 host and standalone pass counts are unchanged (identical).
      **CI must confirm** — the suite is a sharded `merge_group` job and was not
      run locally.
- [x] A test constructs a non-JS tag domain and lowers IR through the bytecode
      backend with it. **Phase 3, done 2026-08-19** —
      `tests/issue-3954-phase3-nonjs-domain.test.ts`. Met **partially and
      knowingly**: IR built against the Abacus domain's own carrier decisions
      lowers through the production `lower.ts` and RUNS on `runProgram`, but a
      **tag-bearing** instruction cannot be lowered through that backend by any
      domain (W1), and cannot be built in a non-JS domain at all (W2–W6). The
      answer to "is the seam nominal?" is *for operations on dynamic values,
      yes* — see "Phase 3 (the falsification)" above for the six walls with
      file:line and what closing each costs.
- [x] Every ECMA-262-derived predicate moved behind the seam cites its spec
      clause, so a reader can tell a conformance decision from a lowering
      convenience — this is the issue's primary deliverable, not a nicety.
- [x] `docs/architecture/codegen-axes.md` gains a short "producer axis" note
      naming the seam and stating the C++ non-goal, so the boundary is
      documented where the other axes are.

## References

- `src/ir/js-tag.ts:42` — the closed `JsTag` enum.
- `src/ir/nodes.ts:358` — `IrType`'s `{ kind: "dynamic"; tag?: JsTag }` leaf.
- `src/ir/string-runtime.ts:7` — `IrStringEncoding`, the in-tree precedent for a
  parameterized value-model dimension.
- `docs/ir/ir-contract.md` (#3030-T1) — the frozen, producer-neutral IR contract.
- `docs/architecture/target-architecture.md` — the IR interchange boundary.
- `src/ir/backend/README.md` (#3029-S1) — the five-part backend contract; the
  already-neutral half of the pipeline.
- `docs/architecture/codegen-axes.md` — the two existing orthogonal axes this
  adds a third to.
