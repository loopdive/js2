# Project status

**Stage: early-stage research prototype / technical demo.** `js2wasm` is an
experimental ahead-of-time compiler from JavaScript and TypeScript to
WebAssembly GC. It is under active development, has incomplete language and
standard-library coverage, known bugs, and breaking changes between versions.
It is not production-ready and should be treated as something to evaluate and
experiment with, not to deploy.

The Test262 figures in the next section are **generated** from
`benchmarks/results/test262-current.json` and
`benchmarks/results/test262-standalone-highwater.json` by
`scripts/sync-conformance-numbers.mjs`, and CI fails when they drift
(`pnpm run sync:conformance:check`). No other conformance figure is typed into
prose anywhere in the repo.

## Test262 conformance

<!-- AUTO:conformance-start -->

**test262 conformance**: 39,284 / 48,232 (81.4 %)

<!-- AUTO:conformance-end -->

<!-- AUTO:conformance-standalone-start -->

**standalone (host-free) test262 conformance**: 41,923 / 48,232 (86.9 %)

<!-- AUTO:conformance-standalone-end -->

<!-- AUTO:conformance-scope-start -->

Both figures are scored against the same **48,232** official tests (47,146 ECMAScript standard + 1,086 Annex B). The 503 TC39 proposal-stage tests are excluded.

<!-- AUTO:conformance-scope-end -->

<!-- AUTO:conformance-areas-start -->

Per-area pass rates, JS-host (`gc`) lane. The area rows cover all 48,735 test files the runner scores — 503 more than the headline total, because they include proposal-stage files that the headline figures exclude.

| Area          |   Pass |  Total |   Rate |
| ------------- | -----: | -----: | -----: |
| `language/`   | 19,835 | 23,724 | 83.6 % |
| `built-ins/`  | 18,814 | 23,809 | 79.0 % |
| `annexB/`     |    855 |  1,086 | 78.7 % |
| `harness/`    |    104 |    116 | 89.7 % |
| **All areas** | 39,608 | 48,735 | 81.3 % |

Selected built-ins:

| Feature              | Test262 path                            |  Pass | Total |   Rate |
| -------------------- | --------------------------------------- | ----: | ----: | -----: |
| eval                 | `built-ins/eval` + `language/eval-code` |   320 |   357 | 89.6 % |
| Proxy                | `built-ins/Proxy`                       |   243 |   311 | 78.1 % |
| Reflect              | `built-ins/Reflect`                     |   129 |   153 | 84.3 % |
| Temporal             | `built-ins/Temporal`                    | 3,383 | 4,603 | 73.5 % |
| SharedArrayBuffer    | `built-ins/SharedArrayBuffer`           |    80 |   104 | 76.9 % |
| Atomics              | `built-ins/Atomics`                     |   215 |   389 | 55.3 % |
| WeakRef              | `built-ins/WeakRef`                     |    16 |    29 | 55.2 % |
| FinalizationRegistry | `built-ins/FinalizationRegistry`        |    13 |    47 | 27.7 % |

<!-- AUTO:conformance-areas-end -->

## Where the other live numbers live

| What | Live source |
|------|-------------|
| Test262 pass rate (overall + per category/edition) | The conformance dashboard on the [landing page](https://js2wasm.loopdive.com/) and the [Test262 report](https://js2wasm.loopdive.com/benchmarks/report.html). The underlying data is published to the [`loopdive/js2wasm-baselines`](https://github.com/loopdive/js2wasm-baselines) repo (`test262-current.json`) and refreshed by CI on every merge. |
| Module size & cold-start characteristics | The benchmark charts on the [landing page](https://js2wasm.loopdive.com/) (size and cold-start panels), regenerated from `benchmarks/results/` on every merge. |
| Per-feature support detail | The feature tables and [Test262 report](https://js2wasm.loopdive.com/benchmarks/report.html), which break results down by language feature and edition. |

If a number you see quoted elsewhere disagrees with the generated section above
or these sources, they win.

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

This is the qualitative shape only; the per-area pass rates are the generated
table above, and the per-feature detail is in the sources linked above.

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
- standalone (no-JS-host) mode — scored separately (see the generated figures
  above)
- getters/setters and other highly dynamic patterns — limited

**Gaps (implemented to a degree, not spec-complete — measured per area in the
generated table above):**

- runtime `eval` and dynamic `Function` construction — constant strings are
  compiled away; runtime strings go through a `dynamicCode` policy (an isolated
  evaluator in a JS host; an interpreter-based runtime-eval provider
  standalone). See [docs/js-host-eval-isolation.md](./docs/js-host-eval-isolation.md)
  and [docs/architecture/runtime-eval-interpreter.md](./docs/architecture/runtime-eval-interpreter.md)
- `Proxy` / `Reflect`, `Temporal`, `SharedArrayBuffer` / `Atomics`, `WeakRef` /
  `FinalizationRegistry` — present, with the gaps shown in that table
- dropping in an arbitrary npm package unchanged — not guaranteed

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

_Apart from the generated Test262 section, this document is intentionally
qualitative. For any other number, follow the links to the live sources — they
are authoritative and current; this page is not._
