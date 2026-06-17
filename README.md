# js2wasm

Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.

> **Status: early-stage research prototype — a tech demo, not a production-ready compiler.**
> `js2wasm` is an experimental ahead-of-time JavaScript/TypeScript-to-WasmGC compiler under active development. It explores one specific point in the design space: full ECMAScript backwards compatibility via direct AOT compilation, with no JavaScript engine or interpreter bundled into the output. It does **not** claim production readiness, full language coverage, or stable APIs — expect rough edges, gaps, and breaking changes. Live conformance and benchmark figures are in **[STATUS.md](./STATUS.md)** (numbers change frequently and are not duplicated in this README).

`js2wasm` compiles source code into WasmGC binaries without embedding a JavaScript interpreter or shipping a bundled runtime. That avoids the runtime tax common in the interpreter-based and engine-embedding approaches — where a JavaScript interpreter or full engine is compiled to Wasm and shipped inside every module — and keeps the output aligned with Wasm-native deployment models.

`js2wasm` is a free and open-source project developed by **Loopdive GmbH** and released under the **Apache License 2.0 with LLVM Exceptions**. It is a freely-licensed, open-source technical foundation and reusable building block, developed fully in the open, including its agentic engineering workflow. The repository contains the compiler source, the complete planning surface (`plan/`), and the agent coordination infrastructure (`.claude/`) that a small team uses to ship fixes in parallel.

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

The current public benchmark and conformance work exists to test an open question: whether direct AOT compilation can become a viable alternative to bundling a runtime for these workloads. That has not been settled yet — it is what the project is investigating.

Many alternatives in adjacent spaces solve the problem by narrowing the language instead:

- supporting only a constrained subset of TypeScript or JavaScript
- introducing a new language or dialect that compiles to Wasm more easily

`js2wasm` is aimed at a harder target: targeting mainstream JavaScript semantics through direct compilation rather than changing the language model to fit the compiler.

Projects in this category usually take years to reach meaningful semantic coverage. A large part of the Loopdive thesis is that an AI-native compiler workflow can compress that timeline substantially without giving up on the harder target.

Current Test262 conformance and benchmark numbers are tracked in one place and
change frequently — see **[STATUS.md](./STATUS.md)** for the live figures, the
[Playground](https://js2.loopdive.com/playground/), and the
[Roadmap](./ROADMAP.md). The single auto-updated conformance figure (refreshed
by CI on every merge) is for the JS-host path; everything else links to
STATUS.md rather than duplicating numbers that go stale. Standalone
(no-JS-host) pass-rate and benchmark figures are intentionally omitted from the
README until the current standalone regression is fixed.

<!-- AUTO:conformance-start -->
**test262 conformance**: 31,357 / 43,135 (72.7 %) — baseline unknown, 2026-06-17T03:16:20.635Z
<!-- AUTO:conformance-end -->

## Current Status

`js2wasm` is an early-stage research prototype: an experimental compiler under
active development, not a production-ready tool. It is being explored as a
public, in-the-open project, and the conformance story, runtime boundary, and
standalone path are all still hardening. What exists today:

- a JS-hosted compilation path passing a substantial subset of Test262 (see
  [STATUS.md](./STATUS.md) for the current figure)
- a public browser playground
- continuous conformance and benchmark reporting on every change
- a standalone (no-JS-host) path that is in progress; its public numeric
  baselines are paused here until the current regression is fixed

Treat it as a tech demo to evaluate the approach, not as something to deploy.

## The AOT JavaScript compilation landscape

There are several established ways to get JavaScript running on WebAssembly.
Each makes a different, reasonable trade-off, and most have years of engineering
behind them. The point of this map is not to rank them — it is to locate the
specific gap `js2wasm` is exploring. Described by architecture rather than by
product:

- **Interpreter-based approach** — compile a JavaScript *interpreter* to Wasm
  and run the user's program on top of it. Gets broad ECMAScript compatibility
  more or less for free, because a real interpreter is doing the work. The cost:
  every deployed module ships and initializes the interpreter, which adds size
  and startup overhead and means application code runs interpreted rather than
  compiled.

- **Engine-embedding approach** — compile a full production JavaScript *engine*
  to Wasm (optionally specialized per-script, e.g. via partial evaluation).
  Inherits mature, battle-tested engine semantics and very high compatibility.
  The cost: the engine is large, and even when specialized the engine itself is
  still part of what ships.

- **Typed JS/TS subset languages** — a statically typed language with
  JavaScript-like or TypeScript-like syntax that compiles ahead of time to
  compact Wasm. Output is small and fast precisely *because* it deliberately
  does **not** accept full ECMAScript: dynamic semantics are excluded by design
  and the type system is the contract. Excellent when you can write to that
  language; not a path to running existing JavaScript unchanged.

- **Linear-memory AOT compilers** — compile JavaScript ahead of time to Wasm
  using linear memory, implementing object model, allocation, and (typically) a
  garbage collector inside the module. This shares the "compile, don't embed a
  runtime" goal; the distinguishing axis from `js2wasm` is the lowering target
  (linear memory and a self-managed heap vs. host-managed WasmGC) and, in
  current projects, how much of full ECMAScript compatibility is an explicit
  goal.

**Where `js2wasm` sits.** Direct AOT compilation to **WasmGC** (objects,
closures, and arrays lower to host-managed GC structs/arrays/references), with
**full ECMAScript backwards compatibility as the explicit goal**, and **no
JavaScript engine or interpreter bundled into the output**. Where the compiler
can prove stable types and shapes it lowers them directly; where JavaScript
stays dynamic it inserts guards, boxed representations, or host fallbacks.

The structural observation behind the project is that this *combination* of
trade-offs is largely unoccupied: the typed-subset languages excluded full
ECMAScript compatibility on purpose; the linear-memory AOT compilers do not
currently center it; and the interpreter-based and engine-embedding approaches
reach compatibility only by shipping a runtime (paying in size and startup).
Targeting WasmGC + full backwards compatibility + no bundled runtime is a point
that has not been seriously attempted. `js2wasm` is testing whether it is
viable — that is an open question, not a settled result, and the honest answer
today is "we don't know yet."

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

> **Breaking change (#1757):** `compile()` (and `compileMulti`, `compileFiles`,
> `compileToWat`, `compileProject`, `createIncrementalCompiler().compile`) now
> return a `Promise` — `await` them. This lets the optional Binaryen optimizer
> load lazily only when `optimize` is requested, without forcing standalone
> bundles to embed Binaryen (GH #986).

```ts
import { compile } from "js2wasm";

const result = await compile(
  `
  export function add(a: number, b: number): number {
    return a + b;
  }
`,
  { target: "standalone" },
);

if (result.success) {
  // standalone modules have no host imports, so {} is sufficient
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  console.log((instance.exports as any).add(2, 3)); // → 5
}
```

Standalone CLI bundle:

```bash
pnpm run build:standalone-cli -- --minify
deno compile -A --no-check -o js2wasm dist/js2wasm-standalone.mjs
# or:
bun build --compile --target=node --outfile js2wasm dist/js2wasm-standalone.mjs
```

`build:standalone-cli` creates a relocatable `dist/js2wasm-standalone.mjs`
bundle for native-executable workflows. Unlike the normal npm library build, it
bundles the core compiler dependencies and embeds TypeScript's `lib.*.d.ts`
declarations, so the generated file does not need to remain next to
`node_modules/typescript/lib` after it is moved or compiled. The `--ts7`
preview backend and Binaryen optimizer remain development/optimization opt-ins
and are not bundled into this standalone artifact. If you use `-O` with the
standalone CLI, install `binaryen` next to the runner or put `wasm-opt` on PATH;
you can also run `wasm-opt` directly on the emitted `.wasm` afterward.

### Compile modes and imports

The imports a module needs depend on the compile target:

- **Default (JS-host) mode** (no `target`, or `target: "gc"`) emits runtime
  imports — a `string_constants` module plus `env.*` helpers such as
  `__box_number`, `__extern_get`, and `__throw_reference_error`. These are
  supplied by the js2wasm JS runtime, so instantiating with an empty `{}`
  throws `Import #0 "string_constants": module is not an object or function`.
  Use this mode when you run the output alongside the JS runtime that provides
  those imports. The result carries a ready-to-pass `result.importObject` that
  wires those host helpers for you — pass it straight to
  `WebAssembly.instantiate` with no hand-wiring:

  ```ts
  const r = await compile(`
    export function add(a: number, b: number): number { return a + b; }
  `);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  (instance.exports as any).add(2, 3); // → 5
  ```
- **Standalone mode** (`target: "standalone"`, also `target: "wasi"`) emits a
  pure WasmGC module with Wasm-native intrinsics and **no host imports**, so it
  instantiates with `WebAssembly.instantiate(binary, {})` and runs anywhere
  WasmGC is available. Prefer this for portable, host-independent output — it is
  what the snippet above uses.

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

In a JS host, `js2wasm` passes a substantial subset of Test262 — enough that a
large, useful slice of the language works — but there are real gaps, and you
will hit them. The current pass rate lives in [STATUS.md](./STATUS.md) and the
full [Test262 report](./benchmarks/results/report.html); this section is the
qualitative high-level shape, and the report is the authoritative per-feature
detail. Note that Test262 measures conformance to the ECMAScript *language*
specification — it does not cover Web APIs, Node.js host behavior, or whether an
arbitrary real-world npm package runs unchanged.

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
- standalone (no-JS-host) mode — actively in progress; standalone numeric
  baselines are temporarily omitted here while the current regression is fixed
- getters/setters and other highly dynamic patterns — limited

**Not yet** (intentionally unsupported or out of scope today):

- `eval`, `with`, and dynamic `Function` construction
- `Proxy` and `Reflect`-driven metaprogramming
- `SharedArrayBuffer` / threads, `WeakRef` / `FinalizationRegistry`, `Temporal`
- dropping in an arbitrary npm package unchanged

If a pattern you rely on does not work, check the [Test262 report](./benchmarks/results/report.html)
or open an issue. This is an actively developed compiler with a growing
compatibility baseline and a clear infrastructure target — but it is a research
prototype, not yet a "drop in any npm package" story.

## FAQ

**Why not embed an existing interpreter or engine?**
That is the interpreter-based / engine-embedding approach, and it is a perfectly
reasonable way to get compatibility — but every deployed module then ships and
initializes a runtime, which is exactly the size and startup cost `js2wasm` is
trying to avoid. The bet here is that *compiling* the code, rather than shipping
something to run it, is worth pursuing for size- and cold-start-sensitive
deployments. Whether that bet holds across enough real code is the open
question.

**Isn't the Test262 conformance still incomplete?**
Yes, and the live figure is in [STATUS.md](./STATUS.md) and the
[Test262 report](./benchmarks/results/report.html) rather than rounded up here.
Two caveats matter more than the number: Test262 measures the ECMAScript
*language* spec, **not** Web APIs, host/Node.js behavior, or whether an arbitrary
npm package runs unchanged; and standalone (no-JS-host) figures are omitted here
until the current regression is fixed. A high pass rate is necessary but not
sufficient for "runs real JavaScript."

**Won't you eventually re-implement a JavaScript engine?**
That is the real risk, treated as an empirical question, not a solved one. The
design is compiled-code-first: resolve what can be resolved statically and lower
it directly, with no interpreter on the common paths. The genuinely unstatic
corners (`eval`, dynamic `Function`) would need a small interpreter fallback that
runs only on those paths — not a full engine in every module. Whether that
fallback stays small, and how much real code avoids it, is what the prototype is
testing. If compatibility turns out to require shipping an engine, that is a
negative result worth knowing.

**Why not extend an existing typed JS/TS subset language?**
Typed JS/TS subset languages produce small, fast Wasm *because* they deliberately
exclude full ECMAScript — dynamic semantics are dropped by design and the static
type system is the contract. Extending one toward full backwards compatibility
means re-adding the dynamics it was built to avoid. `js2wasm` instead targets
existing JavaScript semantics directly, so existing code is the input rather than
a rewrite into a new dialect.

**Why WasmGC rather than linear memory?**
WasmGC gives the compiler host-managed structs, arrays, references, and function
references, which map onto JavaScript objects, closures, and arrays fairly
directly and let the host GC manage memory instead of shipping a collector inside
the module. Linear-memory AOT compilation is a legitimate alternative with its
own trade-offs (more control, broader runtime support today, but a self-managed
heap); `js2wasm` keeps a linear-memory backend for WASI-oriented targets, so this
is a per-target choice rather than a one-way bet. See the
[ADRs](./docs/adr/README.md) for the reasoning.

**What is the realistic timeline to production-ready?**
Unknown. This is research-stage work, and a firm date would be a guess dressed up
as a commitment. The viability of the core bet — full ECMAScript backwards
compatibility, AOT-compiled to WasmGC, no bundled runtime — is still being
established. The conformance and benchmark trends are public so progress can be
judged from data. Until they say otherwise, treat it as something to evaluate,
not to deploy.

## The Methodology

Loopdive develops `js2wasm` with an **Automated Agile Team** model. The goal is not novelty for its own sake. The goal is to compress the feedback loop between product intent, compiler implementation, and conformance verification.

### Operating Roles

- **Product Owner**: defines goals with the human stakeholder, plans sprints, prioritizes work, and keeps the backlog aligned with the product surface.
- **Technical Delivery Lead**: orchestrates sprint execution, coordinates task flow, manages merge discipline, and keeps implementation work moving through the pipeline.
- **Compiler Engineer (AI)**: implements ECMA-262 behavior, compiler pipeline changes, WasmGC lowering, and code generation details.
- **QA Engineer (Automated)**: runs CI-based conformance and regression feedback loops, especially around Test262 trend tracking and behavioral drift.
- **Architect (Human / Loopdive)**: owns system design, strategic constraints, runtime boundaries, and platform-facing product decisions.

### Why It Matters

This model is a bet that a tight, automated feedback loop lets a small team
iterate on a hard compatibility target faster than a conventional one would.
Whether that bet pays off is part of what this prototype is testing.

The workflow is optimized for:

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

- Source code in this repository is available under **Apache-2.0 WITH LLVM-exception**
- Community contributions are accepted under the contributor terms described in [CONTRIBUTING.md](./CONTRIBUTING.md)

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

- [Playground](https://js2.loopdive.com/playground/)
- [Roadmap](./ROADMAP.md)
- [Architecture Decisions](./docs/adr/README.md)
- [Architecture Notes](./CLAUDE.md)
- [Contributing](./CONTRIBUTING.md)

## Trademark Disclaimer

JavaScript is a trademark or registered trademark of Oracle in the United States and other countries. This project is independent from Oracle and is not endorsed by, sponsored by, or affiliated with Oracle.
