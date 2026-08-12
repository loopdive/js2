---
id: 3630
title: "Runtime eval: compile the string via acorn + IR→codegen (no TS parser/checker), linked as a separate module"
status: in-progress
created: 2026-07-25
updated: 2026-08-12
priority: low
horizon: xl
feasibility: hard
area: codegen, runtime
goal: es5
related: [1006, 1054, 1066, 1073, 1102, 2927, 2928]
blocked-by: [1102, 1066]
sprint: current
---

# #3630 — runtime eval compilation via acorn + IR→codegen

**Deliberately last of three for production.** This is the most expensive way
to support `eval`; the bounded POC activated on 2026-08-12 validates only the
portable host boundary. It does not displace the cheaper AOT and interpreter
phases or claim production conformance coverage.

## 2026-08-12 POC checkpoint — JavaScript + Wasmtime boundary works

The core architectural risk has a positive result: one core-Wasm broker can
compile runtime source into a second Wasm module and execute it through the same
import contract under both host families.

The POC is in `examples/runtime-eval-side-module/`:

- The broker imports shared memory, a replaceable
  `js2wasm:compiler::compileEval` capability, and narrow operations modeled on
  `WebAssembly.Module`, `WebAssembly.Instance`, and instance export invocation.
- Module and Instance values cross the broker boundary as opaque `externref`s.
  JavaScript stores the real JS WebAssembly objects; Wasmtime stores real native
  `wasmtime::Module` / `wasmtime::Instance` values in the same Engine and Store.
- The generated numeric-expression module is standalone (zero imports). Both
  hosts compile runtime-created source `6 * 7`, instantiate the 21,001-byte side
  module, and return `42`; the broker itself is 295 bytes.
- Wasmtime invokes the current js2wasm compiler through a deterministic Node
  helper at runtime. That proves native module instantiation/execution and the
  portable host ABI, but not yet an embedded/self-hosted compiler payload.
- No existing eval backend or default changes. The native bytecode interpreter
  remains available, and QuickJS remains independent.

The POC intentionally limits the result ABI to `f64`. Before production use,
the design still needs boxed JS values, direct-scope reification/write-back,
exception transfer, caching/policy, and the Acorn + all-dynamic IR/codegen
compiler payload. See the example README for the exact ABI and acceptance
commands.

## Phase ordering (stakeholder-set, 2026-07-25)

1. **Static / ahead-of-time eval compilation — #1102.** Eval strings that are
   compile-time constants are compiled at build time. No runtime compiler, no
   linking, no scope marshalling. **Likely covers the majority of the 512
   eval-dependent test262 failures** — see the measurement below.
2. **Dynamic eval via the interpreter — #1066, #2927/#2928.** An interpreter
   over the acorn AST. No codegen, no module instantiation, no host linking,
   and no marshalling of scope across a module boundary — it runs in-process
   and reads the reified scope object directly.
3. **THIS ISSUE — compile dynamic eval.** Only after (1) and (2). Its only
   advantage over (2) is *execution speed* of eval'd code, which is irrelevant
   for conformance. Do not start it for conformance reasons alone.

## The idea

Compile the eval'd string at runtime and link the result as a separate Wasm
module. The payload is kept small by dropping the front end:

```
eval string -> acorn (already being dogfooded, #2927) -> AST
            -> IR builder in ALL-DYNAMIC mode  (no type checker)
            -> codegen -> wasm bytes -> host instantiate -> funcref
```

**Why the checker can be dropped:** the type oracle is an *optimiser*, not a
correctness requirement. Eval'd code can be compiled fully dynamic (everything
boxed / `any`); the oracle exists to avoid that path when it can prove better.
Slower but correct is free for conformance.

**Why the TypeScript parser can be dropped:** eval strings are *JavaScript*, not
TypeScript. No annotations to parse. acorn is the right parser and is already
being compiled to Wasm.

So the runtime payload collapses from *TS parser + checker + IR + codegen* to
**acorn + IR builder + codegen**.

## Two hard constraints

**1. Core Wasm has no runtime module-instantiation primitive.** A Wasm module
cannot instantiate another Wasm module by itself. This step MUST be a host
import. Model it on the `WebAssembly` JS API so a JS host satisfies it natively
and a standalone runtime (Wasmtime et al.) can satisfy it via its embedding API.

**Design refinement — do NOT model the general API.** `instantiate(module,
importObject)` requires constructing an arbitrary import object from inside
Wasm. Eval needs exactly one thing passed in (a reference to the reified scope),
so specialise: `eval_instantiate(source, scopeRef) -> funcref`. No import-object
machinery.

**2. Wasm locals are not addressable**, so a separate module cannot see the
caller's scope as compiled today. Any function containing a **direct** `eval`
must have its bindings spilled into a heap-allocated environment record instead
of Wasm locals — the same deoptimisation production JS engines apply. This also
solves write-back: sloppy-mode direct eval can introduce `var`/function bindings
into the *caller's* variable environment, which is impossible against Wasm
locals and trivial against a reified environment object.

Cost falls on the **caller**, not the eval: a function containing direct eval
pays reification even if eval never runs. Mitigated because direct eval is
syntactically detectable (the identifier must appear in call position), and
**indirect eval** (`(0,eval)(s)`) sees only the global scope and needs no
reification at all.

## Consequence for the standalone metric — decide deliberately

The standalone conformance number counts **host-free** passes. If eval is
satisfied by host imports, those tests stop being host-free, so this path lifts
the **host and WASI** lanes and leaves the standalone floor unchanged. This and
the interpreter are therefore **complementary, not alternatives**: this gets
Wasmtime deployments working; only the interpreter moves the standalone number.

## Bonus that may justify the IR work regardless

If the IR is defined as a **stable serialised form**, the same representation
serves both the ahead-of-time case (#1102) and the runtime case — one format,
both paths.

## MEASURE FIRST — this is cheap and it may retire the whole issue

Partition the **512 eval-dependent ES5 failures** (measured 2026-07-25, #3626;
826 eval-dependent tests total) three ways:

1. **compile-time-constant strings** -> phase 1 (#1102) alone
2. **indirect eval** -> global scope only, no reification
3. **direct eval with a runtime string** -> the only case needing this issue

If (1) and (2) dominate — the current expectation, but explicitly UNMEASURED —
most of the ES5 ceiling lifts without this issue ever being started. **Do not
size or schedule this work before that partition exists.** Guessing at cluster
sizes has been wrong repeatedly on this project.

## Context

ES5 conformance caps at **8,419/8,931 = 94%** until real eval lands (#3626).
CLAUDE.md's old claim that eval is skip-filtered was **stale** — those tests run
and are counted (corrected in the same change as this filing).
