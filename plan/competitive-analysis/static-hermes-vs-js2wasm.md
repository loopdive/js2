# Static Hermes vs js2wasm: Architectural Comparison

*Research date: 2026-05-20. Static Hermes sources: `github.com/facebook/hermes/tree/static_h`.*

---

## TL;DR (Comparison Table)

| Dimension | Static Hermes (`static_h`) | js2wasm |
|-----------|---------------------------|---------|
| **Output format** | Native machine code via C IR + Clang/LLVM; also Wasm via Emscripten | WasmGC bytecode (struct/array/func GC types) |
| **IR** | SSA-based typed Hermes IR → C structs | TypeScript AST → WasmGC module (no named IR tier) |
| **Type language** | Flow types (primary); partial TypeScript via `-parse-ts` | TypeScript (full TypeScript compiler API) |
| **Type system posture** | Unsound opt-in — `any` casts implicitly with runtime check | Structurally sound within the type domain; `any` → `externref` |
| **GC** | Native GC (Hades — tri-color concurrent mark-sweep) owned by Hermes runtime | Host Wasm engine GC (browser, wasmtime, wasmer) |
| **Runtime library** | Full Hermes JS runtime (all builtins) embedded in binary | JS host mode: browser/Node runtime; standalone mode: Wasm-native helpers |
| **`eval` / `new Function`** | Embedded bytecode interpreter (activated on demand) | Wasm-module recompile path; JS host fallback; absent in standalone/WASI |
| **Proxy / Reflect** | Unknown — not documented in public static_h sources | Compile-time error (not supported; tracked in skip filters) |
| **`async` / generators** | Not yet supported in typed mode | Supported (generators and async/await compile to WasmGC coroutine structs) |
| **Primary target** | React Native (mobile); also WASI-ish via Emscripten | Browser, Node, WASI, wasmtime, wasmer, Wasm Component Model |
| **Portability** | Platform-specific native binary; Wasm via Emscripten (requires Clang) | Single .wasm file runs anywhere with WasmGC support |
| **Conformance posture** | Focuses on untyped + typed ES2015+; `eval` supported via interpreter | Test262 driven (25,830 / 43,168 pass as of 2026-04-28; CLAUDE.md line 7) |
| **Standalone (no JS host)** | Yes — runtime library embedded; Wasm via Emscripten requires JS glue | Standalone mode (WASI target, `nativeStrings`) — no JS host needed |
| **JIT** | Baseline JIT in interpreter mode; native-compiled code runs without JIT | None — pure AOT |
| **Toolchain complexity** | Requires Clang + LLVM (or Emscripten for Wasm) | Self-contained TypeScript → Wasm (only dependency: Binaryen for opt) |

---

## Compilation Strategy

### Static Hermes

Static Hermes follows a multi-stage pipeline described in the blog post "Hermes Compilation and Runtime Modes" (2025-11-02, `doc/blog/2025-11-02-hermes-compilation-runtime-modes.md`):

1. **Parse** — JS/TS source is parsed by the Hermes parser.
2. **Semantic analysis** — `lib/Sema` performs scope resolution and type annotation.
3. **IRGen** — Produces a typed SSA-form Hermes IR (`lib/IRGen`). The IR is described in `doc/IR.md` as "a Static Single Assignment (SSA) based representation that captures the JavaScript language semantics. It features optional types (values may be annotated with types)."
4. **Optimizer** — Type-aware optimization passes over the SSA IR (`lib/Optimizer`).
5. **Native backend** — The optimized IR is lowered to **C source code** by the `shermes` (Static Hermes) compiler. Clang + LLVM then compile that C to native machine code. For Wasm, Emscripten is used as the C compiler (`doc/Emscripten.md`).
6. **Wasm linking** — The JavaScript standard library (`lib/InternalJavaScript`), the runtime, and compiled JS are linked into a single Wasm binary. The resulting binary is described in the "Compiling Full-Featured JavaScript to Wasm" blog post (2024-12-23, `doc/blog/2024-12-23-compiling-javascript-to-wasm.md`) as containing: "Compiled JavaScript, JavaScript Library (all standard built-ins), and Embedded Interpreter (for dynamic features like `eval`)."

The compilation is **language-agnostic**: typed and untyped functions can coexist. Untyped functions fall back to the interpreter. The blog post notes: "All of these modes can be mixed and exist in the same runtime simultaneously."

The pipeline is also **target-agnostic by design** — Wasm is just another Clang target. Quote from the 2024-12-23 blog: "By leveraging Clang and LLVM for code generation, it can treat WebAssembly (Wasm) as just another compiler target."

### js2wasm

js2wasm also performs AOT compilation but its pipeline is shorter and outputs WasmGC directly:

1. **TypeScript API** — The full TypeScript compiler (`ts` API imported at `src/codegen/index.ts:2`) parses and type-checks the source.
2. **Type extraction** — `src/checker/` maps TS types to Wasm value types via `mapTsTypeToWasm` (`src/codegen/index.ts:12`).
3. **Codegen** — `src/codegen/index.ts` walks the TypeScript AST and directly emits WasmGC instructions (struct types, func types, instructions). There is no separately named IR tier in the production path; a middle-end IR exists as `src/ir/` but is experimental and guarded by `experimentalIR` (`src/index.ts:151`).
4. **Binary emission** — `src/emit/binary.ts` encodes the WasmGC module. Optional Binaryen `wasm-opt` post-processing via `src/optimize.ts`.

There is **no C or native backend** — the output is always a `.wasm` file using WasmGC types.

---

## Runtime Model

### Static Hermes

Static Hermes embeds a complete JavaScript runtime in every compiled binary:

- The Hermes VM runtime (`lib/VM`) provides object model, GC, and exception semantics.
- All standard built-ins (Array, Math, RegExp, etc.) come from `lib/InternalJavaScript`, compiled to bytecode or native.
- A **bytecode interpreter** is embedded for dynamic features — `eval()`, `new Function()`, and any code that could not be AOT-compiled.

The runtime model is described in `doc/Design.md`: memory ownership is shared between `JSFunction` (GC-managed JS object), `CodeBlock` (bytecode or native code block), `RuntimeModule`, and `Domain`. This C++ runtime is linked into the Wasm binary when compiling with Emscripten, producing binaries typically in the 2–3 MB range (the blog post shows `demo-wasm.wasm` at 2.6 MB for a simple demo).

The resulting Wasm binary **requires a JS glue file** (e.g., `demo-wasm.js`) because the Emscripten Hermes build relies on a small JS helper for Unicode — see the note in `doc/Emscripten.md`: "Under Emscripten, Hermes relies on a small amount of JavaScript to be executed by the Wasm host. If you intend to run it under a 'pure' Wasm host, consider using `-DHERMES_UNICODE_LITE`."

### js2wasm

js2wasm's runtime model is dual-mode, controlled by the `target` and `nativeStrings` compile options (`src/index.ts:98–104`):

**JS host mode (default):** Compiled Wasm imports helper functions from a JS runtime module (`src/runtime.ts`). These helpers implement the parts of JS semantics that are hard to express in WasmGC: property descriptor sidecar storage (`_wasmStructProps` WeakMap at `src/runtime.ts:48`), string operations via `wasm:js-string`, boxing/unboxing, and prototype registration. There is no embedded interpreter — the Wasm binary itself is the compiled code.

**Standalone mode (WASI target):** When `target: "wasi"` and/or `nativeStrings: true` are set, the compiler switches to WasmGC-native string arrays (i16 arrays instead of `wasm:js-string` imports) and emits WASI imports (`fd_write`, `proc_exit`) instead of JS host imports. No JS runtime is required. The design principle is stated in CLAUDE.md: "New features should have Wasm-native implementations for standalone mode; JS host imports are acceptable as a fast path when a JS runtime is available."

The **dynamic eval path** in JS host mode (`src/runtime.ts:2068–2094`) first tries to compile the eval string through js2wasm itself (producing a new Wasm module), then falls back to `(0, eval)` in the JS host. In standalone/WASI mode neither path is available and the `__extern_eval` import is absent entirely.

**Key contrast:** Static Hermes's Wasm output always includes a large runtime library (~2–3 MB); js2wasm Wasm output for simple typed code contains only the compiled code plus minimal type glue, with library functions tree-shaken to what is actually referenced.

---

## Type System

### Static Hermes

The Static Hermes type system is documented in `doc/TypedLanguage.md`. Key characteristics:

- **Input language:** Flow type syntax (`-typed` flag). TypeScript is partially supported via `-parse-ts`, which converts TS to Flow before compilation.
- **Type posture:** Unsound by design. `any` is a supertype that "casts implicitly to other types with a runtime type check." The document explicitly states: "The compiler will emit errors for any type errors which can be detected ahead of time… certain operations will result in checked casts which must happen at runtime."
- **Exact objects:** "All object types in the typed language are exact objects... They must have exactly the set of properties listed in their type." This maps JS objects to C structs with known field offsets.
- **Nominal classes:** "Classes in the typed language are nominally typed. This means that two classes that happen to have the same field names cannot be used interchangeably."
- **Sound arrays:** "These soundly typed arrays are incompatible with untyped JS arrays and are more restrictive. They do not allow holes or empty spaces... Indexed access to arrays is bounds-checked and throws on out-of-bounds access."
- **`c_ptr` native type:** A raw C pointer type for FFI — unique to the native compilation context.
- **Generics:** Classes and type aliases can be generic.
- **Inference:** Whole-program fixed-point forward type inference narrows value types (documented in `doc/plans/ir-type/ir-type-system.md`).
- **IR type system evolution:** The v2 IR type system (`doc/plans/ir-type/ir-type-system-v2-design.md`) extends the current 16-bit bitmask to support nominal class IDs, typed arrays, function signatures, and tuples, all unified under "Union as the single composition mechanism."

**Not yet supported in typed mode:** `async` methods, generator methods, computed property names, optional call expressions, spread arguments in calls.

### js2wasm

js2wasm uses the **full TypeScript compiler API** as its type system:

- **Input language:** TypeScript — all TS syntax including generics, conditional types, mapped types, decorators.
- **Type mapping:** `src/checker/type-mapper.ts` maps TS types to WasmGC value types (`f64`, `i32`, `externref`, struct refs, array refs). See `mapTsTypeToWasm` at `src/codegen/index.ts:12`.
- **Native type annotations:** `type i32 = number` → emits i32 locals and arithmetic (CLAUDE.md, "Key Patterns").
- **`any` → `externref`:** The `any` keyword maps to WasmGC `externref` — a fully opaque, GC-traced reference that passes through the Wasm/JS boundary without boxing overhead.
- **Struct types:** TypeScript interface/object types with known shape map to WasmGC struct types with fixed field layouts. Ref cells are emitted for mutable closure captures (`struct (field $value (mut T))`).
- **Lattice type inference:** The experimental IR path (`src/ir/propagate.ts`) uses `buildTypeMap` with lattice types for numeric range specialization.
- **`nativeStrings` flag:** Decouples WasmGC string arrays (i16 arrays) from the default `wasm:js-string` fast mode.

**Key contrast:** SH uses Flow as the type language (with partial TS support), while js2wasm uses the TypeScript compiler directly. SH's type system is more conservative about unsoundness (explicit `any` casts with runtime checks). js2wasm's `externref` for `any` is transparent to the GC but has no runtime type assertion.

---

## Garbage Collection

### Static Hermes

Static Hermes uses its own native GC: **Hades** (default) and the older **GenGC** (documented in `doc/GenGC.md` and `doc/Hades.md`).

Hades is a tri-color concurrent mark-sweep collector with very low pause times, designed for mobile (React Native). GenGC is a generational collector that returns memory to the OS aggressively. Both are implemented in C++ as part of `lib/VM`.

Key properties:
- The GC manages all JS heap objects via `GCCell` base class.
- Type metadata (vtables with pointer offsets) enables marking without branches.
- Memory mode (`HV64` vs `HV32`) is configurable (`doc/blog/2025-11-06-hermes-memory-modes.md`): HV64 uses 64-bit NaN-boxing; HV32 uses 32-bit values with boxed doubles for overflow. On 64-bit platforms, HV32 reserves a 4 GB contiguous block.
- The GC heap is entirely separate from the C++ malloc heap.

When SH compiles to Wasm via Emscripten, the **C++ GC code is compiled into the Wasm binary** — the host Wasm engine just executes linear memory operations; it does not manage the JS heap via WasmGC.

### js2wasm

js2wasm uses the **host Wasm engine's WasmGC GC** — no custom GC code is compiled into the output binary.

- WasmGC structs and arrays are declared with explicit GC type definitions (`structTypeDef`, `arrayTypeDef` in `src/ir/types.ts`).
- The engine (V8, SpiderMonkey, wasmtime, etc.) traces references through those types automatically.
- There is no GC configuration knob — the user picks the engine and its GC.
- Sidecar WeakMaps in the JS host (`_wasmStructProps`, `_wasmStructDeletedKeys`, `_wasmFrozenObjs` — `src/runtime.ts:48–92`) participate in host GC through normal JS weak-reference semantics: when the Wasm struct is collected, the WeakMap entry is reclaimed.

**Key contrast:** SH's GC is full-featured, battle-tested on mobile, and tunable; but it adds several hundred KB to every binary and must be maintained. js2wasm's approach delegates all GC complexity to the engine, keeps binaries small, and benefits from ongoing engine GC improvements — at the cost of no control over GC behavior.

---

## Portability

### Static Hermes

Native compilation:
- Platform-specific: one binary per CPU architecture (arm64, x86_64, armhf).
- Designed for React Native: Android and iOS are primary targets.
- Benchmarked on Raspberry Pi 3 and Pi 5 (embedded/ARM).

Wasm compilation (via Emscripten):
- Single `.wasm` binary, runs in Node or browsers.
- **Requires a JS glue file** (`demo-wasm.js`) for Unicode and memory management helpers — not a pure Wasm module.
- Build requires Emscripten SDK + CMake + Ninja — non-trivial toolchain setup (`doc/Emscripten.md`).
- The resulting binary embeds the full Hermes runtime; typical output is 2–3 MB before compression.

### js2wasm

- Single `.wasm` file (WasmGC format).
- Runs in any environment with WasmGC support: browser (Chrome/Firefox/Safari with WasmGC), Node 22+, wasmtime, wasmer, WASM Component Model hosts.
- WASI mode produces a standalone Wasm binary with standard WASI imports only — runs in `wasmtime`, `wasmer`, or any WASI-compliant runtime.
- No toolchain dependency beyond Node.js for running the compiler (`package.json` / `npm test`); Binaryen is optional for `--optimize`.
- Output size scales with code: a simple `add(a, b)` compiles to a few hundred bytes; complex modules with many builtins are larger but not padded with a fixed runtime.

**Key contrast:** js2wasm's portability is its core strength. Static Hermes's Wasm support is functional but the Emscripten dependency and embedded runtime make it heavier and more complex to deploy.

---

## Dynamic JS Features (eval, Proxy, etc.)

### Static Hermes

The "Compiling Full-Featured JavaScript to Wasm" blog post (2024-12-23) addresses this directly:

> "Dynamic features like `eval()` and `new Function()` are supported through an integrated interpreter, activated only when required."

The design embeds the Hermes bytecode interpreter inside the compiled Wasm binary. When `eval()` is called at runtime, the embedded interpreter compiles and executes the source string. This is possible because the full Hermes runtime (including parser, IR, and bytecode generator) is statically linked into the binary.

`eval()` support: Yes, via embedded interpreter.
`new Function()`: Yes, same mechanism.
Proxy/Reflect: Unknown — not addressed in public `static_h` documentation.
`with` statement: Present in Hermes IR (untyped mode); status in typed mode is unknown.
Dynamic `import()`: Unknown.

The key trade-off: supporting `eval` costs binary size (the interpreter + compiler pipeline is embedded even if never called).

**Spec incompatibilities** (`doc/SpecIncompat.md`) are focused on loose-mode `arguments` aliasing and scoped function promotion edge cases — not on missing dynamic features.

### js2wasm

Dynamic features in js2wasm follow a different model:

- **`eval`:** In JS host mode, the primary path recompiles the eval string through js2wasm itself (producing a fresh Wasm module instantiated via the JS Wasm API — CSP-compatible, requiring only `wasm-unsafe-eval`). A fallback to `(0, eval)` is retained for sources js2wasm cannot yet compile (`src/runtime.ts:2068–2094`). In standalone/WASI mode, `eval` is absent.
- **`Proxy` / `Reflect`:** Not supported — blocked at compile time. Listed in the test262 skip filters in CLAUDE.md.
- **`with` statement:** Not supported — blocked at compile time.
- **Dynamic `import()`:** Not supported — blocked at compile time.
- **`Function` constructor:** Not supported (same category as `eval`; blocked in `hardened` mode).

The design philosophy is compile-away: "resolve JS semantics statically, zero runtime overhead" (CLAUDE.md feedback). Features that inherently require runtime reflection or a source interpreter are rejected or deferred rather than embedded.

**Key contrast:** Static Hermes's eval story is stronger — it embeds a working interpreter. js2wasm trades eval completeness for smaller binaries and standalone portability.

---

## JS Host Interop

### Static Hermes

Static Hermes targets React Native, where the JS host interop model is **JSI (JavaScript Interface)**. JSI is a C++ API that allows native code to call JS and JS to call native. The blog post "JSI Runtime Data APIs" (2025-06-09) describes new `setRuntimeData`/`getRuntimeData` methods for per-runtime C++ storage.

In Wasm mode (Emscripten), the interop with the Wasm host is mediated by the JS glue file Emscripten generates. The Hermes runtime communicates with the JS host for Unicode operations.

SH does not use WasmGC types or the `wasm:js-string` proposal — all values are represented in linear memory using NaN-boxing.

### js2wasm

js2wasm's JS host interop is mediated by a **generated imports helper** (`importsHelper` field of `CompileResult` — `src/index.ts:53`). The `src/runtime.ts` module is the runtime bridge, providing host functions that the Wasm module imports from the `env` module.

Key interop types (`src/index.ts:35–40`):
- Module: `"env"` (most host functions), `"wasm:js-string"` (JS string built-in), `"string_constants"` (string literal pool).
- Kind: `"func"` or `"global"`.

The `ImportIntent` union (`src/index.ts:3–33`) describes the semantic intent of each import: `string_method`, `builtin`, `extern_class`, `math`, `callback_maker`, `box`/`unbox`, etc. This allows the compiler to emit precise, purpose-specific imports rather than a generic FFI.

In standalone mode the `wasm:js-string` imports are replaced by native i16-array string helpers, and the `env` imports are replaced by WASI imports.

The WIT generator (`src/wit-generator.ts`) can produce a WIT interface for use with the WebAssembly Component Model — enabling typed interop with non-JS hosts.

**Key contrast:** SH's host interop is designed for C++ (JSI) and mobile; js2wasm's is designed for JS hosts with a gradual path to Component Model interop.

---

## Conformance / Compatibility

### Static Hermes

The December 2024 blog post highlights:

- "Full spec-compliant implementation of ES6 classes" (not including private fields at time of writing).
- "Full block scoping support for `let`, `const` and Temporal Dead Zone (TDZ)."
- Classes performance: ~2.3x faster instance construction than Babel strict transform.

Static Hermes runs the test262 suite via `utils/test_runner.py`. No specific pass/fail numbers are published in the public `static_h` documentation reviewed here.

`doc/SpecIncompat.md` documents known deliberate incompatibilities:
- Mapped arguments aliasing in loose mode is not implemented.
- Assignment to `arguments` is prohibited in loose mode.
- `var arguments` shadowing differs from spec.
- Some scoped function promotion corner cases differ.

All are characterized as low-priority "rare cases." No spec incompatibilities are listed for the typed mode beyond the "not yet supported" features in `doc/TypedLanguage.md`.

### js2wasm

Test262 conformance is the primary quality gate. Current state: **25,830 / 43,168 pass (59.8%)**, 1,858 compile errors, 1,339 skipped (CLAUDE.md, plan/goals/goal-graph.md line 7).

Skip filters include: `eval`, `with`, `Proxy`, `SharedArrayBuffer`, `Temporal`, `WeakRef`, `FinalizationRegistry`, and dynamic `import()`. Each skip category has a tracking issue (CLAUDE.md, "Test262" section).

The conformance goal graph (`plan/goals/goal-graph.md`) shows active work on:
- **property-model** (~5,000 failing — descriptors, prototype)
- **class-system** (~1,015 failing — computed props/accessors)
- **error-model** (~2,799 failing — assert.throws not thrown)
- **core-semantics** (~660 failing — for-of destructuring, valueOf/toString)

Target: 90%+ pass rate at `spec-completeness` goal; 100% at `full-conformance`.

**Key contrast:** js2wasm has a quantified conformance posture (public test262 numbers) and tracks every known gap with issues. Static Hermes's conformance posture is less quantified in public documentation.

---

## Performance Expectations

### Static Hermes

Performance data from the December 2024 and July 2025 blog posts:

**Untyped JS (Octane benchmarks vs original Hermes main branch):**
- 1.09–1.72x faster with interpreter alone
- 1.15–2.97x faster with JIT (selected benchmarks up to 7.9x for InterpDispatch2 with good type inference)

**vs QuickJS (July 2025, `hv32+jit`):**
- Competitive or faster on most Octane benchmarks

**Classes (vs Babel transforms):**
- ~2.3x faster instance construction than Babel strict mode
- ~4.5x faster super invocations vs Babel strict mode

**Typed JS performance** is documented as the primary goal but specific typed-mode vs untyped-mode benchmark numbers are not published in the public blog posts reviewed.

The native compilation path eliminates the interpreter overhead entirely. For purely typed code, SH can emit C structs with direct field offsets (no hash table lookups), which is comparable to hand-written C performance.

### js2wasm

js2wasm does not publish standalone benchmark numbers (no equivalent of the Static Hermes blog posts). Performance expectations from architecture:

- **Typed numeric code:** When TS types resolve to `f64` or `i32`, the compiler emits direct WasmGC numeric operations. The WASM loop for a typed `sum()` function would be identical to what Static Hermes emits (as shown in the SH blog: `f64.add`, `f64.lt`, `br_if` — standard tight loop).
- **Object-heavy code:** WasmGC structs provide O(1) field access (direct struct.get by field index), comparable to SH's C struct field access. Both avoid hash table lookups for typed objects.
- **Dynamic (untyped) code:** Routes through `externref` + host imports. Each untyped property access crosses the Wasm/JS boundary — significant overhead vs SH's embedded interpreter (which handles untyped code in native/bytecode without boundary crossing).
- **`wasm-opt` pass:** The optional Binaryen optimizer (`src/optimize.ts`) can improve output further.
- **JIT:** js2wasm has no JIT — it is pure AOT. SH adds a baseline JIT for hot bytecode functions.

The **performance ceiling** for typed numeric code is similar (both emit f64/i32 operations without boxing); the **gap** is in dynamic/untyped code where SH's embedded runtime handles it natively and js2wasm crosses the host boundary.

---

## What js2wasm Can Learn from Static Hermes

### 1. Typed arrays with bounds checking as a first-class type

Static Hermes's `doc/TypedLanguage.md` defines typed arrays as "soundly typed… bounds-checked and throws on out-of-bounds access" — a separate type from untyped JS arrays. js2wasm has `TypedArray` / `ArrayBuffer` support but the equivalent of "typed arrays that reject holes" is not a distinct compilation path. This could enable more aggressive WasmGC array optimizations.

### 2. Method overloading as a compiler feature

SH's `@Hermes.overload` decoration resolves overloads at compile time, with no dispatch cost. js2wasm does not implement method overloading. For performance-critical libraries, compile-time overload resolution would eliminate runtime type dispatch overhead.

### 3. `@Hermes.final` method annotation

SH marks methods `final` to prevent virtual dispatch. js2wasm currently emits all method calls through `call_ref` (indirect) even when the callee is statically known. A `final` annotation (or equivalent static devirtualization pass) could replace many `call_ref` with `call` (direct), which is both cheaper and allows the engine to inline.

### 4. Embedded interpreter for `eval` completeness

SH's eval story (embed a bytecode interpreter) gives full eval support at the cost of binary size. js2wasm's primary eval path (recompile to Wasm) is clever but requires the full js2wasm compiler to be present at runtime. A lightweight interpreter fallback — even limited to the most common eval patterns — would close the conformance gap for test262 eval tests without bundling the full compiler.

### 5. Explicit typed-vs-untyped function boundary

SH explicitly separates typed and untyped functions: "If a function has NO type annotations, it is considered to be an 'untyped' function, and calls to it will not be typechecked." This clean boundary means the optimizer knows exactly which functions can be specialized and which must handle arbitrary JS. js2wasm has a similar but implicit distinction (resolved type vs `externref` fallback). Making this boundary explicit in the IR could improve optimization decisions.

### 6. `c_ptr` / linear memory FFI for performance-sensitive paths

SH's `c_ptr` type enables direct C memory access for FFI-heavy code. js2wasm has a `linear` target mode but it is not the default and does not expose a typed raw-pointer mechanism. For embed-in-C use cases, a typed pointer primitive would open a performance tier currently unavailable.

### 7. Configurable TDZ (Temporal Dead Zone) elimination

SH documents "an option to disable TDZ for increased performance." js2wasm always emits TDZ checks. A `--no-tdz` flag for known-safe code (or a shape inference pass that proves no TDZ can occur) would improve performance for strict-mode code that never touches uninitialized bindings.

---

## Conclusion

Static Hermes and js2wasm are both AOT compilers that transform typed JS/TS to efficient executable code — but they diverge sharply in their target and philosophy:

**Static Hermes** optimizes for **native performance on mobile devices** (React Native). It uses Clang/LLVM as its native backend, embeds a complete runtime including GC and interpreter, and achieves near-C performance for typed code. Its Wasm story is a secondary target via Emscripten — functional, but heavyweight (2–3 MB binaries with full runtime embedded, JS glue required). The typed language is still marked experimental and incomplete (`async`, generators not yet supported).

**js2wasm** optimizes for **WebAssembly portability and host integration**. It outputs lean WasmGC binaries that delegate GC to the host engine, scale in size with code content, and run anywhere WasmGC is supported — including browsers, WASI runtimes, and Component Model hosts. Its conformance story (test262, 59.8% pass rate, tracking all gaps) is more quantified. Its weakness is dynamic features: eval requires the host or compiler be present, and Proxy/with/dynamic import are not supported.

The two projects explore different points in the same design space. SH's approach (language → C → native/Wasm via LLVM) gives a mature backend and full eval support at the cost of toolchain complexity and binary size. js2wasm's approach (language → WasmGC directly) gives portability, small binaries, and engine GC reuse at the cost of no JIT, no embedded interpreter, and some host-boundary overhead for dynamic code.

For **React Native / mobile**: Static Hermes is better suited — native performance, full eval, battle-tested GC.

For **browser/edge/WASI deployment**: js2wasm is better suited — no toolchain, lean binaries, host GC, Component Model path.

The most actionable insights for js2wasm from Static Hermes (see "What js2wasm can learn" above): bounds-checked typed array specialization, final method annotations for devirtualization, compile-time overload resolution, and a configurable TDZ elimination pass.

---

## Sources

**Static Hermes:**
- Repository: `https://github.com/facebook/hermes/tree/static_h`
- Blog: "Compiling Full-Featured JavaScript to Wasm" (2024-12-23) — `doc/blog/2024-12-23-compiling-javascript-to-wasm.md`
- Blog: "Static Hermes Update, December 2024" (2024-12-19) — `doc/blog/2024-12-19-static-hermes-update-dec-2024.md`
- Blog: "Hermes Compilation and Runtime Modes" (2025-11-02) — `doc/blog/2025-11-02-hermes-compilation-runtime-modes.md`
- Blog: "Hermes Memory Modes" (2025-11-06) — `doc/blog/2025-11-06-hermes-memory-modes.md`
- Blog: "Static_h Branch Performance: June 2025 Update" (2025-07-15) — `doc/blog/2025-07-15-static-h-performance-june-2025.md`
- Blog: "Octane Benchmark Results: Hermes JIT Progress" (2024-11-09) — `doc/blog/2024-11-09-octane-benchmark-jit-progress.md`
- `doc/TypedLanguage.md` — type system specification
- `doc/IR.md` — SSA IR documentation
- `doc/Design.md` — compilation pipeline design
- `doc/GenGC.md` — generational GC documentation
- `doc/Emscripten.md` — Wasm compilation guide
- `doc/SpecIncompat.md` — known spec incompatibilities
- `doc/HighLevelOptimizations.md` — optimization strategy
- `doc/plans/ir-type/ir-type-system-v2-design.md` — IR type system v2 design
- `CLAUDE.md` (Hermes) — build configuration and project overview

**js2wasm:**
- `/workspace/CLAUDE.md` — architecture overview, dual-mode design, key patterns
- `/workspace/src/index.ts` — `CompileOptions`, `ImportIntent`, `CompileResult` types
- `/workspace/src/codegen/index.ts` — compilation pipeline, WasmGC codegen entry point
- `/workspace/src/runtime.ts` — JS host runtime, sidecar WeakMaps, eval shim
- `/workspace/plan/goals/goal-graph.md` — conformance goals, test262 pass rate, active issues
