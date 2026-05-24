# js2wasm

Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.

`js2wasm` compiles source code into WasmGC binaries without embedding a JavaScript interpreter or shipping a bundled runtime. That removes the runtime tax common in interpreter-in-Wasm and bundled-engine stacks, where interpreters often land in the high-hundreds-of-kilobytes range and full-fledged JavaScript engines in the megabytes, and keeps the output aligned with Wasm-native deployment models.

`js2wasm` is the core compiler product of **Loopdive GmbH**, released under **Apache License 2.0 with LLVM Exceptions** — and developed fully in the open, including its agentic engineering workflow. The repository contains the compiler source, the complete planning surface (`plan/`), and the agent coordination infrastructure (`.claude/`) that a small team uses to ship fixes in parallel.

## Value Proposition

Most JavaScript-on-Wasm systems work by putting a JavaScript engine inside a Wasm module. That approach inherits good compatibility, but it also inherits the cost of shipping and initializing the engine.

`js2wasm` takes the opposite approach:

- **Direct AOT compilation to WasmGC** instead of interpreter bundling
- **No embedded JS engine** in the deployed module
- **No bundled interpreter or engine tax** just to execute application code
- **Wasm-native deployment model** for runtimes, serverless platforms, and embedded hosts

This matters for infrastructure workloads where artifact size, cold start, density, and host integration are first-order constraints.

It also matters for security boundaries. In browsers, Node.js, and other JavaScript-capable hosts, compiling modules to Wasm introduces an isolation boundary that can limit how much third-party dependencies and user-provided code can affect the surrounding process. That is relevant for supply-chain defense, plugin systems, and multi-tenant execution.

## Why This Architecture

`js2wasm` is being built for environments where bundling a JavaScript engine is the wrong tradeoff:

- edge and serverless runtimes
- Wasm-first infrastructure platforms
- plugin and extension systems
- embedders that want JavaScript semantics without shipping an interpreter
- desktop applications that want a lighter and safer alternative to Electron-style runtime bundling

That includes practical combinations with hosts like Tauri, where compiler output can be shipped as executable Wasm artifacts instead of bundling a full browser-plus-JS-engine runtime into the application.

The current public benchmark and conformance work is aimed at proving that direct compilation can become a viable alternative to interpreter bundling for production infrastructure.

Many alternatives in adjacent spaces solve the problem by narrowing the language instead:

- supporting only a constrained subset of TypeScript or JavaScript
- introducing a new language or dialect that compiles to Wasm more easily

`js2wasm` is aimed at a harder target: targeting mainstream JavaScript semantics through direct compilation rather than changing the language model to fit the compiler.

Projects in this category usually take years to reach meaningful semantic coverage. A large part of the Loopdive thesis is that an AI-native compiler workflow can compress that timeline substantially without giving up on the harder target.

Current public milestone:

<!-- AUTO:conformance-start -->
**test262 conformance**: 28,842 / 43,159 (66.8 %) — baseline 1f5208c8, 2026-05-22T19:51:21Z
<!-- AUTO:conformance-end -->

See the [Playground](https://loopdive.github.io/js2wasm/playground/) and [Roadmap](./ROADMAP.md) for the current public surface.

## Current Status

`js2wasm` is still an active compiler effort, but it is no longer just a research prototype. The project now has:

- **~60% Test262 compliance**
- a public browser playground
- ongoing benchmark and compatibility reporting
- both JS-hosted and standalone-oriented compiler work, with standalone support still in progress and not yet the primary conformance path

The project is being positioned for a community-first release while the compiler, runtime boundary, and conformance story continue to harden.

## How It Compares

Most JavaScript-on-Wasm approaches fit into one of four broad categories:

1. bundled JavaScript interpreters,
2. bundled JavaScript engines,
3. incompatible JavaScript or TypeScript subsets, supersets, and new languages,
4. direct AOT compilation of JavaScript semantics to WasmGC.

`js2wasm` is in the fourth category.

Bundled-runtime approaches inherit compatibility from an interpreter or engine,
but every deployed module pays for that runtime. Subset, superset, and
new-language approaches can generate compact Wasm by changing the language
contract.

`js2wasm` is aimed at a different target: **JavaScript semantics without
shipping a JavaScript engine or interpreter inside the deployed artifact**.
Where the compiler can prove stable types and shapes, it lowers them directly to
WasmGC structs, arrays, primitives, and functions. Where JavaScript remains
dynamic, it inserts guards, uses dynamic representations, or delegates at host
boundaries.

### How does this compare to specific projects?

These projects share parts of the design space with `js2wasm` and each makes a
different, reasonable trade-off:

- **[AssemblyScript](https://www.assemblyscript.org/)** — a well-engineered
  compiler for a TypeScript-*like* language with its own stricter type system,
  lowering to compact Wasm via Binaryen. It achieves small output by defining a
  new language contract rather than accepting mainstream JavaScript semantics.
  `js2wasm` targets existing TypeScript/JavaScript semantics directly, which is
  a harder compatibility goal; AssemblyScript is the better fit when you can
  write to its language and want maximally lean output.

- **[Javy](https://github.com/bytecodealliance/javy)** — embeds the QuickJS
  interpreter inside the Wasm module and runs your JS on top of it. That
  inherits broad JavaScript compatibility immediately, at the cost of shipping
  and initializing an interpreter in every module. `js2wasm` instead compiles
  the code ahead-of-time with no embedded interpreter, trading some
  compatibility for a smaller, engine-free artifact.

- **[Porffor](https://porffor.dev/)** — like `js2wasm`, an ahead-of-time
  JavaScript-to-Wasm compiler aiming at real JS semantics rather than a subset,
  which puts it in the same fourth category. It is an early-stage project that
  lowers to linear memory; `js2wasm` lowers to WasmGC, leaning on the host
  garbage collector for objects, closures, and arrays. The two are close
  neighbors exploring different lowering strategies for the same hard target.

- **StarlingMonkey + [weval](https://github.com/bytecodealliance/weval)** —
  StarlingMonkey is a WASI-oriented build of the SpiderMonkey engine; weval
  applies Wasm partial evaluation (a Futamura projection) to specialize the
  engine for a given script, reducing interpreter overhead. This is a
  bundled-engine approach made faster through specialization, so it keeps full
  engine compatibility while still shipping the engine. `js2wasm` avoids
  bundling an engine at all, accepting a narrower compatibility surface in
  exchange.

For a more detailed category-level comparison, see the [FAQ](./docs/faq.md).

## Quick Start

Install dependencies:

```bash
pnpm install
```

Compile a file:

```bash
npx js2wasm input.ts -o output.wasm
```

Programmatic API:

```ts
import { compile } from "js2wasm";

const result = compile(`
  export function add(a: number, b: number): number {
    return a + b;
  }
`);

if (result.success) {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  console.log((instance.exports as any).add(2, 3));
}
```

Useful local commands:

```bash
pnpm typecheck
pnpm lint
npm test
pnpm run test:262
pnpm dev
```

## Running compiled output

`js2wasm` emits WasmGC modules that use several post-MVP WebAssembly proposals.
Most are on by default in current engines, but **WasmGC and typed function
references are not enabled by default in stable Wasmtime**, so a bare
`wasmtime out.wasm` fails with a validation error until they are turned on.

The simplest way to run the output is to enable all proposals:

```bash
wasmtime -W all-proposals=y out.wasm
```

The proposals the compiler actually relies on are:

| Proposal | Wasmtime `-W` flag | Why js2wasm needs it |
| --- | --- | --- |
| Garbage collection | `gc=y` | objects, arrays, closures lower to GC structs/arrays |
| Typed function references | `function-references=y` | required by GC; typed `call_ref` for closures |
| Exception handling | `exceptions=y` | `throw` / `try` / `catch` lowering |
| Tail calls | `tail-call=y` | `return_call` optimization in tail position |

So the minimal explicit flag set is:

```bash
wasmtime -W gc=y -W function-references=y -W exceptions=y -W tail-call=y out.wasm
```

Bulk memory, sign-extension, saturating float-to-int, multi-value, and mutable
globals are also emitted but are enabled by default in current Wasmtime, so they
do not need explicit flags. `js2wasm` deliberately avoids the custom-descriptors
proposal, which stable Wasmtime does not yet accept.

**Minimum version:** Wasmtime **44+** (the first release with a stable WasmGC
implementation). Older versions reject the GC types.

> The flag table reflects the proposals the compiler emits (see
> `src/optimize.ts`). The exact minimal `-W` subset was not re-verified by
> running each flag combination in this environment; if `all-proposals=y` is
> what you reach for, it is always safe.

Other standalone runtimes: WasmGC support in WAMR and WasmEdge is still
maturing, so compiled output is not guaranteed to run there yet. Browser hosts
(Chrome 119+, Firefox 120+) and Node.js 22+ run the JS-host target without extra
flags.

For reading STDIN and writing STDOUT/STDERR from standalone (`--target wasi`)
output, see [docs/standalone-io.md](./docs/standalone-io.md).

## Current coverage and limitations

`js2wasm` passes roughly two-thirds of Test262 in a JS host (see the conformance
figure above and the full [Test262 report](./benchmarks/results/report.html)).
That means a large, useful subset of the language works — but there are real
gaps, and you will hit them. This section is the honest high-level shape; the
report is the authoritative per-feature detail.

**Solid** (broadly works):

- arithmetic, comparison, and scalar operations
- functions, closures, recursion, and most control-flow forms
- classes, inheritance, methods, and object operations
- arrays and array methods, destructuring, spread, template literals
- strings and common string methods
- `try`/`catch`/`finally` and `throw`
- `async`/`await`, generators, and iterators

**Partial** (works in common cases, with gaps):

- standard-library built-ins — many are implemented, but not the full surface;
  some methods are missing or only handle the common overloads
- `Map`, `Set`, `RegExp`, `JSON` — present but not fully spec-complete
- standalone (no-JS-host) mode — actively in progress; conformance there is
  lower than the JS-host figure and it is not yet the primary path
- getters/setters and other highly dynamic patterns — limited

**Not yet** (intentionally unsupported or out of scope today):

- `eval`, `with`, and dynamic `Function` construction
- `Proxy` and `Reflect`-driven metaprogramming
- `SharedArrayBuffer` / threads, `WeakRef` / `FinalizationRegistry`, `Temporal`
- dropping in an arbitrary npm package unchanged

If a pattern you rely on does not work, check the [Test262 report](./benchmarks/results/report.html)
or open an issue. This is a serious compiler with a growing compatibility
baseline and a clear infrastructure target — not yet a "drop in any npm package"
story.

## The Methodology

Loopdive develops `js2wasm` with an **Automated Agile Team** model. The goal is not novelty for its own sake. The goal is to compress the feedback loop between product intent, compiler implementation, and conformance verification.

### Operating Roles

- **Product Owner**: defines goals with the human stakeholder, plans sprints, prioritizes work, and keeps the backlog aligned with the product surface.
- **Technical Delivery Lead**: orchestrates sprint execution, coordinates task flow, manages merge discipline, and keeps implementation work moving through the pipeline.
- **Compiler Engineer (AI)**: implements ECMA-262 behavior, compiler pipeline changes, WasmGC lowering, and code generation details.
- **QA Engineer (Automated)**: runs CI-based conformance and regression feedback loops, especially around Test262 trend tracking and behavioral drift.
- **Architect (Human / Loopdive)**: owns system design, strategic constraints, runtime boundaries, and platform-facing product decisions.

### Why It Matters

The project is optimized for:

- short implementation-to-validation cycles
- continuous spec-aligned compiler iteration
- rapid backlog triage from conformance data
- keeping product direction, engineering execution, and QA tightly coupled

### Open Agentic Development

The workflow is not hidden behind a consultancy. It is **in this repository**:

- `plan/issues/` — architect-written implementation specs for every open and completed work item
- `plan/log/dependency-graph.md` — current priorities and what's blocked on what
- `plan/issues/sprints/` — sprint plans and retrospectives
- `.claude/agents/` — agent role definitions (product owner, architect, developer, scrum master)
- `.claude/hooks/` — safety scripts (pre-commit gates, path checks)
- `.claude/skills/` — reusable workflow protocols (test-and-merge, self-merge, harvest-errors)
- `.claude/memory/` — accumulated feedback and learnings shared across sessions

Anyone with a [Claude Code](https://docs.claude.com/claude-code) subscription can clone the repo, spawn a `developer` agent from `.claude/agents/developer.md`, point it at a `status: ready` issue under `plan/issues/sprints/`, and contribute a real fix through the same pipeline the core team uses. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the agentic contribution path.

### How this is built

For a long-form, technical account of the agentic development methodology — how the team is structured, how correctness is anchored across multiple test suites, where the decision boundaries between human and agent are drawn, what has gone wrong, and how the methodology has evolved — see [`docs/methodology.md`](./docs/methodology.md).

The document is intended for senior engineers who are skeptical but curious. It cites concrete numbers (sprint count, PR count, test262 pass rate), names the failure modes the team has hit, and discusses honest tradeoffs versus a traditional engineering team. It synthesizes the raw planning material in `plan/` for an external reader without contradicting it; if the two ever diverge, `plan/` is the primary source.

## Licensing

This repository is licensed under the **Apache License 2.0 with LLVM Exceptions**. See [LICENSE](./LICENSE).

### Community License

- Source code in this repository is available under **Apache-2.0 WITH LLVM-exception**
- Community contributions are accepted under the contributor terms described in [CONTRIBUTING.md](./CONTRIBUTING.md)

### Commercial Licensing

Loopdive GmbH offers commercial licensing discussions for infrastructure partners that need:

- proprietary integrations
- closed-source redistribution rights
- dedicated support or integration work
- custom backends or hardware-accelerated targets
- private deployment arrangements for platform partnerships

This is the intended path for infrastructure vendors and strategic partners, including cloud, edge, browser, and silicon platform organizations evaluating deeper integration.

Contact: `hello@loopdive.com`

## Testing

`js2wasm` validates correctness through three complementary test layers:

- **Unit & equivalence tests** — `npm test` (vitest). Targeted regression coverage and JS↔Wasm equivalence assertions. See `tests/equivalence/`.
- **Test262 conformance** — `pnpm run test:262` runs the official ECMAScript test suite (~48k tests) and reports per-edition / per-path pass rates. CI runs this sharded on every PR; the [report](./benchmarks/results/report.html) is regenerated on each merge.
- **Differential testing vs V8** — `pnpm run test:diff` (#1203). For each program in `tests/differential/corpus/`, the harness runs Node-V8 directly and the compiled `.wasm` and compares stdout. test262 measures spec compliance; differential testing measures whether real programs actually produce the right answer. CI gates each PR on a delta against `benchmarks/results/diff-test-baseline.json` — no new mismatches allowed. Use `pnpm run test:diff:triage` to bucket mismatches by category for follow-up filing.

## Development

Additional contributor workflow details, including CLA terms, are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Architecture decisions

The foundational design choices behind `js2wasm` — why WasmGC instead of linear memory, why AOT instead of an embedded engine, how TypeScript annotations are treated, how closures are lowered — are documented as Architecture Decision Records in [`docs/adr/`](./docs/adr/README.md). Each record states the context, the decision, and the consequences in 200–600 words. Start with [ADR-002 (architectural approach)](./docs/adr/0002-architectural-approach.md) and [ADR-001 (hybrid compilation strategy)](./docs/adr/0001-hybrid-compilation-strategy.md); the rest are sub-decisions within that frame.

## Further Reading

- [Playground](https://loopdive.github.io/js2wasm/playground/)
- [Roadmap](./ROADMAP.md)
- [Architecture Decisions](./docs/adr/README.md)
- [Architecture Notes](./CLAUDE.md)
- [Contributing](./CONTRIBUTING.md)

## Acknowledgments

We are grateful to the following people for fruitful technical discussions that shaped key design decisions in this project:

- **Chris Fallin** (Cranelift tech lead) — discussions on type inference, IR design, and the performance implications of missing type information at object boundaries.
- **Luke Wagner** (WebAssembly co-designer, Mozilla / Fastly) — discussions on WasmGC type system design, component model integration, and the long-term direction of WasmGC as a compilation target for typed languages.

## Trademark Disclaimer

JavaScript is a trademark or registered trademark of Oracle in the United States and other countries. This project is independent from Oracle and is not endorsed by, sponsored by, or affiliated with Oracle.
