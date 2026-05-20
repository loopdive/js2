---
id: 1520
title: "WasmGC-native interpreter as opt-in fallback for dynamic JS features"
status: proposed
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: eval
goal: spec-completeness
depends_on: []
related: [1006, 1066, 1100, 1102]
es_edition: multi
---
# #1520 — WasmGC-native interpreter as opt-in fallback for dynamic JS features

## Problem

A class of JavaScript features cannot be compiled ahead of time because the
source code does not exist until runtime, or the dynamic shape of the program
cannot be specialized at compile time:

- `eval(s)` and `new Function(...)` with non-literal sources (#1006, #1066, #1102)
- `with` statements outside strict mode
- arbitrary source generated at runtime by template engines, ORMs, expression
  evaluators

Today these are handled in three ways: (a) **compile-time folding** when the
source is a literal (ADR-010 case 1); (b) **JS host import** when a JavaScript
runtime is present (ADR-010 case 2, #1006); (c) **not supported** in standalone
/ WASI mode (ADR-010 negative consequence, #1066 tries to recover this via
recursive js2wasm compilation but inherits compilation latency on every call).

Two existing alternatives have been proposed and ruled out as defaults:

- **Embed an interpreter in every module** — rejected by ADR-002 and ADR-004
  because it imposes a runtime size and cold-start tax on every program
  regardless of whether it ever uses dynamic features.
- **Statically link QuickJS / Javy** — feasible (~600 KB always-on, dual
  builtins, two-heap interop tax) but contradicts the no-bundled-engine
  positioning and inherits all the cross-heap bridge costs (handle tables,
  two-GC bookkeeping, `JSValue` ↔ WasmGC ref conversion).

This issue proposes a third path: a **small JS interpreter written in
TypeScript, compiled by js2wasm itself**, that produces WasmGC code sharing
the same heap, GC, and builtin set as compiled output. The interpreter is
**lazy-loaded as a separate WasmGC chunk** and only ships when a build flag
opts in or when the static analyzer detects features that need it.

## Why this is uniquely attractive in our architecture

Because the interpreter is compiled to WasmGC (not linear memory), the
cross-heap impedance that makes the QuickJS option painful disappears:

| | QuickJS-static-linked | **WasmGC-native interpreter** |
|---|---|---|
| Cross-heap interop | handle tables, `JSValue` ↔ ref | **same heap, no bridge** |
| Object identity across boundary | requires bidirectional proxies | **automatic** |
| Builtin duality (`Array`, `Object`, …) | yes, two implementations | **none, interpreter calls compiled builtins** |
| Module size | ~600 KB always-on | **~50–150 KB lazy-loaded** |
| Bootstrap | external project | **dogfoods our own compiler** |

The interpreter and the compiled code are not two cooperating engines — they
are two front-ends to the same WasmGC runtime.

## Scope (v1)

Cover the **source-at-runtime** family of dynamic features:

- `eval(string)` — direct and indirect forms
- `new Function(...args, body)`
- `with(obj) { ... }` (sloppy mode only)
- runtime-generated source from template engines

**Out of scope** (handled elsewhere):

- `Proxy` and `Reflect` — object-model features, not source-at-runtime; tracked
  in #1100. The interpreter does not solve these.
- Dynamic `import()` — host/fetch problem, tracked in #1089.
- Performance parity with compiled code — the interpreter is a correctness/
  coverage tool, not a hot-path tool. ~20–100× slower than compiled JS is
  acceptable for v1.

## Design

### Architecture

```
                  ┌──────────────────────────────────────┐
                  │     js2wasm static compiler          │
                  │     (build time)                     │
                  └─────────────┬────────────────────────┘
                                │
              ┌─────────────────┼─────────────────────┐
              ▼                                       ▼
   ┌────────────────────┐                ┌────────────────────────┐
   │  user-program.wasm │   eval/with    │  interp-chunk.wasm     │
   │  (always)          │ ─────────────► │  (opt-in, lazy)        │
   │                    │  same heap     │  - parser              │
   │  - compiled funcs  │ ◄───────────── │  - AST walker          │
   │  - WasmGC builtins │   shared refs  │  - shared builtins ref │
   └────────────────────┘                └────────────────────────┘
              │                                       │
              └───────────────┬───────────────────────┘
                              ▼
                     Single host WasmGC heap
                     (host-owned GC, shared structs)
```

The interpreter chunk is a separate Wasm module that imports the user
program's builtin table (Array, Object, String, Map, etc.) and the runtime
helper functions, and exports a single entry: `eval(source, scopeBridge) → value`.

### Pipeline

1. **Parser** — small bespoke ES2017+ parser written in TS, compiled by
   js2wasm. Acorn-shaped. ~5–10 KLOC TS. No error recovery beyond what
   ECMAScript requires. ~50–150 KB gzipped output.
2. **AST walker** — switch over node kinds; evaluate each node against a
   reified scope chain (linked list of envs, reusing the ref-cell pattern
   from #007 closure conversion).
3. **Scope bridge** — eval/with need access to the caller's lexical scope.
   The static compiler emits a scope object at every eval site (already
   designed in #1073). The interpreter walks that scope object.
4. **Exception interop** — Wasm `try_table` + the existing throw tag; thrown
   values propagate transparently across interpreter ↔ compiled boundary
   (because they're the same ref values).

### Build modes

- `--standalone-eval=host` (default in JS-host mode) — ADR-010 case 2
- `--standalone-eval=interp` — link the interpreter chunk; resolves
  `eval`/`Function` imports against it
- `--standalone-eval=none` (default in WASI mode) — current behavior; eval
  throws at runtime
- `--auto-interp` — static analyzer decides per-program based on detected
  feature use

## Bootstrap discipline

The interpreter is written in TS and compiled by js2wasm. **Features the
interpreter uses must already be supported by the static compiler.** This
forces the interpreter to use a known-good subset:

- no `eval` inside the interpreter itself (no turtle-stacking)
- no `Proxy`, no `with`, no `Function` constructor
- typed-where-possible to enable compiler specialization

This discipline yields a side benefit: **the interpreter is a giant
integration test for the static compiler.** Anything that breaks in the
interpreter implementation breaks loudly at compiler-build time.

## Acceptance criteria (v1)

- [ ] Bespoke parser compiles via js2wasm; round-trips a 1000-LOC JS program
      to AST and back to source with no semantic loss
- [ ] AST-walking interpreter executes the test262 eval-positive subset
      (≥50 tests passing through the interpreter path) in standalone mode
- [ ] `with(obj) { ... }` (sloppy) executes through the interpreter
- [ ] Interpreter chunk gzipped size < 200 KB
- [ ] Cross-boundary object identity preserved: `let o={}; eval("o.x=1"); o.x === 1`
- [ ] Thrown exceptions cross interpreter ↔ compiled boundary as the same
      ref (no value re-construction)
- [ ] Build flag wires interpreter as the standalone eval provider
- [ ] CI lane: interpreter source files typecheck and compile clean on every PR

## Risks

- **Bootstrap discipline.** Easy to accidentally write the interpreter in
  TS features the compiler doesn't yet support. Mitigation: a dedicated
  CI lane that compiles only the interpreter subdirectory and gates merges.
- **Spec maturity.** QuickJS has had a decade of weird-input hardening; our
  interpreter starts at 0%. Mitigation: drive test262 conformance on the
  interpreter path as a parallel workstream, same model as the static
  compiler's 60% baseline.
- **Performance.** AST-walking is slow. Acceptable for v1 because the
  fallback path is rare by construction. A future bytecode interpreter
  (~5–10× faster) is straightforward to layer on once the AST walker
  works.
- **Parser maintenance burden.** A second parser to keep in sync with the
  TS compiler's parser (which we use at build time). Mitigation: scope
  the bespoke parser to ES-only (no TS syntax — eval'd source never has
  TS annotations) and a fixed ES edition (ES2017 is the realistic baseline).
- **Double-implementation drift.** Semantics-bug fixes need to land in both
  the compiler and the interpreter. Mitigation: differential testing
  (compile-then-run-vs-eval-then-run) for the overlap subset.

## Relationship to existing issues

- **Supersedes #1102 Option A** as the concrete plan: the lightweight
  interpreter is WasmGC-native and lazy-loaded, not bundled.
- **Complements #1066** — that issue proposes recursive js2wasm compilation
  on every eval call (slow first call, fast steady-state with caching).
  #1520 proposes an in-Wasm interpreter (slow steady-state, no compilation
  latency, much smaller binary). Both can coexist; they suit different
  workload shapes.
- **Does not solve #1100 (Proxy)** — that needs object-model work,
  orthogonal to source-at-runtime execution.

## Phased delivery

1. **Phase 1** (~3 weeks): AST walker against stubbed parser (parse at build
   time, embed AST as WasmGC literal). Exercises dispatch loop, scope
   chains, exception interop without parser dependency.
2. **Phase 2** (~6 weeks): bespoke ES parser compiled via js2wasm.
   Dogfood the compiler.
3. **Phase 3** (~3 weeks): build mode wiring (`--standalone-eval=interp`,
   `--auto-interp`), lazy-load packaging, separate component chunk.
4. **Phase 4** (ongoing): drive test262 conformance through the interpreter
   path; expand parser feature coverage incrementally.

## See also

- [ADR-010 — Dynamic eval() via host import](../../../docs/adr/0010-eval-host-import.md)
  (this issue extends ADR-010 with a new standalone provider)
- [ADR-0013 — WasmGC-native interpreter for dynamic fallback](../../../docs/adr/0013-wasmgc-native-interpreter.md)
  (proposed; the decision record for this approach)
