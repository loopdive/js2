# Codegen axes: backend lowering vs front-end IR

> Read this before touching anything under `src/codegen/`, `src/codegen-linear/`,
> or `src/ir/`. It should take ~10 minutes. If it takes longer, file an issue
> against this doc.

> **A third axis — the producer axis — is being drawn (#3954).** The two axes
> below are about *lowering*; the producer axis is about *which source language
> an instruction's semantics come from*. Its first slice has landed: the 23
> uncontested ECMAScript instruction kinds now live in `src/ir/dialect/js.ts`,
> behind the `scripts/check-ir-dialect.mjs` gate. See
> [The producer axis](#the-producer-axis) below.
>
> **A C++ front-end is an explicit non-goal** — value semantics, RAII
> scope-exit lifetimes, pointer arithmetic and precise ABI layout are outside
> what `IrType`'s GC-managed `object`/`class`/`boxed` kinds can express. That
> should target LLVM. Do not design for it.

## TL;DR

There are **two orthogonal axes** in the compiler back-half. They are not a
single linear progression of "old → new". A change to codegen lives on
**exactly one** axis; pick the right one before you write a line.

```
                 ┌──────────────────────────────────────────────────┐
                 │                  Front-end axis                  │
                 │  direct AST→Wasm   <───>   typed IR (src/ir/)    │
                 │  (legacy, hacks)            (replaces hacks)     │
                 └──────────────────────────────────────────────────┘
                                       ×
                 ┌──────────────────────────────────────────────────┐
                 │                  Backend axis                    │
                 │  WasmGC lowering   <───>   Linear-memory         │
                 │  (browser / GC)            (WASI / C ABI)        │
                 │  src/codegen/              src/codegen-linear/   │
                 └──────────────────────────────────────────────────┘
```

- **Backend axis (lowering)** — WasmGC vs linear memory. **Alternatives**, not
  rivals. The target dictates the choice (browser/JS host → WasmGC; WASI /
  Component Model → linear). Both stay.
- **Front-end axis (representation)** — direct AST→Wasm vs IR. IR
  **replaces** the accumulated direct-codegen hacks (155+ workarounds tracked
  in #1098). IR adopts AST node kinds step by step; on each adopted kind it
  is the only path. The two backends can both lower from IR — once IR
  declares a node kind backend-agnostic.

## North star (the end state)

This is the explicit architectural commitment (goal `ir-full-coverage`,
elevated 2026-07-02; ratchet #2855):

1. **ALL AST node kinds route through the IR front-end** (`src/ir/from-ast.ts`).
   One parse, one type-resolution, one normalization — for every kind. The
   staged adoption below is a _sequencing_ plan for getting there, not a
   partition of kinds into "IR kinds" and "direct kinds".
2. **WasmGC vs linear memory is purely a backend fork** — a choice made _below_
   the IR, behind the `BackendEmitter` trait (#1713; `WasmGcEmitter` /
   `LinearEmitter`, two-backend proof #1714). Backend-divergent Wasm shapes are
   expressed as emitter intents, not as separate front-ends.
3. **The legacy direct AST→Wasm path is deprecation-tracked, not a peer.** Both
   `src/codegen/`'s front-end role and `src/codegen-linear/`'s direct AST
   reading are the shrinking remainder: every kind still on them is an entry in
   `plan/log/ir-adoption.md` with an owner and a bucket in the #1376 fallback
   ratchet. "Both backends stay" (backend axis) must never be read as "the
   direct front-end paths stay" — they don't.

## The three paths (and why they look like three)

| Path                  | Size              | Role                                                                                                                                                                                                                                |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/codegen/`        | 2.3 MB, ~44 files | Direct AST→Wasm. Default fallback. WasmGC lowering. The "legacy" hacks live here. **Front-end role is deprecation-tracked** (per-kind in `plan/log/ir-adoption.md`); the WasmGC lowering knowledge migrates behind `WasmGcEmitter`. |
| `src/codegen-linear/` | 320 KB, 6 files   | Direct AST→Wasm. Selected by `target: "linear"`. Linear-memory lowering (WASI / C ABI). **Its direct AST reading is likewise transitional** — the linear lowering plugs into IR via `LinearEmitter` (#1714).                        |
| `src/ir/`             | 652 KB, 11 files  | Typed IR built from the AST (`from-ast.ts`) and lowered via `lower.ts` + the `BackendEmitter` trait. **The end-state front-end for all kinds.** WasmGC is the complete backend today; linear consumes the trait-migrated groups.    |

`src/ir/` looks like a third path, but conceptually it sits on the
front-end axis. The current `lower.ts` happens to emit WasmGC ops because
the first IR-aware backend was WasmGC; the `BackendEmitter` trait (#1713,
proven on two backends by #1714) is how the linear lowering plugs into the
same IR. **Both backends keep existing** — but the direct AST→Wasm
_front-ends_ do not: they are the transitional remainder for kinds IR has
not adopted yet (see the north star above). Divergent lowering is not a
reason to stay direct — it is exactly what the emitter trait expresses.

`src/ir/types.ts` is intentionally shared: it defines the **Wasm-level
`Instr` union** that both `lower.ts` (IR's WasmGC lowerer) and
`src/codegen-linear/index.ts` emit. That sharing is bookkeeping convenience,
not coupling — both backends emit Wasm, so both need a Wasm-level data type.

## Which axis is my change on?

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Are you adding a new AST node kind or fixing how one is compiled?      │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Does the Wasm shape differ between WasmGC and linear memory?           │
│  e.g. WasmGC needs `array.new`, linear needs `memory.grow` + offset.    │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
        Yes — diverges          No — same shape modulo
                │                ops mapped from the IR
                ▼                       │
       The divergence lives             ▼
       in the backend LAYER:    Adopt in `src/ir/`:
       an intent on the         add the kind to from-ast.ts,
       `BackendEmitter` trait   build the IR node in nodes.ts,
       with a WasmGC impl and   lower in lower.ts. Once both
       a linear impl (#1713/    backends consume IR for the
       #1714). A direct-path    kind, delete the direct-codegen
       fix is a stopgap for a   branch as a follow-up.
       not-yet-adopted kind —
       record it in
       plan/log/ir-adoption.md.
```

If your change is a pure backend concern — e.g. tweaking how `array.new`
is emitted, fixing a linear-memory layout, adding a new WasmGC subtype —
it lives in the backend file. Don't add a knob to the IR for it.

If your change is a structural front-end concern — type propagation,
binding resolution, control-flow normalization, scope handling — it
lives in IR. Don't add another flag to `src/codegen/expressions.ts`.

## Concrete example: a new array method

> "I'm adding `Array.prototype.includes`. Where does it go?"

1. The semantics are AST-level: take an array, walk it, return a bool.
2. The Wasm shape for the walk is:
   - WasmGC: load the array struct, `array.len`, loop `array.get`, compare.
   - Linear: load the array's base pointer + length from a header, loop
     `i32.load` from `base + i*stride`, compare.
3. Both backends share the same control-flow skeleton and bool result.

Right answer: **define an `IrArrayIncludes` node** (or extend the existing
`IrArrayMethodCall`) in the IR. Each backend's lowerer translates it to its
own op sequence. The direct-codegen branch in `src/codegen/expressions.ts`
either delegates to the same lowering helper or is deleted once IR owns the
kind end-to-end.

Wrong answer: write two separate ad-hoc implementations in
`src/codegen/expressions.ts` and `src/codegen-linear/index.ts`. That doubles
the surface for every fix.

Counter-example: **GC reference equality**. If you're adding `ref.eq` (a
WasmGC-only op with no linear-memory twin), the _op_ is a backend detail:
today it lives in `src/codegen/` directly; end-state it is the
`WasmGcEmitter` implementation of a backend-agnostic identity-comparison
intent (whose linear implementation compares pointers/handles). The IR node
says "compare object identity" — it never names `ref.eq`. What IR must not
carry is a node whose _semantics_ only exist on one backend.

## The producer axis

The two axes above are both about **lowering** — which Wasm shape, from which
front-end representation. The producer axis is a different question:

> **Does this instruction's meaning come from a language specification, or from
> compilation in general?**

`dyn.truthy` is ECMA-262 §7.1.2. `iter.next` is the JS iterator protocol.
`await` is JS async semantics. None of them means anything to a source language
that is not JavaScript. Those live in **`src/ir/dialect/js.ts`**. The neutral
core — control flow, calls, closures, refcells, slots, arithmetic, try/throw —
stays in `src/ir/nodes.ts`.

The boundary is enforced, not conventional (`scripts/check-ir-dialect.mjs`, in
`quality`): only `nodes.ts` may import a dialect (it assembles the `IrInstr`
union and re-exports the names), and it must re-export every name a dialect
declares. The split is a declaration move — all 54 importers of `nodes.js` are
unaffected.

**Unsettled kinds stay in core.** `vec.*`, `class.*`, `object.*`, `string.*`,
`box`/`unbox`/`tag.test`, `forof.vec`/`forof.string` and `coerce.to_externref`
are *not* in the dialect, because whether they are neutral is genuinely open —
`vec.*` array holes turn out to live in `src/codegen/array-holes.ts`, above the
IR, and `string.*` is already parameterized by `IrStringEncoding` rather than
hardcoding UTF-16. #4551 owns the per-kind verdict. Placing a kind on a hunch
gives a guess the authority of a lint rule.

Why this axis was drawn before the `ir-full-coverage` push rather than after:
the work is O(instruction kinds), and kinds went 51 → 78 in the three months to
2026-08-01. Doing it later costs proportionally more, and `ir-full-coverage` is
expected to add roughly 40 more.

### The tag-domain seam (#3954 phase 1)

The dialect split answers "which instruction kinds are JavaScript's?". The
**tag-domain seam** answers the other half: "what does a *dynamic value* mean?".

`IrType`'s dynamic leaf no longer names ECMAScript. It carries an opaque
`TagId` resolved against a **`TagDomain`** (`src/ir/tag-domain.ts`, a
zero-import leaf) that states four things about a source language's dynamic
values: the partition set, each partition's Wasm-carrier kind, the refinement
lattice, and the truthiness / numeric-coercion predicates.

- **`src/ir/js-tag-domain.ts`** is the sole implementation — ECMAScript. Every
  predicate arm there **cites its spec clause** (ToBoolean §7.1.2, ToNumber
  §7.1.4, …), so a reader can tell a conformance decision from a lowering
  convenience without already knowing which it is. That legibility is the
  deliverable; a second front-end is a side effect.
- **`src/ir/producer.ts`** is the single wiring point — a pure lookup from
  producer id to domain, deliberately not a mutable global (a domain left set
  by a previous compilation would silently reinterpret the next one's tags, and
  this process runs many compilations).
- **`scripts/check-jstag-seam.mjs`** (in `quality`) ratchets it: a committed
  per-file baseline of direct `JsTag` value usage under `src/`, growth fails,
  `--update-on-decrease` banks improvements. Two files remain by design — the
  JavaScript producer (`from-ast.ts`, entitled to name JavaScript partitions)
  and the WasmGC lowering (`integration.ts`, which emits these integers as
  `$AnyValue.tag` constants).

**C++ is an explicit non-goal on this axis, now and later.** It needs value
semantics, copy/move/destructors, RAII scope-exit lifetimes, pointer
arithmetic, precise struct layout/ABI and template monomorphization;
`IrType`'s `object`/`class`/`boxed` kinds all assume GC-managed reference
identity and cannot express "destroyed at scope end". A C++ front-end should
target LLVM. Do not design for it.

Full design: #3954 (four phases — this tag-domain seam, the dialect split,
synthetic-tag-domain falsification, out-of-tree producer).

## When NOT to use IR yet

IR adoption is staged. Some node kinds _should_ stay in direct codegen
today because lowering them through IR would force a premature backend
decision or would leave too many fallback paths. Every row below is a
**deprecation-tracked exception** (north star: the table empties), not a
durable design partition — except the wont-fix features, which die with
the direct path rather than migrate.

Stay in `src/codegen/` (direct) until the listed issues land:

| Node kind                | Reason                                                     | Tracking |
| ------------------------ | ---------------------------------------------------------- | -------- |
| Class methods (full)     | `class-method` fallback in select.ts is the largest bucket | #1370    |
| Async / generator bodies | Generator state machines are WasmGC-shaped today           | #1373    |
| Destructuring params     | Param-shape selector rejects them                          | #1372    |
| `eval`, `with`, `Proxy`  | Deferred features — not coming                             | wont-fix |
| Generic type parameters  | Needs monomorphisation                                     | (future) |

`scripts/ir-fallback-baseline.json` is the ratchet. When a kind is
adopted, its bucket goes to zero and the demote-to-warning escape hatch
in `src/codegen/index.ts` is removed for that kind — see #2855.
(Bucket-zero is necessary but **not sufficient** to make a reason a hard
error via `STRICT_IR_REASONS`; see #3341 and the escape-hatch section below.
The baseline's `postClaim` section is the same ratchet for failures AFTER
the claim, gated by `STRICT_IR_POSTCLAIM_CODES`.)

## Current hidden bias in `src/ir/` (and what to do about it)

The IR was bootstrapped against WasmGC. A grep for WasmGC ops inside IR
files surfaces real coupling that the orthogonality claim cannot yet
deliver on. None of these are bugs — they reflect IR being one backend old.

| File                                  | Bias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Lift plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ir/lower.ts`                     | **Partially behind the `BackendEmitter` trait (#1713).** The pass-through group (locals/globals/const/arithmetic/control flow) and the **vec** group (`emitVecLen`/`emitVecDataPtr`/`emitElemGet`, serving `vec.len`/`vec.get`/`forof.vec`) now route through `emitter.*` instead of pushing `struct.get`/`array.get` inline. The aggregate (object/class/union), closure/refcell, and ref-coercion groups **have now been moved** behind typed `BackendEmitter` primitives (#2953, DONE) — they no longer emit `struct.new`/`struct.get`/`ref.cast` inline. The residue is small and tracked: **5 GC-op literals** remain in `lower.ts` (`class.get`/`class.set`/union-`instanceof` tag read still emit `struct.get`/`struct.set` via `pushRaw` at ~L1797/1815/1908, and `forof.str` pushes `struct.get` directly onto the raw sink at ~L2614/2674, bypassing the trait) — an internal inconsistency, not whole un-migrated groups. Async/Promise + string ops stay inline by design (string ops are already behind `resolver.emit*`). | `WasmGcEmitter` (`src/ir/backend/wasmgc-emitter.ts`) is the behaviour-identical impl. **#1714 (DONE): the vec group is now the first node kind lowered through the trait to TWO backends** — `LinearEmitter` (`src/ir/backend/linear-emitter.ts`) emits the same `emitVecLen`/`emitVecDataPtr`/`emitElemGet` intents to linear memory (`i32.load`/offset arithmetic) instead of WasmGC struct/array ops, proving the seam abstracts a real second backend (`tests/ir-vec-two-backend.test.ts`). #1715 adds a bytecode emitter. |
| `src/ir/types.ts`                     | `Instr` union includes both GC ops (`struct.*`, `array.*`, `ref.cast`) and linear ops (`memory.size`, `i32.load`, etc.).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | This is shared _Wasm encoding_, not IR. Both backends emit Wasm, both need the union. Stays.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/ir/passes/tagged-union-types.ts` | Names WasmGC struct/array layouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Move to a backend trait when the linear backend grows IR-driven tagged unions.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/ir/nodes.ts` `IrType.boxed`      | Assumes a boxed scalar is a `(struct (field $val))`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keep abstract at the IR level; let each backend pick its boxing strategy (struct vs heap object vs nan-boxing).                                                                                                                                                                                                                                                                                                                                                                                                                |

The **explicit claim**: today, IR adoption gives you a typed front-end
that lowers fully on the WasmGC backend and partially (the trait-migrated
groups) on linear. IR adoption on the linear backend is **committed
direction, not a maybe** — `LinearEmitter` (#1714) already consumes the
same emitter intents for the vec group, and each group that moves behind
the `BackendEmitter` trait becomes linear-capable by implementation
rather than by a separate front-end. The remaining inline WasmGC emission
in `lower.ts` is staged under #1713.

## The fallback-to-warning escape hatch (`src/codegen/index.ts`)

Today, if the IR path throws while compiling a function the selector
claimed, the failure is logged at severity `"warning"` and the legacy
direct-codegen body is kept. This makes the IR safe to enable by default
without breaking test262, but it also masks real IR bugs. Two sites — cited
by **anchor, not line number**, because absolute line citations in this file
have gone stale twice (`889-896`, then `~1889/~2390`) while the code moved:

- the `catch` around the per-claim override-map build in `planIrOverlay`,
  which emits `IR path: could not resolve types for <name>` at `"warning"`
  and records a `type-resolution-unsupported` / `resolve` preparation
  failure (the #1921 contract);
- `formatIrPathFallbackDiagnostic`, consumed by `consumeIrOverlayReport`
  for every `IrIntegrationError` in the integration report — an IR
  build/verify/lower throw.

Three sets gate promotion out of that channel: `STRICT_IR_REASONS`
(selector rejections — empty, and correctly so),
`STRICT_IR_BUILD_ERRORS` (#3341 Slice B — the name-repoint invariants,
non-empty), and `STRICT_IR_POSTCLAIM_CODES` (#3341 Slice C — typed
`unsupported` codes whose post-claim arm restates a gate the selector
already applied; non-empty, see `plan/log/ir-adoption.md`'s post-claim
table for the per-code classification).

**This is a transitional safety net, not the final design.** #2855 phases
the warning channel out. The endgame: when a node kind is IR-owned, the
selector either claims it (and IR succeeds) or it stays direct (and the
selector reports a structured "deferred" reason). There is no third
"IR claimed it and silently fell back" state.

**Promoting a reason to strict is per-reason, not a corpus-zero flip
(#3341).** A reason absent from `scripts/ir-fallback-baseline.json` only
means the 13-file playground corpus doesn't happen to trigger it — it does
**not** mean the reason is unreachable on real code. Reasons like
`external-call`, `call-graph-closure`, `param/return-type-not-resolvable`,
`type-resolution-failure`, and `class-method` describe **legitimate**
IR-non-claimability (an external dependency, an unclaimable callee, an
unresolvable type, a computed/generator/abstract method name) that the
legacy path must still catch. Adding such a reason to `STRICT_IR_REASONS`
would turn those legitimate fallbacks into hard compile errors and regress
real programs. STRICT promotion is therefore gated on first making a
_specific_ reason genuinely unreachable in the IR (real #2855-family
adoption work), reason by reason — not a documentation flip.

If you're reading this and the warning channel still exists, treat any
new warning here as an error — it means a regression slipped past the IR
fallback budget (`pnpm run check:ir-fallbacks`).

## See also

- [`target-architecture.md`](target-architecture.md) — the **end-state
  module architecture** (layer stack, the five-part backend contract a new
  backend — MLIR or others — would implement, reviewability rules with CI
  ratchets, migration map) and the serializable IR interchange contract for
  external consumers. Umbrella issues #3029/#3030. This doc (codegen-axes)
  stays authoritative for "which axis is my change on"; that one answers
  "where does the code end up".
- `plan/log/ir-adoption.md` — table of AST node kinds × IR status. The
  ratchet's source of truth. Updated when a kind moves between
  `direct-only`, `mixed`, and `ir-owned`.
- `docs/adr/0012-intermediate-representation.md` — the original ADR for
  the IR. Background reading, not authoritative for current state.
- #1098 — direct-codegen hack inventory (the thing IR replaces).
- #1131 — IR Phase 2 plan (what's claimed today).
- #1370, #1372, #1373 — selector bucket reductions (the path forward).
- #1376 — IR fallback budget (current ratchet).
- #2855 — phase out the demote-to-warning channel.
- #2856, #2857, #2858, #2859 — drive the unintended fallback buckets to zero
  (the `ir-full-coverage` north-star work; see `plan/goals/ir-full-coverage.md`).
- #1526 — Instr `as unknown as` cast budget (related cleanup).
- #1527 — this doc.
