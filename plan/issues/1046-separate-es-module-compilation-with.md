---
id: 1046
title: "Separate ES-module compilation with consumer-driven import/export type specialization"
status: ready
created: 2026-04-11
updated: 2026-07-17
priority: medium
feasibility: hard
reasoning_effort: max
goal: compiler-architecture
sprint: current
horizon: xl
parent: null
required_by: [1058]
fable_role: spec
model: opus
assignee:
note: "Verified 2026-05-21: preprocessImports 23→89, compileProject 216→248, resolveAllImports 204→360, compileMultiSource 406→534. 2026-07-17: architecture spec + slice decomposition added (Fable); slice 1 scoped Opus-implementable."
---

# #1046 — Separate ES-module compilation with consumer-driven type specialization

## Problem

The compiler today has two multi-file code paths, both of which are **whole-program**:

1. **`compile(source, options)`** — single-file. Unresolved imports fall through `preprocessImports` (`src/import-resolver.ts:89`, verified 2026-05-21 — was L23) to `declare const X: any` stubs, losing all cross-module type information.
2. **`compileProject(entryFile, options)`** (`src/index.ts:248`, verified 2026-05-21 — was L216) — builds a `ModuleResolver`, walks the entire import closure via `resolveAllImports` (`src/resolve.ts:360`, verified — was L204), inlines every reachable file into **one shared `ts.Program`** in `compileMultiSource` (`src/compiler.ts:534`, verified — was L406), and emits **one** Wasm binary containing everything.

Whole-program works for a single app but is the wrong distribution model for publishing and consuming compiled `.js`/`.ts` ES modules independently. Two concrete costs:

- **No shareable artifacts.** A library author cannot ship a precompiled `.wasm` for their module; every consumer must recompile the entire transitive closure from source. No equivalent of an npm tarball with a `.wasm` next to the `.d.ts`.
- **Type specialization happens only implicitly.** Because everything lives in one `ts.Program`, cross-module types are trivially shared. But there is no mechanism to specialize an exported function's parameter or return type at a specific consumer's import site — the function is codegen'd once with whatever the library author wrote (often `unknown` / `any` / generic), and the consumer gets the externref-y worst case even when their usage pins concrete types.

## Goal

Support **separate compilation**: each `.js`/`.ts` ES module is compiled to its own Wasm artifact (or artifact family) that can be consumed by another compiled module at link time, with **optional consumer-driven specialization** of imported symbols based on the consumer's concrete usage.

Conceptual analogues: Rust generic monomorphization, C++ template instantiation, OCaml functor specialization, GHC `SPECIALIZE` pragma.

## Motivating examples

### Example 1 — distributable library

```
// producer: @acme/math/add.ts
export function add(a: number, b: number): number { return a + b; }
```

Compiled once by the library author:

```
@acme/math/add.wasm      // reusable artifact
@acme/math/add.d.ts      // existing
@acme/math/add.widl      // NEW: module interface descriptor (types + export shapes)
```

A consumer can then:

```
// consumer: app.ts
import { add } from "@acme/math/add";
console.log(add(1, 2));
```

…and the compiler links against `add.wasm` via a reference-types import instead of inlining the source.

### Example 2 — consumer-driven specialization

```
// producer: @acme/collections/map.ts
export function map<T, U>(xs: T[], f: (x: T) => U): U[] { ... }
```

One consumer uses it monomorphically with `number → number`:

```
// consumer: hot-path.ts
import { map } from "@acme/collections/map";
const doubled = map([1, 2, 3], (x) => x * 2);
```

At the consumer's import site, the compiler should be able to:

1. Inspect the consumer's usage, pin `T=number, U=number`
2. Emit (or request from a specialization cache) a specialized variant of `map` that uses `f64` storage and `f64`-typed closures instead of externref
3. Link the consumer against the specialized variant

If another consumer uses `map<string, number>` (word count), they get a different specialization. If the specialization descriptor isn't available (producer wasn't recompiled for this consumer), fall back to the externref-typed variant.

## Non-goals

- Replacing `compileProject` — whole-program compilation stays as the default and fastest path for apps
- Dynamic `import()` — separate out
- Cross-language linking (linking against Wasm produced by other compilers) — separate out
- Shared-nothing Wasm components (Component Model / WIT) — related but distinct
- Incremental recompilation — a consequence of this work but not the primary goal

## Design sketch

### Compilation unit boundary

- **One module = one compilation unit.** A `.ts` or `.js` file that TypeScript considers a module (has an `import` or `export`) becomes one compilation unit. Script files (no imports/exports) continue to compile as today.
- **Each unit emits**: `.wasm` (the module) + `.widl` (interface descriptor, see below) + existing `.d.ts`.

### Interface descriptor (`.widl`)

A machine-readable description of the module's public surface that sits alongside the Wasm artifact. Fields:

- For each export: name, kind (function, class, const, type), Wasm type (or "generic" + TS type source), specialization keys (which TS type parameters or union arms are specialization points)
- For each import: name, module specifier, Wasm type expected
- Per-export specialization table: map from concrete type instantiation → function index within the wasm artifact (or a follow-up pointer if lazy)

Rendered format: JSON. `.widl` is auto-generated, reproducible, and typically committed alongside the `.wasm` for published libraries.

### Linking model

At consumer compile time:

1. Consumer's imports are resolved to producer modules (existing `ModuleResolver`).
2. For each imported symbol:
   - If the producer has a `.wasm` + `.widl` available, and a matching specialization exists → emit a `(import "producer" "symbol_specN" (func ...))` and bind at instantiate time.
   - If the producer has `.wasm` + `.widl` but **no** matching specialization → either (a) emit a new specialization by re-invoking the producer compiler with the consumer's pin, or (b) fall back to the externref-typed variant.
   - If the producer has **no** compiled artifact → fall back to the existing whole-program path: inline the producer source into the consumer's `ts.Program`.
3. Emit the consumer's Wasm with the resolved import table.

At runtime, the host (`buildImports` in `src/runtime.ts`) wires together the separate Wasm instances. Reference types flow across boundaries as externrefs or typed struct refs when the engine supports them.

### Specialization protocol

A specialization request is a tuple: `(producerModulePath, exportName, typePinning)` where `typePinning` is a canonical serialization of the TS type arguments (concrete primitives, struct shapes, union narrowings). The producer compiler, given a pin, emits a specialized function with the name `${exportName}_spec_${hash(pinning)}` and records it in the producer's `.widl`.

Two modes:

- **Ahead-of-time**: the producer ships with N precomputed specializations for the common cases. The `.wasm` file contains all N functions under different table slots.
- **Just-in-time (consumer-triggered)**: when a consumer requests a pin that doesn't exist, the consumer's build invokes the producer compiler on the producer source, emits the new specialization, and writes an updated `.wasm`/`.widl` pair in a build-local cache (not into node_modules).

### Dataflow through existing code

- **`ModuleResolver.resolve`** (`src/resolve.ts:130`) gains a companion `resolveArtifact(specifier, containingFile): { wasm, widl } | null` that looks for `.wasm`/`.widl` next to the `.ts` source. When found, the producer source is not read.
- **`compileMultiSource`** (`src/compiler.ts:406`) gains a third mode alongside whole-program: "compile THIS file as a unit, emit imports for resolved-but-artifact-backed modules, emit whole-program inlining for source-backed modules." Today both are inlined.
- **Codegen** (`src/codegen/index.ts`) learns how to emit cross-module function imports with non-trivial ref types (not just externref).
- **`runtime.ts`** `buildImports` learns how to link Wasm-to-Wasm imports in addition to host-to-Wasm.

## Acceptance criteria (milestone 1 — static ahead-of-time only)

- [ ] `.widl` format specified, versioned, and emitted by `compileProject` + a new `compileModule(entry, options)` single-module entry
- [ ] A producer module with a monomorphic `add(a: number, b: number): number` can be compiled standalone to `.wasm` + `.widl`
- [ ] A consumer module that imports `add` can be compiled against the producer's `.wasm` + `.widl` and emits a cross-module import (not inlined source)
- [ ] At runtime, the two Wasm instances link and the consumer can call `add` successfully
- [ ] Existing `compileProject` whole-program path continues to work unchanged for all current tests

## Acceptance criteria (milestone 2 — type specialization)

- [ ] Specialization protocol documented: pin format, hash canonicalization, cache layout
- [ ] A generic `map<T, U>` producer supports ahead-of-time specializations for `number→number` and `number→string`
- [ ] A consumer using `map([1,2,3], x => x * 2)` binds to the `number→number` specialization, not the generic externref path
- [ ] Performance win vs. the externref fallback is measurable on a tight-loop microbenchmark

## Acceptance criteria (milestone 3 — just-in-time specialization)

- [ ] A consumer requesting an unprecomputed pin triggers a producer recompile in the build-local cache
- [ ] Cache keyed on producer source hash + pin; stable across clean builds

## Notes

- **Engine support for typed refs across instances**: Wasm reference types flow between instances only when both instances agree on the struct type. The WasmGC `type` section is per-module, so cross-instance typed refs require the host to share `ref $X` definitions at link time. Initial implementation can fall back to externref at boundaries and specialize only the function bodies; the type-sharing optimization is a follow-up.
- **Overlap with Wasm Component Model / WIT**: the `.widl` proposal is intentionally simpler than WIT and does not attempt to be a host-independent component interface. Bridge later if useful.
- **Not a tree-shaker**: orthogonal to `src/treeshake.ts`. Tree-shaking removes unused exports from the producer; specialization narrows the types of used exports.

## Leverage TypeScript declarations

When a producer module ships without detailed types in its own source (a plain `.js` file with generic `any` parameters, or a `.ts` file with broad `unknown`/`any` signatures), **pick up type information from the ecosystem's declaration files**:

1. **Bundled declarations** — many npm packages ship a `types` or `typings` field in `package.json` pointing at an `index.d.ts` (e.g. `axios`, `prettier`, `react`). `ts.resolveModuleName` already surfaces these via `resolvedModule.extension === ".d.ts"` and the `packageId` field. `ModuleResolver.resolve` (`src/resolve.ts:130`) should be extended to return BOTH the `.js` implementation file AND the associated `.d.ts` when present, so codegen can use the `.js` for bodies and the `.d.ts` for signatures.
2. **Sidecar `@types/*` packages** — when a package ships no types, TypeScript conventionally looks in `node_modules/@types/<pkg>/index.d.ts` (e.g. `@types/lodash` for `lodash`). `ts.resolveModuleName` with `typeRoots` already finds these today when `@types/<pkg>` is installed. The resolver should prefer declarations from `@types/*` if the package has no bundled types.
3. **TSDoc and type-only refinement** — even a generic TS source (`function map<T, U>(...)`) gains value from the consumer's binding site. Use the consumer's concrete call-site types (via `ts.TypeChecker.getTypeAtLocation`) to drive the specialization key — this is the "consumer-driven" part of the specialization protocol above.

Concretely, the `.widl` interface descriptor should record:

- The producer's declared signature (from `.ts` source, bundled `.d.ts`, or `@types/*`, in that order of priority)
- Whether the signature contains generics, unions, or `any`/`unknown` that are candidates for specialization
- The source file the signature came from (for regeneration)

This means specialization is not limited to packages we have source for: as long as we have **types** (from a declaration file) and the consumer pins concrete instantiations at use sites, we can emit a specialized import stub even for precompiled or externally-provided producers.

### Acceptance criteria addendum (milestone 1)

- [ ] `ModuleResolver.resolve` returns both the implementation file and any co-located or `@types/*`-sourced `.d.ts`
- [ ] `compileMultiSource` feeds the `.d.ts` files into the `ts.Program` alongside the `.js`/`.ts` sources so the checker sees precise signatures
- [ ] Stress tests (#1031-#1034) automatically pick up types — `lodash` via `@types/lodash`, `axios` via its bundled `index.d.ts`, `prettier` via its bundled types, `react` via `@types/react`

## Related

- Supersedes: **#1041** (closed — framing error; mislabeled as "no module graph")
- Dependency-adjacent: **#1044** (Node host imports), **#1045** (DOM host imports) — host imports are the "no specialization possible" edge of the same spectrum
- Architecture doc: `plan/design/architecture/npm-stress-compiler-gaps.md` cross-cutting gap #1 (corrected)

## Implementation Plan (added 2026-05-21)

### Strategic recommendation

Ship in three milestones (as outlined). Milestone 1 is independent and unblocks the rest. Land #904 (link-time specialization) IN PARALLEL — they share infrastructure.

### Milestone 1 — single-module compile + `.widl` emit

#### Entry points

- New file `src/widl.ts` — `.widl` schema, serialiser, parser
- New `compileModule(entryFile, opts)` exported from `src/index.ts` — variant of `compileProject` that compiles ONE file, treats every import as an extern import
- `src/resolve.ts:360` — add `resolveArtifact(specifier, containingFile)` next to `resolveAllImports`
- `src/codegen/index.ts` — emit imports with concrete struct types (not just externref) when the producer signature is monomorphic

#### .widl JSON schema (v1)

```json
{
  "schemaVersion": 1,
  "moduleId": "@acme/math/add",
  "sourceHash": "sha256:...",
  "exports": {
    "add": {
      "kind": "function",
      "params": [
        { "name": "a", "tsType": "number", "wasmType": "f64" },
        { "name": "b", "tsType": "number", "wasmType": "f64" }
      ],
      "returns": { "tsType": "number", "wasmType": "f64" },
      "wasmExportName": "add",
      "specializations": []
    }
  },
  "imports": []
}
```

#### Algorithm (Milestone 1)

1. Parse the entry module only into a `ts.Program` (do not walk the import closure).
2. For each `import` statement, populate `ts.SymbolFlags` from the resolved `.d.ts` (existing TS module resolution).
3. For each unresolved import, emit a placeholder `(import "<specifier>" "<name>" (func ...))` whose type comes from the `.d.ts` signature.
4. For each export, emit it as a wasm `(export ...)` with the function's concrete wasm signature.
5. Emit `<module>.widl` alongside `<module>.wasm`.
6. At runtime, `buildImports` in `src/runtime.ts` looks up each `(import "X" "Y" ...)` against a registry of pre-instantiated producer modules.

#### Wasm output (per import)

For `import { add } from "./add"` where `.widl` says `add: (f64,f64) -> f64`:

```wasm
(import "./add" "add" (func $add (param f64 f64) (result f64)))
```

NOT `(import "./add" "add" (func (param externref externref) (result externref)))`. Concrete types eliminate boxing across module boundaries.

#### Edge cases

- **Producer signature uses union / any** → emit two import shapes (one specialized externref, one if specialization is requested). Until specialization lands, fall back to externref.
- **Cross-module class instances** → the consumer references the producer's `$ClassFoo` struct. Wasm doesn't share named types across instances. Workaround: emit a thin trampoline that does `extern.convert_any` / `ref.cast` at the boundary.
- **Circular imports** → must detect and break cycles; emit a runtime-init dependency edge in the host loader.
- **Default export** → maps to wasm export named `default`.
- **Re-exports** (`export * from "./other"`) → walk to find the originating module; emit a re-export at the wasm level.
- **Side effects** (top-level statements) → emit as a `(start ...)` function in the wasm module.

### Milestone 2 — type specialization (ahead-of-time)

#### Specialization key

```
key = sha256(producerHash + ":" + exportName + ":" + canonicalize(typePinning))
canonicalize({ T: "number", U: "string" }) = '{"T":"number","U":"string"}'  // sorted keys
```

#### Algorithm

1. Consumer walks every imported symbol's call site, collects a set of `typePinning` tuples per import.
2. For each pinning, look up `<producer>.widl > exports.<name>.specializations[key]`.
3. If present → emit `(import "producer" "<name>_spec_<key>" (func ...))`.
4. If absent and Milestone 3 is on → trigger JIT specialization (next milestone).
5. If absent and Milestone 3 is off → fall back to the generic externref import.

#### Producer specialization generation

- `compileModule(entry, { specializations: [{ exportName, typePinning }, ...] })` produces additional `_spec_<key>` exports inside the same wasm module.
- Each specialization runs codegen with `ctx.typeParams = pinning` so the existing type-resolver sees concrete types and emits f64/i32 instead of externref.

### Milestone 3 — JIT specialization

- Consumer build invokes producer `compileModule(... specializations:[<new pin>])`
- New artifact `.wasm`/`.widl` written to a build-local cache: `node_modules/.cache/js2wasm-spec/<producerHash>/<key>.wasm`
- Cache eviction by source-hash mismatch on producer re-compile.

### Test plan

- Add `tests/issue-1046-separate-compile.test.ts` covering:
  - Producer compiles standalone → emits `.wasm` + `.widl`
  - Consumer compiles with `.widl` available → emits cross-module imports (verify by reading the wasm import table)
  - Two-instance link at runtime → calls succeed
  - Mismatched `.widl` schemaVersion → graceful fallback
  - Circular imports → detected, broken via runtime init order

### Dependencies

- **Hard**: type-flow analysis sufficient to identify monomorphic export signatures (subset of #743 — can ship without full whole-program if signatures are already concrete).
- **Hard**: #904 (link-time specialization) — shares infrastructure; coordinate on which lands first.
- **Soft**: WIT generator at `src/wit-generator.ts` is a similar artifact-emitter — share serialiser scaffolding.

### Files touched

- new `src/widl.ts` (schema + serializer)
- `src/resolve.ts` (resolveArtifact)
- `src/compiler.ts` (compileMultiSource third mode)
- `src/codegen/index.ts` (concrete-type imports)
- `src/runtime.ts` (multi-instance buildImports)
- new `src/index.ts` export `compileModule`
- new `tests/issue-1046-separate-compile.test.ts`

## Architecture Spec — slice decomposition (Fable, 2026-07-17)

Author: Fable architect (spec-only). Implementer: Opus. This section
**supersedes** the 2026-05-21 milestone plan above for _sequencing_ purposes:
the milestones are the vision; the slices below are the executable order, and
**Slice 1 is scoped to be a single self-contained, Opus-implementable PR**.
Line numbers are against `origin/main` at spec time; re-grep before editing.

### Where this work lives on the two axes (read first)

Per `docs/architecture/codegen-axes.md`, separate compilation is a **driver /
front-end concern, NOT a backend-lowering concern**:

- The compilation-unit boundary, module-graph walk, `.widl` emit, and
  import/export wiring live in the **driver layer** (`src/index.ts`,
  `src/compiler.ts`, `src/resolve.ts`, new `src/widl.ts`) — above BOTH the
  WasmGC/linear backend axis and the direct/IR front-end axis.
- A cross-module import is emitted the **same way host imports already are**
  (`addImport` / the `ImportDescriptor` path) — it is backend-agnostic. Do NOT
  add module-linking knowledge to `src/codegen/`'s lowering or to `src/ir/lower.ts`.
- **IR-forward framing**: model a cross-module call as a typed extern call with a
  resolved concrete signature. Today the direct path emits it via `addImport` +
  a normal `call funcIdx`; when IR owns the callee kind this becomes an
  `IrExternCall` with the `.widl`-resolved signature. Slice 1 must therefore NOT
  bake WasmGC struct assumptions into the boundary — restricting Slice 1 to
  scalar/externref boundary types (below) keeps it representation-neutral.

### The one scoping decision that makes Slice 1 real: scalar/externref-only boundaries

The blocker in the vision is **WasmGC type-section sharing**: `ref $ClassFoo` is
a per-module type index; two separately compiled instances cannot pass a typed
struct ref without the host sharing rec-groups (see the issue's "Engine support"
note, and the Slice 3 discussion below). **Slice 1 sidesteps this entirely** by
restricting cross-module boundary types to exactly what already crosses the
JS-host boundary today:

| TS type at boundary                            | Wasm boundary type                | Status in Slice 1                                             |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| `number`                                       | `f64`                             | supported                                                     |
| `boolean`                                      | `i32`                             | supported                                                     |
| `bigint`                                       | `i64`                             | supported                                                     |
| `string`                                       | `externref` (existing string ABI) | supported                                                     |
| `void`/`undefined`                             | (no result / externref)           | supported                                                     |
| object / class / array / typed union / generic | —                                 | **rejected in Slice 1** → fall back to whole-program inlining |

An import whose producer signature is entirely scalar/externref is
**artifact-linkable**; anything else falls back to the existing whole-program
inline path (`compileProject`). This is a safe, additive gate: no current
program regresses, because artifact-linking is only attempted when a `.widl`
exists AND all boundary types are in the supported set.

### Slice 1 — single-module compile + `.widl` v1 + scalar cross-module linking (THE Opus PR)

Deliverable: a producer with a monomorphic scalar signature compiles to
`.wasm` + `.widl`; a consumer imports it, emits a real cross-module import
(verified in the wasm import table, not inlined), and the two instances link and
call at runtime. No specialization, no generics, no struct boundaries.

#### 1a. `.widl` schema + serializer — new `src/widl.ts`

- Define `WidlModule` (schema v1) and `serializeWidl(ast) / parseWidl(json)`.
  Reuse the WIT generator (`src/wit-generator.ts`) as the artifact-emitter
  template — it already walks a `TypedAST` and renders per-export/per-import
  records (`WitFunc`/`WitImportFunc` at `wit-generator.ts:42/48`,
  `generateWit(ast, opts)` at `:58`). `.widl` is the JSON sibling of that WAT-ish
  interface. Share the export-signature extraction (`ExportSignature` already
  exists in `src/ir/types.ts`, surfaced on `CompileResult.exportSignatures`).
- v1 JSON schema (use the shape in the 2026-05-21 plan above, with these
  concretizations): each export records `kind`, `params[]`
  (`{name, tsType, wasmType}`), `returns`, `wasmExportName`, and
  `linkable: boolean` (true iff all param/return `wasmType`s are in the
  scalar/externref set), `specializations: []` (empty in Slice 1). Top-level:
  `schemaVersion: 1`, `moduleId`, `sourceHash` (sha256 of producer source, for
  Slice 5 cache-keying — computed now, unused now).
- Emit `<module>.widl` next to `<module>.wasm`. Gate emission on a new option
  `options.widl === true` (mirrors the existing `options.wit`) so the default
  path is byte-identical.

#### 1b. `compileModule(entry, opts)` — new export in `src/index.ts`

- A variant of `compileProject` (`src/index.ts:705`) that compiles ONLY the
  entry module and does NOT walk/inline the import closure. Concretely:
  - Build the resolver as `compileProject` does (`new ModuleResolver`,
    `src/index.ts:714`), but instead of `resolveAllImports` (which recursively
    inlines — `src/resolve.ts:360`), resolve each direct import to decide
    per-import: **artifact-backed** (a `.widl` exists next to the resolved
    source → link) vs **source-backed** (no `.widl` → inline, Slice-1 fallback).
  - Feed `{ entry-source only + inlined source-backed deps }` into
    `compileMultiSource` (`src/compiler.ts:1406`), and pass the artifact-backed
    imports through a NEW options field so codegen emits them as cross-module
    imports instead of expecting inlined definitions.
- Keep `compileProject` (whole-program) untouched and default — Slice 1 is purely
  additive (non-goal: replacing whole-program).

#### 1c. `resolveArtifact` — `src/resolve.ts`

- Add `resolveArtifact(specifier, containingFile): { wasmPath, widlPath, widl:
WidlModule } | null` beside `resolveAllImports`. It runs the existing
  `ts.resolveModuleName` (already used in `ModuleResolver.resolve` at
  `resolve.ts:131/145`) to find the resolved source path, then checks for a
  sibling `.widl` (same basename). If present and `parseWidl` succeeds and
  `schemaVersion === 1`, return it; else `null` (→ source-backed fallback).
- Schema-version mismatch or parse failure → `null` (graceful fallback, an
  acceptance criterion of the test plan).

#### 1d. Cross-module import emission — `src/compiler.ts` + `src/codegen/index.ts`

- `compileMultiSource` gains a third mode input: a map
  `artifactImports: Map<specifier, WidlModule>`. For each imported symbol whose
  producer export is `linkable`, DO NOT expect an inlined `ts` definition;
  instead register a Wasm import
  `(import "<specifier>" "<exportName>" (func (param <scalar…>) (result
<scalar>)))` via the existing import machinery (same `addImport` path the WASI
  syscalls and host imports use — grep `addImport` in `src/codegen/`), and bind
  the TS symbol to that import's funcIdx so call sites lower to `call funcIdx`.
- Extend `ImportDescriptor` (`src/index.ts:96`) `module` union to allow an
  arbitrary module-specifier string (today it's `"env" | "wasm:js-string" |
"string_constants"`), plus a new `intent` arm `"cross-module"`, so
  `buildImports` can distinguish a Wasm-to-Wasm import from a host import.
- The consumer's own exports are emitted exactly as today (normal wasm exports)
  — no producer-side change is needed beyond the `.widl` emit; the producer is a
  plain `compileModule` output.

#### 1e. Host multi-instance linker — `src/runtime.ts`

- `buildImports` (`src/runtime.ts:14195`) today wires host→wasm imports from an
  `ImportDescriptor[]`. Add: given a registry of already-instantiated producer
  instances keyed by module specifier, satisfy each `"cross-module"`
  `ImportDescriptor` by looking up `producerInstance.exports[exportName]` and
  passing it as the import function. Instantiation order = reverse-topological
  over the import graph (producers before consumers); Slice 1 supports acyclic
  graphs only (circular → documented error, full handling deferred).
- Add a small `linkModules(modules: {specifier, result, }[])` host helper (new,
  in `src/runtime.ts` or a sibling) that instantiates in dependency order and
  returns the entry instance — the test harness and future CLI use it.

#### 1f. Tests — new `tests/issue-1046-separate-compile.test.ts`

- Producer `add(a: number, b: number): number` → `compileModule` emits `.wasm`
  - a `.widl` whose `exports.add` is `linkable`, params `[f64,f64]`, returns
    `f64`.
- Consumer `import { add } from "./add"; export function run(): number { return
add(1,2); }` compiled with the producer `.widl` available → assert the wasm
  **import table** contains `(import "./add" "add" (func …))` and that `add`'s
  body is NOT inlined (no second `add` function defined).
- Two-instance link via `linkModules` → `run()` returns `3`.
- Mismatched `.widl` `schemaVersion` → `resolveArtifact` returns null → consumer
  falls back to inlining → still compiles and returns `3` (graceful fallback).
- A consumer importing a NON-scalar export (e.g. `makePoint(): {x:number}`) →
  `linkable:false` → falls back to whole-program inline (asserts the current
  behavior is preserved, no regression).

#### Slice 1 explicit non-scope (do NOT attempt in the Opus PR)

- No generics / type parameters (rejected → inline fallback).
- No cross-module struct/class/array boundaries (scalar/externref only).
- No specialization tables (`specializations: []`).
- No JIT / cache. No circular-import resolution beyond a clear error.
- No `.d.ts` ecosystem pickup (that is Slice 2).

### Slice 2 — declaration-file pickup (independent, parallelizable)

Implements the "Leverage TypeScript declarations" milestone-1 addendum:
`ModuleResolver.resolve` (`resolve.ts:131`) returns BOTH the implementation file
and any co-located or `@types/*`-sourced `.d.ts`; `compileMultiSource` feeds the
`.d.ts` into the `ts.Program` so the checker sees precise signatures even for
`.js` producers. Independent of Slice 1's linking — sharpens the types that
Slice 1's `.widl` records. Can land before or after Slice 1.

### Slice 3 — WasmGC type-section sharing at boundaries (HARD, deferred)

Lifts the scalar-only restriction: allow `ref $ClassFoo` / vec / typed-union refs
across module instances. Requires either (a) host-shared rec-groups (the engine
canonicalizes identical rec-groups across instances — depend on WasmGC
`isorecursive` type equality) or (b) boundary trampolines that
`extern.convert_any` + `ref.cast` at the seam (the issue's "thin trampoline"
note). This is the true architectural hard part and should be its own multi-PR
effort; Slice 1 is explicitly designed to not need it.

### Slice 4 — ahead-of-time type specialization (BLOCKED on #773/#743)

This is milestone 2. **Do not build a parallel specializer.** Cross-module
specialization is the **monomorphization engine (#773) applied at a module
boundary**, driven by the whole-program type-flow analysis (#743) that
identifies monomorphic signatures:

- #743 (whole-program type flow) supplies the "is this export's usage
  monomorphic, and with what pin?" answer.
- #773 (monomorphize with call-site types) supplies the codegen: run the
  producer body with `ctx.typeParams = pinning` so the type-resolver emits
  `f64`/`i32` instead of externref. The `.widl` `specializations[]` table is the
  **serialization of #773's monomorphic variants across the artifact boundary**.
- #904 (link-time specialization) shares this infrastructure — coordinate on
  ordering; #904 and Slice 4 should land against a shared specialization-key +
  variant-emit helper, not two copies.

Concretely, Slice 4 = extend `.widl` with a populated `specializations` table
(`key = sha256(producerHash:exportName:canonicalize(pin))`), have
`compileModule(entry, { specializations: [...] })` emit `_spec_<key>` exports by
delegating to #773's monomorphization codegen, and have the consumer bind
`import "producer" "<name>_spec_<key>"` when its call-site pin matches. Because
it reuses #773, Slice 4 cannot start until #773 lands (or lands in the same
coordinated effort).

### Slice 5 — JIT specialization (milestone 3, depends on Slice 4)

Consumer build invokes `compileModule(producerSource, { specializations:[<new
pin>] })` on a cache miss, writing to
`node_modules/.cache/js2wasm-spec/<producerHash>/<key>.wasm`, evicted on
source-hash mismatch. Pure build-orchestration on top of Slice 4.

### Cross-module type flow through `ctx.oracle` (all slices)

Cross-module signatures must be resolved through `ctx.oracle`
(`src/checker/oracle.ts`), NOT raw `checker.getTypeAtLocation` — the
oracle-ratchet gate (#1930/#3273) rejects raw checker calls in new codegen. For
Slice 1 the boundary types are read from the `.widl` (already-resolved
`wasmType` strings), so no new checker query is needed on the consumer's
import-binding path — this is a bonus: the `.widl` is a **pre-resolved type
oracle for the producer**, sidestepping the cross-`ts.Program` type-identity
problem entirely (two separately compiled modules have DISJOINT `ts.Type`
identities; the `.widl` is the interchange format that bridges them). Slices 2/4
that DO query the consumer's `ts.Program` (for `.d.ts` signatures / call-site
pins) must route through `ctx.oracle.signatureOf`.

### Dependency summary

- **Slice 1**: no hard code deps — independently shippable. Uses existing
  `ModuleResolver`, `compileMultiSource`, `addImport`, `buildImports`,
  `wit-generator` scaffolding.
- **Slice 2**: independent; parallelizable with Slice 1.
- **Slice 3**: hard; standalone effort; not needed by Slice 1.
- **Slice 4**: BLOCKED on #773 + #743; coordinate with #904.
- **Slice 5**: depends on Slice 4.
- Downstream: **#1058** (self-hosting the TS compiler) `required_by` this issue —
  it needs artifact-level separate compilation to avoid recompiling the whole
  closure.

### Risks

- **`ImportDescriptor.module` widening** (`src/index.ts:98`) touches a
  load-bearing union consumed across `runtime.ts`; audit every switch on it.
- **Instantiation order** must be dependency-correct; a wrong order surfaces as
  a runtime "import is not a function". Keep Slice 1 acyclic-only.
- **Do not regress whole-program**: `compileProject` and all existing multi-file
  tests must pass unchanged — the artifact path is entered ONLY when a `.widl`
  is present and every boundary type is scalar/externref.
- Keep the boundary representation-neutral (scalar/externref) so the future IR
  `IrExternCall` migration and the linear backend inherit it for free.
