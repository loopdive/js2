---
id: 3682
title: "Feasibility record: lowering the middle-end IR to scriptc's IR as a native backend — conceivable, not recommended now"
status: backlog
sprint: Backlog
created: 2026-07-27
priority: low
horizon: s
feasibility: hard
reasoning_effort: high
task_type: analysis
area: compiler
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [3678, 3679, 3680, 3681, 1131, 1527]
---

# #3682 — Feasibility: js2wasm IR → scriptc IR bridge

## Question

Can our middle-end IR (`src/ir/`, #1131) be integrated with or lowered to
[vercel-labs/scriptc](https://github.com/vercel-labs/scriptc)'s IR, gaining
their C/LLVM native backends (170–200KB binaries, ~2.4ms startup) as a third
lowering target next to WasmGC and linear memory?

Companion to `plan/log/scriptc-comparison.md` (2026-07-26 comparison) and
issues #3678–#3681.

## The two IRs

**Ours** (#1131): typed **SSA with basic blocks + block arguments**, between
the TypedAST and the backend Wasm IR (`src/ir/types.ts`). The properties that
make retargeting conceivable at all are deliberate:

- **Symbolic references, never raw indices** — `IrCallableBinding`
  (unit/import/runtime/intrinsic/support) resolves to concrete targets only at
  lowering; the node graph is not wasm-index-shaped.
- **Own type lattice** — `IrType` (unions, boxed, callable, class, object,
  string, `dynamic`, `externref`) sits above wasm `ValType`.
- Backend-neutrality is already a goal (`plan/goals/backend-agnostic-ir.md`,
  #1527 two-axis split).

**Theirs**: publicly a black box — "typed IR, the sole interface between the
ends," feeding C and LLVM backends. No published spec of form, type system,
or stability contract. One concrete seam: their compiler package ships the IR
**with a validator and serializer**, so a machine-readable boundary exists.

## Mismatches that are lowering-time work (not blockers)

- **Refcounting vs GC**: our IR carries no ownership info — but neither does
  tsc output; scriptc's own front-end inserts retain/release/cycle handling
  during lowering, so a bridge inherits that machinery below the IR seam.
- **Async**: our `await` nodes vs their stackful fibers — fibers are the
  *easier* target (suspension is a plain call).
- **Exceptions**: structural `try`/`throw` maps onto landing-pad lowering.

## Real blockers (descending severity)

1. **Coverage.** The IR only covers adopted node kinds
   (`plan/log/ir-adoption.md`); the entire #1376 legacy-fallback population
   has no IR to lower, and scriptc has no legacy-path escape hatch. A bridge
   today compiles only the IR-clean subset.
2. **Semantics scope.** Our `dynamic`-kind nodes and full-JS behaviors
   (prototype mutation etc. — what test262 forces on us) are constructs
   scriptc's static tier rejects by design. They'd have to lower into their
   quickjs `--dynamic` tier with boundary validation — a semantic
   negotiation, not a mechanical mapping.
3. **Wasm leakage in our IR.** `externref` types,
   `IrStringEncoding`/string-runtime modes, and host-import bindings are
   wasm-host concepts with no scriptc equivalent; an abstraction pass must
   come first.
4. **Moving target.** Their IR is an internal interface with no stability
   promise — bridging two fast-evolving private IRs is a maintenance trap.

Licensing is NOT a blocker: both Apache-2.0 (ours WITH LLVM-exception),
compatible.

## Strategic assessment

The prize is native executables — but **Wasm already has a cheaper route**:
wasm AOT (wasmtime compile, WAMR AOT, wasm2c) produces standalone binaries
from our existing, fully-covered output with zero new lowering. Bigger
binaries and slower startup than scriptc's, but no dependency on an
undocumented third-party IR. The bridge only wins if scriptc-class binary
size/startup becomes a first-class goal.

## Recommendation (the actionable part)

- **Do not build the bridge now.**
- **Do** push wasm-specific leakage out of the middle-end IR under the
  backend-agnostic-ir goal (blocker 3 above) — that keeps the option alive at
  near-zero cost: a clean IR plus their serializer seam is all a future
  bridge needs.
- **Do** pursue the IR-independent collaboration surfaces
  (`plan/log/scriptc-comparison.md`): shared differential-test corpus
  (#3681), rejection-taxonomy vocabulary (#3678), divergence-ledger format,
  boundary-validation contract (#3680).
- Revisit if (a) scriptc documents/stabilizes its IR serializer as a public
  contract, or (b) native binary size/startup becomes a js2wasm goal that
  wasm AOT measurably cannot meet.

## Acceptance criteria

- [x] Analysis recorded (this file) — no implementation is proposed
- [ ] If revisited: prototype exports ONE function through their serializer
      seam before any broader commitment (spike-first)
