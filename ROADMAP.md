# js2wasm Roadmap

## Vision

**Compile any JavaScript/TypeScript to WebAssembly — no interpreter, no runtime, smallest possible output.**

js2wasm is an ahead-of-time compiler that translates ECMAScript directly to WebAssembly using the GC proposal. Unlike approaches that embed a JS interpreter inside Wasm, js2wasm produces native Wasm instructions with no bundled runtime, allocator, or standard library. Output modules range from hundreds of bytes to a few kilobytes — orders of magnitude smaller than interpreter-based alternatives.

The goal: enable JS/TS developers to target WebAssembly as a first-class compilation target, producing modules that run on **any** Wasm host — browsers, WASI runtimes (Wasmtime, Wasmer, wazero), edge platforms, and embedded systems — without requiring a JavaScript engine at the destination.

## What We've Achieved

Across 69 development sprints and **2,700+ merged pull requests**, js2wasm has grown from a proof-of-concept into a functional compiler covering a significant portion of the ECMAScript specification.

### Conformance

<!-- AUTO:conformance-start -->

**test262 conformance**: 32,602 / 43,621 (74.7 %)

<!-- AUTO:conformance-end -->

- Automated conformance tracking with historical trend data and a public [conformance report](https://js2wasm.loopdive.com/benchmarks/report.html)
- 200+ project-level equivalence tests validating JS↔Wasm output parity

### Language Features (compiled to native Wasm)

- **Types** — number (f64/i32), string (WasmGC arrays), boolean, null, undefined, symbol
- **Functions** — declarations, expressions, closures, arrow functions, default/rest parameters, tail call optimization
- **Classes** — constructors, methods, getters/setters, inheritance, `super`, static members, private fields
- **Control flow** — if/else, switch, for/while/do-while, for-of, for-in, labeled break/continue, exceptions (native Wasm tags)
- **Destructuring**, spread, rest, template literals, tagged templates
- **Async/await**, generators, async generators
- **TypedArray**, DataView, ArrayBuffer (Wasm linear memory)
- **Optional chaining** (`?.`), nullish coalescing (`??`), computed properties
- **Block scoping** with proper TDZ semantics
- **SIMD** via native type annotations

### Compilation Modes

| Mode | Description |
|------|-------------|
| **JS host** | Uses host imports for RegExp, JSON, Promises — maximum compatibility |
| **Standalone (WASI)** | Pure Wasm output, no JS runtime required — `--target wasi` |
| **Native strings** | WasmGC i16 arrays instead of `wasm:js-string` — `--nativeStrings` |
| **Component Model** | WIT interface generation for interop — `--wit` |
| **Optimized** | Binaryen wasm-opt integration — `--optimize` |

### Tooling

- **[Live Playground](https://js2wasm.loopdive.com/playground/)** — compile and run TypeScript as WebAssembly in the browser
- **WAT inspector** — view generated WebAssembly Text Format
- **Module analyzer** — binary size treemap visualization
- **CLI** with WAT, `.d.ts`, and imports helper output
- **Programmatic API** — `compile()` and `compileToWat()` for integration

## Planned Work

_Priorities and targets below are indicative and PO-owned; the authoritative
current baselines are in the [conformance section above](#conformance)._

### Near-Term — Target: ≥80% JS-host conformance + close the standalone gap

The original 60% JS-host milestone has been surpassed (currently ~75%). The
near-term focus is pushing JS-host past 80% via the areas below, and closing
the standalone (host-free) gap, which trails the JS-host path.

| Area | Expected Impact | Description |
|------|----------------|-------------|
| **Standalone (host-free) path** | large | Wasm-native replacements for the built-ins still routed through JS host imports; the main lever on the standalone pass rate |
| **Property descriptors** | ~5,000 test fixes | Full `Object.defineProperty`, `Object.getOwnPropertyDescriptor`, property attributes (writable, enumerable, configurable) |
| **Prototype chain** | ~2,500 test fixes | Correct prototype lookup, `Object.create`, `Object.getPrototypeOf`, inherited property access |
| **Iterator protocol** | ~1,500 test fixes | Wasm-native iterators replacing current host-delegated implementation |
| **Type coercion edge cases** | ~1,000 test fixes | Spec-compliant `ToPrimitive`, `ToString`, `ToNumber` for all input types |
| **CI/CD conformance gating** | ✅ shipped | Sharded test262 on every PR with regression detection + merge-queue re-validation |

### Medium-Term — Target: 85% Conformance

- **Full ES2024 compliance** for common application patterns
- **Wasm-native RegExp** engine (removing the largest JS host dependency)
- **Performance benchmarks** — systematic comparison against V8, QuickJS, and other Wasm compilers
- **NPM package** — `npm install js2wasm` for easy integration into build pipelines
- **Documentation and tutorials** — getting started guides, API reference, architecture docs
- **Multi-module compilation** — compile interconnected TypeScript projects to linked Wasm modules

### Long-Term (12 months) — Target: 90%+ Conformance

- **Production-ready** for real-world applications
- **Component Model + WASI P2** — full support for the emerging Wasm component ecosystem
- **Package ecosystem** — compile npm packages to Wasm components for cross-language reuse
- **Source maps** — debug compiled Wasm with original TypeScript source locations
- **Incremental compilation** — fast recompilation for development workflows

## Why This Matters for Digital Sovereignty

### Independence from Heavyweight JS Engines

Today, running JavaScript on the server or at the edge in practice means embedding one of three large, vendor-led engines: Google's V8, Apple's JavaScriptCore, or Mozilla's SpiderMonkey. All three are open source (V8 and JavaScriptCore under BSD-style licenses, SpiderMonkey under the MPL), but each is a megabyte-scale engine governed by a single major vendor, and embedding one means shipping and initializing that whole engine. js2wasm removes that dependency: compiled Wasm modules run on **any** standards-compliant WebAssembly runtime, including lightweight, independently governed options like Wasmtime and wazero — no bundled engine required.

### Open Standards, No Vendor Lock-In

- **WebAssembly** is a W3C standard with multiple independent implementations
- **WASI** provides a portable system interface without platform-specific APIs
- **Component Model** enables language-agnostic module composition
- The compiler itself runs in any JS environment — browser, Node.js, Deno, Bun

### Security by Default

Wasm modules execute in a sandboxed environment with no ambient authority. A compiled module cannot access the filesystem, network, or host memory unless explicitly granted through typed imports. This is not an opt-in security feature — it is the default execution model. This makes js2wasm-compiled code suitable for:

- **In-process plugin systems** — run third-party code safely without separate isolates
- **Supply chain hardening** — each npm package runs in its own sandbox
- **Edge/embedded deployment** — minimal attack surface, deterministic execution

### Deterministic, Reproducible Builds

Same TypeScript input produces the same Wasm binary output. No runtime behavior differences across platforms. No hidden state, no global mutation, no JIT compilation variance. This property is critical for:

- Auditable software supply chains
- Reproducible CI/CD pipelines
- Regulatory compliance in sensitive environments

## Current Performance

_Point-in-time snapshot for illustration — the live, auto-refreshed benchmark
panels on the [landing page](https://js2wasm.loopdive.com/) are canonical._

```
Benchmark     WASM          JS        Ratio     n
──────────────────────────────────────────────────────────────
  array         29.0 µs      30.8 µs    WASM 1.06× 32,510
  fib            2.4 ms       8.2 ms    WASM 3.38× 400
  loop         992.3 µs       1.6 ms    WASM 1.58× 1,010
  dom          100.7 µs      94.9 µs    JS 1.06×   10,670
  string         2.9 µs       2.5 µs    JS 1.12×   300,810
  style         95.1 µs      81.0 µs    JS 1.17×   9,890
```

Compute-intensive workloads (fibonacci, loops, array operations) already match or exceed native JS performance. DOM-heavy and string-heavy workloads are within 17% of JS, with optimization work ongoing.

## Get Involved

- **Repository**: [github.com/loopdive/js2wasm](https://github.com/loopdive/js2wasm)
- **Playground**: [Live demo](https://js2wasm.loopdive.com/playground/)
- **Conformance report**: [Historical compatibility tracking](https://js2wasm.loopdive.com/benchmarks/report.html)
- **License**: Apache 2.0 with LLVM Exceptions

---

*Last updated: July 2026*
