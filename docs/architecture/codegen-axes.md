# Codegen axes: backend lowering vs front-end IR

> Read this before touching anything under `src/codegen/`, `src/codegen-linear/`,
> or `src/ir/`. It should take ~10 minutes. If it takes longer, file an issue
> against this doc.

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

## The three paths (and why they look like three)

| Path                  | Size                | Role                                                                          |
|-----------------------|---------------------|-------------------------------------------------------------------------------|
| `src/codegen/`        | 2.3 MB, ~44 files   | Direct AST→Wasm. Default fallback. WasmGC lowering. The "legacy" hacks live here. |
| `src/codegen-linear/` | 320 KB, 6 files     | Direct AST→Wasm. Selected by `target: "linear"`. Linear-memory lowering (WASI / C ABI). |
| `src/ir/`             | 652 KB, 11 files    | Typed IR built from the AST (`from-ast.ts`) and lowered to Wasm (`lower.ts`). Currently lowers to WasmGC only. |

`src/ir/` looks like a third path, but conceptually it sits on the
front-end axis. The current `lower.ts` happens to emit WasmGC ops because
the only IR-aware backend today is WasmGC. The linear backend reads
AST directly. **Both will keep existing**; the goal is to widen IR so it
covers the AST node kinds where lowering is the same modulo a thin
backend trait, leaving the direct paths for the cases where lowering
genuinely diverges.

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
       Touch the relevant               ▼
       backend directly:        Adopt in `src/ir/`:
       `src/codegen/` (GC) or   add the kind to from-ast.ts,
       `src/codegen-linear/`.   build the IR node in nodes.ts,
       Do NOT plumb through     lower in lower.ts. Once both
       IR — IR is the wrong     backends consume IR for the
       layer for backend-       kind, delete the direct-codegen
       specific decisions.      branch as a follow-up.
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
   - Linear:  load the array's base pointer + length from a header, loop
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
WasmGC-only feature with no linear-memory analogue), it lives in
`src/codegen/` directly. IR shouldn't carry a node it can't lower on every
backend.

## When NOT to use IR yet

IR adoption is staged. Some node kinds *should* stay in direct codegen
today because lowering them through IR would force a premature backend
decision or would leave too many fallback paths.

Stay in `src/codegen/` (direct) until the listed issues land:

| Node kind                  | Reason                                                     | Tracking |
|----------------------------|------------------------------------------------------------|----------|
| Class methods (full)       | `class-method` fallback in select.ts is the largest bucket | #1370    |
| Async / generator bodies   | Generator state machines are WasmGC-shaped today           | #1373    |
| Destructuring params       | Param-shape selector rejects them                          | #1372    |
| `eval`, `with`, `Proxy`    | Deferred features — not coming                             | wont-fix |
| Generic type parameters    | Needs monomorphisation                                     | (future) |

`scripts/ir-fallback-baseline.json` is the ratchet. When a kind is
adopted, its bucket goes to zero and the demote-to-warning escape hatch
in `src/codegen/index.ts:889–896` is removed for that kind — see #1530.

## Current hidden bias in `src/ir/` (and what to do about it)

The IR was bootstrapped against WasmGC. A grep for WasmGC ops inside IR
files surfaces real coupling that the orthogonality claim cannot yet
deliver on. None of these are bugs — they reflect IR being one backend old.

| File                            | Bias                                                                                   | Lift plan |
|---------------------------------|----------------------------------------------------------------------------------------|-----------|
| `src/ir/lower.ts`               | Emits `struct.new`, `struct.get`, `array.get`, `ref.cast` directly. WasmGC-only.       | Add a sibling `src/ir/lower-linear.ts` once a node kind is needed by both backends. Until then, lower.ts stays WasmGC-only by construction — IR-owned kinds are still WasmGC-only at runtime. |
| `src/ir/types.ts`               | `Instr` union includes both GC ops (`struct.*`, `array.*`, `ref.cast`) and linear ops (`memory.size`, `i32.load`, etc.). | This is shared *Wasm encoding*, not IR. Both backends emit Wasm, both need the union. Stays. |
| `src/ir/passes/tagged-union-types.ts` | Names WasmGC struct/array layouts.                                                | Move to a backend trait when the linear backend grows IR-driven tagged unions. |
| `src/ir/nodes.ts` `IrType.boxed` | Assumes a boxed scalar is a `(struct (field $val))`.                                | Keep abstract at the IR level; let each backend pick its boxing strategy (struct vs heap object vs nan-boxing). |

The **explicit claim**: today, IR adoption gives you a typed front-end on
a WasmGC backend. The architecture admits an IR adoption on the linear
backend (a `lower-linear.ts` sibling), but no AST node kind has demanded
it yet. When one does — likely once #1370/#1373 land and class methods are
IR-owned — the lift becomes worth the cost.

## The fallback-to-warning escape hatch (`src/codegen/index.ts:889–896`)

Today, if the IR path throws while compiling a function the selector
claimed, the failure is logged at severity `"warning"` and the legacy
direct-codegen body is kept. This makes the IR safe to enable by default
without breaking test262, but it also masks real IR bugs.

**This is a transitional safety net, not the final design.** #1530 phases
the warning channel out. The endgame: when a node kind is IR-owned, the
selector either claims it (and IR succeeds) or it stays direct (and the
selector reports a structured "deferred" reason). There is no third
"IR claimed it and silently fell back" state.

If you're reading this and the warning channel still exists, treat any
new warning here as an error — it means a regression slipped past the IR
fallback budget (`pnpm run check:ir-fallbacks`).

## See also

- `plan/log/ir-adoption.md` — table of AST node kinds × IR status. The
  ratchet's source of truth. Updated when a kind moves between
  `direct-only`, `mixed`, and `ir-owned`.
- `docs/adr/0012-intermediate-representation.md` — the original ADR for
  the IR. Background reading, not authoritative for current state.
- #1098 — direct-codegen hack inventory (the thing IR replaces).
- #1131 — IR Phase 2 plan (what's claimed today).
- #1370, #1372, #1373 — selector bucket reductions (the path forward).
- #1376 — IR fallback budget (current ratchet).
- #1530 — phase out the demote-to-warning channel.
- #1526 — Instr `as unknown as` cast budget (related cleanup).
- #1527 — this doc.
