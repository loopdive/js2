# Goal: backend-agnostic-ir

**The typed middle-end IR (`src/ir/`) is decoupled from any single backend, so it can lower to (1) WasmGC today, (2) linear memory, and (3) a future bytecode interpreter — without the IR presuming WasmGC.**

- **Status**: Active
- **Track**: Supporting / architecture track (parallel to conformance)
- **Target**: A documented backend-trait seam in `src/ir/lower.ts`; at least one node kind lowered through that seam to two backends; one proof point of a non-WasmGC backend.
- **Dependencies**: `compiler-architecture` (activatable). Builds on #1131 (SSA IR), #1527/codegen-axes doc, #1530 (phase out the warning fallback).

## Why

The codegen-axes doc (`docs/architecture/codegen-axes.md`) names two orthogonal
axes and makes one explicit admission:

> Today, IR adoption gives you a typed front-end on a **WasmGC backend**. The
> architecture admits an IR adoption on the linear backend (a
> `lower-linear.ts` sibling), but no AST node kind has demanded it yet.

In other words: the IR's `lower.ts` (~2,460 lines) emits `struct.new`,
`struct.get`, `array.get`, `ref.cast` *inline in its node switch*. There is no
backend boundary — the IR-node→Wasm-op mapping is hardcoded to WasmGC. The doc
itself lists the exact leak points (the "Current hidden bias" table). This is
acceptable as a one-backend-old state, but it blocks two strategic directions:

1. **The bytecode interpreter (#1584)** needs the IR to be lowerable to a
   *non-Wasm* target (a bytecode opcode stream executed by a dispatch loop).
   That is impossible while lowering is hardwired to emit Wasm GC ops.
2. **IR adoption on the linear backend** — `src/codegen-linear/` reads the AST
   directly today, duplicating front-end work the IR already does. Routing
   linear lowering through the IR removes that duplication for the node kinds
   where the front-end concern is identical and only the *op emission* differs.

The user's intent is to make the IR's instruction contract **backend-agnostic**
so a backend is a *visitor over IR nodes*, not a hardcoded switch arm. The IR
declares *what* (build a closure cell, read a vec element, box a scalar); the
backend decides *how* (WasmGC struct vs linear-memory offset vs bytecode op).

## Approach

This is a multi-sprint goal. Sprint 57 lands the first three issues — the
audit/seam, one two-backend proof, and a minimal bytecode proof point:

1. **Audit + seam definition** (#1713, `feasibility: hard`, needs architect
   spec) — enumerate every WasmGC-specific emission in `lower.ts` against the
   codegen-axes "hidden bias" table; define a `BackendEmitter` trait (the set
   of operations a backend must implement: `emitStructNew`, `emitFieldGet`,
   `emitArrayGet`, `emitBoxScalar`, `emitCallRef`, …) that captures the
   *intent* of each emission without naming Wasm ops. Deliver the trait
   interface + a `WasmGcEmitter` implementation that is behavior-identical to
   today's inline emission (pure refactor, zero conformance delta).
2. **Two-backend proof** (#1714) — pick ONE already-IR-owned, structurally
   simple node kind (recommend the vec/array length+element-read path, which
   `lower.ts` already lowers and which has a clean linear analogue) and lower
   it through the trait to BOTH the WasmGC emitter and a new
   `src/ir/lower-linear.ts` emitter. Prove the same IR node produces correct
   output on both backends via a focused equivalence test. This is the first
   node kind to "demand" the linear lift the codegen-axes doc anticipates.
3. **Bytecode proof point** (#1715) — a minimal bytecode emitter + TS dispatch
   loop for a *tiny* IR subset (arithmetic + locals + return + one branch),
   proving the trait can target a non-Wasm backend. This is the de-risking
   first slice of #1584's Phase 1, scoped down to "does the seam admit a
   bytecode backend at all" — NOT the full interpreter.
4. **#1530 alignment** (tracked, not a sprint-57 issue) — driving IR-owned
   node kinds forward feeds backend-agnosticism: a kind can only be lowered by
   multiple backends once it is IR-owned end-to-end.

## The bytecode-vs-extend-linear decision

Both #1714 (extend linear coverage via the trait) and #1715 (bytecode proof)
are in scope for Sprint 57 because they de-risk *different* claims:

- **#1714 (linear-via-trait)** proves the trait abstracts a backend that
  *already exists and is exercised by WASI*. Low risk, high architectural
  payoff, directly retires front-end duplication. This is the **primary**
  proof point — it must land.
- **#1715 (bytecode)** proves the trait can target a backend with a
  *fundamentally different execution model* (dispatch loop, not structured
  Wasm). Higher risk, scoped to a throwaway-grade minimal subset, gated behind
  #1713. This is the **stretch** proof point — it validates the #1584
  direction before that 8–12 week investment is committed.

Reasoning: extending the linear backend is the higher-value *first* proof
because it is grounded in a real, shipping target (WASI) and immediately
removes duplicated front-end work, whereas the bytecode interpreter is a large
speculative investment. But doing a *minimal* bytecode slice in the same sprint
is cheap insurance: if the trait cannot cleanly express a bytecode target, we
learn that for ~1 issue of effort instead of discovering it 8 weeks into #1584.

## Issues

<!-- AUTOGENERATED:GOAL-ISSUES-START -->

| # | Title | Sprint | Status | Priority |
|---|-------|--------|--------|----------|
| **1713** | IR backend-trait: audit WasmGC bias in lower.ts + define BackendEmitter seam | 57 | done | high |
| **1714** | Lower one IR node kind through the BackendEmitter trait to BOTH WasmGC and linear | 57 | done | high |
| **1715** | Minimal bytecode emitter + dispatch loop for an IR subset (backend-agnostic proof point) | 57 | done | medium |
| **1783** | IR inference parity: native-messaging .js and .ts emit divergent WASI Wasm | Backlog | ready | medium |
| **1851** | Make BackendEmitter an explicit legalization boundary + extract a declared type-converter; add a backend-neutral mid-level | Backlog | done | medium |
| **1852** | Make dynamic-value representation explicitly per-backend (typed refs / i31ref on WasmGC; f64-value + i32-tag on linear) | Backlog | done | medium |
| **1979** | IR: mid-body `if (cond) stmt;` in a void function silently skips ALL subsequent statements when cond is true | 62 | done | high |
| **1980** | IR: while/for with a numeric-truthiness condition emits invalid Wasm and bricks the entire module (no fallback, verifier silent) | 62 | done | high |
| **1981** | IR: === null / !== null on class-typed values statically folded to false/true — null guards silently deleted | 62 | done | high |
| **1982** | IR: lazy use-site emission reorders memory reads past writes — slot/class-field reads observe future mutations | 61 | done | critical |
| **2710** | Late-bind module indices (func/global/type) to eliminate the late-index-shift bug class | current | ready | high |
| **2713** | IR↔legacy parity: IR path re-introduces correctness bugs fixed only on the legacy side | 66 | done | high |
| **2953** | Close the BackendEmitter pushRaw gap: route unions/closures/refcells/coercions/null/funcref through the trait | 72 | done | high |
| **2954** | LinearEmitter core-op coverage (const/binary/locals/control-flow/call) + cross-backend corpus dynamic rows | 69 | done | medium |
| **2956** | Linear backend consumes the IR front-end: wire the selector + LinearEmitter into generateLinearModule | current | done | medium |
| **3030** | Stable serializable IR contract (interchange v1): versioned canonical JSON + schema, verified types, external-consumer ready | current | ready | high |
| **3288** | Optional Porffor IR backend: prove the target-neutral JS2 linear-memory plan | porffor-backend | done | high |
| **3295** | Porffor backend P0: freeze the optional IR compatibility surface | porffor-backend | done | high |
| **3296** | Porffor backend P1: make generic lowering results genuinely non-Wasm | porffor-backend | done | high |
| **3297** | Porffor backend P2: scalar and control-flow differential proof | porffor-backend | done | high |
| **3298** | Porffor backend P3: extract the shared target-neutral LinearMemoryPlan | porffor-backend | done | high |
| **3299** | Porffor backend P4: heap and layout proof through shared planning | porffor-backend | done | high |
| **3300** | Porffor backend P5: prove shared allocation-policy leverage | porffor-backend | done | high |
| **3332** | linear direct path: arr.push returns 0 (not new length) and drops extra args | 72 | done | medium |
| **3336** | planning: make LinearMemoryPlan ownership target-neutral before dispatch | Backlog | ready | high |
| **3478** | Porffor source-to-native canary: real TypeScript through shared linear-memory planning | 73 | done | high |
| **3482** | Benchmark direct Porffor against JS2 typed SSA and shared-plan Porffor IR | 73 | done | high |
| **3497** | Resolve exact-source JSDoc signatures for the linear IR landing benchmarks | 75 | done | high |
| **3498** | Landing benchmark: four honest backend/runtime lanes | current | ready | high |
| **3499** | Lower typed JavaScript bitwise composites through the Porffor backend | 75 | done | high |
| **3500** | Carry checker-backed type evidence through recursive linear-IR call-graph closure | current | in-review | high |
| **3501** | Infer typed linear vectors from empty-array read/write evidence | 75 | done | high |
| **3502** | Lower landing string construction and char methods through shared IR | 75 | done | high |
| **3508** | Advance the optional Porffor integration pin to pre-alpha 9 | 73 | done | high |
| **3514** | POC: use Porffor's JavaScript parser as a frontend to JS2 IR | current | ready | high |
| **3641** | Investigate a dual-emit compile entry point: gc + standalone from one parse/type-check/IR-build pass | current | ready | high |
| **3682** | Feasibility record: lowering the middle-end IR to scriptc's IR as a native backend — conceivable, not recommended now | Backlog | backlog | low |
| **3784** | #2782/#2790's no-box number-local gate threw a PLAIN Error, so its documented demote-to-legacy became a HARD compile error — latent until #3783 claimed function-local `var`s, then ordinary untyped JS stopped compiling on every target | 77 | done | high |
| **3931** | Port detectCanonicalCharReadLoop into the IR front-end — the #2682 charCodeAt hoist has been dead for standalone and wasi all along, and #3907 removed its last hiding place | current | done | high |
| **3954** | Name the IR's ambient ECMAScript assumptions: factor the JS value model behind a tag-domain seam | current | in-progress | high |
| **4070** | Add a `never` exhaustiveness check to `verify.ts` `collectUses` — a new IR kind currently fails at runtime, not compile time | current | done | medium |
| **4097** | Lift the IR class-instance-throw demote: unify IR class-allocation struct identity with legacy collectClassDeclaration | current | done | medium |
| **4177** | IR-first hard-fails on lattice-narrowed `+`: selection claims a function off the fixpoint's f64 param fact, but from-ast `+` provability does not consume lattice facts | current | done | high |
| **4186** | IR/legacy SIGNATURE split-brain on standalone implicit-any object params: lattice types acorn's `options` as a shape struct while legacy's `lowerParamType` deliberately refuses `__anon_*` — every such claim demotes at the typeIdx parity guard | current | in-progress | high |
| **4236** | exploration: QuickJS JSValue as the linear lane's BOXED tier — native representation for typed code, QuickJS for the eval-visible/dynamic frontier (Static-Hermes-shaped) | Backlog | backlog | low |
| **4237** | exploration: compile-time regex specialization — lower literal patterns to per-pattern wasm functions at build time (the AOT analogue of Irregexp's JIT tier) | current | ready | medium |
| **4523** | checkInstr type rules cover 16/78 IR kinds by construction — decide the opt-in→opt-out question and own the roadmap | current | ready | medium |
| **4551** | Settle the neutral/ECMAScript split per IR instruction kind, so #3954's dialect boundary is drawn on evidence rather than an approximate count | Backlog | blocked | medium |
| **4552** | Fable-lane architect review: the #3954 phase 2 dialect split was implemented by the Opus lane and has not been reviewed by its owning lane | current | ready | high |

<!-- AUTOGENERATED:GOAL-ISSUES-END -->

## Success criteria

- `lower.ts` no longer emits WasmGC ops inline for the audited node kinds;
  emission goes through a `BackendEmitter` trait whose `WasmGcEmitter`
  implementation is behavior-identical (zero conformance delta).
- At least one node kind is provably lowered to two backends (WasmGC + linear)
  from the same IR.
- A minimal bytecode backend exists as a proof point, executing a tiny IR
  subset through a dispatch loop, validating the #1584 direction.
- The codegen-axes "hidden bias" table is updated to reflect which leaks are
  now behind the trait.
