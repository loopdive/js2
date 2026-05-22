---
id: 1584
title: "Wasm-GC-native bytecode interpreter with Acorn for eval and dynamic fallback"
status: ready
created: 2026-05-23
updated: 2026-05-23
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: spec-completeness
depends_on: [1058, 1006, 1066, 1102]
es_edition: multi
---

# #1584 — Wasm-GC-native bytecode interpreter with Acorn for eval and dynamic fallback

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
and gives a defensible answer to "what about eval" in partner conversations.

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

**Phase 1 (target: end of 3-month outreach window)**

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

**Phase 2 (post-outreach)**

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
  TypeScript and compiled by the same compiler doubles as a velocity
  demonstration for the agentic engineering workflow.
- Built-ins authored against the boxed representation benefit both paths
  equally. This is the lever that makes the proposal viable in a 3-month
  window: most of the engineering surface area (built-ins) is shared work
  that needed to happen for AOT conformance anyway.
- Reference engines studied during design: V8 Ignition (register-based
  dispatch with accumulator, feedback vectors, suspend/resume encoding), Lua
  5 (clean register-based VM), Hermes (production register-based JS
  interpreter at scale). All are referenced in the ADR as prior art, none
  are ported.
- This issue does not commit to shipping an interpreter in Phase 1 of any
  partner conversation. The decision to start the work is contingent on:
  (a) #1058 reaching a state where self-hosting Acorn is plausible, and
  (b) a test262 cluster analysis confirming that genuinely-dynamic eval is
  the binding constraint for partner conversations, not built-in coverage.
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
