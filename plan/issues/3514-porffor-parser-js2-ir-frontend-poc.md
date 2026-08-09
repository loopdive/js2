---
id: 3514
title: "POC: use Porffor's JavaScript parser as a frontend to JS2 IR"
status: ready
sprint: current
created: 2026-07-21
updated: 2026-07-21
priority: high
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: architecture
area: parser, frontend, ir, porffor
language_feature: compiler-internals
es_edition: n/a
goal: backend-agnostic-ir
model: gpt-5.6-sol
depends_on: []
related: [1584, 1710, 1715, 3288, 3295, 3478, 3482, 3508]
origin: "2026-07-21 explicit user request: create a proof of concept integrating Porffor's JavaScript parser as a frontend to JS2 IR"
---

# #3514 - POC: Porffor JavaScript parser to JS2 IR

## Objective

Prove that Porffor's self-hostable JavaScript parser can feed JS2's typed SSA
IR as an optional frontend, independently of the existing TypeScript
`SourceFile`/`TypeChecker` path and independently of the optional Porffor IR
backend.

The proof must exercise a real frontend/backend cross-product:

```text
                         +-> JS2 linear-Wasm
Porffor parser -> JS2 IR-+
                         +-> optional Porffor IR -> C

TypeScript frontend -> JS2 IR -> the same two backend checks (control)
```

Porffor is a proof frontend, not the owner of JS2 IR. The work must not narrow
the IR, memory planner, or backend contracts to Porffor's AST, semantic
annotations, runtime, value ABI, or C renderer.

## Current state

- `vendor/Porffor/compiler/parser/index.js` is Porffor's dependency-light,
  single-module JavaScript and TypeScript parser. It returns an ESTree-like
  program and uses module-level mutable lexer/parser state for self-hosted
  bundling.
- `vendor/Porffor/compiler/parse.js` configures module and TypeScript parsing
  through Porffor preferences and the input filename.
- `vendor/Porffor/compiler/semantic.js` resolves bindings and annotates the
  parsed tree with Porffor-private metadata such as inferred value/storage
  types, variable ownership, writes, and closure relationships.
- JS2's existing `src/ir/select.ts`, `src/ir/type-evidence.ts`, and
  `src/ir/from-ast.ts` consume TypeScript `ts.Node` identities and checker-backed
  symbol/type evidence. They cannot consume an ESTree program directly.
- The completed backend proof #3288 goes in the opposite direction:
  `IrModule -> Porffor IR`. It neither exposes nor requires a Porffor parser
  frontend.
- The optional Porffor checkout is pinned and fingerprinted, but its parser AST
  and semantic metadata are internal interfaces without a compatibility
  guarantee.

## Architectural boundary

### Do not synthesize a TypeScript AST

The POC must not translate Porffor nodes into synthetic `ts.Node` objects and
then call the existing TypeScript lowerer. Synthetic nodes are not bound into
a TypeScript `Program`; checker symbol identity, declaration resolution,
contextual types, signatures, diagnostics, and source ownership would be
missing or misleading.

### Add a narrow optional frontend adapter

Own a JS2-side adapter with an explicit boundary, tentatively:

```ts
interface PorfforFrontendOptions {
  readonly module?: boolean;
  readonly fileName?: string;
  readonly entrySignatures?: ReadonlyMap<string, IrFrontendSignature>;
}

interface PorfforFrontendResult {
  readonly module: IrModule;
  readonly allocationSites: AllocSiteRegistry;
  readonly diagnostics: readonly IrFrontendDiagnostic[];
}

async function lowerPorfforSourceToIr(source: string, options?: PorfforFrontendOptions): Promise<PorfforFrontendResult>;
```

The exact API may change, but the ownership rules may not:

- JS2 owns normalized source spans, binding IDs, type evidence, diagnostics,
  allocation-site provenance, and every emitted `IrNode`.
- Porffor-private `_...` annotations stay behind the adapter. No Porffor node
  or numeric type enum may appear in `src/ir/nodes.ts`, `LinearMemoryPlan`, or
  a backend contract.
- The adapter uses `IrFunctionBuilder` and the ordinary verifier/passes. It
  must not emit Porffor IR, C, Wasm instructions, or backend-specific layouts.
- Unknown syntax, binding state, or type evidence fails with a source-located
  `porffor-frontend:*` diagnostic. It must not guess a scalar ABI or silently
  route through Porffor's own AST-to-IR codegen.

### Keep Porffor optional

Core installation, typechecking, build, and non-Porffor tests must pass with an
uninitialized `vendor/Porffor`. Production modules must not statically import
the submodule. A loader dynamically imports only the exact pinned parser and,
where needed, semantic pass after validating the git commit and frozen parser
surface.

The loader must isolate Porffor's global preferences and module-level mutable
parser state. Concurrent or repeated parses must not leak filename, module,
TypeScript, or semantic-scope state between calls. If safe in-process reset is
not possible at the pin, the POC may use a dedicated worker boundary and must
document the cost.

## POC scope

### Supported syntax

Implement a deliberately narrow pure-JavaScript subset already representable
in JS2 IR:

- function declarations with identifier parameters;
- numeric, boolean, and ASCII string literals;
- local `let`/`const`/`var` declarations and assignment;
- arithmetic, comparison, logical, conditional, and JS bitwise expressions;
- `if`, counted/while loops, direct calls, recursion, and return;
- fixed numeric object literals/property reads/writes;
- dense numeric array construction, indexing, writes, and length;
- the string operations required by the selected POC fixture, only when the
  shared string contract can prove their encoding and allocation requirements.

Type evidence may come from conservative Porffor semantic annotations,
syntax/operation constraints, or explicit POC entry-signature hints. Every
source of evidence must be recorded in the result. Unknown or conflicting
evidence rejects the function; no TypeScript reparse/checker fallback is
allowed in the Porffor-frontend lane.

### Fixtures

Use exact checked-in source bytes rather than translated twins:

1. `playground/examples/benchmarks/fib.js` - scalar loop and JS bitwise result.
2. `playground/examples/benchmarks/fib-recursive.js` - recursive call-graph
   closure and signature evidence.
3. At least one memory-bearing exact source: `array-sum.js` or
   `tests/fixtures/porffor-source-to-native-canary.ts` if the POC's
   JavaScript-only boundary can consume it without a second maintained source.

`string-hash.js` is a stretch fixture. It may be an explicit unsupported result
if the missing operation is source-located and assigned to a follow-up instead
of being approximated.

## Implementation plan

### 1. Freeze the parser frontend surface

- Extend the optional Porffor loader or add a frontend-specific loader that
  validates the exact gitlink before importing parser internals.
- Record a structural fingerprint for the ESTree node families used by the
  POC, source ranges, literal representation, function/type-annotation fields,
  and semantic annotations consumed by the adapter.
- Add repeated and concurrent parse probes for state isolation.
- A changed pin must fail with an actionable compatibility diagnostic before
  AST lowering.

### 2. Define JS2-owned frontend evidence

- Add small parser-neutral records for source spans, binding identities,
  function signatures, and scalar/aggregate type evidence. Do not attempt a
  repository-wide neutral-HIR migration in this POC.
- Map Porffor binding/semantic annotations into those records behind the
  adapter.
- Keep the existing TypeScript frontend unchanged. The POC may add a control
  exporter that records equivalent evidence from the TypeScript path, but must
  not force the production TypeScript lowerer through the new adapter.

### 3. Lower the supported ESTree subset to JS2 IR

- Implement expression and statement lowering using `IrFunctionBuilder` and
  existing IR operation/type constructors.
- Preserve left-to-right evaluation, short-circuiting, completion, source
  provenance, and allocation-site identity.
- Build the local call graph before bodies so direct and recursive calls have
  stable signatures.
- Run the ordinary IR verifier, allocation verifier, and target-neutral passes.
  The Porffor frontend may not define its own verifier or memory plan.

### 4. Prove frontend/backend independence

For every supported fixture:

- obtain the JavaScript result from Node as the semantic oracle;
- lower the exact bytes through the Porffor frontend without a TS checker;
- execute the resulting IR through linear-Wasm;
- when the optional checkout and C compiler are present, lower the same
  `IrModule` and `LinearMemoryPlan` through the existing Porffor backend and
  execute sanitizer-instrumented C;
- compile the same exact source through the current TypeScript frontend as a
  control and compare normalized signatures, operation families, allocation
  layouts/policies, and outputs. IR byte identity is not required because node
  IDs and provenance may differ; semantic and planning differences must be
  reported rather than normalized away.

### 5. Record the eval feasibility result

Measure parser artifact size, parse latency, worker/startup cost, and the set of
unsupported syntax/semantic dependencies. Add a short architecture note stating
whether this parser is a better standalone-eval candidate than the currently
planned Acorn path. This POC does not implement `eval`; it only produces the
evidence needed for that decision.

## Acceptance criteria

- [ ] Exact pinned Porffor parser/semantic internals are loaded only through an
      optional, commit-checked, structurally fingerprinted boundary.
- [ ] Core build, typecheck, and non-Porffor tests pass when `vendor/Porffor` is
      absent.
- [ ] No Porffor AST node, private `_...` annotation, numeric type enum, or
      preference leaks into JS2 IR, `LinearMemoryPlan`, or backend contracts.
- [ ] At least `fib.js`, `fib-recursive.js`, and one memory-bearing exact source
      lower from Porffor AST to verified JS2 IR without a TypeScript reparse or
      checker query.
- [ ] Node, TypeScript-frontend/IR, and Porffor-frontend/IR executions produce
      identical results for every supported fixture.
- [ ] The Porffor-frontend `IrModule` executes through linear-Wasm and, when
      optional native prerequisites exist, through sanitizer-clean
      Porffor-IR/C.
- [ ] Recursive call signatures, effect order, object/array aliasing, bounds,
      and allocation plans have focused differential assertions.
- [ ] Unsupported syntax or insufficient type/binding evidence produces a
      stable source-located diagnostic and never silently invokes Porffor's
      own codegen.
- [ ] Repeated/concurrent parse tests prove state isolation or establish and
      measure a worker boundary.
- [ ] A retained note compares parser latency, dependency/artifact size,
      conformance surface, type-evidence quality, and standalone-eval fitness
      against the existing TypeScript and proposed Acorn paths.

## Non-goals

- Replacing the default TypeScript frontend.
- Full TypeScript type checking, declaration-file resolution, JSX, decorators,
  or TypeScript diagnostic parity.
- Translating Porffor AST nodes into synthetic TypeScript nodes.
- Reusing Porffor's AST-to-Porffor-IR code generator.
- Making the Porffor parser or submodule a mandatory dependency.
- Adding a public `--parser porffor` flag before the POC establishes a stable
  semantic contract.
- Implementing standalone `eval`, TinyCC execution, or a new runtime value ABI.
- Changing the shared linear-memory planner or preferring Porffor/C over other
  backends.

## Risks

- **Semantic coupling:** Porffor's `_...` annotations are private mutable AST
  state and may change with no compatibility promise. The fingerprint and
  adapter boundary are mandatory.
- **Type-evidence regression:** Porffor's storage/type inference is not a
  replacement for TypeScript's checker. The adapter must reject uncertainty,
  not turn it into an unsound raw-number ABI.
- **Parser state leakage:** module-level mutable lexer and global preference
  state may make concurrent in-process use unsafe.
- **Duplicate lowering:** a direct ESTree lowerer can drift from `from-ast.ts`.
  Keep the POC narrow, build parser-neutral semantic helpers only where they
  remove demonstrated duplication, and use cross-frontend differential tests.
- **False performance conclusion:** Porffor parser timing alone is not
  comparable with JS2's current combined parse/check/select/lower/backend
  timings. Report phase-separated measurements.
- **Eval overclaim:** parsing dynamic source does not provide direct-eval scope
  capture, runtime bytecode execution, or shared-value semantics. Those remain
  separate runtime-eval work.
