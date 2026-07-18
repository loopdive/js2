---
id: 1584
title: "Wasm-GC-native bytecode interpreter with Acorn for eval and dynamic fallback"
status: ready
created: 2026-05-23
updated: 2026-07-02
priority: medium
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: Backlog
depends_on: [1058, 1006, 1066, 1102]
required_by: [1743]
children: [2923, 2924, 2925, 2927, 2928, 2929]
es_edition: multi
---
# #1584 — Wasm-GC-native bytecode interpreter with Acorn for eval and dynamic fallback

> **DECOMPOSED (2026-07, architect).** This issue is now the **umbrella /
> strategy-of-record** for the `runtime-eval` goal. The full architecture —
> strategy comparison, hard-problem answers (direct-eval scope reification,
> the value-rep bridge, global/realm access, `new Function` ordering), test262
> quantification, and the milestone roadmap — lives in
> [docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md).
> Two key refinements vs. the original text below: (1) Tiers 0 and 1
> (constant-string compile-away #1163, JS-host meta-circular #1164) are
> **already shipped** — the interpreter is the *third* leg, not a greenfield;
> (2) the work is staged into landable slices, not one 8–12-week issue:
> **#2923** (broaden compile-away, S), **#2924** (`new Function` compile-away,
> M), **#2925** (direct-eval scope reification in JS-host, L), **#2927**
> (Acorn-via-js2wasm + generic-built-in audit, L), **#2928** (bytecode VM core
> + standalone `new Function`/indirect eval, XL), **#2929** (direct eval +
> `with` + Proxy-MOP convergence, XL). The original strategy write-up below
> remains accurate and is preserved as the rationale of record.
>
> **UNIFIED (2026-07-04, architect).** The architecture doc gained **Part II
> (§12–§16)**, which is now authoritative: the complete **4-tier ladder**
> (compile-away → host shim → interpreter → refuse-loudly; Tiers 0/1/3
> **landed** via #2923/#2924/#1164/#2960) with normative routing rules; the
> representation **ADR: register+accumulator bytecode, tree-walking
> rejected**; the **two-producer** generalization (runtime ESTree emitter now,
> build-time IR→bytecode deopt for `with`-class features later — #1715);
> unified **name-resolution semantics** shared by the host shim and the
> interpreter (fixes #3017 gap 2 by construction); the compiled-acorn
> **feasibility verdict** (confirmed; #2853-A/B are the remaining hard
> blockers); and the Opus-executable slice sequence **E0/P1/P2/E1–E6 +
> G1–G4** (detailed in #2928's `## Implementation Plan`).

Strategy proposal for executing genuinely dynamic JavaScript inside the
standalone Wasm-GC module without bundling a third-party engine. The
interpreter and its runtime parser are written in TypeScript and compiled with
js2wasm itself, sharing value representation, built-ins, and frame layout with
the AOT path.

This is the **Option A path of #1102, refined and committed to** — not a
fourth competing approach. #1102 recorded Option A (embed a lightweight
interpreter) as a known direction and recommended Option B (AOT
specialization) as the immediate-term answer. #1066 covers the standalone
host-import path with recursive compilation. This issue argues that Option A
is now the right next step for the dynamic cases Option B cannot resolve
statically and #1066 cannot reach without shelling out to the compiler, and
proposes a concrete shape grounded in the existing dual-mode architecture
(#679 dual string backend, #682 dual RegExp backend).

## Why this, why now

We have three previously-considered paths and one external dependency:

1. **AOT specialization (#1102 Option B)** — handles constant-string and
   statically analyzable eval. Real-world coverage is meaningful but bounded;
   templating engines, plugin systems, and dynamic schema validators all fall
   outside its reach.
2. **Recursive host compilation (#1066)** — handles arbitrary strings but
   requires the host to embed the compiler and pay 5–50ms compile latency per
   call. Suitable for low-frequency eval. Eliminated for hot-eval workloads
   (templating in a loop).
3. **`func.new` (#1165)** — would be ideal, but the proposal is not in the
   active staged process and broad runtime support is years out. Not a
   near-term answer.
4. **Embedded third-party engine** (QuickJS-WASM, Engine262 compiled, etc.) —
   600KB to several MB, breaks identity semantics across the AOT/embedded
   boundary, dilutes the "no embedded JS engine" architectural story that
   defines the project.

This issue proposes a fifth path that is genuinely architecturally aligned
with the rest of the compiler: a Wasm-GC-native bytecode interpreter built on
the same boxing representation, called from the AOT path without marshalling,
and emitted by a bytecode lowering of the existing IR. The parser problem is
solved by compiling Acorn through js2wasm itself, which doubles as a stress
test for #1058 (self-host).

The investment is real (estimated 8–12 weeks of focused engineering with a
multi-channel agent setup), but the deliverable is durable: a dynamic fallback
that does not depend on any external engine, does not break the size story,
and gives a defensible architectural answer to "what about eval" for
adopters evaluating the compiler.

## Architecture

The runtime is structured as four components, all compiled to the same Wasm
module by js2wasm itself. The boundary between the AOT path and the
interpreter path runs through the value representation and the built-in
library, both of which are shared.

```
TypeScript sources (compiler authoring language)
├── parser/acorn.ts            (vendored Acorn, runtime parser)
├── interpreter/emitter.ts     (IR → bytecode)
├── interpreter/dispatch.ts    (register+accumulator dispatch loop)
├── runtime/box.ts             (shared boxed JSValue, used by both paths)
└── builtins/*.ts              (Array, String, Number, Object, …;
                                shared with AOT path)
        │
        ▼
js2wasm AOT compilation
        │
        ▼
Single Wasm-GC module containing:
  - AOT-compiled application code (fast path)
  - Bytecode interpreter (fallback for eval / dynamic Function / unanalyzable)
  - Acorn parser (only linked into modules that use dynamic eval)
  - Shared built-ins (called from both paths without adapter)
```

### Component 1: Acorn compiled via js2wasm (runtime parser)

Acorn (MIT, ~100KB unminified JS) is the de-facto ECMAScript parser in the
ecosystem. Babel's internal parser is an Acorn fork, ESTree is its AST shape,
and ES2024 support is current.

Compiling Acorn through js2wasm has two purposes:

1. It provides a runtime parser for `eval(s)` and `new Function(body)` without
   shipping a separate parser binary.
2. It is a non-trivial real-world JavaScript codebase that doubles as a
   conformance and stress test for the self-hosted compilation path (#1058).
   If Acorn does not compile cleanly, that surfaces concrete compiler gaps.

Acorn is restricted to **runtime use for dynamic source strings**. The
build-time pipeline continues to use the existing TypeScript parser for
type-annotated source. This avoids regressing the type-driven specialization
the AOT path depends on, while keeping the runtime parser language-aligned
(eval is always JavaScript, never TypeScript).

The Acorn module is **optionally linked**: modules that the static analyzer
proves contain no `eval` / `new Function` / direct-eval indicators do not pay
its size cost. This preserves the floor of the current 0.2KB baseline for the
common case.

### Component 2: Bytecode emitter (TypeScript)

The existing IR is lowered to bytecode by a second backend running alongside
the current Wasm-GC backend. The same IR feeds both; the choice of backend is
per-function, driven by static analysis:

- function statically provable as not containing dynamic constructs → AOT
  backend (Wasm GC, monomorphized)
- function flagged as may-contain-eval, or evaluated source body from a
  runtime `eval` / `new Function` call → bytecode backend

The bytecode is stored as a Wasm-GC array attached to a function metadata
struct, alongside its constant pool, exception table, and source map (if
available).

Opcode design is **register-based with an accumulator**, after Ignition. The
rationale is documented in `docs/adr/` as part of this issue's deliverables.
Briefly: register-based dispatch produces fewer opcodes per source operation
than stack-based, the accumulator pattern reduces operand encoding overhead,
and Wasm-locals map directly to virtual registers in the dispatch function.
Stack-based dispatch was considered and rejected on the dispatch-loop
performance grounds documented in Titzer 2022 (_A fast in-place interpreter
for WebAssembly_, OOPSLA).

### Component 3: Dispatch loop (TypeScript)

The dispatch loop is a TypeScript function that takes a bytecode array and a
frame struct, runs the dispatch over opcodes, and returns either a boxed
result or a thrown value tag. The function is itself compiled by js2wasm to
Wasm-GC, with all hot-path variables typed (`number` for the program counter,
typed struct references for frame and constant pool, etc.) so the generated
code avoids interpreter-level boxing.

Opcode set sized at roughly 120–150 instructions, covering:

- arithmetic (add/sub/mul/div/mod, bitwise) with full ToPrimitive semantics
- property access (`Get`, `Set`, `GetByName`, `GetByValue`) with prototype chain
- function call (`Call`, `Construct`, `CallMethod`, with `this` binding)
- variable access (`LdLocal`, `StLocal`, `LdClosure`, `StClosure`, `LdGlobal`)
- control flow (`Jump`, `JumpIfTrue`, `JumpIfFalse`, `Throw`, `TryStart`,
  `TryEnd`)
- built-in invocation (`CallBuiltin <id>`) — dispatches into the shared
  built-in library, same functions the AOT path calls
- generator / async support (`SuspendGenerator`, `ResumeGenerator`,
  `YieldValue`) — Phase 2

Wide / extra-wide opcode prefixes mirror Ignition's design for compact common
case + headroom for functions with many locals.

### Component 4: Shared boxing and built-ins

The single most important architectural property: the interpreter and the AOT
path operate on **identical boxed JSValue representations**. A boxed value
produced by AOT code can be read directly by interpreter code and vice versa,
without a marshalling layer.

This is what differentiates the proposed strategy from any embedded-engine
approach (QuickJS, Engine262, V8 Ignition port). Those would all require
adapter layers at the boundary, with the attendant identity-semantics
breakage that has been documented for the host-import path in #1066.

Built-ins (Array.prototype._, String.prototype._, Object._, Reflect._, etc.)
are implemented once in TypeScript against the boxed representation. The AOT
path calls them directly via type-specialized wrappers when types allow, or
generically when not. The interpreter calls them generically via the
`CallBuiltin` opcode. Adding a new built-in benefits both paths equally.

For ECMA-262 compliance, built-in implementations follow the Engine262 source
as a reference — Engine262's spec-direct implementations port mechanically to
TypeScript against our boxing API. This is _not_ a compilation of Engine262;
it is an implementation guided by the same source the TC39 reference uses.

### What's unified, what's separate

| Concern                               | Unified                     | Separate                                |
| ------------------------------------- | --------------------------- | --------------------------------------- |
| Value representation (JSValue, boxes) | ✓                           |                                         |
| Built-in library                      | ✓                           |                                         |
| Object shape / hidden-class layout    | ✓                           |                                         |
| Garbage collection                    | ✓ (Wasm GC)                 |                                         |
| Frontend (parser → IR)                | ✓ (TS parser at build time) |                                         |
| Backend (IR → output)                 |                             | AOT to Wasm GC vs. bytecode emission    |
| Execution                             |                             | direct Wasm execution vs. dispatch loop |
| Linked module size                    |                             | optional Acorn + interpreter            |

## Scope

1. Compile Acorn through js2wasm, verify it parses ES2024 input under the
   self-hosted toolchain (#1058 dependency). Produce a `runtime/parser.wasm`
   artifact for linking on demand.
2. Design and document the opcode set in an ADR. Cover encoding, operand
   widths, suspend/resume semantics, exception table format.
3. Implement the bytecode emitter as a second IR backend. Static analysis
   marks functions as needing bytecode emission; the emitter walks the same
   IR the AOT backend walks.
4. Implement the dispatch loop in TypeScript with strict typing for hot-path
   variables. Verify generated Wasm-GC code is competitive with hand-written
   Rust dispatch via inspection of the emitted code.
5. Wire the AOT path and interpreter path together: AOT-compiled functions
   can call interpreted functions via the shared call protocol; interpreted
   functions can call AOT-compiled built-ins and user code.
6. Implement `new Function(args, body)` first (indirect-eval semantics only,
   no caller scope capture). This covers the majority of templating and
   schema-validation use cases.
7. Implement `eval(s)` as indirect eval (global scope only). Direct-eval with
   caller scope capture is Phase 2 — see Phasing.
8. Exception propagation across the AOT/interpreter boundary. Both paths use
   Wasm Exception Handling tags.
9. Generic forms of all currently-specialized built-ins. Ensure every
   `add_int_int` etc. has a corresponding generic `add(any, any)` that the
   interpreter can call.
10. Test262 integration: extend the conformance run to include eval-positive
    and Function-positive tests under the standalone target.

## Phasing

**Phase 1**

- Acorn compiled via js2wasm (deliverable proves #1058 viability)
- ~30 opcodes covering arithmetic, control flow, variable access, function
  call, built-in invocation
- `new Function(constStringArgs, constStringBody)` end-to-end
- `eval(constString)` as indirect-eval, indirect-eval `(0, eval)(s)` for
  arbitrary s
- Exception propagation
- 10+ test262 eval-positive tests passing under standalone target

The Phase 1 deliverable is a defensible answer to "how does js2wasm handle
eval" without overpromising. The story is: AOT specialization (#1102 Option
B) for static cases, host-import fallback (#1006 / #1066) for hosted
environments, **and** a Wasm-GC-native bytecode interpreter for cases neither
covers.

**Phase 2**

- Direct eval with caller scope capture. Requires may-contain-eval tracking
  in the AOT path, promoting capturable locals into Wasm-GC scope objects.
  Documented in a follow-up ADR; performance impact on non-eval-touching
  functions must be measured before committing.
- Generators / async-await dispatch (SuspendGenerator / ResumeGenerator
  opcodes)
- Tier-up: hot interpreted functions re-compiled by the AOT backend at
  runtime, V8-Ignition-style, gated by call-count feedback slots in the
  bytecode

**Phase 3 (long term)**

- Eventual replacement of the in-module interpreter for `eval(dynamicString)`
  with `func.new` once the JIT-interface proposal (#1165) ships in runtimes.
  The interpreter remains valuable for the structurally-undynamicizable cases
  (`with` statements, Proxy with dynamic handlers) where `func.new` would not
  help.

## Non-goals

- Full V8 / SpiderMonkey-grade interpreter performance. The interpreter is
  the fallback path. Hot code is the AOT path's responsibility, with optional
  tier-up in Phase 2 if measured to be necessary.
- A general-purpose embedded JavaScript engine. The interpreter exists to
  cover the gap between AOT specialization and host-import fallback for code
  that cannot be statically resolved or hosted.
- TypeScript parsing at runtime. The runtime parser is Acorn (JavaScript
  only). TypeScript parsing remains a build-time concern.
- Source-level debugging of `eval`-generated code in Phase 1. Source maps for
  dynamically generated code are a Phase 3 concern.
- Replacement of #1006 or #1066. JS-host mode (#1006) remains the fast path
  for browser and Node hosts; standalone host-import (#1066) remains the
  option for hosts that prefer to embed the compiler. The interpreter is the
  third leg.

## Relationship to other issues

- **#1058** (js2wasm self-host) — hard dependency. The interpreter and Acorn
  must compile through js2wasm itself.
- **#1102** (Wasm-native eval AOT strategy) — this issue is the Option A path
  #1102 documented. Option B (AOT specialization) remains the first dispatch
  attempt; the interpreter is invoked only when Option B cannot resolve the
  call statically.
- **#1006** (eval via JS host import) — unchanged. The interpreter is the
  standalone-mode equivalent, not a replacement.
- **#1066** (eval via host-compiled Wasm child module) — alternative
  standalone path. Both can coexist: hosts that prefer recursive compilation
  use #1066; hosts that prefer in-module execution use this issue.
- **#1100, #1101, #1103, #1104, #1105** (Wasm-native Proxy / WeakRef /
  Map+Set / Error / String methods) — the shared built-in library this
  interpreter dispatches into. Progress on those issues directly improves the
  interpreter's coverage.
- **#1042** (async-await state machine lowering) — Phase 2 generator support
  in the interpreter must align with the lowering strategy decided there.
- **#1089** (codegen support for dynamic import expressions) — adjacent
  dynamic-codegen concern that may share infrastructure with the interpreter
  path.
- **#1165** (track Wasm JIT-interface proposal) — long-term replacement
  candidate for the dynamic-string portion of this work.

## ECMAScript spec reference

- [§19.2.1 `eval(x)`](https://tc39.es/ecma262/#sec-eval-x) — global / indirect
  eval semantics
- [§19.2.1.1 PerformEval](https://tc39.es/ecma262/#sec-performeval) —
  variable environment handling for direct eval (Phase 2)
- [§20.2.1.1 `Function(p1, p2, …, pn, body)`](https://tc39.es/ecma262/#sec-function-p1-p2-pn-body) —
  Function constructor semantics

## Acceptance criteria — Phase 1

- [ ] Acorn vendored under `runtime/parser/` and compiled through js2wasm
      without manual workarounds. Build is reproducible from `pnpm build`.
- [ ] ADR-XXX (opcode set design) committed under `docs/adr/`, citing the
      register+accumulator decision and the alternatives considered.
- [ ] Bytecode emitter integrated as a second IR backend, gated by a per-
      function may-contain-dynamic flag from static analysis.
- [ ] Dispatch loop in TypeScript, compiled with js2wasm, with generated
      output reviewed and noted in the ADR for any boxing in hot-path
      interpreter variables.
- [ ] Bidirectional call protocol: AOT-compiled function `f` can call
      interpreted function `g` and vice versa, with no marshalling, identical
      boxed-value identity preserved.
- [ ] `new Function("a", "b", "return a + b")` returns a callable that
      computes `3` when called with `(1, 2)`, in standalone mode, no JS host.
- [ ] `(0, eval)("1 + 2")` returns `3` in standalone mode (indirect eval).
- [ ] `eval("throw new Error('x')")` propagates through the AOT/interpreter
      boundary into a catching `try / catch` block.
- [ ] At least 30 test262 eval-positive and Function-positive cases pass
      under standalone target.
- [ ] Module-size baseline: a "no-eval" module remains within 5% of current
      0.2KB floor; an "eval-enabled" module documents a single, measured size
      figure for the parser + interpreter linkage.

## Risks

- **Acorn compilation gaps**. Acorn uses generators, classes, computed
  properties, and other features that current conformance covers but may
  exercise compiler corners. Each gap encountered is documented as a child
  issue under #1058. Mitigation: tackle Acorn compilation as Week 1 of
  Phase 1, surface gaps early.
- **Interpreter performance worse than expected**. Even with a TypeScript
  dispatch loop and disciplined typing, the generated code may be slower than
  a hand-written Rust interpreter would be. Mitigation: inspect generated
  Wasm-GC output during ADR work; if the compiler is not yet producing
  efficient switch dispatch, file a compiler issue and accept the slower
  baseline (the interpreter is the fallback, not the hot path).
- **Shared boxing constraints on AOT specialization**. Requiring all built-
  ins to have a generic form may slow the AOT path if specialization decisions
  start hedging. Mitigation: keep specialized forms as the primary AOT
  emission; generic forms are dispatch targets when types are unknown, not
  the default.
- **Direct-eval scope capture (Phase 2) performance impact**. Promoting
  capturable locals into heap-allocated scope objects costs allocation per
  function entry even when no eval is invoked. Mitigation: gate behind static
  analysis ("may contain eval"); only promote when the analyzer cannot
  exclude eval.
- **Surface area for bugs**. A new execution path is a new place semantic
  bugs can hide. Mitigation: differential testing (#1203) extended to cover
  the bytecode path; every test262 case that passes via AOT must produce
  identical results via the interpreter when forced.

## Notes

- The strategy is consciously a **self-hosted** strategy. Acorn-via-js2wasm
  doubles as a #1058 conformance test; the interpreter being authored in
  TypeScript and compiled by the same compiler doubles as a stress test
  for the compilation pipeline on a realistic workload.
- Built-ins authored against the boxed representation benefit both paths
  equally. This is the lever that makes the proposal viable within
  practical time budgets: most of the engineering surface area (built-ins)
  is shared work that needed to happen for AOT conformance anyway.
- Reference engines studied during design: V8 Ignition (register-based
  dispatch with accumulator, feedback vectors, suspend/resume encoding), Lua
  5 (clean register-based VM), Hermes (production register-based JS
  interpreter at scale). All are referenced in the ADR as prior art, none
  are ported.
- This issue does not commit to a specific delivery milestone. The
  decision to start the work is contingent on:
  (a) #1058 reaching a state where self-hosting Acorn is plausible, and
  (b) a test262 cluster analysis confirming that genuinely-dynamic eval is
  a binding constraint for compatibility, not built-in coverage.
  Both gating conditions are tracked separately.

## Implementation Plan

To be added once the issue is taken into a sprint. The plan should cover:

- Acorn vendoring strategy (subtree vs. submodule vs. inlined)
- Concrete opcode list with bytecode encoding
- Static-analysis flag propagation for may-contain-dynamic
- Test plan, including which test262 buckets gate Phase 1 sign-off
- Build flag for opt-in / opt-out of the interpreter linkage
- Cross-mode parity test extension (the differential testing harness must
  exercise both AOT and bytecode paths)


## Parallel slice plan + bytecode contract

> **SUPERSEDED (2026-07-17 audit).** This 2026-05-30 plan predates the
> architecture doc's Part II (§12.1): Phase 1 builds ONLY the runtime
> ESTree→bytecode producer in a new `src/interp/` dir (see #2928's
> `## Implementation Plan` and the #3101 ISA pre-spec); the IR→bytecode
> producer and the a0–a6 trait-migration track below are a Phase-3 option
> re-decided at #2929 time. Do NOT execute the slice plan below. Kept for
> the (a0) seam/#1715 landing history it records. See
> `plan/log/analysis-2026-07/02-interpreter-backend-audit-2026-07-17.md` §3.

This section decomposes Phase 1 into **disjoint, parallel-safe slices** so
multiple senior-devs work it without file collisions, and **pins the shared
bytecode contract** that keeps the slices from drifting apart. It is grounded
in the #1715 proof (landed via PR #954, `src/ir/backend/bytecode-emitter.ts`,
`src/ir/backend/bytecode-vm.ts`, `tests/ir-bytecode-proof.test.ts`) and the
#1713 `BackendEmitter` trait seam (`src/ir/backend/emitter.ts`).

### 0. The #1715 ADR finding this plan rests on

The #1713 trait abstracts the **execution model**, not the representation. The
**only** representation-specific part of the seam is the _sink type_: WasmGC /
linear share the `Instr[]` sink; bytecode generalises it to an abstract
`BytecodeSink`. Everything else — the primitive _set_ (`emitConst`,
`emitBinary`, `emitLocalGet/Set`, `emitReturn`, `emitIf`, …), the
push-to-sink convention, and the **caller-owns-operand-order** contract
(`lower.ts` emits operand subtrees via `emitValue` _before_ the terminal-op
primitive) — transfers unchanged. Critically, **the encoding (stack vs
register+accumulator) is a free choice _below_ the seam**: the seam does not
observe it. That is what lets slices (a) and (b) proceed in parallel against a
frozen primitive surface while one of them picks the encoding internally.

### 0a. SCOPE REALITY — the seam routes ~23 of ~189 sites today (load-bearing)

**Do not let the "emitter slice" hide the bulk of #1584's real work.** As of
the #1713/#1714 landing the `BackendEmitter` trait routes only **~20
pass-through primitives + 3 vec primitives** through the seam. Real `lower.ts`
still contains **~166 inline `out.push({ op })` sites** typed directly against
`Instr[]` — `call` / `call_ref`, `struct.get` / `struct.new` / `struct.set`,
`try` / `throw` / `rethrow`, `loop` / `block` / `br_if`, ref-coercion
(`ref.cast`, `any.convert_extern`, `extern.convert_any`), and the js-bitwise
scratch lowering. **The #1715 proof only worked because the test
HAND-LOWERS through 7 emitter primitives and never invokes `lower.ts`.**

Consequence: **"production emitter" is NOT a contained type-swap.** It is
three distinct movements that must be scoped separately so the work is visible:

1. **Sink generalization** — widen the seam's sink from the concrete `Instr[]`
   to a `BackendSink` abstraction that (a) `WasmGcEmitter` realizes as
   `Instr[]` and (b) `BytecodeEmitter` realizes as a `BytecodeSink`, **and
   that can still absorb a raw `Instr` for the not-yet-routed ops** (so
   migration is incremental, not big-bang). Productionize the already-routed
   ~23-primitive subset end-to-end through real `lower.ts` immediately.
2. **The 166-site trait migration** — move each inline `out.push({op})` site
   behind a trait primitive, **grouped by op family** (see §2a). This is the
   real bulk of #1584 and gets its own explicitly-scoped sub-track.
3. **Bytecode realization** — each newly-routed primitive group then needs a
   `BytecodeEmitter` opcode + a `bytecode-vm.ts` case (slices a/b), which is
   how the op families flow into the VM.

This reframes the dependency order (see §2 summary): **contract pin → sink
generalization → per-op-group trait-migration sub-slices (∥ where families are
independent) → VM realization + eval-entry.** The VM and eval-entry consume
the _output_ of the migration; they do not wait for all 166 sites, only for
the op families they exercise.

### 1. THE PINNED CONTRACT (single source of truth)

> **Owner file: `src/ir/backend/bytecode-emitter.ts`.** This file owns the
> opcode enum (`OP`), the `BytecodeSink` interface/class, and the
> `BytecodeEmitter` primitive surface. **Only slice (a) edits this file.**
> Every other slice imports it **read-only**. The VM (slice b) is the _reader_
> of `OP` + `BytecodeSink`; the eval-entry (slice c) is a _driver_ of
> `BytecodeEmitter`. If two slices both need to touch the contract, that is a
> contract change — escalate, do not edit in parallel.
>
> **Second owned file (the seam): `src/ir/backend/emitter.ts`** — the
> `BackendEmitter` trait + the new `BackendSink` abstraction (§0a-1). The
> sink-generalization sub-slice owns this; the per-op-group migration sub-slices
> _add methods to the trait_ under coordination (see §2a for how the families
> stay disjoint).

#### 1a. Encoding decision: **register + accumulator (Ignition-style)** — but staged

The #1715 proof picked a **stack machine** as the _throwaway-grade_ tiebreaker
(issue §6: "a stack machine is acceptable for the proof if simpler"). For the
**production** Phase-1 VM, this plan commits to **register + accumulator**, per
the issue's own §"Component 2/3" rationale and the V8 Ignition / Lua 5 / Hermes
prior art:

- **Justification (why reg+acc over stack for production):** (1) fewer
  opcodes per source operation — operands are register indices, not
  push/pop pairs, so a single `Add r2` replaces `LOAD; LOAD; ADD`; (2) the
  accumulator absorbs the implicit destination, halving operand encoding on
  the common case; (3) **Wasm-locals map 1:1 to virtual registers** in the
  dispatch function the VM is compiled to, so the compiled dispatch loop
  avoids a software operand stack (the Titzer 2022 dispatch-loop grounds in
  the issue). The stack model would force a `number[]` push/pop hot loop that
  the AOT-compiled dispatch cannot turn into Wasm locals.
- **Why this does NOT block parallelism:** the encoding lives **below the
  seam**. Slices (a) and (b) agree only on the _primitive surface_ + the
  `OP`/`BytecodeSink` shapes; the reg-vs-stack realization of each opcode is
  internal to (a)+(b) and invisible to (c)/(d). The #1715 stack proof remains
  the regression anchor (see §"If the contract shape changes" below).

**STAGING NOTE for the two parallel senior-devs (a)/(b) starting NOW on the
#1715 proof files:** keep building on the **stack** shapes already in
`bytecode-emitter.ts`/`bytecode-vm.ts` for your _first_ landed increment so the
triple-equivalence test keeps passing and you stay disjoint. The reg+acc switch
is a **follow-up contract bump** landed by slice (a) alone (see §"contract
shape change" — it is called out explicitly there). Do **not** race each other
to flip the encoding mid-slice.

#### 1b. Opcode set — Phase 1 target (~30 opcodes, extends the #1715 14)

The #1715 `OP` enum (`CONST, LOAD, STORE, ADD, SUB, MUL, CMP_*, NEG, JZ, JMP,
RET`) is the **kept numeric base** (do not renumber existing values — the VM
and proof test depend on them). Phase 1 adds, owned by slice (a) in
`bytecode-emitter.ts`, realized by slice (b) in `bytecode-vm.ts`. **Each group
below corresponds 1:1 to an op-family migration sub-slice in §2a** — that is
how the inline-site migration and the opcode growth stay coupled:

- arithmetic completion: `DIV, MOD`, bitwise (`AND, OR, XOR, SHL, SHR, USHR`),
  remaining compares (`CMP_NE, CMP_SEQ, CMP_SNE`), `NOT`, `TYPEOF`
- property access (`struct.*` family): `GET_BY_NAME, SET_BY_NAME,
GET_BY_VALUE, SET_BY_VALUE` (prototype-chain walk lives in the shared
  built-in lib, invoked by the op)
- variable/closure: `LD_GLOBAL, ST_GLOBAL, LD_CLOSURE, ST_CLOSURE`
- calls (`call`/`call_ref` family): `CALL <argc>, CONSTRUCT <argc>,
CALL_METHOD <argc>` (with `this`), and `CALL_BUILTIN <id> <argc>` (dispatch
  into the shared built-in library — the _same_ functions the AOT path calls;
  §"Component 4")
- control flow already present (`JZ/JMP/RET`); add `JNZ`, plus the `loop` /
  `block` / `br_if` family lowered to `JZ/JNZ/JMP` + backpatch labels
- exceptions (`try`/`throw`/`rethrow` family): `THROW, TRY_START
<catchTarget>, TRY_END`
- wide / extra-wide prefix opcodes (`WIDE, EXTRA_WIDE`) for >255 locals /
  large jump targets, mirroring Ignition — declared in Phase 1, exercised as
  needed.

`SuspendGenerator / ResumeGenerator / YieldValue` are **Phase 2**, out of these
slices' scope (they align with #1042 async-state-machine lowering).

#### 1c. `BytecodeSink` interface contract (frozen)

The #1715 `BytecodeSink` shape is the contract: `readonly code: number[]`,
`readonly constPool: number[]`, `internConst(value): number`, `here(): number`,
`emit(op, ...operands): void`, `emitJumpPlaceholder(op): number`,
`patch(slot, target): void`. Phase-1 extension owned by slice (a): a parallel
`refPool` (or boxed-value constant pool) for non-f64 immediates (strings,
function templates) so the `code` array stays integer-only, plus an
`exceptionTable` (list of `{tryStart, tryEnd, catchTarget}`) for `TRY_START`.
**Adding fields is backward-compatible**; existing readers ignore them.

#### 1d. VM dispatch contract (frozen)

Entry point shape stays as #1715's, generalised for boxed values in Phase 1:

```
runBytecode(code: readonly number[],
            constPool: readonly JSValueOrNumber[],
            args: readonly JSValue[],
            // Phase-1 additions, all optional so the #1715 numeric path is unchanged:
            closureEnv?, exceptionTable?): JSValue
```

Invariant the VM must preserve (and the eval-entry relies on): **the VM
operates on the shared boxed `JSValue` representation, with NO marshalling at
the AOT⇄interpreter boundary** (issue "Component 4"; AC "identical boxed-value
identity preserved"). Booleans remain `1`/`0` for `JZ`/`JNZ` truthiness as in
#1715. The dispatch loop stays in the js2wasm-compilable TS subset (numbers,
locals, a `switch`, a loop, arrays) so #1584 can compile the loop itself.

#### 1e. eval-entry signature (frozen, owned by slice c)

```
// indirect eval / Function constructor entry — standalone, no JS host
evalIndirect(source: string): JSValue              // (0, eval)("…"), eval(constStr)
functionConstructor(params: string[], body: string): JSValue   // new Function(a,b,"return a+b")
```

Both route: `source → acorn.parse (ESTree) → ESTree→IR adapter → lower.ts(IR,
BytecodeEmitter) → BytecodeSink → runBytecode`. Direct-eval scope capture is
**Phase 2** (§Phasing); Phase 1 is indirect/global-scope only
(ecma262 §19.2.1, the `direct=false` path of §19.2.1.1 PerformEval; Function
constructor per §20.2.1.1, which is _always_ indirect — global scope, no
caller-env capture).

### 2. The slices

| Slice                                              | Owns (writes)                                                                                                                                                   | Imports read-only                            | Depends on                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| **(0) Contract pin**                               | `src/ir/backend/bytecode-emitter.ts` (OP enum, BytecodeSink, BytecodeEmitter surface) + ADR doc                                                                 | `emitter.ts` (BackendEmitter shape)          | — (lands first)                    |
| **(a0) Sink generalization**                       | `src/ir/backend/emitter.ts` (`BackendSink` abstraction; raw-`Instr` escape hatch), `WasmGcEmitter` sink realization, the ~23 already-routed sites in `lower.ts` | `bytecode-emitter.ts`                        | (0)                                |
| **(a1..a6) Trait-migration sub-slices**            | one op-family's inline `out.push` sites in `lower.ts` + that family's trait methods in `emitter.ts` + `WasmGcEmitter` + `BytecodeEmitter` opcodes               | the sink abstraction from (a0)               | (a0)                               |
| **(b) Wasm-GC-native VM**                          | `src/ir/backend/bytecode-vm.ts`                                                                                                                                 | `bytecode-emitter.ts` (`OP`, `BytecodeSink`) | (0), then per-family from (a1..a6) |
| **(c) eval / Function entry + Acorn→IR**           | `src/runtime/eval-entry.ts` (new), `src/ir/backend/estree-to-ir.ts` (new), runtime `parser/acorn` vendoring                                                     | emitter/vm/lower (read-only)                 | (a\*)+(b), **acorn track** (§3)    |
| **(d) dynamic-fallback wiring + standalone story** | `src/codegen/index.ts` dispatch glue, CLI/build flag, standalone link path                                                                                      | `eval-entry.ts`, `lower.ts`                  | (a\*)+(b)+(c)                      |

The contract pin (0) is folded into slice (a0)'s owner — the **emitter
senior-dev owns `bytecode-emitter.ts` + `emitter.ts` and lands the contract
pin + sink generalization as the first commits**, then everyone rebases.
This is why only one slice ever _creates_ the seam shapes; the migration
sub-slices only _add methods_ to an already-shaped trait.

### 2a. The 166-site trait migration — its own sub-track (op-family grouped)

This is the load-bearing bulk of #1584 that the headline "emitter slice"
otherwise hides. After (a0) lands the sink abstraction, the ~166 inline
`out.push({op})` sites in `lower.ts` migrate behind the trait **one op family
at a time**. Each family is an independent sub-slice (parallel-safe _across
families_ because they touch disjoint `lower.ts` switch arms and disjoint trait
methods; serialize _within_ a family). Suggested ordering by leverage:

- **(a1) call family** — `call` / `call_ref` sites → `emitCall` / `emitCallRef`
  trait methods (already _declared_ optional in `emitter.ts`) → `OP.CALL /
CALL_METHOD / CALL_BUILTIN / CONSTRUCT`. Highest leverage: unblocks
  built-in dispatch (the eval-entry needs it).
- **(a2) struct/object family** — `struct.new` / `struct.get` / `struct.set`
  → `emitAggregateNew` / `emitFieldGet` / `emitFieldSet` (declared) →
  `OP.GET_BY_NAME / SET_BY_NAME / GET_BY_VALUE / SET_BY_VALUE`.
- **(a3) control-flow family** — `loop` / `block` / `br_if` → structured
  emitter helpers (the bytecode realization is `JZ/JNZ/JMP` + backpatch, as
  `emitIf` already demonstrates in the #1715 proof).
- **(a4) try/throw family** — `try` / `throw` / `rethrow` → `OP.TRY_START /
TRY_END / THROW` + the `exceptionTable` sink field (§1c). Gates the
  cross-boundary exception-propagation AC.
- **(a5) ref-coercion family** — `ref.cast` / `any.convert_extern` /
  `extern.convert_any` → `emitToExternref` / `emitFromExternref` (declared).
  Note: this family is **WasmGC-specific**; for the bytecode backend it is
  largely a no-op (the VM operates on boxed `JSValue` directly), so the
  `BytecodeEmitter` realization is mostly empty/identity — but the _trait
  routing_ still must happen so `lower.ts` stops branching on backend.
- **(a6) bitwise scratch** — the js-bitwise lowering scratch sites →
  `OP.AND/OR/XOR/SHL/SHR/USHR/NOT`.

**Coordination rule for the trait file:** `emitter.ts` is touched by every
migration sub-slice (each adds/realizes its family's methods). To keep them
disjoint, **each family owns only its own method block** — the optional method
declarations already reserved in `emitter.ts` (`emitCall?`, `emitFieldGet?`,
`emitAggregateNew?`, `emitToExternref?`, …) are the pre-agreed seams, so a
sub-slice _implements_ a declared method rather than _adding new surface_. New
surface (a method not already declared) is a contract change → route through
the (a0) owner.

**Acceptance for the migration track:** the IR-fallback budget
(`pnpm run check:ir-fallbacks`) and the existing equivalence suite stay green
after each family lands (the WasmGC output must remain byte-identical — the
migration is a refactor of _where_ the op is emitted, not _which_ op). A family
is "done" when its `lower.ts` arm contains zero raw `out.push({op})` for that
family and both `WasmGcEmitter` (byte-identical) and `BytecodeEmitter` (opcode)
realize it.

#### Slice (a0)/(a1..a6) — Production emitter, restated

- **Owns:** `bytecode-emitter.ts` (contract), `emitter.ts` (the `BackendSink`
  abstraction + trait method realizations), the migrated `lower.ts` switch
  arms, `WasmGcEmitter` (new method realizations), and the per-family
  `BytecodeEmitter` opcodes. **Do not delete/relocate `WasmGcEmitter` logic** —
  move it _behind_ the trait, byte-identical.
- **Imports read-only:** none beyond IR node types.
- **Acceptance test:** (1) `tests/ir-bytecode-proof.test.ts` triple equivalence
  re-pointed so the bytecode arm is produced by **real `lower.ts`** (not the
  hand-lowerer) for the #1715 three functions; then extended per migrated
  family; (2) equivalence + ir-fallback budget green after every family.
- **Dependency order:** (0)→(a0)→{(a1)∥(a2)∥(a3)∥(a4)∥(a5)∥(a6)}.

##### (a0)-seam LANDED (#958, 2026-05-30) + (a0)-tail LANDED (2026-05-30)

**(a0) TAIL — DONE (task #246).** `lower.ts` is now generic over the emitter
sink `S`: `lowerIrFunctionToWasm` is a thin `S = Instr[]` wrapper over the new
`lowerIrFunctionBody<S>(func, resolver, emitter): IrLoweredBody<S>`. The
`requireInstrSink(out)` guard (`Array.isArray` — true exactly for the WasmGC
`Instr[]` sink) fences the op families that structurally embed `Instr[]`
sub-buffers (forof.vec/iter/string · for/while.loop · try · await) until their
op-families migrate (a1..a6); they throw loudly on a bytecode sink. The ~119
inline pushes split as designed: core stack primitives (local.get/set/tee,
const, binary, unary, select, drop, return) route through the **typed emitter
methods** (byte-identical on WasmGC, functional on bytecode); the remaining
not-yet-migrated raw `Instr` pushes go through `emitter.pushRaw`. Validation:
tsc clean, ir-fallback budget unchanged (zero delta), biome clean, and the
**full equivalence suite has a byte-for-byte identical failing-test set vs
`origin/main`** (73 pre-existing fails, 0 regressions). `tests/ir-bytecode-proof.test.ts`
gained a REAL-`lower.ts` arm: it hands the #1715 three IR functions to
`lowerIrFunctionBody(fn, resolver, new BytecodeEmitter())` and asserts triple
equivalence (bytecode == WasmGC == JS) — satisfying the (a0) acceptance
criterion ("bytecode arm produced by real `lower.ts`, not the hand-lowerer").
Next: the (a1..a6) op-family migration sub-track (task #245).

**The (a0) SEAM is merged (PR #958):** `BackendEmitter<S = Instr[]>` is generic
over the sink; `newSink()` + `pushRaw(out, instr)` (the raw-`Instr` escape hatch)
are on the trait; `WasmGcEmitter`/`LinearEmitter` realize `S = Instr[]`
(byte-identical); production `BytecodeEmitter implements BackendEmitter<BytecodeSink>`
with the additive `OP` set (base 0..14 frozen; +`DIV/CMP_NE/TEE/GLOBAL_GET/SET/
SELECT/DROP/UNREACHABLE` = 15..22) + `BytecodeSink.spliceArm`; the proof test
drives the production trait surface. **The (a0) TAIL — threading the generic sink
through `lower.ts` so REAL `lower.ts` drives the bytecode emitter — is the next
commit.** Below is the validated, deterministic recipe (derived + dry-run'd on
branch `issue-1584-a0-tail`; reverted pending a focused-review session because it
touches the conformance-critical 2368-line file and must be byte-identical on
WasmGC). Task #246 tracks it.

**Signature split (DONE in the dry-run, keep):**

- `IrLoweredBody<S>` = `{ name, body: S, locals, typeIdx, exported }`.
- `lowerIrFunctionToWasm(func, resolver, emitter: BackendEmitter<Instr[]> = new WasmGcEmitter())`
  becomes a THIN wrapper that calls `lowerIrFunctionBody(...)` and assembles the
  `WasmFunction` from `S = Instr[]` (byte-identical; every existing caller unchanged).
- `lowerIrFunctionBody<S>(func, resolver, emitter: BackendEmitter<S> = new WasmGcEmitter() as unknown as BackendEmitter<S>): IrLoweredBody<S>`
  holds the existing body. Final return → `IrLoweredBody<S>` (drop the `func:` wrap).

**The `requireInstrSink` guard (the load-bearing insight):** the out-of-subset op
families — `forof.vec` / `forof.iter` / `forof.string` / `for.loop` / `try` /
`await` — build nested `Instr[]` sub-buffers (`loopBody`, `tryBody`, `catchBody`,
`innerBody`, `innerCatchAll`, `ca`, `rejectedBranch`, `pendingBranch`) and EMBED
them into a raw WasmGC `Instr` (`{op:"loop", body: loopBody}`). That structural
embed is WasmGC-specific and can't flow through a non-`Instr[]` sink. So each such
arm calls FIRST:

```ts
const requireInstrSink = (out: S): Instr[] => {
  if (!Array.isArray(out))
    throw new Error(
      `ir/lower: '${func.name}' uses an op family (loop/try/await) not yet migrated behind the trait — out of the bytecode subset. See plan/issues/1584 §2a.`,
    );
  return out as Instr[];
};
```

`Array.isArray(out)` is true exactly when `S = Instr[]` (WasmGC); the bytecode
`BytecodeSink` is an object → throws (the not-yet-migrated boundary, surfaced
loudly). Inside the arm, do `const wasmOut = requireInstrSink(out);` and use
`wasmOut` for ALL the arm's `Instr[]` work + the terminal `out.push({op:"loop"…})`
→ `wasmOut.push(...)`. The arm's internal `emitInstrTree(sub, loopBody)` recursions
pass `Instr[]` buffers where `S` is expected — sound because the arm already
asserted `S = Instr[]`, so cast: `emitInstrTree(sub, loopBody as unknown as S)`.

**Generic helper signatures (`out: Instr[]` → `out: S`):** `coerceToF64ForBitwise`,
`emitValue`, `emitInstrTree`, `emitBlockBody`. The LOCAL `emitArmBody`/`emitBodyBuffer`
helpers INSIDE try/loop arms stay `target: Instr[]` (they write into `wasmOut`
sub-buffers). The `case "if"` arm's `thenBody`/`elseBody` (and the `br_if`
terminator's `thenOps`/`elseOps`) → `emitter.newSink()` (type `S`), passed to
`emitter.emitIf(blockType, thenBody, elseBody, out)`. The entry `const body: Instr[] = []`
→ `emitter.newSink()`.

**The ~119 raw `out.push({op})` sites split into TWO classes — do NOT blanket-sed:**

1. Sites where `out` is the generic-`S` param (the flat routed-subset emission:
   `call`, `box`/`unbox`, `tag.test`, ref-coercion, the js-bitwise scratch dance,
   etc. — the ~102 TS2339 `Property 'push' does not exist on type 'S'` errors) →
   `emitter.pushRaw(out, {op…})`.
2. Sites inside the out-of-subset arms after `const wasmOut = requireInstrSink(out)`
   (loop/try/await) → rename `out.push` to `wasmOut.push` (stays a real array push).
   Discriminate by: is the `.push` lexically inside a `forof.*`/`for.loop`/`try`/
   `await` case arm? → class 2; else → class 1.

**Error budget from the dry-run:** after the signature changes, `tsc` shows
**127 errors in lower.ts** — 102 × TS2339 (`out.push` → `pushRaw`/`wasmOut.push`),
24 × TS2345 (`Instr[]`↔`S` at the if-arm/loop sub-buffer hand-offs — resolved by
`newSink()` for if-arms + the `requireInstrSink` cast for loop/try), 1 × TS2353
(object-shape, the final return — resolved by the `IrLoweredBody<S>` split). When
all 127 clear AND the equivalence suite + ir-fallback budget are green (WasmGC
byte-identical), extend `tests/ir-bytecode-proof.test.ts` with a REAL-`lower.ts`
arm: `parse src → lowerFunctionAstToIr → lowerIrFunctionBody(fn, resolver, new BytecodeEmitter()) → runSink`,
asserting triple equivalence for the #1715 three functions. That satisfies the
(a0) acceptance criterion ("bytecode arm produced by real `lower.ts`").

**(a5) ref-coercion note (relayed from acorn-dev via #1731/#1725):** the
ref-coercion family's real complexity isn't only `coerceType` — #1725's root cause

- fix lived in `src/codegen/fixups.ts` (`repairStructTypeMismatches`, a backward-walk
  overshoot inserting a bad `ref.cast` across control flow). The (a5) migration must
  account for the `fixups.ts` post-pass too, not just `coerceType`.

#### Slice (b) — Wasm-GC-native VM / dispatch loop

- **Owns:** `src/ir/backend/bytecode-vm.ts` exclusively. Extends the #1715
  dispatch loop to the §1b op set over boxed `JSValue`, keeps the
  js2wasm-compilable TS subset, and **must itself compile through js2wasm**
  (the "compile the dispatch loop" AC). Realizes the reg+acc encoding under the
  frozen `OP`/`BytecodeSink` (the §1a staging note applies — stack first, then
  the (a)-owned reg+acc bump). Consumes op families from (a1..a6) **as they
  land** — VM cases are added per family, not all at once.
- **Imports read-only:** `bytecode-emitter.ts` for `OP` + `BytecodeSink` type.
- **Acceptance test:** (1) the existing triple-equivalence (`runSink` arm)
  stays green; (2) a new test that **compiles `bytecode-vm.ts` itself with
  `compile()`** and runs a small program through the compiled VM, asserting it
  equals the TS-interpreted VM (proves the loop is js2wasm-compilable, AC
  "dispatch loop compiled with js2wasm").
- **Dependency order:** parallel with (a\*) once the contract lands; each VM
  case follows its op family.

#### Slice (c) — eval()/Function() entry + Acorn parse→IR→bytecode

- **Owns:** `src/runtime/eval-entry.ts` (the §1e entry points), a new
  `src/ir/backend/estree-to-ir.ts` (ESTree AST → existing IR nodes), and the
  runtime Acorn vendoring under `runtime/parser/`.
- **Imports read-only:** `bytecode-emitter.ts`, `bytecode-vm.ts`, `lower.ts`.
- **Acceptance test:** the issue's Phase-1 ACs —
  `new Function("a","b","return a + b")(1,2) === 3` and
  `(0, eval)("1 + 2") === 3` in standalone mode (no JS host), plus
  `eval("throw new Error('x')")` propagating across the boundary (needs the
  (a4) try/throw family + (a1) call family landed).
- **Dependency order:** needs the (a1)/(a4) families + (b), **and** the
  acorn-compile track (§3).

#### Slice (d) — dynamic-fallback wiring + standalone (no-JS-host) story

- **Owns:** the dispatch glue in `src/codegen/index.ts` (the may-contain-dynamic
  gate that routes a call to the bytecode path when AOT/#1102-Option-B cannot
  resolve it statically), the **optional Acorn linkage** build flag (no-eval
  modules stay near the 0.2KB floor), and the standalone-mode link path that
  has **no JS host import** for eval (distinct from #1006 host-eval and #1066
  recursive host-compile — the third leg).
- **Imports read-only:** `eval-entry.ts`, `lower.ts`.
- **Acceptance test:** a no-eval module's size stays within 5% of the 0.2KB
  floor; an eval-enabled standalone module runs `(0, eval)("1+2")` with **no JS
  host import present in the import section**; ≥30 test262 eval-/Function-
  positive cases pass under the standalone target.
- **Dependency order:** last — needs (a\*)+(b)+(c).

**Dependency order summary:**
`(0)contract pin → (a0)sink generalization → { (a1)call ∥ (a2)struct ∥ (a3)control-flow ∥ (a4)try-throw ∥ (a5)ref-coercion ∥ (a6)bitwise } → (b)VM realization (per family) → (c)eval-entry [+ acorn track] → (d)wiring`.

### 3. Linkage to the acorn-compile track (#1725 → #1712)

Slice (c)'s `source → acorn.parse → ESTree` step **depends on compiled-acorn
actually working**. A senior-dev is concurrently driving the acorn dogfood
acceptance:

- **#1725** (top current blocker) — `__fnctor_<Ctor>_new` emits
  `any.convert_extern` on a non-extern ref → invalid Wasm. Until this lands,
  `compile(acorn.mjs)` returns `success=true` but the binary fails
  `WebAssembly.compile()`. **Slice (c) cannot instantiate compiled Acorn until
  #1725 is fixed.** (Note: #1725 lives in the same `ref.cast`/`convert_extern`
  territory as the (a5) ref-coercion migration family — coordinate so the two
  don't both rewrite the same coercion sites.)
- **#1712** (acceptance milestone, depends on #1710/#1711) — "compiled acorn
  parses a representative `.js` with an AST structurally equal to node-acorn."
  This is the **gate** slice (c) waits on: only once #1712 is green is
  `acorn.parse` trustworthy enough to feed the ESTree→IR adapter.

**Action for the tech lead:** sequence slice (c) to _start_ its
`estree-to-ir.ts` adapter (which is pure ESTree→IR shape work and can be
unit-tested against node-acorn ASTs **without** compiled acorn) in parallel,
but **gate its end-to-end eval ACs on #1712 acceptance**. The Acorn vendoring +
instantiate path within (c) is hard-blocked by #1725. Flag this dependency in
the TaskList subject for slice (c).

### 4. ECMAScript spec references (eval / Function)

- **§19.2.1 `eval(x)`** (<https://tc39.es/ecma262/#sec-eval-x>) — Phase 1
  implements the **indirect** path: when the eval reference is not a direct
  call to the `%eval%` intrinsic, evaluation uses the **global** environment.
  `(0, eval)("…")` forces indirect via the comma operator.
- **§19.2.1.1 PerformEval(x, callerRealm, strictCaller, direct)** — Phase 1
  uses `direct = false` only (global var/lexical environment, no caller-scope
  capture). The `direct = true` branch (caller environment capture, promoting
  capturable locals into Wasm-GC scope objects) is **Phase 2** (issue §Phasing).
- **§20.2.1.1 `Function (p1, p2, …, pn, body)`** (CreateDynamicFunction) — the
  Function constructor is **always indirect**: the created function's scope is
  the **global** environment regardless of caller. This is why slice (c)
  implements `new Function(...)` first (no scope-capture machinery needed).

### 5. If the contract shape changes from the #1715 proof — READ THIS

**The two senior-devs on (a) and (b) start against the #1715 proof's exact
shapes. This plan changes the contract in exactly TWO bounded, additive ways
— both owned by slice (a), neither breaks the existing proof:**

1. **Encoding flips stack → register+accumulator** (§1a). The `OP` _names_ and
   the `BytecodeEmitter` _primitive surface_ are preserved; what changes is the
   _operand layout_ of each opcode (register indices instead of implicit
   stack) and the VM's internal model (an accumulator + register file instead
   of a `number[]` operand stack). **This is a slice-(a)-owned contract bump
   landed as one commit on `bytecode-emitter.ts` + a matching `bytecode-vm.ts`
   change by (b), coordinated, NOT raced.** Until that coordinated bump, both
   slices build on the stack shapes and keep `tests/ir-bytecode-proof.test.ts`
   green as the anchor.
2. **Sink + VM signatures grow** (the `Instr[]` sink → a `BackendSink`
   abstraction with a raw-`Instr` escape hatch in `emitter.ts`;
   `refPool`/`exceptionTable` on `BytecodeSink`; `closureEnv`/`exceptionTable`
   optional params on `runBytecode`; constPool widened from `number[]` to boxed
   `JSValue`). These are **purely additive** — every #1715 caller keeps working
   because the new params are optional, the numeric path is unchanged, and the
   raw-`Instr` escape hatch lets the not-yet-migrated `WasmGcEmitter` sites
   keep pushing `Instr` during the §2a migration.

**Everything else from #1715 is preserved verbatim:** the primitive set, the
push-to-sink convention, the caller-owns-operand-order contract, the
`OP.CONST/LOAD/STORE/ADD/SUB/MUL/CMP_*/NEG/JZ/JMP/RET` numeric values, and the
triple-equivalence test as the regression anchor. **Senior-devs (a)/(b): align
on these two deltas before the reg+acc bump; do not invent new opcode numbers
or rename the surface.**

---

## 2026-05-30 — VM slice landed: dispatch loop runs AS compiled Wasm-GC (senior-dev)

**Status: the Component-3 (dispatch loop) half is greenlit and proven.** #1715
proved the #1713 seam can target a bytecode stream run by a HOST-TS dispatch
loop. This slice proves the OTHER half of the Component-3 claim — *"the dispatch
loop is itself compiled by js2wasm to Wasm-GC"* — by compiling the interpreter
through the real `compile()` and showing its execution matches.

### What landed (branch `issue-1584-wasmgc-vm`, slice (b) per PR #955 contract)
- `tests/ir-bytecode-wasmgc-vm.test.ts` (ONE new file) — proves slice (b)'s
  acceptance criterion: the dispatch loop **compiled BY js2wasm** runs the same
  bytecode and equals the TS VM. Quadruple equivalence extending #1715's triple:
  for `f(a,b)=a+b`, `g(a)={let x=a*2;return x}`, `h(a,b)=a>0?a+b:a-b`, asserts
  `host-TS VM (runSink) == Wasm-GC-compiled VM == WasmGC-compiled source == JS`,
  plus NEG + every CMP_* opcode through the compiled VM. **5 tests green.**
- **Crucially, the Wasm-GC VM arm compiles the ACTUAL `src/ir/backend/bytecode-vm.ts`
  file** (per the contract's slice-(b) acceptance test #2), not a hand-kept copy.
  `compileVmModule()` reads that file at test time and applies only mechanical
  transforms (drop the host `import`, inline `OP.*` numbers, drop the
  `BytecodeSink`-typed `runSink`, append an in-module-build entry for the #1700
  export-ABI gap). The dispatch-loop body is compiled verbatim — if anyone edits
  `bytecode-vm.ts`, the test compiles the edited loop. **No second copy to drift.**
  (An earlier increment held a `bytecode-vm-source.ts` string copy; removed in
  favor of compiling the real file, which is the stronger, drift-free proof.)
- The bytecode for both VM arms comes from the SAME `BytecodeEmitter` #1715 uses
  (the `OP` enum + `BytecodeSink` consumed READ-ONLY from sdev-emitter's
  `bytecode-emitter.ts`, per the #1584 one-owner contract).

**Zero conformance delta:** ONE new test file; `bytecode-vm.ts` itself, `lower.ts`,
the emitters, and the default pipeline are untouched (the test only *reads* the
VM file). `tsc` clean, `biome` clean.

**Encoding:** STACK machine, per the contract's §1a staging note ("build on the
#1715 stack shapes first; the reg+acc flip is a later coordinated bump owned by
slice (a)"). The reg+acc switch lands as one coordinated commit with sdev-emitter,
NOT raced independently.

### The load-bearing findings (what #1584 Phase 1 must carry forward)

1. **The dispatch loop compiles to Wasm-GC today, unchanged in shape — no
   compiler work needed.** The stack machine (`for(;;)` + `switch(op)` + operand
   `number[]` value stack + `locals`/`code`/`constPool` `number[]`) is fully
   inside the subset js2wasm already lowers. This is the Component-3 greenlight:
   "interpreter authored in TS, compiled by the same compiler" is real, not
   aspirational.

2. **The ONE boundary constraint is the export ABI, not the loop (#1700).**
   Passing a `number[]` *as an exported-function parameter* hits the JS↔Wasm
   marshalling gap ("type incompatibility when transforming from/to JS"). The
   interpreter therefore takes its entry as **primitive args and builds the
   bytecode arrays in-module** — which is also how a real eval-entry behaves
   (bytecode for a dynamic source is emitted into the module; the entry seeds
   only the call args). When #1700's array ABI lands, a generic `run(code[],…)`
   export becomes possible; until then, in-module-build is the entry contract.
   **Phase 1 should depend on / track #1700 for the generic-array entry, but is
   NOT blocked by it** — the in-module-build path is sufficient for eval/Function.

3. **Encoding is a free choice below the seam (re-confirmed).** This VM is a
   stack machine, matching #1715 §6. #1584's eventual register+accumulator VM
   changes the opcode encoding + dispatch body but NOT the
   "interpreter-as-compiled-Wasm-GC" property proven here, nor the host/Wasm
   boundary contract in (2).

4. **Standalone Wasm has no host exception to throw.** The host VM throws a
   string on malformed streams; the compiled VM returns distinct sentinel f64s
   (`VM_ERR_BAD_OPCODE`, `VM_ERR_STEP_BUDGET`). Phase 1's exception story (AC:
   `eval("throw …")` propagating through `try/catch`) must use Wasm EH tags, not
   string throws — this slice's sentinels are a stopgap for the numeric-only
   subset, to be replaced when the boxed-value + EH path lands.

### Scope boundary (honest)
- Subset is exactly #1715's: numeric arithmetic + local/const + return + one
  branch (+ NEG and the full CMP_* set). Objects/arrays-as-values/closures/calls/
  strings/exceptions remain Phase 1 / Phase 2 work.
- The bytecode is hand-lowered (operands then terminal op, as `lower.ts` drives
  the emitter). Wiring real `lower.ts` to a generic sink is the **emitter slice**
  (see `bytecode-emitter.ts` header / the #1584 emitter task), not the VM slice.
  The WasmGC-source arm DOES use real `compile()`, so the equivalence pins the
  VM output against production WasmGC lowering of the same source.
