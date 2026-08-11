# Project status

**Stage: early-stage research prototype / technical demo.** `js2wasm` is an
experimental ahead-of-time compiler from JavaScript and TypeScript to
WebAssembly GC. It is under active development, has incomplete language and
standard-library coverage, known bugs, and breaking changes between versions.
It is not production-ready and should be treated as something to evaluate and
experiment with, not to deploy.

This file is the single place that points at the **live** conformance and
benchmark numbers. The numbers themselves change on every push to `main`, so
they are not frozen into prose anywhere in the repo — follow the links below
for current figures.

## Where the live numbers live

| What | Live source |
|------|-------------|
| Test262 pass rate (overall + per category/edition) | The conformance dashboard on the [landing page](https://js2wasm.loopdive.com/) and the [Test262 report](https://js2wasm.loopdive.com/benchmarks/report.html). The underlying data is published to the [`loopdive/js2wasm-baselines`](https://github.com/loopdive/js2wasm-baselines) repo (`test262-current.json`) and refreshed by CI on every merge. |
| Module size & cold-start characteristics | The benchmark charts on the [landing page](https://js2wasm.loopdive.com/) (size and cold-start panels), regenerated from `benchmarks/results/` on every merge. |
| Per-feature support detail | The feature tables and [Test262 report](https://js2wasm.loopdive.com/benchmarks/report.html), which break results down by language feature and edition. |

If a number you see quoted elsewhere disagrees with these sources, the live
sources win.

## What Test262 does and does not measure

Test262 is the official conformance suite for the **ECMAScript language
specification**. A pass rate against it measures how much of the standardized
*language* — syntax, semantics, built-in objects defined by ECMA-262 — the
compiler implements correctly.

It does **not** measure:

- **Web APIs** (DOM, `fetch`, timers, etc.) — those are host platform APIs, not
  part of ECMAScript.
- **Node.js / host runtime behavior** — filesystem, process, networking, and
  other host surfaces.
- **Whether an arbitrary real-world npm package runs unchanged** — that depends
  on the union of language features, host APIs, and package-specific
  assumptions a given package happens to use.

So a high Test262 pass rate is necessary but not sufficient for "runs real-world
JavaScript." Treat the Test262 figure as a language-conformance signal, not a
drop-in-compatibility guarantee.

## What works today (high-level shape)

This is the qualitative shape only; the per-feature detail and current pass
rates live in the sources linked above.

**Broadly works:**

- arithmetic, comparison, and scalar operations
- functions, closures, recursion, and most control-flow forms
- classes, inheritance, methods, and object operations
- arrays and array methods, destructuring, spread, template literals
- strings and common string methods
- `try` / `catch` / `finally` and `throw`
- `async` / `await`, generators, and iterators

**Partial (common cases work, with gaps):**

- standard-library built-ins — many implemented, but not the full surface
- `Map`, `Set`, `RegExp`, `JSON` — present but not fully spec-complete
- standalone (no-JS-host) mode — actively in progress; conformance there is
  lower than the JS-host path and it is not yet the primary target
- getters/setters and other highly dynamic patterns — limited

**Not supported today (intentionally out of scope or not yet implemented):**

- `eval`, `with`, and dynamic `Function` construction (a small interpreter
  fallback for these is an open research direction, not a shipped feature)
- `Proxy` / `Reflect`-driven metaprogramming
- `SharedArrayBuffer` / threads, `WeakRef` / `FinalizationRegistry`, `Temporal`
- dropping in an arbitrary npm package unchanged

## Output characteristics

`js2wasm` emits WasmGC modules with no embedded JavaScript interpreter or engine
in the output. Because there is no bundled runtime, modules are small relative
to interpreter-based and engine-embedding approaches, and there is no
runtime-initialization step before application code can run. The compiled
output uses several post-MVP WebAssembly proposals (GC, typed function
references, exception handling, tail calls); see the README for the exact host
flags and minimum runtime versions. Current measured sizes and cold-start times
for representative examples are on the landing-page benchmark panels linked
above.

---

_This document is intentionally qualitative. For any specific number, follow the
links to the live sources — they are authoritative and current; this page is
not._
