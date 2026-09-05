---
id: 1058
title: "Compile the TypeScript compiler itself to Wasm — self-hosting stress test"
status: in_progress
created: 2026-04-11
updated: 2026-09-05
priority: high
feasibility: hard
model: fable
reasoning_effort: max
goal: compiler-architecture
sprint: Backlog
depends_on: [1042, 1044, 1046]
required_by: [1059, 1066, 1165, 1584]
loc-budget-allow:
  # 2026-08-29: the deferred object-literal method install (the Tier-3
  # createIdentifier null-deref fix) adds the patch-up block to
  # compileObjectLiteralForStruct.
  - src/codegen/literals.ts
  # This is a consolidated TypeScript-parser stress harvest. The branch predates
  # the change-scoped file/function ratchets and intentionally spans the
  # compiler frontiers documented in the implementation handoff below.
  - src/codegen/declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/closures.ts
  - src/codegen/stack-balance.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/index.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/property-access.ts
  - src/emit/binary.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/binary-ops.ts
  - src/codegen/type-coercion.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/closure-exports.ts
  - src/codegen/class-bodies.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/context/types.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/statements/variables.ts
  - src/compiler.ts
  - src/codegen/expressions/call-receiver-method.ts
  # 2026-08-29: the main merge composes this branch's runtime-namespace capture
  # guard with main's funcMap identity guard, crossing the 1500-line god-file
  # threshold in the closure capture-analysis phase file.
  - src/codegen/closures/arrow-phases.ts
  # 2026-08-30: the runtime parser follow-up adds narrow module-scale,
  # constructor-ABI, nullable-result, and fresh generic-factory handling at the
  # compiler frontiers documented in the current handoff below.
  - src/codegen/expressions.ts
  - src/codegen/generic-callback-result.ts
  - src/codegen/generic-struct-factory.ts
  - src/codegen/module-scale-profile.ts
  # 2026-09-01: the binder runtime reaches TypeScript's bounded
  # `Debug[AssertionKeys]` self-replacement protocol. The namespace-value
  # subsystem now materializes that checker-proven callable projection.
  - src/codegen/module-namespace-value.ts
  - src/codegen/native-construct.ts
  # 2026-09-01: the binder runtime's exported computed-option callback is a
  # cross-source callable snapshot. Keep its module-init read on the Wasm
  # carrier path and invoke it through a finalize-filled, ABI-complete driver.
  - src/codegen/property-access-exact-shapes.ts
  - src/codegen/host-fnctor-method-driver.ts
  - src/codegen/object-runtime.ts
  # 2026-08-31: projected NodeArray vecs retain their host-backed sidecar/MOP
  # identity so parser metadata survives element-type widening.
  - src/runtime.ts
func-budget-allow:
  # 2026-09-01: the standalone apply bridge rejects a local closure whose live
  # declared arity exceeds its fixed eight-position ABI while preserving the
  # existing full-vector linked/native fallback.
  - src/codegen/object-runtime.ts::fillApplyClosure
  # 2026-08-31: parser carrier preservation adds the narrow vec-projection
  # sidecar copy and its runtime import dispatch arm.
  - src/codegen/type-coercion.ts::coerceType
  - src/runtime.ts::resolveImport
  # 2026-08-31: parser runtime identity preservation extends both host closure
  # dispatchers with facade unwrapping and explicit-undefined normalization.
  # Keeping the free and method bridges structurally symmetric is intentional.
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  # 2026-08-29: same change — the deferred install lives at the end of this
  # function, where the literal's method funcIdxs are finally resolvable.
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/ir-inline.ts::inlineUserFunctions
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/statements.ts::compileStatementInner
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/member-set-dispatch.ts::fillMemberSetDispatch
  - src/codegen/expressions/calls.ts::compileIIFE
  - src/codegen/expressions/calls.ts::ensureFuncValueWrappersRegistered
  - src/emit/binary.ts::emitBinaryWithSourceMapUnguarded
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/index.ts::ensureStructForType
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
  - src/codegen/expressions/operator-assignment.ts::compilePropertyCompoundAssignmentExternref
  - src/codegen/index.ts::generateModule
  - src/compiler.ts::runPipeline
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/closures.ts::promoteAccessorCapturesToGlobals
  - src/codegen/expressions.ts::compileExpressionInner
oracle-ratchet-allow:
  # The parser stress harvest predates the ctx.oracle migration and exposes
  # TypeScript checker queries across these existing codegen paths.
  - src/codegen/declarations.ts
  - src/codegen/declarations/struct-type-registration.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/identifier-module-storage.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
  - src/codegen/generic-callback-result.ts
  - src/codegen/generic-struct-factory.ts
  # 2026-08-31: the parser runtime follow-up extends the same reviewed
  # checker-backed specialization harvest across these four existing paths.
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/misc.ts
  - src/codegen/statements/nested-declarations.ts
  # 2026-09-01: admit a runtime-namespace function projection only when the
  # computed write key's checker constraint is a finite string-literal set and
  # every member has one exact executable Program ABI declaration.
  - src/codegen/module-namespace-value.ts
  # 2026-08-30: distinguishing a compiled Scanner implementation from an
  # ambient object requires checker-backed declaration and initializer
  # provenance. This is deliberately local to callback classification.
  - src/codegen/closures/callback-classification.ts
---
# #1058 — Compile the TypeScript compiler to Wasm (self-hosting stress test)

## Goal

Use the actual [`typescript`](https://github.com/microsoft/TypeScript) npm package as the **fifth** real-world stress test for js2wasm, alongside #1031 (lodash), #1032 (axios), #1033 (react), and #1034 (prettier). The TypeScript compiler is the ultimate self-hosting milestone: **js2wasm compiling the compiler that js2wasm itself uses as its TypeScript frontend.**

This is distinct from the already-done **#452** ("Compile TypeScript compiler to Wasm"), which was a feasibility study using a hand-written 411-line toy scanner/parser that imitated TypeScript patterns. #452 concluded "95% of TypeScript patterns compile" — necessary validation, but not an attempt on the real thing. This issue is the real attempt.

## Why the TypeScript compiler specifically

- **~500K lines of mature production TypeScript** — biggest real-world corpus anywhere (vs 17K lodash, ~100K prettier, ~70K react, ~7K axios)
- **Exercises every language feature simultaneously** — parser, binder, type checker, emitter, language service, incremental compiler, module resolution
- **Self-hosting signal is the strongest correctness test possible**. If js2wasm compiles tsc, and compiled-tsc can then compile a non-trivial `.ts` file that matches native-tsc's output, that's a full round-trip semantic check of every path the compiler uses itself
- **No DOM, no Node builtins beyond `node:fs`** — clean host-import boundary (same approach as axios #1032 + WASI #1035 + #1044)
- **Recursive AST traversal + visitor pattern at massive scale** — surfaces every latent codegen issue
- **Huge switch statements on `SyntaxKind`** — hundreds of cases per binder/checker/emitter function; stresses large-switch codegen
- **Known challenges embedded:** template literals with `${}` interpolation (the 1/20 failure in #452), complex conditional/mapped types, recursive type definitions, AST node pool lifetime

## The moonshot — tiered acceptance

Escalating difficulty:

1. **Tier 1 (pattern validation — already done in #452):** TypeScript-compiler-shaped patterns compile. ✅ 19/20
2. **Tier 2 (real compiler leaves):** individual source files from `typescript/src/compiler/` compile without modification
3. **Tier 3 (scanner + parser):** compile `typescript/src/compiler/scanner.ts` + `parser.ts` so the resulting Wasm parses simple `.ts` source to an AST
4. **Tier 4 (checker subset):** compile enough of `checker.ts` to type-check `const x: number = "str"` and report TS2322
5. **Tier 5 (emit):** compile enough of `emitter.ts` to emit a `.js` file from a compiled AST
6. **Tier 6 (full round-trip):** compile a tsc subset end-to-end; hand it a `.ts` file, produce a `.js` file that matches native-tsc byte-for-byte (parallel to prettier's self-format diff #1034)
7. **Tier 7 — the moonshot (self-hosting):** compile js2wasm's own source with compiled-tsc and verify the second-stage js2wasm still compiles test262 correctly

**Tier 7 is aspirational. Tier 3 is the realistic sprint target. Tier 4 is the headline win.**

## Hard prerequisites

This issue depends on:

- **#1042 async/await state-machine lowering** — TypeScript's incremental compiler and project references use `async` extensively. Without real async, Tier 3+ is blocked.
- **#1044 Node builtin modules as host imports** — TypeScript uses `node:fs`, `node:path`, `node:util`, `node:crypto`. Required for loading the compiler's own source files from disk.
- **#1046 separate ES-module compilation with consumer-driven type specialization** — TypeScript's source is split across ~300 ES modules with a complex import graph. Current whole-program compile won't scale; this is a hard architectural blocker for Tier 2+.

Soft prerequisites (not strict blockers but would improve realization rate):

- **Template literal with `${}` interpolation** — #452's only known pattern gap. TypeScript uses these in hundreds of places for error message formatting
- **Large switch codegen scaling** — `binder.ts`, `emitter.ts`, and `checker.ts` each have switch statements with 200+ `SyntaxKind` cases. Our codegen currently emits linear if/else chains — won't fit
- **Recursive generic types** — `ts.Type`, `ts.Node`, `ts.Symbol` are deeply recursive with polymorphic `parent: Node | undefined` chains. If WasmGC struct layout doesn't support this cleanly, we hit walls in Tier 2
- **BigInt** — TypeScript uses BigInt in a few places (checksum/hash); not critical but breaks some modules

## Approach

### Step 1 — Start with leaf modules

Before touching the real compiler, pick the smallest self-contained files in `typescript/src/compiler/` with minimal external dependencies. Candidates:

- `typescript/src/compiler/core.ts` — pure utility functions (mapping, hashing, string helpers)
- `typescript/src/compiler/path.ts` — path manipulation (pure string operations)
- `typescript/src/compiler/debug.ts` — debug assertions
- `typescript/src/compiler/performance.ts` — performance instrumentation

Start with `core.ts` or `path.ts`. These are leaf dependencies with minimal external surface.

### Step 2 — Build a harness

Create `scripts/ts-compiler-stress.ts`:

```ts
import { compile } from '../src/index.ts';
import { readFileSync } from 'node:fs';

const tiers = {
  t2_leaf: [
    'node_modules/typescript/src/compiler/core.ts',
    'node_modules/typescript/src/compiler/path.ts',
  ],
  t3_scanner_parser: [
    'node_modules/typescript/src/compiler/scanner.ts',
    'node_modules/typescript/src/compiler/parser.ts',
  ],
  t4_checker_subset: [
    'node_modules/typescript/src/compiler/checker.ts',
  ],
  t5_emitter_subset: [
    'node_modules/typescript/src/compiler/emitter.ts',
  ],
};

for (const [tier, files] of Object.entries(tiers)) {
  console.log(`=== ${tier} ===`);
  for (const file of files) {
    const src = readFileSync(file, 'utf-8');
    const result = await compile(src, {
      fileName: file,
      esModulesAsHostImports: true,
      nodeBuiltinsAsHostImports: true,
    });
    console.log(result.success ? `  OK   ${file}` : `  FAIL ${file}: ${result.errors[0]?.message?.slice(0, 100)}`);
  }
}
```

### Step 3 — Categorize failures

Same as other stress tests (#1031-#1034): cluster by pattern, sample 2-3 per bucket, file follow-up issues for each concentrated cluster. Expected top buckets:

- Large switch dispatch codegen failures
- Template literal with interpolation (known #452 gap)
- Recursive generic types in declarations
- Module graph compile errors once #1046 lands
- New AST node kinds used internally by TypeScript that js2wasm doesn't handle

### Step 4 — The partial-compile validation

Once Tier 3 compiles (scanner + parser), build an incremental end-to-end test:

```ts
const compiledTs = await loadCompiledTypescript();
const sampleSource = 'const x: number = 1 + 2;';
const compiledAst = compiledTs.parseSource(sampleSource);
const nativeAst = ts.createSourceFile('sample.ts', sampleSource, ts.ScriptTarget.Latest);
assertASTEqual(compiledAst, nativeAst);
```

If compiled scanner+parser produces the same AST as native TypeScript for a set of representative input files, Tier 3 passes.

### Step 5 — Follow-up issues

Expected 5-15 new follow-up issues from Tier 2-3, each scoped narrowly enough for one sprint (one PR).

## Upstream-source experiment (2026-08-09)

### Provenance and comparison lane

The experiment used the exact upstream `microsoft/TypeScript` `v5.9.3` tag
(`c63de15a992d37f0d6cec03ac7631872838602cb`). The downloaded source archive
had SHA-256
`d371a2430d6305290d1bddaf195fdd629d1a8708cda08f4a72fc923b65d36c4a`.
Its checked-in `lib/typescript.js` and the pinned npm-compat fixture's
`package/lib/typescript.js` are byte-identical (both SHA-256
`3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`).
This makes `--mode bundle` versus `--mode source` a representation comparison,
not a version comparison.

The committed worker-isolated probe runs both representations through the same
options:

```text
allowJs: true
skipSemanticDiagnostics: true
target: "gc"
platform: "node"
```

`allowJs: true` deliberately keeps the npm-compat diagnostic policy identical
for both lanes; `.ts` files are still parsed as TypeScript by extension. The
probe streams compiler phases and samples CPU, RSS, and worker event-loop
utilization, so a bounded timeout is distinguishable from an idle/deadlocked
process.

```bash
node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root /path/to/TypeScript-5.9.3 --mode source \
  --timeout-ms 1800000 --heap-mb 4096 --json
```

### Full upstream source

`src/typescript/typescript.ts` resolves **280 input files / 13,780,098 bytes**.
On the clean overload-fix snapshot
`1d260d48a0d01ce3319f3017b81bf8f831f4f6f5`, the compiler passed the four
generic overload-owner frontiers recorded in #4267, #4268, #4270, and #4272.
At the 900-second cap it was actively emitting bodies: the last completed file
was `src/compiler/_namespaces/ts.moduleSpecifiers.ts`, followed by
`src/compiler/checker.ts`. At a near-terminal snapshot it had accumulated
11:22.67 CPU time; peak observed heap was 1,994.0 MB. This was a throughput
frontier, not a new semantic diagnostic.

A second run gave the source path twice as long and doubled the worker heap:

| budget | heap limit | result | CPU time | average cores | peak RSS | binary |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,800,000 ms | 4,096 MiB | bounded timeout | 1,681,964 ms | 0.93 | 2,531.7 MiB | 0 bytes |

That run remained CPU-active and repeatedly grew and garbage-collected its
heap through the exact 1,800,022 ms wall-clock cutoff. It was measured from the
npm-compat integration worktree at head
`8173091329ed37bf7e641e31456005e0e6e79aa4`; unrelated uncommitted dogfood
changes were present, so use the run as a scale/liveness measurement, not as a
stable performance baseline. It produced no result object or Wasm binary.

For comparison, the canonical published-bundle catalog run also produces no
binary before its 600,000 ms cap (`600,076 ms` observed). Upstream source is
therefore **not a compile-time shortcut today**. Its advantage is structural:
module boundaries turn the bundle's opaque large-IIFE frontier into named,
measurable source-file work and exposed four generic overload bugs that are now
fixed.

### Original parser-source slice

The smallest unmodified parser consumer used this wrapper only to make the
result observable:

```ts
import { createSourceFile } from "./src/compiler/parser.js";
import { ScriptKind, ScriptTarget } from "./src/compiler/types.js";

export function runCase(): number {
  const source = createSourceFile(
    "input.ts",
    "export const answer: number = 6 * 7;",
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  return source.kind * 1000 + source.statements.length;
}
```

Native TypeScript returns **308001** (`SourceFile.kind === 308`, one
statement). The unchanged upstream parser graph was compiled with:

```bash
node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root /path/to/TypeScript-5.9.3 --mode source \
  --entry js2-parser-workload.ts --timeout-ms 900000 --heap-mb 4096 --json
```

The resolver admitted **82 input files / 82 user source files / 86 TypeScript
Program files** and planned 336 module-init statements. It reached the same
`ts.moduleSpecifiers.ts` → `checker.ts` boundary, then remained CPU-bound until
the exact 900,028 ms cutoff: 918,534 ms CPU, 1.02 average cores, 1,308.7 MiB
peak RSS, worker event-loop utilization 1.0, and no binary. Because no Wasm
module exists, **308001 is only the native oracle; no parser parity or package
test pass is claimed**.

The unexpected checker dependency is not inherent to parsing. Upstream
`parser.ts` imports `./_namespaces/ts.js`, and that generated barrel re-exports
`checker.ts`, the emitter, transformers, builders, watch support, and the rest
of the compiler. Direct parser source removes the `services`, `server`, and
`jsTyping` graphs (280 → 82 inputs), but the current recursive resolver retains
every re-export instead of only the named bindings consumed by the parser.

### Consumer-driven specialization slice

The first #1046-shaped slice is now implemented as an explicit
`resolve.consumerDrivenBarrels` mode. It tracks named demand through pure
import/re-export barrels, derives demand from static namespace property reads,
and specializes ordinary provider files by blanking unreachable function and
type declarations while preserving line positions. A dynamic namespace use,
an incomplete/cyclic export surface, or a side-effect-only import retains the
full edge. The option remains **off by default**: opting in is the caller's
explicit assertion that unused import/re-export targets and unreachable
declaration bodies in the generated source tree do not have required
initialization effects.

On the exact upstream `v5.9.3` parser wrapper this reduces the graph from **82
input files / 86 Program files to 31 input files / 35 Program files**. The
selected graph no longer contains the emitter, build, watch, or language-service
subsystems. `checker.ts` is still present only for the `getNodeId` leaf used by
`nodeFactory`; specialization blanks 98.3% of its non-whitespace source
(2,178,565 → 38,005 characters). The largest remaining provider is
`nodeFactory.ts`: its single demanded factory returns a large method object, so
declaration-level specialization cannot yet remove individual returned
properties.

The probe now accepts an invocation export, a runtime string, and a numeric
oracle. This keeps the parser input dynamic instead of embedding it in the
wrapper. Native TypeScript returns **308001** for
`"export const answer: number = 6 * 7;"` and **308002** for
`"let a = 1; let b = 2;"`; a future Wasm success must invoke the compiled
`runCase(sourceText)` export and match the requested value before the probe can
pass.

With the four generic overload fixes (#4267, #4268, #4270, #4272) layered for
validation, the specialized static-input wrapper reached final codegen in
251,093 ms at 555.5 MiB peak observed RSS instead of timing out at 900,028 ms
and 1,308.7 MiB on the unspecialized graph. It exposed two generic finalization
gaps: nested `InterfaceDeclaration` statements were incorrectly reported as
runtime statements, and the constant-box walker revisited shared instruction
arrays once per incoming edge. Focused fixes now ignore nested type-only
declarations and visit instruction-array DAG nodes once.

The authoritative **dynamic-input** run still produces no binary. With the
same 31-file graph it remained CPU-active through a 300,300 ms cap (264,014 ms
CPU, 609.5 MiB peak RSS) after compiling 3,252 function bodies. Disabling
constant-box hoisting also timed out after the last profiled
`declared-func-refs` phase (300,083 ms, 206,033 ms CPU, 643.6 MiB peak), proving
that the residual finalization tail is not solely that pass. Consequently
there is still **no 308001 Wasm parity claim**. The next leverage is
consumer-driven property specialization of returned method tables—especially
`createNodeFactory`—plus phase-level profiling of the post-body finalizers.

### Suspended handoff (2026-08-09)

The consumer-driven specialization is committed as `7a50f7fd9a34fd` on the
published `codex/npm-compat-handoff` branch. There is no later uncommitted
TypeScript experiment.
The authoritative dynamic probe remains CPU-active rather than idle: it has
compiled 3,252 bodies when the 300.3-second child budget terminates it, but it
never emits a binary. Therefore TypeScript does **not** compile yet and 308001
is still only the native oracle.

Resume with phase-level profiling after the final body and consumer-driven
property specialization of returned method tables, starting with
`createNodeFactory`. Recompiling the upstream TypeScript source is already the
preferred experiment; merely raising the timeout repeats the measured
post-body tail without addressing it.

### Decision

Keep the upstream TypeScript source route as the migration substrate, but do
not replace the npm-compat package result with it and do not claim that
TypeScript compiles. Land consumer-driven specialization as a measurable,
default-off #1046 slice: it removes 51 irrelevant files and more than halves
peak memory, but the remaining returned-method table and finalization work
still prevent a binary. Raising the timeout or heap alone does not close the
gap; both the 4 GiB / 30-minute full-source run and the 31-file dynamic run
prove that.

## Codex implementation handoff (2026-08-28)

Branch: `codex/1058-typescript5-selfhost`.

The pinned TypeScript 5.9.3 parser graph now compiles to a valid WasmGC module.
The latest authoritative run produced an 81,241,283-byte binary in 298,177 ms
(3,638.8 MiB peak RSS); compilation succeeded and `WebAssembly.validate`
returned true. This closes the former no-binary/finalization frontier, but Tier
3 is not complete because runtime AST fingerprints do not yet return.

```bash
JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC=1 \
JS2WASM_TYPESCRIPT_PROBE_SOURCE_MAP=1 \
pnpm run dogfood:typescript-parser-source
```

Diagnostic artifacts are written to
`/private/tmp/ts2wasm-typescript-parser-latest.wasm` and the adjacent `.map`.

### Completed in this branch

- Pins/prepares the exact upstream source and adds a three-file AST fingerprint
  harness; consumer-driven barrel pruning and post-body DAG finalizers now
  complete within the five-minute worker budget.
- Repairs recursive layouts, mapped readonly erasure, constructor/factory
  identity, late fixups, nested captures, module initialization, enum aliases,
  and the large instruction graphs reached by the parser build.
- Preserves omitted optional numeric arguments as `undefined` at callable
  property boundaries (`scanner.setText(sourceText)` previously received zero
  and produced an empty AST).
- Widens mixed-`undefined` nested returns so `getDirectiveFromComment` no longer
  boxes the undefined f64 sentinel as a Number.
- Pre-registers safe zero-argument boolean/GC-reference callbacks and bridges
  erased generic results, clearing `scanner.speculationHelper<T>` and
  `parser.parseListElement<T>` without admitting unsafe argument-bearing ABIs.

The latest focused checkpoint passed 14/14 optional-padding, generic-callback,
and scalar-callable safety tests. `pnpm run typecheck` also passed.

### Remaining Tier-3 blocker

All three required inputs now converge on one runtime frontier:

```text
RuntimeError: dereferencing a null pointer
  at createIdentifier
  at parseIdentifier
  at parsePrimaryExpression
source: src/compiler/parser.ts:2649:9
wasm offset: 2106116 (source-map anchor 2098406)
```

`builderStatePublic.ts`, `corePublic.ts`, and `performanceCore.ts` therefore do
not yet return their expected fingerprints. Resume by extracting
`createIdentifier` (function index 927 in the latest diagnostic module) and
tracing the null receiver/argument at parser line 2649. Do not revisit the
resolved empty-AST, comment-directive, or generic callback paths unless their
focused regressions fail. After this frontier, rerun the three fingerprints,
then the strict 11-callback upstream suite and final TS5/TS7 typechecks/oracle
ratchet.

### PR refresh against current main (2026-08-29)

PR #5183 was refreshed onto `main` through
`81e54a98ebf95285e22bd2a82ff339cfd06a3fc8`. The merge keeps the parser
branch's nested-capture offset for spread calls while honoring main's newer
`arguments`-based spread path, uses the prepared multi-source module-init
finalizer, profiles both return- and parameter-unboxing statistics, and
combines inherited-array carriers with builtin-shadow protection. The latter
also guards recursive base-type discovery so a user-defined `Array` cannot be
reclassified as the intrinsic.

After the refresh, both TS5 and TS7 typechecks pass, repository lint reports no
errors, all 45 issue-1058 test files pass (151 tests), and the merge-sensitive
main regressions pass (8 files, 94 tests). The runtime `createIdentifier` null
deref above remains the only known Tier-3 fingerprint blocker; this refresh
does not claim it is resolved.

## Runtime parser handoff (2026-08-30)

Branch: `codex/1058-typescript5-runtime`, synchronized to `origin/main` at
`275216c74c7299ea07a72c8d5479f7e1a477000c`.

The canonical consumer-driven TypeScript 5.9.3 scanner/parser graph **compiles
and validates** after the sync. The authoritative diagnostic run on this tree
finished in 467,608 ms worker time / 468,686 ms wall time and produced an
**84,817,448-byte** Wasm module from 30 input/source files, 34 program files,
and 4,284 functions. Peak RSS was **3,848.6 MiB**, below the 4 GiB gate, and the
result contained 16 non-fatal IR/projection warnings. `compileSuccess` and
`WebAssembly.validate` are both true.

Runtime parser equivalence remains open. The same fresh build invoked all three
canonical inputs; none returned its required fingerprint:

- `builderStatePublic.ts = 13386537220945`
- `corePublic.ts = 40098163538143`
- `performanceCore.ts = 49645738923599`

`builderStatePublic.ts` and `performanceCore.ts` both reach semicolon recovery
with a missing Identifier whose `escapedText` is `undefined`, then fail in
`unescapeLeadingUnderscores` / `utilitiesPublic.ts:851`. `corePublic.ts` reaches
an `illegal cast` in `__call_fn_method_2` from
`parseBinaryExpressionRest`. The diagnostic Wasm and source map were preserved
at `/private/tmp/ts2wasm-typescript-parser-latest.wasm{,.map}` for the next
investigation; they match this exact source tree and must not be confused with
the earlier 83.6 MB artifact used for the size audit.

### Compiler fixes in this follow-up

- Generic calls returning callable values (TypeScript's `memoize` family) keep
  a callable closure carrier instead of freezing to the first apparent result.
- Fresh generic node factories use the exact checker declaration and explicit
  result type argument, recover a concrete binding destination during prepared
  program replay, and remain on the legacy materializing frontend when the IR
  overlay cannot preserve that proof.
- `Node -> Declaration -> StringLiteral/NumericLiteral/BinaryExpression` now
  materializes fresh structural extensions rather than performing a nominal
  guard-cast that can only yield null.
- Missing non-null reference fields are widened to nullable carriers across the
  highest owning nominal ancestor and its complete descendant subtree. This
  keeps mutable WasmGC prefixes exact for TypeScript's
  `IterationStatement -> Do/While/For*Statement` hierarchy.
- Interface layout stability now treats its set as an active recursion stack.
  Legal diamonds may revisit an already-completed `Node` branch, while genuine
  active cycles remain rejected. This preserves `StringLiteral`'s nominal
  `LiteralExpression` identity across `parseLiteralLikeNode`.
- Focused coverage includes cross-module memoizers, cached-getter freshness
  rejection, prepared multi-module factories, concrete nullable `Symbol`
  fields, sibling loop layouts, and the exact four-module literal/parser
  diamond that previously trapped.
- Callable-property invocation now bridges erased generic reference ABIs in
  both directions. In particular, a generic `(externref) -> externref`
  identity stored as `Rules.apply(Box): Box` no longer freezes or miscasts its
  argument/result carrier. The focused regressions in
  `issue-1058-generic-identity-return.test.ts` and
  `issue-1058-generic-base-node-factory.test.ts` compile, validate, and return
  their expected values.
- Callback ownership and registration now span the whole prepared source
  graph. Later-source named callbacks are discovered before an earlier generic
  dispatcher is compiled, while an inline arrow passed to a method declared by
  a compiled interface stays on the Wasm-closure path instead of being wrapped
  as a host callback. This is the exact TypeScript parser shape
  `scanner.tryScan(() => scanner.reScanInvalidIdentifier() === Identifier)`;
  before the fix `speculationHelper<T>` cast the host wrapper to a null Wasm
  closure root. All five focused cases in
  `issue-1058-multifile-generic-callback-registration.test.ts` now pass,
  including the inline-arrow case returning `42` and the later-source
  boolean/node/enum callback case returning `14243`.
- Cross-source callback discovery is cached graph-wide. Registration still
  runs per source so a later exact ABI can replace a conservative entry, but
  the compiler no longer walks the roughly 10 MB TypeScript graph once for
  every source.
- Body-proven generic identity helpers can recover the concrete input carrier
  after an erased `externref -> externref` call. The proof fails closed: every
  outer value return must name the same generic parameter symbol and the
  binding may not be assigned, updated, rebound, or used as a loop write
  target. Property writes remain valid for TypeScript's `finishNode<T>`.
  Negative regressions cover returning a fresh asserted value and rebinding
  the parameter before return.

Current-main validation is green for all **53** `tests/issue-1058-*.test.ts`
files (**183/183 tests**), including all **6/6** multi-file callback cases and
the new generic-identity safety controls. TS5 and TS7 typechecks, repository
lint/format, the IR fallback ratchet, the oracle ratchet, and
`git diff --check` pass. The strict upstream callback suite is intentionally
not claimed: its prerequisite parser fingerprints still fail as documented
above.

### Artifact size note

The roughly **84 MB** output is not an intrinsic cost of TypeScript's parser;
it exposes a js2wasm code-generation pathology. A measured 83,585,611-byte
diagnostic artifact has an **81,488,148-byte code section (97.49%)** and no
embedded source/data payload. Of that code, 1,176 generated `__closure_*`
bodies occupy 76,499,060 bytes. TypeScript's 88 KB `visitorPublic.ts` accounts
for **75,571,430 bytes** of closure code because its visitor callback cohort is
emitted during discovery and then twice during the final two-pass compile. The
two final cohorts include an exact byte-for-byte duplicated
**36,791,280-byte** block.

This is why comparison with an approximately 100 KB QuickJS parser is only
partly apples-to-apples: this gate links about 6.82 MB across 28 TypeScript
frontend modules, factories, utilities, diagnostics, and initialization, and
emits raw unoptimized WasmGC. Even so, the current size is not acceptable as a
normal parser baseline. Binaryen's `--remove-unused-module-elements` alone
reduces the measured artifact from 83,585,611 to **41,141,284 bytes**, proving
that almost half is removable duplicate/dead module code rather than required
runtime behavior.

Size follow-up priorities, in order, are:

1. Make callback discovery transactional/analyze-only, or prune the functions
   it emits, so the final pass does not retain the discovery cohort.
2. Reuse the final two-pass closure bodies instead of minting a second identical
   function for the same AST node and capture ABI.
3. Replace per-call expansion over roughly 1,034 closure candidates with shared
   or ABI-narrowed dispatch helpers.
4. Reduce exports and run unused-module elimination/optimization before
   delivery; pool the 12,057 imported string globals separately.

### Exact remaining work

1. Reduce the remaining `builderStatePublic.ts` / `performanceCore.ts`
   `undefined.length` failure through `unescapeLeadingUnderscores` and
   `parseErrorForMissingSemicolonAfter` (`utilitiesPublic.ts:851:5`). The
   optional-argument closure metadata now survives captured and constructible
   subtypes, so this later parser-list carrier miss needs a focused trace rather
   than another broad arity exception.
2. Reduce the independent `corePublic.ts` two-argument method cast in
   `parseBinaryExpressionRest` / `__call_fn_method_2`.
3. Make all three invocations return the expected fingerprints above, then run
   the strict 3-file / 11-callback upstream suite.

This is a real-package compile/validation milestone, not a claim that the
three AST fingerprints or the whole TypeScript unit suite pass yet.

## Runtime carrier follow-up handoff (2026-08-31)

Branch: `codex/1058-typescript5-runtime-followup`, synchronized to the actual
`loopdive/js2` `main` at
`b1085049ed2ed722c33480528b2741369ed73822`. This supersedes the earlier
handoff's `origin/main` wording; that remote points at the legacy
`loopdive/js2wasm` repository.

The final post-sync diagnostic run compiled and validated the canonical
TypeScript 5.9.3 parser graph. It produced an **84,901,009-byte** Wasm module in
363,428 ms worker time / 364,469 ms wall time from 30 source files, 34 Program
files, and 4,284 functions. Peak RSS was **4,027.9 MiB**, below the 4 GiB
worker cap, and the result retained 16 non-fatal IR/projection warnings.
`compileSuccess` and `WebAssembly.validate` are both true. The diagnostic Wasm
and source map are at
`/private/tmp/ts2wasm-typescript-parser-latest.wasm{,.map}`.

### Compiler fixes in this follow-up

- Fail-closed semantic recognition of generic callback-result helpers now
  preserves `<T>(callback: () => T): T` across nested/lifted declarations,
  runtime namespaces, forwarded scanner methods, and constraint-backed
  `current as T` parser fallbacks. `parseListElement` no longer freezes its
  result ABI to the first `Statement` instantiation and nulls a later sibling
  `VariableDeclaration`.
- Closure metadata records the minimum accepted source arity. Dynamic callback
  dispatch pads only proven omitted `externref` suffixes with the canonical
  JavaScript `undefined`, and captured/constructible closure subtypes preserve
  that metadata. Callable-property dispatch likewise accepts safe shorter
  runtime arities without widening scalar suffixes.
- Fresh generic Node/token factories preserve their declared source carrier,
  project concrete sibling results at the call site, and allow only proven
  fresh, non-escaping structural extensions. Arbitrary constructors,
  conditional fallthrough, nested mutator captures, and returned-factory
  escapes all fail closed in focused negative tests.
- Nested FunctionDeclaration result lowering, first-void runtime-namespace
  registration, lossless asserted reference-field export, and immutable
  hoisted-function rematerialization were repaired. Reassignment discovery now
  includes destructuring, updates, and loop assignment targets so a live
  replacement is not overwritten by a later rematerialization.

The former `createIdentifier`/factory failure and the later
`parseVariableDeclarationList` null dereference are both cleared. Runtime
fingerprint equivalence is still open:

- `builderStatePublic.ts` and `performanceCore.ts` stop with
  `TypeError: Cannot read properties of undefined (reading 'length')` through
  `unescapeLeadingUnderscores`, `parseErrorForMissingSemicolonAfter`, and
  `parseListElement` (source-map location `utilitiesPublic.ts:851:5`, Wasm
  offset 1,764,823).
- `corePublic.ts` advances through `parseVariableDeclarationList`, then reaches
  the known `illegal cast` in `__call_fn_method_2` from
  `parseBinaryExpressionRest` (Wasm offset 83,123,160; the retained source-map
  fallback anchor is `parser.ts:10709:1`).

All **56** `tests/issue-1058-*.test.ts` files pass (**285/285 tests**). The four
merge-sensitive dynamic-dispatch suites add **65/65** passing tests. TS5 and
TS7 typechecks pass. This remains a compile/validation and runtime-frontier
advance, not a claim that the three AST fingerprints or TypeScript's upstream
unit tests pass.

## Current-main parser and size handoff (2026-08-31)

The follow-up branch is now merged forward to `loopdive/js2` `main` at
`f08c7c62ce96ce4cbfe8ec89dc7ec2e9a5d10dba` (merge commit
`b8f25effd2826109075f5dba053b60b6841f68df`). The final post-merge canonical
source probe still compiles TypeScript 5.9.3 successfully and emits valid Wasm.
The latest run took 372,529 ms in the worker / 373,428 ms wall time, retained
4,283 source functions after body compilation, and produced an
**85,102,452-byte** module. Peak RSS was **4,379.1 MiB**: the worker completed
within its configured 4,096 MiB V8 heap limit, but process RSS exceeded the 4
GiB target and must not be reported as a memory-gate pass. Its SHA-256 is
`fb1fbb02d76f1e2a514325154bfffec6f45d2b0c936cde1105d3e97ed33b73b0`;
the artifact and source map are
`/private/tmp/ts2wasm-typescript-parser-latest.wasm{,.map}`.

The size is generated-code amplification, not 9 MB of source being copied into
the module. In the measured 84.9 MB predecessor (the same retained source
graph and code-generation regime), the code section was 82,807,923 bytes
(97.53% of the whole module). `visitorPublic.ts` alone accounted for 589
functions and 76,811,865 function-body bytes (90.47% of the module), while
`parser.ts` accounted for 9,579 functions but only 3,667,500 bytes (4.32%).
Exact duplicate function bodies represented 37,099,453 bytes (44.81% of all
body bytes); gzip reduced the raw module to 14,153,303 bytes. This is why an
approximately 100 KB hand-written QuickJS parser is not comparable to this raw
artifact: js2 currently specializes TypeScript's large visitor callback table
into hundreds of 0.5--0.87 MB closures and retains duplicate discovery/final
cohorts. The result has not received whole-module unused-function elimination,
identical-code folding, or ordinary Wasm optimization. Removing unused module
elements alone previously reduced the artifact to about 41.1 MB, so the first
size fix belongs in reachability/deduplication rather than parser semantics.

This round added focused fixes for four concrete compiler gaps:

- TypeScript's merged brand-only `TypeNode` interface now aliases its exact
  physical `Node` parent under the source-authored zero-runtime brand contract.
  Token identity and post-store mutations remain observable; spoofed or
  value-read brands fail closed and retain a real field.
- Generic factory/callback detectors avoid whole-program binding scans before
  resolving a declaration and treat non-mutating unary property reads as reads,
  not writes.
- Nullable vec-to-vec/tuple projections preserve `undefined` before reading the
  source length. This clears the `createInterfaceDeclaration` heritage-clause
  null dereference while retaining populated element projection.
- Minimum callback arity is persistent across replacement of a shared
  `ClosureInfo` record. Optional declarations discovered before their source
  function handle exists now remain in a small pending set; later calls revisit
  only that set and register the exact capture/TDZ-stripped physical ABI.
  Parameter-expanded linear `Uint8Array` ABIs retain both pointer and length
  slots. This clears the former `parseIdentifierName` candidate miss.

The three runtime fingerprints do **not** pass yet:

- `builderStatePublic.ts` and `performanceCore.ts` clear the former
  `parseModuleExportName` / `parseIdentifierName` miss. They now advance through
  `parseImportSpecifier` and stop in `parseImportOrExportSpecifier` with a
  terminal TypeError at `parser.ts:8614:13`. This later carrier/callable miss
  needs its own focused trace; it is not evidence that the earlier callback
  registration fix failed.
- `corePublic.ts` cleared the former illegal cast and nullable heritage-array
  dereference. It now finishes parsing and fails in `clearState`; the reported
  `parser.ts:1784:32` location is one call early. Runtime instrumentation proves
  `scanner.setOnError(undefined)` succeeds. The actual miss is the following
  `scanner.setScriptKind(ScriptKind.Unknown)`: the live captured closure and its
  finalized `__call_fn_1` arm work, but the earlier call-site-local ladder was
  frozen before `createScanner` published that exact nominal trampoline type.
  The sound follow-up is a deferred/finalized callable-property dispatcher, not
  another eager signature guess or a `setOnError` special case.

The next focused follow-up now implements both diagnosed parser seams:

- Conditional expressions joining different nominal reference siblings no
  longer select the first arm's concrete layout and guarded-cast the other arm
  to null. Each arm first honors a lossless contextual reference carrier; with
  no contextual carrier, the result uses the nearest declared common struct
  ancestor (or `externref` when no such ancestor exists). The exact
  `StringLiteral | Identifier` shape behind
  `parseImportOrExportSpecifier` is covered, as is the contextual vec-union
  counterexample that would regress Redux reducers if joined at `__vec_base`.
- Eligible externref-backed callable properties now reserve one typed private
  dispatcher per declared ABI/result while lowering early call sites, then fill
  its body from the complete closure registry after all source bodies have been
  emitted. This admits `createScanner`'s later-published `setScriptKind(number)`
  trampoline without guessing another eager signature or shifting already
  baked module indices. The order-independent path is deliberately limited to
  zero-argument or all-scalar signatures: any admitted reference parameter can
  be indistinguishable from a source-rest closure prefix and still needs an
  argc/argv-aware carrier before it can be widened soundly.

At this checkpoint all **59** `tests/issue-1058-*.test.ts` files pass
(**301/301 tests**). The merge-sensitive #3996/#4294/#4470/#4486/#5166 and
TypeScript verdict controls add **117/117** passing tests. Both TS5 and TS7
typechecks pass, as do the focused formatter/linter, issue-ID, IR-fallback,
LOC/function-budget, and oracle-ratchet gates. The bounded pinned TypeScript
5.9.3 upstream adapter now passes **14/14** native and **14/14** Wasm callbacks
across four selected original files, including all three admitted
`comments.ts` scanner callbacks; **252** files / **1,747** registrations remain
explicitly deferred. These are focused and inventory-honest results, not a
claim that TypeScript's complete upstream unit suite passes. The post-fix
canonical three-fingerprint parser run remains the next required measurement.

## Parser-first carrier checkpoint and module plan (2026-08-31)

The latest pre-fix canonical artifact is **84,770,324 bytes** with **4,298
functions** (SHA-256
`7f2a39eea88146b5c5b595b0dd576d9bd217e574d7b138468fb2fe9dc6c2f464`). It
compiles, validates, and all three
workloads enter the compiled parser. The two remaining failures were reduced to
exact representation/order boundaries rather than parser algorithms:

- `builderStatePublic.ts` and `performanceCore.ts` reached NodeFactory with a
  generic `PunctuationToken` allocation carrier, while the generated
  `createPropertySignature` / `createMethodSignature` ABI demanded a distinct
  nominal `QuestionToken` alias leaf.
- `corePublic.ts` reached `cast(value, isLeftHandSideExpression)`, but the
  generic predicate's callable ladder was finalized before the later imported
  `Node -> boolean` predicate wrapper was visible.

Direct object type-reference aliases now reuse the referenced declaration's
exact carrier when their field ABI and source-level scalar brands match. The
referenced declaration remains the sole owner of shared field metadata, so
sibling specializations such as `Box<A>` and `Box<B>` cannot rewrite each
other's generic field carrier. Cross-source callback discovery now resolves
import aliases to their exported declarations, records exact source-declared
reference predicates, and admits their guarded `externref -> ref` argument
bridge only inside a callable type-predicate signature. Focused coverage passes
in both GC and standalone lanes; all **61** issue-1058 files pass (**306/306
tests**), the nine merge-sensitive/verdict controls pass **117/117**, the pinned
TypeScript slice passes **14/14** native and **14/14** Wasm callbacks, and TS7
typecheck passes.

The subsequent canonical run at `4f153cc9eb4bac` compiled and validated but did
not pass parser acceptance. It took 495,805 ms in the worker / 496,708 ms wall
time, retained 4,301 functions, and emitted a **91,625,084-byte** module. Peak
RSS was **4,310.3 MiB**, so it again completed within the configured 4,096 MiB
V8 heap while exceeding the 4 GiB process-RSS target. All three invocations
failed:

- `builderStatePublic.ts` and `performanceCore.ts` reached the exact registered
  `createPropertySignature` / `createMethodSignature` method arms but trapped
  while converting a parser-produced token. TypeScript's overload exposes a
  `PunctuationToken<T>`, whereas the implementation deliberately allocates its
  generic `Token<T>` parent. `PunctuationToken<T> extends Token<T> {}` had no
  physical members but was emitted as a distinct WasmGC child, making the
  original parent allocation fail the child-typed argument cast.
- `corePublic.ts` reached `createExpressionWithTypeArguments` and the exact
  `isLeftHandSideExpression` predicate target was present in `cast`. The value
  came from TypeScript's generic base-`Node` allocator, then crossed the
  `Expression -> UnaryExpression -> UpdateExpression ->
  LeftHandSideExpression` checker-only brand chain. Those documented zero-cost
  brands had nevertheless become physical fields and distinct nominal WasmGC
  children, so the original base allocation failed the predicate's `Node`
  carrier conversion.

A runtime-empty, single-base interface with stable physical layout now aliases
its parent's exact carrier. The rule requires one unmerged base, no physical
members, and exact ordered field/mutability/physical-brand equality. A merged
brand-only alias also records its carrier provenance so a later single-base
descendant can link through that alias to the real parent instead of remaining
a flat sibling. TypeScript's single-underscore syntax brands are erased only
under the source-authored "never actually given values / zero cost" contract,
only for interfaces descending from `Node`, and only when the complete selected
source graph contains no runtime read or write of that brand. Ordinary brands,
value-observed brands, member-bearing shapes, multiple-base interfaces, and
unstable layouts remain physical.

Production-shaped regressions now cover `NodeFactory.createToken`, the fourth
`createPropertySignature` `TypeNode` argument through a merged base, and the
generic base-`Node` allocation entering `cast(...,
isLeftHandSideExpression)`. They pass in the canonical GC lane (the token and
merged-`TypeNode` cases also pass standalone), while the sibling generic object
specialization and value-observed-brand controls remain green. All **62**
issue-1058 files pass (**309/309 tests**); the nine
merge-sensitive/verdict controls pass **117/117**, and TS7 typecheck passes.
Another canonical three-fingerprint run remains required before parser
acceptance can be claimed.

The immediate product boundary is a runnable **parser-only** artifact. Its
entry graph should link scanner, parser, syntax/node factories, and only their
required core/diagnostic initialization. Binder, checker, emitter, and language
services are not parser-milestone roots. Subsequent public entry graphs should
layer these capabilities explicitly:

1. scanner/parser and AST construction;
2. binder over an existing AST;
3. checker over parser+binder;
4. language/editor/incremental/server services as an opt-in graph.

Source-graph elimination must start from the selected entry API. Type-only
imports disappear, and a runtime module that is neither reachable nor
re-exported may be omitted only when its top-level evaluation is proven
effect-free. Side-effect imports, observable initializers, and module evaluation
order remain roots. Consumer-driven barrels should retain the named parser
bindings, not every export from `_namespaces/ts.js`.

A second DCE pass is required after lowering. Its roots are public exports,
module/start initialization, host-visible callbacks, and functions genuinely
reachable through `ref.func`, tables/elements, or dynamic registries.
Unreachable functions, globals, types, data, and table entries should be
removed, followed by identical-body folding. Current barriers are the broad
`ts` namespace barrel, eager module initialization, runtime namespace and
callable-dispatch registries, conservative `ref.func` rooting, and duplicate
discovery/final closure cohorts. The measured reduction from roughly 83.6 MB
to 41.1 MB using unused-module elimination already proves that a large fraction
of the parser artifact is removable generated code.

## Parser runtime identity follow-up (2026-08-31)

The next canonical parser-only run compiled and validated a **89,140,516-byte**
module with **4,300 functions**, but did not yet pass runtime acceptance. It
took 520,426 ms in the worker / 521,733 ms wall time and peaked at **4,529.9
MiB RSS**. The three real parser invocations advanced beyond the earlier token,
TypeNode, generic-callback, and vec-carrier failures, then exposed two exact
identity boundaries:

- `builderStatePublic.ts` reached `forEachChildInInterfaceDeclaration`, but an
  `InterfaceDeclaration` stored in `NodeArray<Node>` had been structurally
  projected to a physical `Node`. The later syntax-kind handler therefore
  could not cast it back to `InterfaceDeclaration`.
- `corePublic.ts` and `performanceCore.ts` reached
  `parenthesizeTypeArguments`. The factory method dispatcher converted the
  host Array facade through a fresh vec materializer instead of recovering the
  original NodeArray, dropping its identity-bound `pos` / `end` properties
  before `isNodeArray` observed it.

Flattened multiple-heritage interfaces now consider stable, unmerged
**transitive** declared ancestors and install only the largest exact
mutable-field-prefix edge. The production-shaped hierarchy now remains
`InterfaceDeclaration -> Declaration -> Node`, so a derived allocation keeps
its runtime identity through a base Node array. Method closure dispatch now
mirrors free-call dispatch by unwrapping live host facades before concrete
reference conversion. It also normalizes both omitted and explicitly supplied
JavaScript `undefined` to a nullable Wasm ref before casting.

The parser's earlier `forEach<T, U>` frontier is handled by a narrowly
source-certified bridge for direct, capture-free, single-parameter callbacks
whose physical formal is a **non-null** declared ref. Nullable generic callback
formals are deliberately excluded: JavaScript `undefined` is not Wasm null,
and admitting them would reintroduce an unconditional `ref.cast_null` trap.
Constrained type parameters are resolved to their base constraint only in
array-element position. This establishes the canonical `readonly T[]` /
`NodeArray<Node>` carrier needed here; it is not a claim that multiple distinct
derived-array instantiations of the same generic body are fully canonicalized.
That pre-existing order-dependent specialization case remains follow-up work.

Zero-cost syntax-brand erasure is now limited to the known TypeScript Node
brand allowlist declared in `src/compiler/types.ts` under TypeScript's own
zero-runtime-cost contract. Direct and constant-computed runtime observation
disables erasure. This keeps the parser optimization package-scoped instead of
treating similarly named fields in ordinary programs as phantom state.

All **62** issue-1058 files now pass (**313/313 tests**). The nine
merge-sensitive/verdict controls pass **117/117**, and both TS5 and TS7
typechecks pass. Parser acceptance is still intentionally unchecked here: the
branch must first merge the current `loopdive/js2` main and then rerun all three
canonical fingerprints on that final tree. Checker, emitter, and language
services remain outside this parser-first gate.

## Synced parser-first canonical checkpoint (2026-08-31)

The follow-up branch was rebuilt directly on `loopdive/js2` main
`3193ca16685de143af1ae1d6066978b2590c687d`. The canonical consumer-driven
parser graph still contains only **30 input/source files** (**34** total program
files) and **310** module-initialization statements; checker, emitter, and
language-service entry points remain outside this gate.

The first synced run compiled and validated a **69,179,695-byte** module in
345,273 ms wall time and peaked at **3,684.7 MiB RSS**. All three invocations
reached NodeFactory, then converged on one producer defect: a valid
StringLiteral allocated through TypeScript's generic base-node factory was
tested against a separately materialized `LiteralLikeNode` WasmGC carrier and
became null. A TypeScript-only, unmerged `LiteralLikeNode -> Node` carrier alias
now follows the package's documented zero-runtime-cost syntax contract. A
production-shaped regression reproduces the original `parseLiteralLikeNode`
null dereference before the fix and returns the expected value afterward.

The post-fix canonical run again compiled and validated. It emitted a
**69,178,167-byte** module (SHA-256
`32f0ab847dc6c0a2760345cc3285f399e14c204812469d59689586444ba8d0bb`) with
**4,413** source functions after body generation and **16** non-fatal IR
fallback warnings. It took 326,946 ms in the worker / 328,038 ms wall time,
used 360,403 ms CPU (1.10 average cores), and peaked at **3,915.7 MiB RSS**,
inside the 4 GiB process-RSS gate. The literal/import failure is gone, but the
three fingerprints are not yet accepted:

- `builderStatePublic.ts` and `corePublic.ts` now expose the next exact syntax
  seam. Concrete property/index-signature nodes already use the shared Node
  carrier, while `parseTypeMember(): TypeElement` returned through a distinct
  physical `TypeElement` carrier and converted those valid members to null.
  The same tightly gated TypeScript allocation-view rule now covers the
  unmerged `TypeElement` interface. A focused regression exercises both
  PropertySignature and IndexSignatureDeclaration values through the
  TypeElement return/array boundary.
- `performanceCore.ts` reaches its first heritage clause, `Performance extends
  PerformanceTime`. `tryParseTypeArguments()` correctly takes the `undefined`
  source branch, but the externref-to-nullable-NodeArray coercion tests only
  Wasm null. Host JavaScript `undefined` is a non-null externref, so it falls
  through `__array_from_iter(undefined)` and fabricates a truthy empty vec with
  no NodeArray `pos` / `end` metadata. The later `isNodeArray` cast correctly
  rejects it. Exhaustive WAT inspection proves every cache writer and the
  executable funcref target the exact `isNodeArray` trampoline; the misleading
  `'map'` text is only stale reflective function-name metadata. Nullable
  externref-to-vec materialization must preserve both null and undefined instead
  of synthesizing an empty collection.

After the two syntax-view repairs, the focused carrier set passes **58/58**.
Before the TypeElement follow-up, the complete issue-1058 suite passed all
**62** files (**315/315 tests**), both TS5 and TS7 typechecks passed, and
Prettier plus `git diff --check` were clean. Parser acceptance remains
intentionally unchecked until the cached-function identity defect is fixed and
all three canonical fingerprints match in one final synced run. This is still
not a claim that TypeScript's complete upstream unit suite passes.

## Final parser-first handoff checkpoint (2026-08-31)

The final synced branch still **compiles and validates the complete selected
parser graph**. The canonical run retained the same 30 input/source files, 34
program files, and 310 module-initialization statements. It emitted a
**69,198,117-byte** Wasm module with **4,403** functions after body generation
and 16 non-fatal IR-fallback warnings. Compilation took 386,124 ms in the
worker / 387,478 ms wall time. Peak process RSS was **4,479.9 MiB** with a
4,096 MiB V8 heap limit, so the module completed but did not meet the stricter
4 GiB process-RSS target. The exact runnable artifact and source map are
preserved at `/private/tmp/ts2wasm-typescript-parser-latest.wasm` and
`/private/tmp/ts2wasm-typescript-parser-latest.wasm.map`.

Two production-shaped carrier defects were closed before this run:

- vec-to-vec element projection now preserves host-backed expando/MOP state on
  the new physical vec. The focused NodeArray regression covers direct
  `DerivedNode[] -> Node[]` widening and the `forEachChild` optional `cbNodes`
  callback path, retaining `pos`, `end`, `hasTrailingComma`, and indexed
  elements;
- TypeScript's `PropertyAccessChain` now follows its exact
  `PropertyAccessExpression`/`Node` allocation carrier. The focused multi-file
  regression uses the real `src/compiler/types.ts` zero-cost-brand contract,
  multi-heritage base, repeated `name` declaration, full wrapper writes,
  contextual `NodeFactory`, and destructured parser alias. Renaming the view to
  an unrecognized control reproduces the null carrier; the exact TypeScript
  name passes.

The final runtime gate nevertheless remains open:

- `builderStatePublic.ts` still returns **13,385,293,184,043** instead of
  **13,386,537,220,945**;
- `corePublic.ts` still returns **40,101,707,600,196** instead of
  **40,098,163,538,143**;
- `performanceCore.ts` advanced beyond the earlier optional-property failure at
  parser line 6421, then trapped while parsing an arrow-function expression at
  parser line 5566 (`parseArrowFunctionExpressionBody`).

The unchanged first two values prove the focused vec projector is not the last
canonical metadata-loss path. The saved prebuilt-module replay driver at
`/private/tmp/run-prebuilt-typescript-parser.mjs` reconstructs the import
manifest and reruns a selector in roughly 14 seconds, so the next pass should
trace the identity of the `NodeArray<Node>` received by the fingerprint
visitor and locate the additional materialization/copy boundary before another
full rebuild. The performance follow-up should breakpoint the line-5566 ternary
and determine whether the selected context callback or its returned expression
is null. The earlier detailed trace is preserved at
`/private/tmp/ts-parser-trace-result-final-20260831.log`.

The complete focused #1058 suite passes **67 files / 330 tests**, including the
new PropertyAccessChain file at **4/4**, and TS5 typecheck passes. This
checkpoint is therefore a real compiling,
validating, partly runnable parser artifact, not parser semantic acceptance and
not a claim that TypeScript's upstream unit suite passes. Binder, checker,
emitter, language services, and post-link DCE remain the explicit later module
layers described above.

## Current-main publication checkpoint (2026-08-31)

The publication tree is now fast-forwarded to `loopdive/js2` main
`c281669805ea987c0c5c08e4681370d199b77a34`. Reapplying the parser work was
text-conflict-free, but the post-sync suite correctly exposed two semantic
composition gaps. Runtime-namespace destructuring now records each exact
`BindingElement` in the Program ABI and accepts a bare projected global only
when its allocator belongs to that binding; this restores namespace-local
NodeFactory callables without leaking writes to same-named outer or sibling
bindings. The synthetic IR-inline DAG context also supplies main's new
`moduleInitChunkHelperNames` field instead of weakening production validation.

After those repairs, the complete focused suite passes **67/67 files and
330/330 tests**. The nine merge-sensitive controls pass **117/117**, and both
TS5 and TS7 typechecks pass. Prettier and `git diff --check` are clean.

The canonical consumer-driven parser probe was rebuilt on this exact main tip.
It still selects **30 source files**, **34 program files**, and **310** module
initialization statements. Compilation succeeded, the emitted
**69,187,969-byte** Wasm module validates, and body generation retained
**4,439 functions** with 16 non-fatal IR warnings. The worker completed in
487,770 ms / 489,550 ms wall time, used 539,981 ms CPU (1.10 average cores),
and peaked at **3,685.6 MiB RSS**, now inside the stricter 4 GiB process target.
The refreshed artifact and source map remain at
`/private/tmp/ts2wasm-typescript-parser-latest.wasm` and
`/private/tmp/ts2wasm-typescript-parser-latest.wasm.map`.

The semantic frontier is unchanged, rather than regressed by the sync:
`builderStatePublic.ts` returns **13,385,293,184,043** instead of
**13,386,537,220,945**; `corePublic.ts` returns **40,101,707,600,196** instead
of **40,098,163,538,143**; and `performanceCore.ts` reaches the same mapped
`parser.ts:5566` null dereference in `parseArrowFunctionExpressionBody`. This
proves the parser module compile/validate gate on current main, but it is still
not parser semantic acceptance and not a claim that TypeScript's complete
upstream unit suite passes.

## Runnable parser publication checkpoint (2026-08-31)

The final publication candidate remains based directly on `loopdive/js2` main
`c281669805ea987c0c5c08e4681370d199b77a34`. Two additional runtime boundaries
were closed after the checkpoint above:

- TypeScript's generic parser context helpers may bind `callback()` to a stable
  `const` inside a nested lexical block. Certifying that binding by its
  enclosing function, rather than requiring it to be a direct function-body
  statement, preserves the callback's result carrier across calls. In
  particular, `doInAwaitContext` / `doOutsideOfAwaitContext` may first return a
  `NodeArray<ModifierLike>` and later return an `Expression` without freezing
  the helper to the first array carrier. The former null dereference at
  `parser.ts:5566` is gone.
- A host-facing Array mirror now resolves back to its authoritative Wasm vec
  before ordinary-property sidecars are copied. Both the reserved
  `__vec_from_extern` materializer and the direct `externref -> vec` coercion
  copy that state to the fresh typed vec. TypeScript's `NodeArray` `pos`, `end`,
  `hasTrailingComma`, descriptor, prototype, and extensibility state therefore
  survive the `createSourceFile -> forEachChildInSourceFile -> visitArray`
  round trip.

The canonical three-case consumer-driven probe compiled and validated a
**69,196,938-byte** Wasm module (SHA-256
`adc32174d19dfa6f2dd98b1cea9d50d6c761175592792d82d705b56e5f03c27e`). It
retained **30 input/source files**, **34 program files**, **310** module
initialization statements, and **4,439 functions** after body generation. The
16 diagnostics are the same non-fatal IR fallback warnings; there are no
compile or validation errors. The worker completed in 367,871 ms / 369,064 ms
wall time, used 404,945 ms CPU (1.10 average cores), and peaked at **4,240.2 MiB
RSS** with a 4,096 MiB V8 heap limit. This completed reliably but remains 144.2
MiB above the stricter 4 GiB whole-process RSS target. The exact artifact and
its source map (SHA-256
`7e224bc5d9eb9efaaa437bcb1133ae83386042a5fd31dfe5e47a6c2a3b00d565`) are
preserved at `/private/tmp/ts2wasm-typescript-parser-latest.wasm` and
`/private/tmp/ts2wasm-typescript-parser-latest.wasm.map`.

All three workloads now execute the compiled parser without trapping. Two are
exactly native-equivalent under the canonical structural fingerprint:

- `builderStatePublic.ts`: **13,386,537,220,945** expected and actual;
- `corePublic.ts`: **40,098,163,538,143** expected and actual;
- `performanceCore.ts`: **49,594,442,228,282** actual versus
  **49,645,738,923,599** expected.

The remaining performance difference is bounded and reproducible rather than
an execution failure. Statement count is exact at 11; the compiled traversal
visits 283 nodes versus native's 295. Statement-prefix isolation accounts for
all 12 missing nodes as three four-node type-annotation subtrees: the top-level
`performance: Performance | undefined` declaration and two
`() => PerformanceHooks | undefined` return annotations. Each missing subtree
is `UnionType -> TypeReference -> Identifier` plus `UndefinedKeyword`; the
other top-level statements and all 18 minimized parser controls are exact.

The exact residual is a result-carrier projection, not deliberate annotation
elision or a traversal-table defect. `parseUnionOrIntersectionType` builds and
finishes the concrete `UnionTypeNode`, but its terminal `externref -> TypeNode`
`ref.test` rejects that allocation carrier and returns null. The parent
therefore never receives its `.type` subtree. The probe's CLI status is
non-zero only because this one semantic fingerprint is not yet accepted; its
worker exited normally with successful compilation and validation.

The publication tree passes all **67/67** focused #1058 files and **332/332
tests**. The production-adjacent NodeArray/context matrix passes **9/9 files and
139/139 tests**. TS5 and TS7 typechecks, Prettier, `git diff --check`, the LOC
and function budgets, and the checker-oracle ratchet all pass. The pinned
TypeScript 5.9.3 upstream adapter also passes **14/14** admitted original
callbacks natively and **14/14** in Wasm across four selected test files; 252
upstream files remain explicitly deferred.

This checkpoint establishes the requested first module boundary: the selected
TypeScript parser graph compiles, validates, and runs real parser workloads,
with two canonical files exact and one precisely localized union-result carrier
residual. It is not a claim that the entire TypeScript unit suite or parser
semantic surface is complete. Binder, checker, emitter, language services, and
post-link dead-code elimination remain the separately layered follow-up work
described above.

## Exact parser acceptance and binder handoff (2026-09-01)

The parser-only milestone is now accepted. A fresh build of the pinned
TypeScript 5.9.3 consumer-driven scanner/parser graph selected **30 source
files**, **34 program files**, and **310 module-initialization statements**. It
compiled successfully, validated, and emitted a **68,781,935-byte** WasmGC
module with **4,440 functions** after body generation and the same **16**
non-fatal IR fallback warnings. The worker completed in 366,821 ms / 368,018 ms
wall time, used 400,412 ms CPU (1.09 average cores), and peaked at **4,002.7 MiB
RSS** with a 4,096 MiB V8 heap limit. That peak is **93.3 MiB below the strict
4 GiB whole-process RSS target**. The artifact
SHA-256 is
`033de5a467fe492ba8bf531c9daa927c436ee1b43b0c7cc98467f72fd0c63f72`;
the adjacent 48,038-byte source map SHA-256 is
`52fbd62d169554bc5c8d2abbc51da37eb1b077aa52950e5669037d1df27c02d6`.

All three canonical real-source fingerprints are exactly native-equivalent:

| workload | native | Wasm | status |
| --- | ---: | ---: | --- |
| `builderStatePublic.ts` | 13,386,537,220,945 | 13,386,537,220,945 | exact |
| `corePublic.ts` | 40,098,163,538,143 | 40,098,163,538,143 | exact |
| `performanceCore.ts` | 49,645,738,923,599 | 49,645,738,923,599 | exact |

The final two defects were separate representation boundaries. TypeScript's
hosted `UnionTypeNode` and `IntersectionTypeNode` are explicit allocation views
of the exact merged `TypeNode`/`Node` carrier; standalone retains their concrete
physical `types` field. After that repair, the remaining hash difference was
one event: `VariableDeclarationList.flags` held `Ambient` instead of `Ambient |
Const`. Proven fresh generic factories now keep their physical source carrier
when the logical instantiation is opaque, and `finishNode<T>` compound writes
use the finalized typed-member dispatcher before its genuine-host-object
fallback. The exact full-layout flag repro now returns **33,554,434** as native
does. This establishes the selected parser module, not the complete upstream
TypeScript parser unit suite.

The publication tree passes all **69/69** focused #1058 test files and
**336/336 tests**. The nine merge-sensitive and TypeScript-verdict controls pass
**117/117**, and both TS5 and TS7 typechecks pass.

The next self-host slice is a separate binder entry over an already parsed
`SourceFile`. Root `createSourceFile` and `bindSourceFile` directly rather than
the broad `_namespaces/ts.js` barrel. The intended capability boundary excludes
checker semantics, emitter, services, and server code; the current graph still
retains a specialized checker shell solely for `getNodeId`/`getSymbolId`. The
first bounded native/Wasm binder smoke oracle is:

```text
symbolCount * 65,536 + locals.size * 256 + bindDiagnostics.length
```

This packed count is intentionally only a first smoke oracle: different binder
states can collide on the same number, so it is not a semantic fingerprint.
The tracked binder workload now pins two committed controls whose exact fixture
bytes are authoritative:

| committed fixture | native binder smoke oracle |
| --- | ---: |
| `tests/dogfood/fixtures/typescript-binder/const-local.ts` | 65,792 |
| `tests/dogfood/fixtures/typescript-binder/duplicate-let.ts` | 131,330 |

A third value, **459,008**, was previously measured for an exported-class case
with a nested declaration, but the exact source text was not recorded. It is
not an acceptance control: first commit the literal fixture, then remeasure and
record its native result. Acceptance requires compile+validate, unchanged
pre-bind parser fingerprints, and exact native/Wasm results for every committed
binder smoke fixture. The oracle must then grow a deterministic sorted
name-and-flags sequence (or its stable hash) for locals and exports so distinct
binder states cannot pass solely by colliding on the packed count.

`binder.ts` is the smallest next capability slice at approximately 199 KB /
4,008 lines. The tracked workload resolves cleanly to **32 source files / 36
program files**, **6,974,097 selected input source bytes**, and **312
module-initialization statements**. Native TypeScript 5.9.3 recomputes the two
table values exactly from the committed fixtures.

The first full 900-second-budget compile attempt did not time out: it completed
body generation for **4,827 functions** and all late codegen passes in 625,740
ms / 626,423 ms wall, used 692,469 ms CPU (1.11 average cores), and peaked at
**3,970.7 MiB RSS**, 125.3 MiB below the strict 4 GiB process target. It emitted
no binary (`compileSuccess: false`), so no validation or binder invocation is
claimed. The result contained 25 diagnostics; its original bounded report put
20 IR warnings first and hid the decisive tail diagnostics. The probe now
prioritizes non-warning failures, with a focused fail-closed regression.

After that reporting fix, a fresh diagnostic-prioritized rerun again completed
all codegen phases without timing out: **4,827 functions**, 615,304 ms worker /
616,254 ms wall, 656,412 ms CPU (1.07 average cores), and **3,778.9 MiB peak
RSS**, 317.1 MiB below 4 GiB. It still emitted no binary, so validation and
invocation did not run. The 25 diagnostics were **four instances of the same
hard error and 21 warnings**. Each hard error is the #2090 fail-closed
stack-balance diagnostic in `createBinder`: operand-stack underflow by 3 in an
empty-typed block (body delta -3, expected 0). The active binder blocker is
localizing and repairing the missing value producer; the repeated signature is
not yet evidence of four independent defects.

An instrumented localization rerun completed in 634,968 ms worker / 635,901 ms
wall, used 676,862 ms CPU (1.06 average cores), and peaked at **3,703.4 MiB
RSS**, 392.6 MiB below 4 GiB. It confirmed four distinct physical bodies, at
`function body[190].if.then`, `function body[231].if.then[5].if.then`,
`function body[293].if.then[14].if.then`, and
`function body[293].if.then[60].if.then[5].if.then`. Every body constructs the
same memoized nested-function closure and has the same first negative net
prefix: 37 live operands immediately before a 40-field `struct.new`, followed
by the memo-local `local.set`. The deficit is therefore exactly three closure
constructor operands, not a stack-diagnostic accounting artifact.

A producer-provenance rerun completed in 630,303 ms worker / 631,263 ms wall,
used 703,130 ms CPU, and peaked at **3,897.4 MiB RSS**, 198.6 MiB below 4 GiB.
It identified all four sites as memoized reads of `bind`: the current plan has
33 value captures, no TDZ-flag fields, and one constructibility field (37
fields with the three-field closure header), while the cached type was already
40 fields wide at each emission site (36 captures plus the same header and
constructibility field). This rules out late type growth, DCE, and net-delta
accounting. A ten-line reproducer confirmed the general failure mode: Phase 0
publishes a wider capture ABI; compiling an earlier sibling promotes three
owner locals; the real reserved-entry compile recomputes a narrower plan while
the already-minted closure type and trampoline retain the provisional ABI. The
repair must therefore make the reserved Phase-0 capture plan canonical for the
function body, metadata, trampoline, and every constructor rather than padding
only the failing `struct.new`.

The capability graph is also not honestly checker-free yet. `binder.ts` and
`nodeFactory.ts` obtain `getNodeId` through the broad namespace, while private
name binding reaches `getSymbolId` through `utilities.ts`; both allocators and
their counters live in `checker.ts`. Consumer-driven specialization already
blanks more than 99% of that file's semantic content (only 13,444 non-whitespace
characters, 20/4,547 function-like nodes, and 2,114/261,341 AST nodes remain),
so its 3,094,493 blank-preserved raw bytes are not the present codegen bottleneck.
Move both ID allocators to a small shared identity module and direct-import it
to make the parser/binder/checker module boundary truthful, not as a claimed
performance fix. A local extraction would forfeit the unmodified-upstream-source
claim, so treat it as an explicit module-hygiene follow-up (or upstream it), not
as the current stack-balance or performance repair.

### Binder compile, validation, and runtime-namespace frontier (2026-09-01)

This supersedes the earlier stack-balance frontier above. On snapshot
`0280bc394964f1`, the canonical TypeScript 5.9.3 binder workload selected **32
input/source files**, **36 Program files**, and **312 module-initialization
statements**. It completed body generation for **4,828 functions**, compiled
successfully, and emitted a **76,915,977-byte** module that
`WebAssembly.validate` accepted. The worker used 718,317 ms CPU (1.12 average
cores) and peaked at **3,850.2 MiB RSS**, 245.8 MiB below the strict 4 GiB
process target. The result had **21 non-fatal warnings and no hard compile
errors**.

Both committed binder controls instantiated and reached execution, but first
stopped at the same runtime boundary: `visitorPublic.ts:374:5` called the
overloaded `Debug.assertEachNode` through a null namespace receiver. TypeScript
nominates the first bodyless overload as that property's `valueDeclaration`,
so the static namespace-call path had declined to the extern-method bridge.
Commit `b0f313de1f8af204ace11750c3bda9012180b26c` selects the unique body-bearing
declaration and retains the exact Program ABI identity check. Its circular
export-star regression executes the call and emits no
`__extern_method_call_*` import.

A fresh post-fix run again compiled and validated successfully. It completed in
656,354 ms worker / 657,223 ms wall, used 718,349 ms CPU (1.09 average cores),
peaked at **3,494.3 MiB RSS**, and emitted a **76,914,855-byte** module with
**4,828 functions**, **21 non-fatal warnings**, and no hard compile errors. Both
fixtures then entered `Debug.assertEachNode` and reached the next shared
boundary inside `shouldAssertFunction`: the computed self-read `Debug[name]` at
`debug.ts:189:56` still treated the mixed runtime namespace as its legacy null
placeholder. The probe correctly rejected both invocations and did not publish
`/private/tmp/ts2wasm-typescript-binder-latest.wasm{,.map}`.

The focused repair materializes one symbol-keyed namespace function projection
only when the checker proves that every possible computed-write key is a finite
string-literal set of unique executable exports. It selects overload
implementations by their body-bearing declarations, re-resolves exact Program
ABI handles after late-import shifts, and never serves the partial projection
for a bare/escaping namespace value or a non-admitted member. The exact
`Debug[AssertionKeys]` circular-barrel regression now compiles, validates, and
executes.

The first full rerun after that lowering change remained byte-identical to the
previous module and stopped at the same `Debug[name]` boundary. The projection
had not been admitted because consumer-driven specialization retained the
exported runtime variable `Debug.loggingHost` but blanked its annotation owner,
`LoggingHost`. The checker consequently treated the member as `any`, collapsed
`MatchingKeys<typeof Debug, AnyFunction>` to `any`, and could no longer prove a
finite key set. Commit `2fb2e6281be880a15d07ee8d669e0933933732ee`
adds a checker-only type closure rooted narrowly at retained exported namespace
variable annotations. It keeps the transitive `HostAlias` / `LoggingHost` /
`LogRecord` chain without turning type-only declarations or exported function
signatures into runtime roots. All four real `Debug` index sites then resolve to
the same 51-member string-literal union, while the selected graph remains
exactly **32 source files / 36 Program files**.

The authoritative namespace post-fix run completed in 679,516 ms worker /
680,545 ms wall, used 725,668 ms CPU (1.07 average cores), and peaked at
**3,859.4 MiB RSS**, 236.6 MiB below the strict 4 GiB process target. It
compiled and validated a **77,236,087-byte** module with **4,862 functions**,
**21 non-fatal warnings**, and no hard compile errors. Relative to the
pre-admission module, the additional 321,232 bytes and 34 functions prove that
the bounded namespace projection reached the binary. Both committed fixtures
passed the former `Debug[name]` frontier and then stopped while invoking the
imported property-derived callback `getEmitScriptTarget(options)` at
`binder.ts:586:9` (Wasm offset 14,612,147, source-map anchor 14,612,053).

The callback itself was present, but its exported const snapshot had been
initialized to null. `_computedOptions.target.computeValue` is a Wasm closure
field on a generic object whose receiver is represented as externref. During
module initialization, the JS-host property bridge cannot inspect WasmGC fields
because instance wiring has not completed. Callable exact-shape reads now stay
on the Wasm carrier/member-dispatch path in the host lane. Cross-source const
aliases then invoke the stored snapshot through a finalize-filled driver rather
than a body-time signature ladder: this sees closures registered by later
source units, pads under-applied calls to the implementation arity while
preserving the true argument count, and falls back directly for genuine host
callables. Both host and standalone bridges now trap when the live closure
exceeds their eight-formal ABI cap, so contextual types, property replacement,
aliasing, or spreads cannot turn an unsupported closure into a silent undefined
result. Standalone keeps its existing structural property reads.

The focused multi-module regression now verifies the original computed-option
callback, snapshot identity after the source property is replaced, a preceding
truthy alias, positional argument order, under-application, the >8-formal
boundary, direct/escaped/hoisted/factory/spread replacements before snapshot,
and a host-free build with zero function imports (**8/8 passing**). A
narrow real-upstream TypeScript probe selected **17
source files / 21 Program files**, emitted and validated **2,465,088 bytes** in
7.6 seconds with an 819.4 MiB peak, and invoked the previously null alias with
the expected result **99**.

The next authoritative binder run completed in 638,618 ms worker / 639,467 ms
wall, used 720,370 ms CPU (1.13 average cores), and peaked at **4,089.9 MiB
RSS**. It compiled and validated a **77,013,373-byte** module with **4,863
functions**, the same **32 source files / 36 Program files / 312 module-init
statements**, **21 non-fatal warnings**, and no hard compile errors. Both binder
oracles passed `getEmitScriptTarget` and reached `bindSourceFileAsExternalModule`
before trapping with a null dereference at `binder.ts:3133:9` (Wasm offset
14,778,839; source-map anchor 14,778,791). Focused probes prove the allocator,
its `getSymbolConstructor()` result, the exact small-graph late-assigned
constructor, and the individual filename, symbol, declaration-array, and
export-table operations; the remaining investigation is whether the complete
closure registry changes that dynamic constructor ABI or whether another
operation inside the call is the first null. Until both exact binder oracles
match, the binder slice is not accepted and the failed invocation does not
publish the latest artifact.

### 2026-09-01 stop handoff — draft PR #5390

Work is published from `codex/1058-typescript-binder` in draft PR **#5390**.
The parser milestone remains accepted; this checkpoint fixes the next binder
runtime boundary but does **not** claim binder or full TypeScript completion.

Validated at handoff:

- `tests/issue-1058-barrel-computed-option-capture.test.ts`: **8/8 passing**
  across host and standalone, including snapshot identity, under-application,
  runtime arity overflow, and direct/escaped/hoisted/factory/spread mutation
  controls.
- `tests/standalone-shared-globalthis-import.test.ts`: **2/2 passing**, proving
  the arity guard preserves linked-realm callable delegation.
- `pnpm run typecheck:ts5` and `pnpm run typecheck`: passing.
- `pnpm run check:ir-fallbacks`, issue-ID validation, formatting, and diff
  checks: passing.
- A narrow real TypeScript callback graph compiles, validates, and returns 99;
  the latest full binder module compiles and validates before the runtime trap
  described above.

Non-authoritative broader checks still expose existing branch/environment
noise: the #1712 dynamic suite has its prior Acorn `parse is not a function`
failure, #4384 retains its prior native-array 0-versus-42 failure, and direct
#3592 execution requires Node's experimental Wasm exception-reference support.
None is on the focused #1058 path.

Resume at `binder.ts:3133:9` inside `bindAnonymousDeclaration`, using both
committed binder oracles. First distinguish the complete-graph dynamic
constructor ABI from the filename/symbol/declaration/export-table operations
already proven independently. Do not rerun the ten-minute authoritative binder
until a focused discriminator changes that boundary. After binder parity, move
to the checker TS2322 oracle, then printer/emitter, and only then self-hosting.

### 2026-09-05 current-main sync and resumed frontier

Branch `codex/1058-typescript-binder` is synchronized with loopdive/js2 main at
`0a5a3e87df074982cc3022a95899fc62ad69b036` by merge commit
`0c9f00a0f3fb4f`. The two content conflicts were resolved by composition, not
side selection: module namespace objects retain main's immutable-global and
Node-builtin re-export entries together with this branch's declaration-aware
callable-handle refresh, while nested declarations retain main's promoted and
forwarded pre-registration ABI together with this branch's canonical reserved
capture plan. The seven conflict-focused suites pass **34/34**.

The sync exposed a TypeScript 5-only source typecheck regression inherited
from main: TS5's DOM declarations do not yet contain `WebAssembly.Tag`, while
TS7's do. Commit `45b7d783353d04` describes the feature-detected tag locally by
the only contract this runtime uses (constructible object identity). Both
`pnpm run typecheck:ts5` and `pnpm run typecheck:ts7` pass, and the linked
provider exception-identity suite passes **4/4**. `AGENTS.md` now uses
repository-relative memory links in commit `d3ff3a70028dd1`, so the documented
context resolves from every worktree rather than one retired checkout.

Current main also contains the focused discriminator for the prior
`binder.ts:3133:9` null-constructor hypothesis: a read-only GC-reference capture
whose declaring slot was boxed later is forwarded as its value instead of the
ref cell. The capture/constructor regression set passes **12/12**, including
both TypeScript late-constructor factories. This makes the mainline capture fix
a credible mover for the old runtime boundary, but it is not yet authoritative
proof for the full graph.

The first authoritative post-sync binder run used the same **32 source files /
36 Program files / 312 module-init statements** and remained actively in
codegen until the probe's 900,000 ms limit. It timed out after **900,044 ms**
wall / **647,781 ms CPU** (0.72 average cores), peaked at **1,882.5 MiB RSS**,
and last reported `src/compiler/parser.ts`; it produced no compile diagnostic,
no module, and therefore no binder invocation result. This is a measured
compile-time frontier, not evidence that the old runtime null survived. Resume
with a longer completion budget against this already-prepared pinned checkout,
then compare both exact binder oracle results. If construction succeeds but
each result is exactly 65,536 too high, inspect
`externalModuleIndicator`/`isExternalModule` before changing constructor
lowering.

The module plan remains capability-based: parser, binder, checker, and
printer/emitter are separate public roots. A runtime module that is neither
reachable from the selected runtime entry nor re-exported may be removed only
when its top-level evaluation is proven unobservable. A linked but otherwise
unused module remains rooted when import evaluation, an observable initializer,
or module evaluation order can affect behavior; side-effect imports therefore
remain roots. Post-lowering DCE starts from public exports,
module/start initialization, host callbacks, and genuine `ref.func`, table, or
dynamic-registry targets, then removes unreachable functions, globals, types,
data, and table entries before identical-body folding. The checker oracle after
the binder slice must be `const x: number = "str"` producing TS2322; `1 +
"str"` is valid TypeScript and is not a checker-negative control. Printer
equivalence should be a separate `createPrinter().printFile` slice before full
emit and self-hosting.

## Acceptance criteria

- [ ] `scripts/ts-compiler-stress.ts` exists and runs against a local `typescript` install
- [ ] Tier 2 (leaf modules: `core.ts`, `path.ts`) compiles cleanly
- [x] Tier 3 scanner+parser graph compiles, validates, and executes all three pinned real-source workloads
- [x] Consumer-driven source resolution narrows the parser graph with default
      resolution unchanged and focused static/dynamic-demand tests
- [ ] Binder slice compiles, validates, preserves the three accepted parser
      fingerprints, and matches both committed native/Wasm binder oracles
- [ ] ≥ 5 follow-up issues filed for concrete gap patterns
- [x] Results document the real-package compile rate, not hand-written toy subset (supersedes #452's scope)
- [x] **Stretch 1 (Tier 3):** compiled scanner+parser produces native-equivalent AST fingerprints for all three pinned real `.ts` files
- [ ] **Stretch 2 (Tier 4):** compiled checker subset reports TS2322 for `const x: number = "str"`
- [ ] **Moonshot (Tier 7):** js2wasm-compiled tsc can compile js2wasm's own source, and the second-stage output passes test262 at the same rate

## Non-goals

- Full TypeScript compatibility — stress test / correctness harvest, not reimplementation
- Compiling the language service (`typescript/lib/tsserver.js`) — out of scope
- Performance parity with native tsc — correctness first
- Incremental compilation state across runs — the real tsc caches; we don't need that for single-shot
- Type-checker edge cases even native TypeScript struggles with (infinite conditional types, deeply nested `infer`)

## Design notes

**Why this is harder than prettier (#1034).**

Prettier is a pure source-to-source transformer whose acceptance test is "compiled output == native output byte-for-byte" — a mechanical diff. TypeScript is a type checker whose acceptance test is "compiled checker arrives at the same type assignments as native checker" — a semantic test over a graph of Type nodes, not a string diff. Much harder to verify, much more informative when it passes.

**Why this is easier than it looks.**

TypeScript compiles itself every day at Microsoft. The code is battle-tested. If a pattern works in real tsc, it's a pattern we *should* handle. Every failure in our compile is a concrete bug in js2wasm, not ambiguous tooling interaction. Unambiguous feedback: either we handle TypeScript's idioms or we don't.

**Self-hosting is the ultimate integration test.**

Every compiler gap today hides behind test262 or equivalence abstractions. Self-hosting breaks that — if we can't compile our own frontend, we know *exactly* which path is broken because tsc compiled that path a million times before. Strongest correctness signal available.

**Relationship to #452.**

#452 proved feasibility at the *pattern* level — 19/20 TypeScript idioms compile. This issue is the implementation at the *codebase* level — real modules, real call graphs, real type definitions. Complementary: #452 said "the puzzle pieces fit," this issue says "now build the puzzle."

**Why backlog-level dependency on #1046.**

TypeScript's source is split across ~300 ES modules with an intricate import graph. Current `compile(src, options)` assumes whole-program input. #1046 (separate ES-module compilation) is the architectural enabler that lets each file compile against declared imports without inlining the entire graph. Until #1046 is at least partially landed, Tier 2+ is blocked on "can we even load the second file."

## Related

Fifth in the real-world stress-test set:
- **#1031 lodash** — pure compute (generic algorithms)
- **#1032 axios** — I/O, Node host imports
- **#1033 react** — closures, hooks, DOM host imports
- **#1034 prettier** — parsers, recursive AST, string-heavy, self-format diff
- **#1058 TypeScript (this)** — self-hosting, type checking, everything at once

**Supersedes the scope of #452** (pattern-level feasibility study, #452 stays in done/ as historical validation).
**Depends on** #1042 (async/await), #1044 (Node builtins as host imports), #1046 (separate ES-module compilation).
**Soft dependencies:** template literal interpolation, large-switch codegen, recursive type inference.
**Unlocks:** ultimate self-hosting milestone, concrete stewardship-pitch deliverable ("js2wasm compiles tsc").

## Stewardship angle

"js2wasm compiles 60% of test262" is a percentage. "js2wasm compiles the TypeScript compiler itself" is a story. Landing even Tier 3 is the single strongest artifact for conversations with potential maintainers or funders — it demonstrates the compiler has enough depth to handle production TypeScript, not just hand-picked benchmark inputs. The gap between "a toy subset compiles" and "the real compiler compiles" is exactly what separates a proof-of-concept from a usable tool.
