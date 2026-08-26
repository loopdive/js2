# js2wasm

Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.

> **Status: early-stage research prototype — a tech demo, not a production-ready compiler.**
> `js2wasm` is an experimental ahead-of-time JavaScript/TypeScript-to-WasmGC compiler under active development. It explores one specific point in the design space: full ECMAScript backwards compatibility via direct AOT compilation, with no JavaScript engine or interpreter bundled into the output. It does **not** claim production readiness, full language coverage, or stable APIs — expect rough edges, gaps, and breaking changes. Beyond the two auto-updated conformance figures below, live numbers live in **[STATUS.md](./STATUS.md)** (they change frequently and are not otherwise duplicated here).

`js2wasm` compiles source code into WasmGC binaries without embedding a JavaScript interpreter or shipping a bundled runtime. That avoids the runtime tax common in the interpreter-based and engine-embedding approaches — where a JavaScript interpreter or full engine is compiled to Wasm and shipped inside every module — and keeps the output aligned with Wasm-native deployment models.

`js2wasm` is a free and open-source project developed by **Loopdive GmbH** and released under the **Apache License 2.0 with LLVM Exceptions**. It is developed fully in the open, including its agentic engineering workflow: the repository contains the compiler source, the complete planning surface (`plan/`), and the agent coordination infrastructure (`.claude/`) that a small team uses to ship fixes in parallel.

Conformance is tracked along the two compile paths — both figures auto-update on every merge to `main`:

<!-- AUTO:conformance-start -->

**test262 conformance**: 33,282 / 43,621 (76.3 %)

<!-- AUTO:conformance-end -->

The line above is the **JS-host path** (default `gc` target): runs alongside the js2wasm JS runtime, which supplies host imports for some built-ins.

<!-- AUTO:conformance-standalone-start -->

**standalone (host-free) test262 conformance**: 32,068 / 43,621 (73.5 %)

<!-- AUTO:conformance-standalone-end -->

The line above is the **standalone path** (`--target standalone`/`wasi`): pure WasmGC with no JS host, measured host-free on the same official denominator. Lower today and actively hardening — this is where the current gap is.

Full breakdowns, the trend graph, and benchmarks are in **[STATUS.md](./STATUS.md)**, the [Playground](https://js2wasm.loopdive.com/playground/), and the [Roadmap](./ROADMAP.md).

## Value proposition

Most JavaScript-on-Wasm systems work by putting a JavaScript engine inside a Wasm module. That approach inherits good compatibility, but it also inherits the cost of shipping and initializing the engine. `js2wasm` takes the opposite approach:

- **Direct AOT compilation to WasmGC** instead of interpreter bundling
- **No embedded JS engine or interpreter** in the deployed module — no runtime tax just to execute application code
- **Wasm-native deployment model** for runtimes, serverless platforms, and embedded hosts

This matters for infrastructure workloads where artifact size, cold start, density, and host integration are first-order constraints — edge and serverless runtimes, Wasm-first platforms, plugin and extension systems, embedders that want JavaScript semantics without shipping an interpreter, and desktop applications that want a lighter, safer alternative to Electron-style runtime bundling (e.g. shipping compiler output as executable Wasm artifacts under a host like Tauri instead of bundling a full browser-plus-JS-engine).

It also matters for security boundaries. In browsers, Node.js, and other JavaScript-capable hosts, compiling modules to Wasm introduces an isolation boundary that can limit how much third-party dependencies and user-provided code can affect the surrounding process — relevant for supply-chain defense, plugin systems, and multi-tenant execution.

The open question the project is testing is whether direct AOT compilation can become a viable alternative to bundling a runtime for these workloads. That is not settled — it is what the conformance and benchmark work is investigating.

## AOT JavaScript compilation landscape

There are several established ways to get JavaScript running on WebAssembly. Each makes a different, reasonable trade-off, and most have years of engineering behind them. The point of this map is not to rank them — it is to locate the specific gap `js2wasm` is exploring, described by architecture rather than by product:

- **Interpreter-based approach** — compile a JavaScript *interpreter* to Wasm and run the user's program on top of it. Gets broad ECMAScript compatibility more or less for free, because a real interpreter is doing the work. The cost: every deployed module ships and initializes the interpreter, which adds size and startup overhead and means application code runs interpreted rather than compiled.

- **Engine-embedding approach** — compile a full production JavaScript *engine* to Wasm (optionally specialized per-script, e.g. via partial evaluation). Inherits mature, battle-tested engine semantics and very high compatibility. The cost: the engine is large, and even when specialized the engine itself is still part of what ships.

- **Typed JS/TS subset languages** — a statically typed language with JavaScript-like or TypeScript-like syntax that compiles ahead of time to compact Wasm. Output is small and fast precisely *because* it deliberately does **not** accept full ECMAScript: dynamic semantics are excluded by design and the type system is the contract. Excellent when you can write to that language; not a path to running existing JavaScript unchanged.

- **Linear-memory AOT compilers** — compile JavaScript ahead of time to Wasm using linear memory, implementing object model, allocation, and (typically) a garbage collector inside the module. This shares the "compile, don't embed a runtime" goal; the distinguishing axis from `js2wasm` is the lowering target (linear memory and a self-managed heap vs. host-managed WasmGC) and, in current projects, how much of full ECMAScript compatibility is an explicit goal.

**Where `js2wasm` sits.** Direct AOT compilation to **WasmGC** (objects, closures, and arrays lower to host-managed GC structs/arrays/references), with **full ECMAScript backwards compatibility as the explicit goal**, and **no JavaScript engine or interpreter bundled into the output**. Where the compiler can prove stable types and shapes it lowers them directly; where JavaScript stays dynamic it inserts guards, boxed representations, or host fallbacks.

The structural observation behind the project is that this *combination* of trade-offs is largely unoccupied: the typed-subset languages excluded full ECMAScript compatibility on purpose; the linear-memory AOT compilers do not currently center it; and the interpreter-based and engine-embedding approaches reach compatibility only by shipping a runtime. Targeting WasmGC + full backwards compatibility + no bundled runtime is a point that has not been seriously attempted. Projects in this category usually take years to reach meaningful semantic coverage; a large part of the Loopdive thesis is that an AI-native compiler workflow can compress that timeline substantially without giving up on the harder target.

## Current status

What exists today:

- a JS-hosted compilation path passing a substantial subset of Test262 (the figure above)
- a public browser [Playground](https://js2wasm.loopdive.com/playground/)
- continuous conformance and benchmark reporting on every change
- a standalone (no-JS-host) path that is in progress — host-free conformance (see the figure above) is meaningfully lower than the JS-host path and actively hardening

## Quick start

Install dependencies:

```bash
pnpm install
```

Compile a file:

```bash
npx js2wasm input.ts          # writes input.wasm (+ .wat, .d.ts) into your current directory
npx js2wasm input.ts -o dist  # -o is an existing output DIRECTORY, not a file
```

The compiler derives the output name from the input basename; `-o <dir>` chooses
the directory to write into (it must already exist). The default (JS-host) build
also emits an `input.imports.js` helper — see [Compile modes and imports](#compile-modes-and-imports).

Programmatic API:

> The compile functions — `compile`, `compileMulti`, `compileFiles`,
> `compileToWat`, `compileProject`, and `createIncrementalCompiler().compile` —
> are async: they return a `Promise`, so `await` them. This keeps the optional
> Binaryen optimizer out of standalone bundles by loading it lazily only when
> `optimize` is requested.

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

  Dynamic `eval` / `new Function` can instead use an isolated JS evaluator
  while the AOT Wasm instance stays in its original host. See
  [Isolated JS-host eval](docs/js-host-eval-isolation.md).
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

To independently cross-check compiler compatibility with test262.fyi's
literal, unmodified harness assembler, initialize its optional data submodule
and run the separate comparison lane:

```bash
git submodule update --init --checkout test262-fyi/data
pnpm run test:262:fyi -- --filter built-ins/Array --limit 20
```

This lane uses `test262-fyi/data/runner/read.js` to concatenate the host shim,
upstream `assert.js`, `sta.js`, metadata `includes`, and each raw test body. The
canonical `pnpm run test:262` runner and CI use the same literal-harness
contract; this optional lane cross-checks their assembly against test262.fyi's
own reader and reports its score separately. Neither verdict path uses
`wrapTest()` or a synthetic preamble. Omit the filter and limit for a full run;
use `--help` for output and target options.

## Running compiled output

`js2wasm` emits WasmGC modules that use several post-MVP WebAssembly proposals.
Most are on by default in current engines, but **WasmGC and typed function
references are not enabled by default in stable Wasmtime**, so a bare
`wasmtime out.wasm` fails with a validation error until they are turned on.

Enable exactly the proposals the compiler emits:

```bash
wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y out.wasm
```

The proposals the compiler actually relies on are:

| Proposal | Wasmtime `-W` flag | Why js2wasm needs it |
| --- | --- | --- |
| Garbage collection | `gc=y` | objects, arrays, closures lower to GC structs/arrays |
| Typed function references | `function-references=y` | required by GC; typed `call_ref` for closures |
| Exception handling | `exceptions=y` | `throw` / `try` / `catch` lowering |
| Tail calls | `tail-call=y` | `return_call` optimization in tail position |

Bulk memory, sign-extension, saturating float-to-int, multi-value, mutable
globals, and reference types are also emitted but are enabled by default in
current Wasmtime, so they do not need explicit flags. `js2wasm` deliberately
avoids the custom-descriptors proposal, which stable Wasmtime does not yet
accept.

**Do not use `-W all-proposals=y`.** It also enables the **stack-switching**
proposal, which Wasmtime does not support in its default compiler configuration —
the runtime then fails at module load with `the wasm_stack_switching feature is
not supported on this compiler configuration` and exits before running anything,
regardless of module content (js2wasm output contains zero stack-switching
opcodes). Stick to the targeted flag set above.

**Recommended version:** Wasmtime **46+** — earlier releases either reject the
GC types or carry WasmGC bugs that can cause memory leaks or poor performance.

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
full [Test262 report](https://js2wasm.loopdive.com/benchmarks/report.html);
this section is the qualitative high-level shape, and the report is the
authoritative per-feature detail. Note that Test262 measures conformance to the
ECMAScript *language* specification — it does **not** cover Web APIs, Node.js
host behavior, or whether an arbitrary real-world npm package runs unchanged. A
high pass rate is necessary but not sufficient for "runs real JavaScript."

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
- standalone (no-JS-host) mode — actively in progress; host-free conformance
  (see the two-path figures near the top) trails the JS-host path
- getters/setters and other highly dynamic patterns — limited

**Not yet** (intentionally unsupported or out of scope today):

- `eval`, `with`, and dynamic `Function` construction
- `Proxy` and `Reflect`-driven metaprogramming
- `SharedArrayBuffer` / threads, `WeakRef` / `FinalizationRegistry`, `Temporal`
- dropping in an arbitrary npm package unchanged

If a pattern you rely on does not work, check the
[Test262 report](https://js2wasm.loopdive.com/benchmarks/report.html) or
open an issue.

## FAQ

**Won't you eventually re-implement a JavaScript engine?**
That is the real risk, treated as an empirical question, not a solved one. The
design is compiled-code-first: resolve what can be resolved statically and lower
it directly, with no interpreter on the common paths. The genuinely unstatic
corners (`eval`, dynamic `Function`) would need a small interpreter fallback that
runs only on those paths — not a full engine in every module. Whether that
fallback stays small, and how much real code avoids it, is what the prototype is
testing. If compatibility turns out to require shipping an engine, that is a
negative result worth knowing. (For why *not* to just embed an interpreter or
engine outright, or extend a typed subset, see
[the landscape map above](#aot-javascript-compilation-landscape).)

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
Unknown, and a firm date would be a guess dressed up as a commitment. The
viability of the core bet — full ECMAScript backwards compatibility, AOT-compiled
to WasmGC, no bundled runtime — is still being established. The conformance and
benchmark trends are public so progress can be judged from data. Until they say
otherwise, treat it as something to evaluate, not to deploy.

## Methodology

Loopdive develops `js2wasm` with an **Automated Agile Team** model. The goal is not novelty for its own sake — it is to compress the feedback loop between product intent, compiler implementation, and conformance verification. This is a bet that a tight, automated feedback loop lets a small team iterate on a hard compatibility target faster than a conventional one would; whether that bet pays off is part of what this prototype is testing.

### Operating roles

- **Product Owner**: defines goals with the human stakeholder, plans sprints, prioritizes work, and keeps the backlog aligned with the product surface.
- **Technical Delivery Lead**: orchestrates sprint execution, coordinates task flow, manages merge discipline, and owns process retrospectives.
- **Compiler Engineer (AI)**: implements ECMA-262 behavior, compiler pipeline changes, WasmGC lowering, and code generation details.
- **QA Engineer (Automated)**: runs CI-based conformance and regression feedback loops, especially around Test262 trend tracking and behavioral drift.
- **Architect (Human / Loopdive)**: owns system design, strategic constraints, runtime boundaries, and platform-facing product decisions.

### Open agentic development

The workflow is not hidden behind a consultancy. It is **in this repository**:

- `plan/issues/` — architect-written implementation specs for every open and completed work item
- `plan/log/dependency-graph.md` — current priorities and what's blocked on what
- `plan/issues/sprints/` — sprint plans and retrospectives
- `.claude/agents/` — agent role definitions (product owner, architect, tech lead, developer, senior developer)
- `.claude/hooks/` — safety scripts (pre-commit gates, path checks)
- `.claude/skills/` — reusable workflow protocols (test-and-merge, self-merge, harvest-errors)
- `.claude/memory/` — accumulated feedback and learnings shared across sessions

Anyone with a [Claude Code](https://docs.claude.com/claude-code) subscription can clone the repo, spawn a `developer` agent from `.claude/agents/developer.md`, point it at a `status: ready` issue under `plan/issues/`, and contribute a real fix through the same pipeline the core team uses. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the agentic contribution path.

For a long-form, technical account of the methodology — how the team is structured, how correctness is anchored across multiple test suites, where the human/agent decision boundaries are drawn, what has gone wrong, and how the methodology has evolved — see [`docs/methodology.md`](./docs/methodology.md). It is written for senior engineers who are skeptical but curious, cites concrete numbers, names the failure modes the team has hit, and synthesizes the raw planning material in `plan/` (the primary source if the two ever diverge).

## Testing

`js2wasm` validates correctness through three complementary test layers:

- **Unit & equivalence tests** — `npm test` (vitest). Targeted regression coverage and JS↔Wasm equivalence assertions. See `tests/equivalence/`.
- **Test262 conformance** — `pnpm run test:262` runs the ECMAScript test suite (~48k tests: ~43k official plus ~5k staging/proposal tests) and reports per-edition / per-path pass rates. The headline conformance figure is scored against the 43,106 official tests (proposals excluded); CI runs this sharded on every PR and the [report](https://js2wasm.loopdive.com/benchmarks/report.html) is regenerated on each merge.
- **Differential testing vs V8** — `pnpm run test:diff` (#1203). For each program in `tests/differential/corpus/`, the harness runs Node-V8 directly and the compiled `.wasm` and compares stdout. test262 measures spec compliance; differential testing measures whether real programs actually produce the right answer. CI gates each PR on a delta against `benchmarks/results/diff-test-baseline.json` — no new mismatches allowed. Use `pnpm run test:diff:triage` to bucket mismatches by category for follow-up filing.

## Licensing

This repository is licensed under the **Apache License 2.0 with LLVM Exceptions**. See [LICENSE](./LICENSE).

- Source code in this repository is available under **Apache-2.0 WITH LLVM-exception**
- Community contributions are accepted under the contributor terms described in [CONTRIBUTING.md](./CONTRIBUTING.md)

Additional contributor workflow details, including CLA terms, are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Architecture decisions

The foundational design choices behind `js2wasm` — why WasmGC instead of linear memory, why AOT instead of an embedded engine, how TypeScript annotations are treated, how closures are lowered — are documented as Architecture Decision Records in [`docs/adr/`](./docs/adr/README.md). Each record states the context, the decision, and the consequences in 200–600 words. Start with [ADR-002 (architectural approach)](./docs/adr/0002-architectural-approach.md) and [ADR-001 (hybrid compilation strategy)](./docs/adr/0001-hybrid-compilation-strategy.md); the rest are sub-decisions within that frame.

## Further reading

- [Playground](https://js2wasm.loopdive.com/playground/)
- [Status & live numbers](./STATUS.md)
- [Roadmap](./ROADMAP.md)
- [Architecture Decisions](./docs/adr/README.md)
- [Architecture Notes](./CLAUDE.md)
- [Contributing](./CONTRIBUTING.md)

## Trademark disclaimer

JavaScript is a trademark or registered trademark of Oracle in the United States and other countries. This project is independent from Oracle and is not endorsed by, sponsored by, or affiliated with Oracle.
