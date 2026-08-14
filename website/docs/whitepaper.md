# js² (js squared) Whitepaper

## Squaring the Circle

### Standard ECMAScript, compiled to WebAssembly GC without embedding a runtime

### Abstract

`js²` ("js squared") is a direct ahead-of-time compiler from JavaScript and TypeScript to WebAssembly GC. Its central claim is that JavaScript can be compiled into Wasm-native artifacts without shipping a bundled JavaScript engine inside the deployed module [[1]](https://cacm.acm.org/research/bringing-the-web-up-to-speed-with-webassembly/) [[4]](https://webassembly.github.io/spec/core/) [[19]](https://pldi17.sigplan.org/details/pldi-2017-papers/48/Bringing-the-Web-up-to-Speed-with-WebAssembly).

That position differs from the two dominant alternatives in the space:

1. compiling or embedding a JavaScript interpreter inside Wasm
2. narrowing the language into a TypeScript-like subset or replacement dialect

`js²` is aimed at a harder target: **full ECMAScript language compatibility over time, with TypeScript source compatibility on top**, reached through direct compilation rather than runtime emulation or language reduction. The intended endpoint is not a custom JavaScript sub- or superset; it is mainstream JavaScript semantics defined by ECMAScript and validated through public conformance work, with Test262 used as the current measurement baseline [[2]](https://tc39.es/ecma262/) [[3]](https://github.com/tc39/test262). That matters not only for language purity, but for ecosystem fit: broad compatibility with JavaScript is a cornerstone of compatibility with the wider JavaScript ecosystem, including real-world npm packages and existing application code. The project is still in active development, but it already exposes a public playground, public benchmark and compatibility reporting, and a public ECMAScript conformance milestone of **{{TEST262_PCT}}% Test262 compliance** on the JS-host path, with a separately tracked standalone (host-free) path at **{{STANDALONE_PCT}}%**.

This whitepaper explains the architectural thesis behind the compiler, why WebAssembly GC is the right target, what deployment profile this enables, where the approach fits, and what tradeoffs still remain.

The central claim is not only that JavaScript can be compiled without embedding a runtime. It is that this changes the economics of deployment: the resulting modules can be **orders of magnitude smaller** than interpreter-bundling and bundled-engine approaches and, on representative published standalone Wasmtime benchmark paths, can remove large interpreter or engine overhead from hot runtime execution. That in turn makes it realistic to build, ship, link, and swap small Wasm modules instead of paying a full runtime tax per module.

## 1. The Problem: JavaScript on Wasm Usually Means Shipping an Engine

Most attempts to run JavaScript in WebAssembly follow one of two paths.

The first path bundles a JavaScript engine into a Wasm module. That strategy inherits mature JavaScript semantics, but it also inherits the cost profile of shipping and initializing the engine. In practice, interpreter-based approaches often land in the high-hundreds-of-kilobytes range before application code is even considered, while full-fledged JavaScript engines land in the megabytes [[7]](https://github.com/bytecodealliance/javy/) [[8]](https://github.com/bytecodealliance/StarlingMonkey). For edge runtimes, plugin systems, and multi-tenant platforms, that overhead is often the wrong tradeoff.

QuickJS-based approaches sit squarely in this category. They are still runtime interpreters packaged inside Wasm: the engine is bundled, and user code executes through that interpreter at runtime [[7]](https://github.com/bytecodealliance/javy/). That also places them in the slowest performance tier, because interpretation remains on the hot path.

Full-fledged engine approaches land in a different tier, but they run into a different ceiling. Modern JavaScript engines are designed around native tiered execution, especially JIT compilation, not around ahead-of-time compilation into standalone Wasm artifacts. Once the engine itself is shipped as Wasm, those native JIT tiers are generally unavailable, so the fastest optimization paths of the engine do not come along for the ride [[8]](https://github.com/bytecodealliance/StarlingMonkey/) [[10]](https://pldi25.sigplan.org/details/pldi-2025-papers/14/Partial-Evaluation-Whole-Program-Compilation).

SpiderMonkey-based approaches therefore try to recover some of that lost ground through preinitialization and ahead-of-time baseline specialization, for example with tools such as Wizer and weval. That can improve startup and execution behavior, but it does not change the core architecture: a full JavaScript engine is still shipped inside the module, and the engine is still being adapted to an AOT deployment model it was not originally designed for [[8]](https://github.com/bytecodealliance/StarlingMonkey/) [[9]](https://github.com/bytecodealliance/wizer/) [[10]](https://pldi25.sigplan.org/details/pldi-2025-papers/14/Partial-Evaluation-Whole-Program-Compilation) [[20]](https://cir.nii.ac.jp/crid/1361418520481560832).

The second path avoids bundling an engine by narrowing the language. In practice that usually means one of:

- a constrained subset of TypeScript or JavaScript
- a TypeScript-adjacent dialect
- a new language designed to compile to Wasm more easily than JavaScript itself

That can be a valid product choice, but it changes the developer contract. Instead of making mainstream JavaScript portable to Wasm, it asks developers to adopt a new language boundary.

`js²` is built around a third position:

> JavaScript should be compiled directly to WebAssembly GC, without embedding a JavaScript engine, and without redefining the language into a smaller substitute.

That is a more difficult compiler target, but it produces a materially better deployment profile if it works.

## 2. Design Thesis

The project is organized around four design commitments.

### 2.1 Direct AOT compilation

The compiler translates JavaScript and TypeScript source directly into Wasm GC binaries. It does not ship an interpreter or rely on runtime bytecode dispatch inside the deployed artifact.

### 2.2 No embedded JavaScript engine

The deployed module contains compiled program logic, not a full JavaScript runtime. That removes the baseline cost of carrying an engine just to execute user code.

### 2.3 Full ECMAScript direction, not a subset endpoint

The goal is not to stop at a “safe subset” of JavaScript. The strategic value of the project is precisely the path toward full ECMAScript language compatibility, measured publicly through Test262 progress but not limited to what the test suite can express, with TypeScript accepted as a source-language layer rather than used to redefine JavaScript semantics. A subset compiler is easier to build, but it does not solve the mainstream platform problem.

This is also an ecosystem issue, not just a language-design issue. Full-language compatibility is a cornerstone of compatibility with the JavaScript ecosystem itself. If the language surface is narrowed too aggressively, or extended into a custom superset that is not specified ECMAScript, then compatibility with mainstream application code, existing libraries, and npm packages erodes quickly.

### 2.4 Wasm-native deployment model

The output should behave like a WebAssembly artifact, not like a JavaScript runtime disguised as one. That matters for:

- artifact size
- cold start
- isolation boundaries
- supply-chain attack surface
- embedding into Wasm-native hosts
- platform integration across browsers, serverless runtimes, and standalone Wasm environments
- interface-stable module composition and swapping

## 3. Why WebAssembly GC

Targeting WebAssembly GC is not incidental. It is the technical basis that makes direct JavaScript compilation plausible without recreating a garbage-collected runtime inside linear memory [[1]](https://cacm.acm.org/research/bringing-the-web-up-to-speed-with-webassembly/) [[4]](https://webassembly.github.io/spec/core/).

WebAssembly GC provides:

- **struct and array types** for representing objects, arrays, and user-defined aggregates
- **host-managed garbage collection**, so the compiler does not need to ship a custom allocator and collector
- **nominal typing and subtyping**, which maps more naturally onto class hierarchies
- **`externref` interop**, which allows bridging to host objects where appropriate
- **`i31ref`**, which helps represent tagged small integers without heap allocation

Without Wasm GC, direct JavaScript compilation usually falls back to one of two less attractive strategies:

1. manual object models in linear memory
2. a bundled runtime that recreates the missing semantics

Wasm GC changes that equation. It does not solve JavaScript semantics on its own, but it provides the right runtime substrate for compiling a dynamic, garbage-collected language without embedding another garbage-collected runtime inside the artifact.

## 4. Architecture Overview

At a high level, the compiler pipeline is:

```text
JavaScript / TypeScript source
  -> parse and type-check via the TypeScript compiler API
  -> collect imports and declarations
  -> lower expressions, statements, objects, arrays, and functions into a WasmModule IR
  -> emit a Wasm GC binary
  -> optionally optimize the result
```

The implementation is organized in three main stages:

### 4.1 Parse and type-check

The compiler uses the TypeScript compiler API for parsing, symbol resolution, and type information. It tolerates many ordinary type errors and only aborts on hard syntax failures, which keeps the pipeline usable for both TypeScript and plain JavaScript.

### 4.2 Code generation

Code generation lowers the typed AST into a Wasm module IR. This stage:

- collects required host imports
- registers functions, classes, interfaces, globals, and Wasm types
- compiles function bodies into Wasm instructions
- performs fixups and lightweight optimization passes

This is where JavaScript constructs become WasmGC structs, arrays, function references, locals, and control-flow blocks.

### 4.3 Emit and optimize

The IR is serialized into a `.wasm` binary. Optional optimization can then run through Binaryen for size or speed improvements.

## 5. Execution Model: JS Host and Standalone Paths

The compiler currently operates across two execution models.

### 5.1 JS-host mode

In the default path, the Wasm module can import selected helpers from a JavaScript host. This is useful where some operations are expensive, awkward, or not yet implemented purely inside Wasm.

More generally, the host should be understood as a **platform surface**, not just as “some leftover JavaScript runtime”. In a browser, that surface is the Web Platform and its Web APIs. In Node.js, it includes the environment and standard-library APIs exposed by the runtime and underlying native system. Those platform capabilities are part of the surrounding execution environment and do not need to be eliminated simply because application logic is being compiled to Wasm.

The JS-host path is therefore intentional for interoperability, not only a temporary fallback. It is the right mode when compiled modules need to integrate with platform APIs or with existing JavaScript code that already runs in that environment and is not itself meant to be compiled to Wasm. In that sense, JS-host mode is part compatibility bridge and part integration surface.

That keeps the system practical while conformance grows, while still allowing compiled modules to participate in browser and JS-runtime environments without requiring the entire surrounding world to move into Wasm at once.

### 5.2 Standalone / WASI-oriented mode

There is also an explicit standalone direction in which the compiler emits modules that depend on WASI or Wasm-native facilities rather than a JavaScript embedding environment.

This distinction matters. The strategic end state is not “Wasm that still secretly depends on a browser-like runtime.” The point is to move as much behavior as possible into compiled output and explicit Wasm-native integration.

The deeper goal is to **shrink the implicit host environment and enlarge the Wasm closed world** over time. The long-term shape is not “no host at all”, because useful systems still depend on explicit platform APIs such as Web APIs, Node APIs, or WASI. The goal is that what remains outside the compiled module is an explicit, bounded API surface rather than a large, ambient JavaScript runtime context. Those API surfaces can then, in principle, be implemented by any compatible host.

This aligns with the direction of WinterCG and its successor standardization work in Ecma TC55 / WinterTC: a provider-spanning effort to define a common, web-aligned API surface for server-side and edge JavaScript runtimes, including worker-like serverless hosts such as Cloudflare Workers and Deno Deploy [[21]](https://www.w3.org/community/wintercg/). `js²` does not need to replace that host surface. The relevant point is that a compiled module can target explicit, portable host APIs instead of assuming that each deployment unit must carry a full JavaScript engine to get a familiar serverless programming model.

This is not just theoretical. Wasmer's Edge.js is a recent example of a system that re-exposes Node.js workloads through a WebAssembly-based execution model rather than treating a conventional Node process as the only way to provide the Node environment. That kind of work reinforces the broader point: the platform surface can remain, while the ambient runtime context behind it can change [[11]](https://wasmer.io/posts/edgejs-safe-nodejs-using-wasm-sandbox).

Standalone support is meaningful and growing, but it is not yet the primary public conformance path today.

## 6. Deployment Profile

The main reason to pursue direct compilation is not aesthetic purity. It is deployment.

When an application is compiled directly to WasmGC without bundling an engine, the resulting module can be materially better suited for:

- **edge and serverless runtimes**, where artifact size and startup cost matter
- **plugin and extension systems**, where strong isolation boundaries are valuable
- **embedded and desktop applications**, where bundling a browser-plus-engine stack is too expensive
- **multi-language hosts**, where JavaScript support is desired without carrying a full JS runtime in every deployment unit
- **modular systems**, where compatible components should be swappable without rebuilding the full application

This deployment profile changes the shape of the artifact:

- no bundled interpreter or engine tax before application code begins, from high-hundreds-of-kilobytes for interpreters to megabytes for full-fledged JS engines
- a cleaner boundary between host integration and compiled program logic
- better fit with Wasm-native execution environments
- a smaller supply-chain and runtime attack surface than runtime-heavy JavaScript deployment models

That size tax also matters at the granularity of composition. If the engine is embedded directly into each deployment unit, then the cost is effectively paid per module, not just per application. It can be amortized only if the engine is factored out into an imported or otherwise shared dependency. That is a meaningful optimization path, but it changes the packaging model less than it changes the size accounting.

The current public standalone Wasmtime benchmark surface is easiest to read as a packaging and runtime comparison. The Wasmtime rows use precompiled Wasmtime artifacts (`wasmtime compile` / `--allow-precompiled`) with runtime JIT compilation disabled. That is intentional: it approximates a serverless deployment shape where code is prepared before the request path, and the measured cost is packaging, instantiation, startup, and execution without on-demand runtime compilation. The benchmark programs are deliberately small, behavior-oriented kernels: iterative numeric looping, recursive calls, array allocation/fill/summation, object allocation and field access churn, and string concatenation plus character-code hashing.

| Deployment pattern                               | What it represents                                                                        |                                              Module / runtime size |  Cold start |     Runtime |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | -----------------------------------------------------------------: | ----------: | ----------: |
| Direct `js²` AOT WasmGC                          | Compiled WasmGC output, no JavaScript engine in the module                                |                                                        **0.34 kB** | **13.7 ms** | **21.7 ms** |
| Dynamic imported-interpreter module              | Small module calling a shared interpreter/runtime plugin                                  | **2.98 kB** per module plus about **1.2 MB** shared runtime/plugin | **24.7 ms** |  **272 ms** |
| Preinitialized and specialized bundled JS engine | Bundled engine with ComponentizeJS/Wizer/weval-style preinitialization and specialization |                                                        **14.4 MB** | **24.7 ms** |  **297 ms** |

In the same benchmark set, native JavaScript in Node/V8 with JIT enabled is **12.4 ms** on the runtime metric and **20.8 ms** on cold start. That remains the native runtime baseline to beat on hot execution.

The benchmark is a public standalone datapoint, not the scope of the compiler. Current compatibility work is also pushing against popular npm packages and real application code, while Test262 remains the public conformance baseline.

The runtime data should be read narrowly. Native JavaScript with JIT remains the runtime reference point, and the current standalone path still has known gaps. The useful claim is not universal speedup. It is that removing the embedded interpreter or engine changes module size by orders of magnitude, improves cold start against the fresh Node/V8 process baseline in this benchmark set, and can remove large standalone Wasmtime runtime overhead where direct compilation is already mature.

This is also what makes modular composition more practical. If each deployment unit does not need to carry an engine, it becomes realistic to ship and link smaller Wasm modules instead of collapsing everything into one large runtime container just to amortize the engine cost. If an engine can be shared as an imported dependency, that can reduce duplicated size across many modules, but it still leaves execution centered around the imported engine rather than around directly compiled module logic. With stable interfaces, compatible modules can also be swapped independently, which pushes dependency injection and platform integration to the module boundary instead of the source-bundle boundary.

That modularity is also a security property. Smaller runtime-free modules make it more realistic to adopt a Component-Model-style or otherwise shared-nothing composition model, where modules communicate through explicit interfaces instead of through one shared ambient runtime. In that shape, smaller modules do not just improve packaging; they reduce the amount of state, capability, and implicit trust bundled into each deployment unit [[5]](https://github.com/WebAssembly/component-model/) [[6]](https://popl25.sigplan.org/details/waw-2025-papers/4/The-WebAssembly-Component-Model) [[12]](https://www.usenix.org/conference/usenixsecurity22/presentation/bosamiya).

The security implications matter as well. In-process JavaScript execution is structurally difficult to harden, because code often shares one mutable object graph, one prototype universe, and one ambient runtime context. In practice, once untrusted or compromised code runs in that shared environment, it is often difficult to prevent it from reaching or influencing unrelated parts of the program unless heavier isolation mechanisms such as iframes, workers, separate processes, or comparable boundaries are used [[15]](https://www.usenix.org/system/files/usenixsecurity23-alhamdan_1.pdf) [[16]](https://www.usenix.org/conference/usenix-security-11/adsafety-type-based-verification-javascript-sandboxing) [[17]](https://research.chalmers.se/en/publication/246300) [[18]](https://www.usenix.org/conference/usenixsecurity21/presentation/xiao).

Today, JavaScript deployment is often tied to a large runtime and a package-heavy execution model. Public npm ecosystem incidents have shown how quickly that can widen the blast radius of supply-chain failures [[14]](https://www.microsoft.com/en-us/research/publication/what-are-weak-links-in-the-npm-supply-chain/). A compiled, sandboxed Wasm artifact model does not eliminate software supply-chain risk, but it can reduce the amount of runtime machinery, shared mutable context, and ambient capability that each deployment unit carries by default [[12]](https://www.usenix.org/conference/usenixsecurity22/presentation/bosamiya) [[13]](https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann).

That is the core practical claim of `js²`: not simply that JavaScript can run in Wasm, but that it can do so with a meaningfully different packaging, execution, security, and composition profile.

## 7. Compatibility Strategy

The main risk in any direct JavaScript compiler is semantic coverage. JavaScript is a large language with specification-heavy edge cases, observable runtime behavior, and broad built-in API surface.

`js²` treats compatibility as a public engineering problem rather than a hidden claim.

### 7.1 Test262 as the public conformance baseline

The project tracks ECMAScript compatibility through Test262, the standard conformance suite for JavaScript engines and implementations [[2]](https://tc39.es/ecma262/) [[3]](https://github.com/tc39/test262).

Conformance is measured along **two independent paths** (see §5), and both are reported publicly:

- **JS-host path** (default target, host imports allowed): **{{TEST262_PCT}}% Test262 compliance** ({{TEST262_PASS}} / {{TEST262_TOTAL}} official conformance tests passing in the current public report, generated {{REPORT_DATE}})
- **Standalone / host-free path** (pure WasmGC, no JS host): **{{STANDALONE_PCT}}%** ({{STANDALONE_PASS}} / {{TEST262_TOTAL}}), measured host-free on the same official denominator

These are distinct metrics on different targets and are never summed. The JS-host figure is the headline conformance number; the standalone figure is lower today because host-assisted operations are counted as failures unless a Wasm-native implementation exists, and closing that gap is where the current effort concentrates (§5.2, §12.2). Both improve as host fallbacks are replaced with compiled Wasm-native behavior.

That number should be interpreted correctly. It does not mean the compiler is finished or suitable for arbitrary npm workloads today. It means there is already a public, measurable conformance baseline that can improve in a disciplined way toward the broader goal of real ecosystem compatibility.

### 7.2 Public evaluation surface

The project exposes public artifacts that make progress inspectable:

- public landing page: [js2wasm.loopdive.com](https://js2wasm.loopdive.com)
- browser playground
- public compatibility reporting
- public benchmark reporting

That matters because it prevents “compiler claims” from turning into marketing theater. The project can be evaluated through its actual outputs and current conformance posture.

### 7.3 Compatibility as a long-term moat

The project is not trying to prove that a small curated subset compiles well. The long-term value is the steady expansion toward mainstream ECMAScript semantics, with TypeScript source support layered above that contract, while preserving the deployment advantages of direct compilation.

That is harder than shipping a reduced language, but it is also where the durable strategic value sits. In practice, ecosystem compatibility flows from language compatibility: the closer the compiler gets to full ECMAScript semantics, the more credible it becomes as a path for existing application code and npm packages rather than only for greenfield demos.

## 8. What This Approach Is Not

Clarity about non-goals matters.

`js²` is **not**:

- an interpreter compiled to Wasm
- a TypeScript-like dialect
- a small pedagogical subset compiler
- a “drop any npm package in today” claim
- a claim that every JavaScript feature is equally AOT-friendly

Some JavaScript behaviors are intrinsically hostile to ahead-of-time compilation or require explicit host boundaries. Examples include:

- dynamic code evaluation
- runtime module loading semantics
- deeply host-observable engine behaviors

The correct response is not to pretend those constraints do not exist. It is to design a compiler and product surface that handles them explicitly while still making the broad language tractable.

## 9. Competitive Landscape

There are four broad architectures in the JavaScript-to-Wasm space:

1. **Bundled engine plus AOT specialization**  
   Strong compatibility, large runtime payload, complex toolchains.

2. **Interpreter-only bundling**  
   Production-ready semantics, but the deployed module still ships an engine and pays interpretation overhead.

3. **Direct AOT to core Wasm**  
   Small artifacts without a bundled engine, but usually with manual object models and custom runtime machinery.

4. **Direct AOT to Wasm GC**  
   The path taken by `js²`: direct compilation, host GC, no embedded engine, Wasm-native types.

As of mid-2026, we are not aware of another AOT JavaScript-to-Wasm approach that both aims to implement the full ECMAScript standard and already has production-ready garbage collection. The closest direct-AOT efforts are important, but publicly visible projects either remain experimental, target a narrower language surface, or use core Wasm / linear-memory strategies rather than host-provided WasmGC.

The nearest Wasm-GC direct-compilation analogues we track are JAWSM [[22]](https://github.com/drogus/jawsm), a JavaScript-to-Wasm prototype, and Wasmnizer-ts [[23]](https://github.com/web-devkits/Wasmnizer-ts), a TypeScript-subset-to-WasmGC research compiler from the WAMR / Web DevKit ecosystem. They are useful signals that direct JS/TS-to-WasmGC compilation is an active research direction, but we currently treat them as prototype/subset comparators rather than production competitors for full ECMAScript coverage.

The architectural difference can be summarized like this:

| Dimension                                       | Interpreter-in-Wasm                        | Custom sub- or superset             | Direct AOT to Wasm GC (`js²`)       |
| ----------------------------------------------- | ------------------------------------------ | ----------------------------------- | ----------------------------------- |
| Ships a JS engine in the artifact               | Yes                                        | No                                  | No                                  |
| Targets full ECMAScript compatibility over time | Usually inherits engine semantics          | Usually no                          | Yes                                 |
| Garbage collection model                        | Engine-owned GC inside the bundled runtime | Usually custom or language-specific | Host-provided WasmGC                |
| Wasm-native deployment profile                  | Weak                                       | Strong                              | Strong                              |
| Compatibility ceiling                           | High                                       | Limited by design                   | High, but reached incrementally     |
| Product risk                                    | large artifacts and runtime overhead       | language adoption friction          | compiler and conformance complexity |

`js²` deliberately accepts the last category of risk. It chooses compiler complexity over runtime bulk and over language substitution.

## 10. Where `js²` Fits Best

The approach is especially relevant where JavaScript demand exists but shipping a JavaScript engine is the wrong deployment decision.

Best-fit categories include:

- edge and serverless platforms
- Wasm-native compute environments
- extension and plugin ecosystems
- embedded application containers
- desktop applications using Wasm as an isolation boundary
- multi-language hosts that want JavaScript and TypeScript support without embedding a JS engine
- systems that want to swap compatible modules without rebuilding the rest of the program

This includes practical deployment ideas such as:

- TypeScript-defined business logic running inside a Wasm-based plugin host
- smaller serverless modules with better cold-start characteristics
- desktop application extensions compiled to Wasm instead of delivered as unrestricted JavaScript
- linkable small modules where functionality can be decomposed without paying a bundled-runtime penalty per module
- interface-stable modules that can be swapped out by consumers as long as the contracts remain compatible

## 11. Current Tradeoffs

A whitepaper is not useful if it ignores the hard parts.

The current tradeoffs are straightforward:

### 11.1 Conformance is still incomplete

At {{TEST262_PCT}}% Test262 compliance on the JS-host path — and {{STANDALONE_PCT}}% on the standalone, host-free path — the compiler is credible but not complete. There is still significant work to do across language semantics, built-ins, and host-sensitive behaviors, and the standalone gap in particular is a primary focus (§5.2, §12.2).

### 11.2 Wasm GC runtime support is required

The architecture depends on runtimes with Wasm GC support. That is increasingly practical in modern browser and Wasm runtime environments, but it remains a real deployment constraint.

### 11.3 Some host fallbacks still exist

The system already compiles substantial behavior directly, but some operations still use host imports or host-assisted paths. The long-term direction is to shrink those boundaries, not normalize them.

### 11.4 The hardest part is semantic closure

The real challenge is not emitting Wasm bytes. It is matching JavaScript behavior closely enough that mainstream code can move through the compiler without requiring a language rewrite.

## 12. Roadmap Direction

The highest-value next steps are not ambiguous.

### 12.1 Deeper ECMAScript conformance

The most important line of work is continued Test262-driven semantic expansion and regression control.

### 12.2 Stronger standalone execution

Reducing dependence on JS-host fallbacks makes the compiler more valuable to Wasm-native environments and strengthens the “no embedded runtime” claim.

### 12.3 Packaging and host integration

Support for Component Model and platform-facing packaging workflows can make compiled modules easier to adopt in production environments and make interface-stable module swapping more practical.

### 12.4 Real application workloads

The compiler should continue to be validated not just on micro-tests, but on actual application and plugin-style workloads where module size, isolation, and startup behavior matter.

## 13. Conclusion

`js²` exists because “JavaScript in Wasm” is not the same thing as “JavaScript compiled to Wasm.”

Bundling an interpreter inside Wasm can deliver excellent compatibility, but it inherits the size and runtime costs of shipping the engine. Narrowing or extending the language can simplify compilation, but it changes the developer contract. `js²` takes the harder route: compile mainstream ECMAScript semantics directly to WebAssembly GC without embedding a runtime, with TypeScript source support layered on top rather than used as a different language contract.

That route is still in progress, and it is not trivial. But it produces a distinct and strategically valuable outcome if it succeeds:

- Wasm-native artifacts
- many-times smaller modules than interpreter-bundling approaches
- substantially lower hot-path runtime overhead on representative standalone benchmark paths
- smaller deployment units
- stronger isolation boundaries
- reduced runtime and supply-chain attack surface
- more portable deployment across Wasm-capable environments without Node.js as the target runtime
- more composable, swappable modules when interfaces are stable
- a credible TypeScript story for Wasm platforms that do not want to ship a JS engine

The current public milestone is enough to make the direction concrete. The next phase is about turning that direction into broad compatibility and production-grade platform fit.

## 14. References

- **[1]** Andreas Rossberg, Ben L. Titzer, Andreas Haas, Derek L. Schuff, Dan Gohman, Luke Wagner, Alon Zakai, J. F. Bastien, Michael Holman. [_Bringing the Web Up to Speed with WebAssembly_](https://cacm.acm.org/research/bringing-the-web-up-to-speed-with-webassembly/). Communications of the ACM, 2018.
- **[2]** TC39. [_ECMAScript Language Specification_](https://tc39.es/ecma262/).
- **[3]** TC39. [_Test262: Official ECMAScript Conformance Test Suite_](https://github.com/tc39/test262).
- **[4]** WebAssembly Community Group. [_WebAssembly Core Specification_](https://webassembly.github.io/spec/core/).
- **[5]** WebAssembly Community Group. [_Component Model design and specification_](https://github.com/WebAssembly/component-model/).
- **[6]** Lucy Menon, Luke Wagner. [_The WebAssembly Component Model_](https://popl25.sigplan.org/details/waw-2025-papers/4/The-WebAssembly-Component-Model). WebAssembly Workshop at POPL, 2025.
- **[7]** Bytecode Alliance. [_Javy_](https://github.com/bytecodealliance/javy/).
- **[8]** Bytecode Alliance. [_StarlingMonkey_](https://github.com/bytecodealliance/StarlingMonkey/).
- **[9]** Bytecode Alliance. [_Wizer_](https://github.com/bytecodealliance/wizer/).
- **[10]** Chris Fallin, Maxwell Bernstein. [_Partial Evaluation, Whole-Program Compilation_](https://pldi25.sigplan.org/details/pldi-2025-papers/14/Partial-Evaluation-Whole-Program-Compilation). PLDI, 2025.
- **[11]** Wasmer. [_Edge.js: Running Node apps inside a WebAssembly Sandbox_](https://wasmer.io/posts/edgejs-safe-nodejs-using-wasm-sandbox). 2026.
- **[12]** Jay Bosamiya, Wen Shih Lim, Bryan Parno. [_Provably-Safe Multilingual Software Sandboxing using WebAssembly_](https://www.usenix.org/conference/usenixsecurity22/presentation/bosamiya). USENIX Security, 2022.
- **[13]** Daniel Lehmann, Johannes Kinder, Michael Pradel. [_Everything Old is New Again: Binary Security of WebAssembly_](https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann). USENIX Security, 2020.
- **[14]** Nusrat Zahan, Tom Zimmermann, Patrice Godefroid, Brendan Murphy, Chandra Maddila, Laurie Williams. [_What are Weak Links in the npm Supply Chain?_](https://www.microsoft.com/en-us/research/publication/what-are-weak-links-in-the-npm-supply-chain/). ICSE, 2022.
- **[15]** Abdullah AlHamdan, Cristian-Alexandru Staicu. [_SandDriller: A Fully-Automated Approach for Testing Language-Based JavaScript Sandboxes_](https://www.usenix.org/system/files/usenixsecurity23-alhamdan_1.pdf). USENIX Security, 2023.
- **[16]** Joe Gibbs Politz, Spiridon Aristides Eliopoulos, Arjun Guha, Shriram Krishnamurthi. [_ADsafety: Type-Based Verification of JavaScript Sandboxing_](https://www.usenix.org/conference/usenix-security-11/adsafety-type-based-verification-javascript-sandboxing). USENIX Security, 2011.
- **[17]** Steven Van Acker, Andrei Sabelfeld. [_Javascript sandboxing: Isolating and restricting client-side javascript_](https://research.chalmers.se/en/publication/246300). FOSAD, 2016.
- **[18]** Feng Xiao, Jianwei Huang, Yichang Xiong, Guangliang Yang, Hong Hu, Guofei Gu, Wenke Lee. [_Abusing Hidden Properties to Attack the Node.js Ecosystem_](https://www.usenix.org/conference/usenixsecurity21/presentation/xiao). USENIX Security, 2021.
- **[19]** Andreas Haas, Andreas Rossberg, Derek Schuff, Ben L. Titzer, Dan Gohman, Luke Wagner, Alon Zakai, J. F. Bastien, Michael Holman. [_Bringing the Web up to Speed with WebAssembly_](https://pldi17.sigplan.org/details/pldi-2017-papers/48/Bringing-the-Web-up-to-Speed-with-WebAssembly). PLDI, 2017.
- **[20]** Neil D. Jones. [_An Introduction to Partial Evaluation_](https://cir.nii.ac.jp/crid/1361418520481560832). ACM Computing Surveys, 1996.
- **[21]** W3C. [_Web-interoperable Runtimes Community Group_](https://www.w3.org/community/wintercg/).
- **[22]** [_JAWSM: Javascript to WebAssembly compiler_](https://github.com/drogus/jawsm).
- **[23]** [_Wasmnizer-ts: A TypeScript-to-WebAssembly compiler_](https://github.com/web-devkits/Wasmnizer-ts).

## Public Surface

- Project page: [js2wasm.loopdive.com](https://js2wasm.loopdive.com)
- Playground: [js2wasm.loopdive.com/playground](https://js2wasm.loopdive.com/playground)
- Repository: [github.com/loopdive/js2wasm](https://github.com/loopdive/js2wasm)
- Contact: `js2@loopdive.com`
