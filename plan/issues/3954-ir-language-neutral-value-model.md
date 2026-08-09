---
id: 3954
title: "Name the IR's ambient ECMAScript assumptions: factor the JS value model behind a tag-domain seam"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: backend-agnostic-ir
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

## Non-goals

- **Not** a Python front-end, and **not justified by one**. This issue adds no
  `from-python.ts`, no Python parser, no Python runtime. It makes a second
  producer *possible* as a side effect; do not schedule, descope, or cancel this
  issue based on whether a Python front-end is wanted.
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

Only if phases 1–3 land and a Python front-end is actually wanted. It consumes
the serialized IR as an out-of-tree producer — no changes to `from-ast.ts`.
Known gaps to solve **there**, not here: arbitrary-precision `int` (nothing in
`IrType` expresses it); `__getattribute__` + descriptor protocol vs JS property
lookup on `dynMemberGet`; MRO / multiple inheritance vs single-inheritance
`IrClassShape`; codepoint vs UTF-16 string indexing (partly covered by
`IrStringEncoding`).

## Acceptance criteria

- [ ] A `TagDomain` seam exists; `IrType`'s dynamic leaf no longer names
      `JsTag` directly.
- [ ] `JS_TAG_DOMAIN` is the only implementation and is wired at one place.
- [ ] A ratcheted CI gate bounds direct `JsTag` value imports outside the domain
      leaf, with a committed baseline and an `--update-on-decrease` mode.
- [ ] Emitted binaries are byte-identical across phase 1 on the
      `website/playground/examples` corpus.
- [ ] test262 host and standalone pass counts are unchanged (identical).
- [ ] A test constructs a non-JS tag domain and lowers IR through the bytecode
      backend with it.
- [ ] Every ECMA-262-derived predicate moved behind the seam cites its spec
      clause, so a reader can tell a conformance decision from a lowering
      convenience — this is the issue's primary deliverable, not a nicety.
- [ ] `docs/architecture/codegen-axes.md` gains a short "producer axis" note
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
