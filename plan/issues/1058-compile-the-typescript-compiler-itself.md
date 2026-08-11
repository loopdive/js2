---
id: 1058
title: "Compile the TypeScript compiler itself to Wasm — self-hosting stress test"
status: ready
created: 2026-04-11
updated: 2026-08-09
priority: high
feasibility: hard
model: fable
reasoning_effort: max
goal: compiler-architecture
sprint: Backlog
depends_on: [1042, 1044, 1046]
required_by: [1059, 1066, 1165, 1584]
loc-budget-allow:
  # The stacked TypeScript-source validation branch includes #4267/#4268's
  # overload-owner fixes in the declaration driver. The pruning subsystem
  # itself lives in src/resolve/consumer-driven-barrels.ts.
  - src/codegen/declarations.ts
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
4. **Tier 4 (checker subset):** compile enough of `checker.ts` to type-check `1 + "str"` and report a type error
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

## Acceptance criteria

- [ ] `scripts/ts-compiler-stress.ts` exists and runs against a local `typescript` install
- [ ] Tier 2 (leaf modules: `core.ts`, `path.ts`) compiles cleanly
- [ ] Tier 3 attempted — even a partial compile produces valuable error data
- [x] Consumer-driven source resolution narrows the parser graph with default
      resolution unchanged and focused static/dynamic-demand tests
- [ ] ≥ 5 follow-up issues filed for concrete gap patterns
- [ ] Results document the real-package compile rate, not hand-written toy subset (supersedes #452's scope)
- [ ] **Stretch 1 (Tier 3):** compiled scanner+parser produces AST shape-equivalent to native ts for ≥ 3 real `.ts` files
- [ ] **Stretch 2 (Tier 4):** compiled checker subset detects `1 + "str"` as a type error
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
