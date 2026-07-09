---
id: 2956
title: "Linear backend consumes the IR front-end: wire the selector + LinearEmitter into generateLinearModule"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-09
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir, codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
depends_on: [2953, 2954]
related: [1585, 1713, 2710, 1852]
origin: "2026-07-02 July Fable audit §5 (production linear compilation consumes zero IR; #1585 is investigation-only)"
---

# #2956 — the backend fork sits ABOVE the IR

## Problem

`--target linear` branches at `src/compiler.ts:861` and hands the **AST**
to `generateLinearModule` (src/codegen-linear/index.ts, 5.5k lines) — the
IR selector and from-ast never run for linear compiles. "Backends differ
only at lowering" is therefore true for **no shipping code path**: the
linear backend is a second direct AST→Wasm front-end (15.9k lines,
maintained but far behind on parity: fail-loud rejects for typeof/await/
spread/regex, no dynamic-value representation, no closures-via-IR).
#1585 (dual-target IR architecture) is the investigation umbrella; no
implementation issue existed.

## Approach (architect spec is the first deliverable)

Mirror the WasmGC overlay pattern (#2138 shape), not a big-bang port:

1. **Spec:** a linear `IrLowerResolver` twin — `integration.ts` is today
   hardwired to the WasmGC codegen context (imports 8 codegen modules,
   patches `ctx.mod.functions` slots). Extract the context-facing surface
   (funcMap/typeIdx/slot-patch/import registration) into an interface both
   backends implement. #2710 (late-bound module indices) reduces the
   index-shift hazard here.
2. **Slice 1:** for IR-claimed _numeric/control-flow_ functions under
   `--target linear`, build IR once and lower via LinearEmitter into the
   linear module's slots; everything else stays on the linear direct path
   (its own demote channel, bucketed + ratcheted like #1376).
3. **Slice 2+:** widen families as LinearEmitter grows (aggregates via
   codegen-linear/layout.ts, the #1852-G4 f64+tag dynamic cell, strings).
   Async/closures explicitly deferred (blocked on linear closure + Promise
   runtime — do not promise them here).

## Acceptance criteria

- Architect spec recorded here (resolver interface + slice map) before dev
  dispatch.
- A claimed numeric function compiles once via IR into the linear module;
  cross-backend corpus rows flip from expectLinearUnsupported to executed
  parity.
- Linear fallback reasons bucketed against a baseline (clone of
  check-ir-fallbacks), so parity progress banks.

## Implementation Plan (fable-arch, 2026-07-09 — the requested architect spec)

> Verified against `origin/main @ 928c85179`. Re-grep symbol anchors before
> editing (`generateLinearModule`, `compileIrPathFunctions`,
> `IrLowerResolver`, `LinearEmitter`). #2954 (LinearEmitter core-op
> coverage) is **done**; #2953 (pushRaw gap) is **in-progress** — slice L2
> below depends on the refcell/aggregate groups it moves behind the trait,
> but L0/L1 do not: they can start once #2953's _vec + core_ groups are
> stable (already true today).

### Current seam, precisely

- **Fork point**: `src/compiler.ts` (`useLinear = options.target ===
"linear"`, ~line 871) → `generateLinearModule(ast, opts)`
  (`src/codegen-linear/index.ts:74`). The IR planner never runs on this
  path.
- **The WasmGC integration** (`src/ir/integration.ts:131`
  `compileIrPathFunctions(ctx: CodegenContext, …)`) is hardwired to the
  WasmGC context: it imports ~20 `src/codegen/*` modules, and its
  `IrLowerResolver` implementation delegates every `resolve*` hook to the
  legacy WasmGC registries (`getOrRegisterVecType`, `ensureAnyValueType`,
  boxing/closure/refcell/class registries), then patches
  `ctx.mod.functions[localIdx].body` in place.
- **`IrLowerResolver`** (`src/ir/lower.ts:99-200`) is ALREADY the right
  abstraction boundary: `lower.ts` reaches the module exclusively through
  it (+ the `BackendEmitter` for op emission). Nothing in `lower.ts` needs
  to change for linear — what is missing is (a) a **linear implementation**
  of the resolver's Phase-1 subset, (b) a **slot/patch surface** on the
  linear module, and (c) a **capability gate** narrowing claims to what
  `LinearEmitter` can lower.
- **`LinearContext`** (`src/codegen-linear/context.ts:7`) already has the
  pieces the integration needs: `funcMap: Map<string, number>`,
  `numImportFuncs`, `mod.functions[]` (name-keyed slots registered at
  `index.ts:100-170`).

### Design decision: ONE integration, TWO context adapters (not a twin)

Do **not** clone `integration.ts` into a linear twin (2.6k lines of
selection/typeMap/report logic that would drift — the exact #2713 parity
bug class). Instead split `compileIrPathFunctions` into:

1. **Backend-neutral core** (stays in `integration.ts`): selection
   consumption, calleeTypes map, per-function `lowerFunctionAstToIr` →
   verify → passes → `lowerIrFunction`, error/report handling.
2. **A `IrBackendIntegration` adapter interface** — the context-facing
   surface the core calls:

```ts
export interface IrBackendIntegration {
  /** Backend identity — picks the BackendEmitter + legality profile (#1851). */
  readonly backend: IrBackendKind; // "wasmgc" | "linear"
  /** The resolver lower.ts consumes. Linear: Phase-1 subset (below). */
  readonly resolver: IrFromAstResolver & IrLowerResolver;
  /** Pre-allocated slot lookup (name → funcIdx); mirrors ctx.funcMap. */
  lookupFunc(name: string): number | undefined;
  numImportFuncs(): number;
  /** Replace the body/locals of a pre-allocated slot (the overwrite step). */
  patchFunction(localIdx: number, patch: { body: Instr[]; locals: ValType[] }): void;
  /** Late helper/import registration (linear: runtime.ts helpers; must
   *  follow the name-based repoint discipline — funcIdx shifts, #2710). */
  ensureHelper(name: string): number;
}
```

The existing WasmGC behavior becomes `WasmGcIntegration` (a thin wrapper
over today's code — behavior-identical, byte-identical refactor, proven
by the corpus hash harness `scripts/byte-diff-corpus.mts` from #2138).

3. **`LinearIntegration`** implements the adapter over `LinearContext`:
   - `resolver`: Phase-1 linear subset — `resolveFunc/resolveGlobal/
resolveType/internFuncType` over the linear module tables;
     `resolveString()` returns the linear string rep; **every optional
     hook (`resolveUnion/Boxed/Object/Closure/RefCell/Class/Vec…`) is
     initially ABSENT** — per the documented resolver contract, a function
     whose IR demands a missing hook fails at lowering, and the gate
     (below) must have rejected it first.
   - `patchFunction` writes `mod.functions[localIdx]` exactly like the
     WasmGC patch site (`integration.ts:718` family).

### The linear capability gate (what slice 1 claims)

Reuse two EXISTING mechanisms — do not write a new predicate family
(#2135's lesson):

- **Per-backend legality verifier (#1851, `src/ir/backend/legality.ts`)**:
  run the claimed function's IR through the linear legality profile
  _before_ lowering; any instr outside the profile → structured reject.
- **Reject reasons bucketed** into a NEW `scripts/linear-ir-baseline.json`
  ratchet (clone of `check:ir-fallbacks` — acceptance criterion 3), reason
  = the first illegal instr kind. This measures parity progress per family.

Slice-1 legal set = exactly what `LinearEmitter` implements post-#2954:
const/binary/unary/locals/globals/drop/select/return/unreachable/
if/br/br_if/block/loop/direct-call + vec len/get (reads). Everything else
(vec construction #1804-linear, aggregates, refcells, exceptions,
call_ref/closures, strings, dynamic/boxed) rejects to the linear direct
path — which remains the module driver and default.

### Slice map (each independently landable)

| #      | Slice                                                                                                                                                                                                                    | Scope                                                                                                | Gate                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0** | Adapter extraction (`IrBackendIntegration` + `WasmGcIntegration`) — refactor only                                                                                                                                        | `src/ir/integration.ts`; no linear code                                                              | byte-identical corpus hash (2,692-compile harness); full merge_group                                                                                 |
| **L1** | `LinearIntegration` + overlay wiring in `generateLinearModule` (after slot registration ≈ `index.ts:170`, before body finalization) behind `JS2WASM_LINEAR_IR=1`; legality-gated numeric/CF claims; the ratchet baseline | `codegen-linear/index.ts`, new `src/ir/backend/linear-integration.ts`, `scripts/check-linear-ir.mjs` | flag-off byte-identical; flag-on: cross-backend corpus rows (#1854 harness) flip `expectLinearUnsupported` → executed parity for claimed numeric fns |
| **L2** | Widen: vec construction (#1804 linear arm), refcells (needs #2953's group), aggregates via `codegen-linear/layout.ts`                                                                                                    | `linear-emitter.ts`, `linear-integration.ts`                                                         | ratchet decreases bank; differential harness rows                                                                                                    |
| **L3** | Strings (blocked on #2955 de-polymorph — the IR front-end currently builds string-mode-specific IR at 5 from-ast sites; linear must not inherit that fork)                                                               | after #2955                                                                                          | corpus string rows                                                                                                                                   |
| **L4** | Default-ON for the claimed families + fold the linear direct path's per-function reject list into the same ratchet                                                                                                       | `compiler.ts`                                                                                        | one soak window on main, then flip                                                                                                                   |

**Explicitly deferred (do not promise here):** closures/`call_ref` (linear
dispatches through a table — needs a table-based `emitCallRef` design),
exceptions (no linear EH lowering), async/Promise (no linear runtime),
dynamic/boxed-any (#1852-G4 f64+tag cell is the design seed, but it is a
value-rep decision that must be made jointly with #2949's dynamic IrType —
file separately when L2 lands).

### Risks / edge cases

- **funcIdx shifts**: linear registers runtime helpers up-front
  (`index.ts:100-116`) then user funcs — the overlay must patch
  pre-allocated slots only, never append (same placeholder discipline as
  #2138). `ensureHelper` additions before finalize follow the name-based
  repoint rule (#2710, memory `project_standalone_hostimport_gate_index_shift`).
- **Two type-numbering passes do not exist on linear** (no hoist pass) —
  simpler than WasmGC; but `internFuncType` must dedupe against the linear
  module's type section, not grow it per call.
- **Multi-module linear** (`generateLinearMultiModule`, second context at
  `index.ts:235`) — out of scope for L1 (single-module only), mirror later.
- **The linear backend's own fail-louds** (typeof/await/spread/regex) are
  UNCHANGED — the IR overlay only ever _adds_ capability; a claim the gate
  rejects lands exactly where it lands today.

### Effort

XL total; L0+L1 ≈ one senior-dev budget window (Fable for L0's interface
cut + L1's gate; the LinearIntegration itself is mechanical); L2+ are
M-sized Opus slices banked by the ratchet.
