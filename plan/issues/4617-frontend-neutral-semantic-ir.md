---
id: 4617
title: "Frontend-neutral semantic IR snapshot for TypeScript 7 and Acorn"
status: in-progress
created: 2026-08-22
updated: 2026-09-01
assignee: ttraenkler/codex
branch: codex/4617-frontend-neutral-semantic-ir
priority: critical
feasibility: hard
reasoning_effort: high
task_type: architecture
area: compiler, checker, codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [1930, 3518, 3520, 3521]
related: [4218, 4410, 4411, 4589, 4590]
files:
  - src/checker/index.ts
  - src/checker/oracle.ts
  - src/checker/oracle-declaration-snapshot.ts
  - src/compiler.ts
  - src/ts-api.ts
  - src/ir/identity.ts
  - src/ir/integration.ts
  - src/ir/planning-identity.ts
  - src/ir/semantic-declaration-snapshot.ts
  - src/ir/semantic-function-value-route-facts.ts
  - src/ir/semantic-function-value-source-projection.ts
  - src/ir/program.ts
  - src/ir/prepared-component-sealing.ts
  - src/codegen/certified-function-value-authority.ts
  - src/codegen/certified-function-value-evidence.ts
  - src/codegen/certified-function-value-materialization.ts
  - src/codegen/closures.ts
  - src/codegen/closures/method-trampolines.ts
  - src/codegen/declarations.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/ir-overlay-identity.ts
  - src/codegen/ir-overlay-outcomes.ts
  - src/codegen/legacy-body-audit.ts
  - src/codegen/multi-prepared-body-skips.ts
  - src/codegen/multi-prepared-callable-orchestration.ts
  - src/codegen/multi-prepared-program.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - src/codegen/multi-prepared-fibonacci-pair.ts
  - src/codegen/multi-prepared-function-value-declaration-replay.ts
  - src/codegen/multi-prepared-function-value-import-target.ts
  - src/codegen/program-abi-finalization.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/registry/imports.ts
  - tests/issue-4590-bench-loop-prepared-cutover.test.ts
  - tests/issue-4591-fib-pair-prepared-cutover.test.ts
  - tests/issue-4617-declaration-replay-mutations.test.ts
  - tests/issue-4617-certified-function-value-materialization.test.ts
  - tests/issue-4617-semantic-declaration-snapshot.test.ts
  - tests/issue-4617-semantic-function-value-source-projection.test.ts
  - tests/dogfood/acorn-harness.mjs
---

# #4617 — frontend-neutral semantic IR snapshot for TypeScript 7 and Acorn

## Problem statement

js2wasm currently has a useful but incomplete semantic boundary. TypeScript
source is parsed, bound, resolved, and checked into live TypeScript compiler
objects; code generation, optimization, ABI planning, and some Prepared-IR
certification continue to query those objects while lowering. This couples the
frontend to the rest of the compiler in several directions:

```text
TypeScript source ── TypeScript frontend adapter ─┐
                                                  ├──> Versioned semantic IR
JavaScript source ── Acorn frontend adapter ──────┘             │
                                                                ▼
                                                    Prepared IR → ABI → Wasm
```

The architectural boundary in this issue is deliberately different from the
direct-codegen retirement tracked by #3518. #3518 moves code generation behind
Prepared IR, while this issue makes the facts consumed by that downstream
pipeline independent of the language frontend. Both are required for the
eventual product shape, but one does not imply the other.

The semantic IR is not a TypeScript parser or type checker. Parsing, binding,
module resolution, and language-specific semantic analysis remain frontend
responsibilities. The adapters must convert the facts needed by later stages
into stable records, including explicit unknown/unsupported/invariant outcomes
when a fact cannot be proven.

The invariant is:

> After construction of the semantic IR, no compiler stage may require a
> `ts.Node`, `ts.Symbol`, `ts.Type`, `ts.Signature`, `ts.TypeChecker`, Acorn AST
> node, or any other frontend-specific object.

The IR must be serializable and replayable in a process in which neither
TypeScript nor Acorn is loaded. A TypeScript 6 process may initially produce the
snapshot, but it must not remain an implicit dependency of Prepared IR, ABI
planning, optimization, runtime-contract selection, or Wasm emission.

Today Acorn is only used by a dogfood harness: `tests/dogfood/acorn-harness.mjs`
loads a pinned Acorn source file and passes it through `compile` with
`skipSemanticDiagnostics`, so the compiler still uses the TypeScript JavaScript
mode rather than an Acorn frontend adapter (`tests/dogfood/acorn-harness.mjs:1-25,
93-112`). Acorn cannot automatically reuse the current downstream pipeline
unless it reconstructs equivalent binding, module, type-carrier, ABI, and
runtime facts.

## Current measured state

The following is a read-only inventory measured on the current worktree. The
worktree contains unrelated dirty compiler changes from another task; none of
those files are part of this planning change. Counts below are categorized
because no single textual total distinguishes direct checker calls, oracle
queries, AST retention, and semantic facts that have already been projected.

### Direct TypeScript API surface

The repository's #1930 ratchet reports:

```text
node scripts/check-oracle-ratchet.mjs --verbose
[oracle-ratchet] current totals: getTypeAtLocation=462, ctx.checker=938
[oracle-ratchet] OK — no net checker-usage growth across 20 changed src/codegen file(s)
```

The ratchet intentionally counts only `getTypeAtLocation` and `ctx.checker`
under `src/codegen`, and it is change-scoped. Independent read-only searches
show the surrounding surface:

```text
rg -l -g '*.ts' '\\bctx\\.checker\\b|\\bgetTypeAtLocation\\s*\\(' src/codegen | wc -l
95

rg -o -g '*.ts' '\\bgetTypeAtLocation\\s*\\(' src/codegen | wc -l
462

rg -o -g '*.ts' '\\bctx\\.checker\\b' src/codegen | wc -l
937

rg -o -g '*.ts' '\\b(?:ctx\\.)?oracle\\.[A-Za-z0-9_]+' src/codegen | wc -l
344
```

The 937-versus-938 textual difference is intentionally not reconciled into a
new baseline here: the ratchet's own occurrence counter is the authoritative
measurement for its gate, while the independent search is a file/surface
inventory. The repository also has many direct checker methods outside those
two ratchet patterns. A selected-method search across the codegen, IR, linear
codegen, and compiler seams found 1,137 occurrences of methods such as
`getSymbolAtLocation`, `getTypeAtLocation`, `getSignaturesOfType`,
`getResolvedSignature`, `getAliasedSymbol`, `getExportsOfModule`, and
`typeToString`:

```text
rg -o -g '*.ts' \\
  '\\b(?:getSymbolAtLocation|getTypeAtLocation|getSignaturesOfType|getResolvedSignature|getAliasedSymbol|getExportsOfModule|typeToString)\\s*\\(' \\
  src/codegen src/ir src/codegen-linear src/compiler.ts | wc -l
1137
```

### Frontend queries already behind the oracle

The 344 oracle-member occurrences are not 344 distinct query families. The
current `TypeOracle` surface includes `typeFactOf`, `staticJsTypeOf`,
`isBooleanProducing`, `nullabilityOf`, `unionPartsOf`, `signatureOf`,
`propertyFactOf`, `elementFactOf`, `contextualFactOf`, `builtinReceiverOf`,
`typeKeyOf`, `declaredNameOf`, `declarationsOf`, and
`valueDeclarationOf` (`src/checker/oracle.ts:25-166`). The public surface avoids
returning `ts.Type`, but still accepts and returns AST objects, so it is an
oracle boundary rather than a frontend-neutral snapshot boundary.

### Frontend objects retained or crossing the proposed boundary

The current counts are:

```text
rg -o -g '*.ts' '\\bts\\.(?:Type|Symbol|Signature|TypeChecker)\\b' src/codegen src/ir | wc -l
645

rg -o -g '*.ts' '\\bts\\.SourceFile\\b' src/codegen src/ir | wc -l
447

rg -n 'Map|WeakMap|Set' src/codegen src/ir | \\
  rg 'ts\\.(?:Node|Symbol|Type|Signature|SourceFile)' | wc -l
238
```

These are source references, not a claim that every occurrence is a long-lived
heap leak. The important concrete crossings are:

- `src/checker/index.ts:1056-1064` defines `MultiTypedAST` with
  `sourceFiles: ts.SourceFile[]`, `entryFile`, `checker: ts.TypeChecker`, and
  `program: ts.Program`. `analyzeMultiSource` creates source files, a program,
  and a checker (`src/checker/index.ts:1073-1158`), then orders dependencies
  before importers and the entry last (`src/checker/index.ts:1170-1228`).
- `src/compiler.ts:809-825` retains `userSourceFiles`, typed-AST state, and
  diagnostics in `PipelineInput`; the shared pipeline begins at
  `src/compiler.ts:894` and still contains JavaScript retry/diagnostic paths at
  `src/compiler.ts:1419-1505,1715-1776`.
- `src/codegen/context/create-context.ts:35-77` stores a live
  `checker: ts.TypeChecker` and constructs the oracle from it. The context type
  likewise exposes `checker` beside `oracle`.
- `src/ir/planning-identity.ts:58-72` retains maps from `ts.SourceFile` to
  `IrSourceId`, `ts.Node` declarations to `IrUnitId` and `IrClassId`, and source
  files to module-init statements. Its construction and validation at
  `src/ir/planning-identity.ts:464-725` depend on exact object identity.
- `src/ir/program.ts:190-204` has a sealed in-memory `PreparedIrProgram`, but
  its reconciliation is still `"pending-production-wiring"`. It is a useful
  downstream structural seam, not a general semantic snapshot/replay format.

### Late semantic queries

Late queries remain in the codegen path even where an IR candidate or ABI draft
already exists. Representative sites include:

- `src/codegen/index.ts:1498-1776` for class parameters, members,
  accessors, and signatures; `src/codegen/index.ts:7722-7842` for direct symbol
  and alias resolution; `src/codegen/index.ts:9430-9440` for identifier type
  facts; and `src/codegen/index.ts:4599-4602,8113-8120` for late library and
  type scans.
- `src/codegen/literals.ts:217-250,352-369,1522-1870,2339-2378,2648-2732`
  for contextual types, anonymous object maps, method signatures, and carrier
  selection.
- `src/codegen/declarations.ts:239-284,618-622,793-823` for function
  parameter/return ABI, generator, and async facts.
- `src/codegen/expressions/calls.ts`, `src/ir/module-bindings.ts`, and
  `src/ir/integration.ts` for call signatures, import bindings, and lowering
  facts that are still recovered from frontend-shaped inputs.
- `src/codegen/multi-prepared-scalar-leaf.ts:487-580,981-1105` demonstrates
  the current direction: an exact candidate is certified before a direct-body
  skip, a Prepared component and Program ABI receipt are carried forward, and
  the route is re-proven later. The proof still uses AST identity and oracle
  queries rather than a serializable semantic record.

### Existing reusable infrastructure

The repository already has several pieces that should be reused rather than
replaced:

- Frontend-qualified identity records in `src/ir/identity.ts:9-23,100-139`
  (`IrSourceId`, `IrUnitId`, `IrClassId`, `IrBindingId`, source/unit/class
  records), plus inventory validation in the planning identity context.
- Source-qualified Program ABI planning and publication in
  `src/codegen/program-abi-session.ts:1-205` and
  `src/ir/program-abi.ts`. The session freezes exact source/unit locators,
  plans retained callables and module-init bindings, and rejects publication
  after the planning boundary.
- Prepared component dependency evidence and terminal sealing in
  `src/ir/prepared-component-dependencies.ts` and
  `src/ir/prepared-component-sealing.ts:177-260`, including exact callable,
  class-layout, import/provider, closure, and dynamic-support failures.
- Route receipts and audit streams in
  `src/codegen/context/body-route-audit.ts`,
  `src/codegen/legacy-body-audit.ts`, and
  `src/codegen/multi-prepared-scalar-leaf.ts`. IR outcomes, capability
  provenance, and Prepared-component dependency records provide the beginnings
  of replayable evidence, even though they are not yet a semantic snapshot.
- The #3518/#3520/#3521 migration seams: `PreparedIrProgram`, source-qualified
  identity, Program ABI binding, sealing, route audit, and oracle abstractions.
  These are the correct substrate for a frontend-neutral handoff.

A focused search for a general semantic-IR serializer, deserializer, or
snapshot reader under `src/ir` and `src/codegen` found no production format.
The first implementation must therefore add a deliberately small record/replay
slice, not pretend that current Prepared objects are already serializable.

## TypeScript 7 constraint

This issue is based on the current official Microsoft/TypeScript sources:

- The [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
  says that TypeScript 7 can be installed and used through its CLI, but that
  7.0 does not ship an API; the new API is expected in 7.1 and is different
  from the TypeScript 6 API. It explicitly says embedded languages/tooling must
  continue using TypeScript 6 until that API exists.
- The official [TypeScript-go API discussion](https://github.com/microsoft/TypeScript-go/discussions/455)
  describes a curated API rather than a promise to expose every compiler API,
  and discusses consumers communicating with the compiler through a process
  boundary/message passing in common deployments.
- The official [TypeScript-go API roadmap issue](https://github.com/microsoft/TypeScript-go/issues/4830)
  tracks the supported API as a future roadmap and notes that a top-level
  `createProgram(options)`-style experience is not yet the supported substitute
  for the TypeScript 6 API.

Therefore:

- TypeScript 7 can be used for CLI typechecking independently of this project.
- TypeScript 7 currently does not provide a stable embedded API equivalent to
  the TypeScript 6 compiler API.
- The likely future API is curated and may be used through an out-of-process or
  message-passing service boundary; it must not be assumed to reproduce every
  TypeScript 6 object or method.
- The architecture must not depend on TypeScript 7 reproducing `ts.Node`,
  `ts.Symbol`, `ts.Type`, `ts.Signature`, `ts.Program`, or any other TypeScript
  6 object graph.
- TypeScript 6 remains a temporary semantic-snapshot producer until a TypeScript
  7 adapter can provide all facts required by the shared IR.
- TypeScript 7 CLI diagnostics alone cannot drive code generation. Diagnostics
  are not the complete binding, overload, narrowing, runtime-carrier, closure,
  ABI, or module-initialization fact set required below.

The current repository makes this constraint visible in
`src/ts-api.ts:184-212`: the TypeScript 7 facade synthesizes an incomplete
object and throws for `createProgram`, `createSourceFile`, and
`createCompilerHost`, directing callers toward a subprocess API and the
upstream API work. This issue does not treat that facade as a supported embedded
compiler API.

## Goals

- Define a frontend-independent, versioned semantic IR.
- Ensure no TypeScript or Acorn object appears below the frontend boundary.
- Add a TypeScript 6 adapter that initially produces the semantic IR.
- Add a future TypeScript 7 adapter that produces the same semantic IR.
- Add an Acorn adapter for plain JavaScript.
- Make Prepared IR, the ABI planner, optimizer, runtime contract, and Wasm
  backend common to both frontends.
- Make semantic planning deterministically serializable and replayable.
- Represent unknown/dynamic JavaScript semantics conservatively rather than
  manufacturing optimistic static facts.
- Preserve exact provenance for every semantic claim, including abstentions,
  withdrawals, and invariant failures.

## Non-goals

- Reimplementing the complete TypeScript type checker inside the semantic IR.
- Immediately deleting TypeScript 6.
- Depending on unstable TypeScript 7 internals or an uncommitted API shape.
- Replacing Acorn in this slice.
- Optimistically supporting every JavaScript construct.
- Removing dynamic runtime semantics.
- Combining frontend decoupling with direct-codegen handler deletion.
- Performing a flag-day rewrite of all existing IR structures.

Direct-codegen handler deletion continues through #3518 and its children. This
issue provides the evidence boundary that lets those handlers eventually be
removed without keeping frontend objects alive downstream.

## Semantic IR contract

The semantic IR must contain stable, frontend-neutral records for at least the
following. Record shapes may evolve, but a consumer must never need to recover
these facts by reopening a frontend object.

### Identity and provenance

- Stable source, declaration, symbol, binding, and executable-unit identities.
- Source ranges, source-content identity, declaration locations, and diagnostic
  provenance.
- Lexical scopes, hoisting, captures, and closure ownership.
- Exact origin for a fact: source range, frontend, analysis mode, rule/version,
  confidence, and whether the result is proven, unknown, unsupported, withdrawn,
  or invariant-failing.

### Modules and execution

- A canonical module graph, imports, exports, aliases, re-exports, and
  CommonJS facts.
- Module-initialization ordering and ownership, including the source/unit that
  owns each initializer.
- Call-graph edges and function-value-use edges, including imported-call and
  callback relationships.
- Runtime capability and host-import requirements.

### Types, calls, and values

- Resolved callable signatures, parameter/return representations, overload
  selection, and relevant generic substitutions.
- Canonical semantic value types and runtime carrier representations.
- Constant values and computed-name resolution.
- Operator and coercion decisions.
- Mutation, reassignment, escape, and effect information.
- Control-flow facts and narrowing facts required by lowering.
- Explicit unsupported, withdrawn, unknown, and invariant outcomes.

The IR must distinguish source-language types from runtime representations. For
example, `number`, a narrowed numeric value, a boxed value, an `externref`, and
an ABI `f64` carrier are related facts but not interchangeable types. Wasm
types are an output/lowering representation, not the only semantic type model.

### Classes, closures, and ABI

- Class heritage, member identities, fields, constructors, accessors,
  initializer order, and canonical class layouts.
- Closure environments, captured bindings, ownership, lifetime/escape facts,
  and function-value representations.
- Program ABI bindings, slot intent, callable signatures, module-init bindings,
  support bindings, and exact provenance for every binding.
- Prepared-component selection, dependency evidence, terminal ownership, and
  sealing outcomes that can be validated without the frontend.

The semantic IR may contain a fact whose value is `unknown` or `unsupported`.
It must not contain a pointer to a frontend object or a recipe that says “ask
the checker again later.”

## Frontend responsibilities

### TypeScript adapter

The TypeScript adapter is responsible for parsing, binding, module resolution,
and TypeScript semantic analysis. It must:

- run initially against TypeScript 6;
- convert the required TypeScript facts into stable semantic records;
- assign frontend-neutral source/declaration/symbol/binding/unit identities;
- preserve ranges and exact provenance for every converted fact;
- never leak TypeScript objects through the semantic-IR boundary;
- later support TypeScript 7 only through its stable supported API or an
  explicitly supported service/process boundary;
- produce the same semantic-IR contract whether facts came from a TypeScript 6
  process or a TypeScript 7 process/service.

The adapter may use the TypeScript checker internally. Once the snapshot is
constructed, the checker, program, source files, symbols, types, signatures,
and AST nodes are disposable.

### Acorn adapter

The Acorn adapter is responsible for parsing JavaScript and producing the same
frontend-neutral records. It must include a correct binder/scope model for:

- hoisting and Annex B-sensitive behavior;
- lexical scopes, captures, and closures;
- ES modules, CommonJS, aliases, and module initialization;
- classes, heritage, fields, constructors, accessors, and initializer order;
- function values, calls, reassignment, mutation, and escape.

It may infer only facts that can be proven from the JavaScript source and its
configured analysis. When proof is unavailable it must record `unknown`, use a
dynamic runtime capability, withdraw the optimization, or reject the construct
with actionable provenance. It must conservatively handle or reject direct
`eval`, `with`, proxies, dynamic properties, getters, and Annex B-sensitive
behavior. The adapter must preserve ordinary JavaScript runtime semantics; a
smaller optimized subset is acceptable, an unsound static guess is not.

The existing `tests/dogfood/acorn-harness.mjs:93-112` is an input/dogfood path,
not evidence that this adapter exists. Its pinned Acorn source currently enters
the TypeScript JavaScript/checkJs path.

## Serialization and versioning

The snapshot contract must require:

- a deterministic schema version and explicit record-kind versions;
- stable ordering for sources, scopes, identities, graph edges, facts, and
  diagnostics;
- no memory addresses, object identity hashes, TypeScript compiler-object
  identities, Acorn node identities, or process-local ordering;
- reproducible hashes for identical source contents, options, adapter version,
  and semantic inputs;
- a documented backward-compatibility policy, including which schema versions
  can be read and when migration is mandatory;
- source-content fingerprints and compiler-option fingerprints;
- frontend, adapter, runtime-capability, and schema-version negotiation;
- actionable failures for stale, truncated, tampered, unsupported, or
  incompatible snapshots.

This issue does not mandate JSON, protobuf, CBOR, or another wire format. The
repository has deterministic audit/receipt patterns but no general semantic
snapshot format, so the wire-format decision belongs to the schema child issue
after the record set is understood.

## Replay and mutation-proof gates

The decisive replay mode must:

1. construct and serialize semantic IR using the current TypeScript 6 frontend;
2. terminate or isolate the frontend process;
3. reload the snapshot in a process where TypeScript and Acorn are unavailable
   or actively poisoned;
4. complete Prepared IR, ABI planning, code generation, instantiation, and
   runtime execution from the snapshot;
5. prove that no late frontend query occurred.

The gate must include mutation tests that deliberately omit, reorder, alter, or
tamper with semantic facts. A consumer must fail closed with a provenance-rich
missing-evidence, stale-snapshot, unsupported, or invariant result. It must not
consult TypeScript, load Acorn as a fallback, silently guess, or produce a
different ABI/runtime result. A poisoned checker/oracle and an unavailable
frontend module are separate negative tests because a process can accidentally
retain a module loader even after a live-query path has been disabled.

Existing `tests/issue-4590-bench-loop-prepared-cutover.test.ts:98-105,270-390`
and the related route code already demonstrate useful positive and negative
patterns: direct-body poisoning, kill-switch controls, runtime parity, exact
Prepared/ABI evidence, tamper failure, and withdrawal before a direct skip.
Snapshot replay must move that proof from in-memory receipts to an independent
semantic record.

## Cross-frontend equivalence

For plain `.js` fixtures accepted by both frontends:

- build semantic IR through TypeScript's JavaScript mode and through Acorn;
- normalize only documented frontend-specific diagnostics and provenance;
- compare stable identities, module relationships, call/value-use edges,
  runtime representations, Prepared outcomes, Program ABI bindings, generated
  behavior, and supported artifact surfaces;
- require runtime parity for the shared supported surface;
- do not require artificial equality for facts available only from TypeScript
  unless those facts affect lowering, ABI, runtime behavior, or a declared
  capability decision.

The comparison must classify differences as equivalent, frontend-only and
irrelevant, conservative withdrawal, unsupported, or a genuine lowering/runtime
disagreement. Byte-identical Wasm is not required when semantic, ABI, surface,
and runtime parity are proven.

## Migration phases

Each phase is independently landable. “Exit evidence” is deliberately stronger
than a compile success; “rollback” names the safe boundary for reverting the
phase; “remaining” prevents a bounded phase from being mistaken for completion.

| Phase | Entry conditions | Exit evidence | Rollback and what remains |
| --- | --- | --- | --- |
| **A — inventory and ratchet** | #1930 oracle surface, the current direct-query inventory, and the #3518 R1–R4 seams are available. | Categorized direct-API/AST-retention inventory is checked in; new raw frontend API uses below `ctx.oracle` are forbidden or explicitly reviewed; ratchet output is reproducible. | Revert the ratchet/docs change. Existing debt remains; no frontend objects have been removed. |
| **B — schema and identifiers** | Source-qualified identity and Program ABI records from #3520 are available. | Frontend-neutral records cover source/declaration/binding/unit identity, ranges, provenance, values, and explicit unknown/unsupported outcomes; deterministic serialization tests pass. | Keep the old in-memory IR and adapters; discard only the new schema reader/writer. The record set is still incomplete. |
| **C — TypeOracle record/replay** | A stable record vocabulary exists for one query family. | TypeOracle records can be captured from TS6, replayed without a checker, hashed deterministically, and rejected when missing/tampered. | Restore live TS6 oracle queries behind the existing seam. No broad codegen cutover is implied. |
| **D — minimum-facts bounded corpus** | One record family can be replayed and one Prepared fixture has exact route/ABI evidence. | The minimum facts for one bounded standalone corpus are serialized with provenance and consumed by a frontend-neutral reader. | Disable snapshot production/consumption and retain TS6 analysis. Other facts and larger graphs remain live. |
| **E — frontend-free replay** | The bounded snapshot contains every fact its consumer requests. | The corpus completes Prepared IR, ABI planning, code generation, instantiation, and runtime with TypeScript and Acorn poisoned/unavailable; missing facts fail closed. | Keep the snapshot gate opt-in and fall back to TS6 only before the explicit boundary; no silent fallback after boundary entry. |
| **F — replay expansion** | The bounded replay gate is non-vacuous and mutation-proven. | Replay covers functions, closures, classes, module initialization, imports, dynamic operations, and multi-source compilation, with exact provenance and runtime parity. | Roll back by corpus family or capability, not by reopening arbitrary late checker queries. Unsupported families remain explicit. |
| **G — Acorn adapter** | Replay can consume the frontend-neutral contract and the JavaScript scope rules are specified. | Acorn handles one bounded plain-JavaScript corpus with correct scopes, hoisting, modules/CommonJS, classes, initialization, and conservative dynamic behavior. | Keep Acorn behind a feature/corpus gate and withdraw unsupported constructs. Do not change TypeScript behavior. |
| **H — TypeScript-JS versus Acorn equivalence** | Phase G has a bounded corpus with runtime and artifact observation. | Both frontends agree on documented stable facts, Prepared outcomes, ABI bindings, supported artifact surface, and runtime behavior; differences are classified. | Keep the adapter differential-only and disable Acorn lowering for disagreement classes. The entire JS language is not covered. |
| **I — TypeScript 7 adapter** | The required TypeScript 7 API/service boundary is supported and can provide the facts in the schema. | A TS7 adapter produces the same versioned semantic IR for the required corpus without changing downstream IR, ABI, Prepared, or Wasm interfaces. | Keep TS6 as the producer and TS7 as opt-in differential validation. Do not depend on unstable TS7 internals. |
| **J — TS7 default, TS6 differential oracle** | TS7 equivalence and replay coverage are comprehensive for the supported product surface. | TS7 is the default semantic producer; TS6 can independently produce/diff snapshots; all divergences are classified or block promotion. | Restore TS6 default while retaining the neutral snapshot interface. Direct-codegen retirement remains separate. |
| **K — final TS6 removal gate** | TS7 default has sustained semantic, artifact, runtime, Test262, and npm compatibility evidence. | TS6 is deleted only after comprehensive equivalence, Test262, npm-package, performance, and artifact checks pass, including negative/dynamic gates. | Keep TS6 available until every gate is green; a successful TS7 typecheck alone is not sufficient. |

No phase authorizes deleting direct-codegen handlers, and no phase makes the
entire compiler frontend-free in one change. A phase may land while later
phases remain unfinished.

## Acceptance criteria

- [ ] No frontend-specific object appears in exported semantic-IR types or in
      the types consumed by Prepared IR, ABI planning, optimization, or Wasm
      emission.
- [ ] A representative compiler corpus completes from serialized snapshots
      while frontend modules are poisoned or unavailable.
- [ ] Every late semantic query is either represented in the snapshot or
      rejected as missing evidence; no consumer silently reopens a frontend.
- [ ] Stable semantic-IR hashes reproduce on identical source, options, adapter,
      and schema inputs.
- [ ] TypeScript 6 live compilation and TypeScript 6 snapshot replay have
      equivalent semantic outcomes and runtime behavior.
- [ ] Acorn and TypeScript-JS adapters agree on a bounded shared JavaScript
      corpus, including documented conservative withdrawals.
- [ ] Unsupported dynamic JavaScript cases withdraw or use explicit dynamic
      semantics; they do not receive an unsound static representation.
- [ ] Program ABI bindings and Prepared-component provenance remain exact after
      serialization and replay.
- [ ] A TypeScript 7 adapter can be added without modifying downstream semantic
      IR, Prepared IR, ABI, runtime-contract, or codegen interfaces.
- [ ] Removing TypeScript 6 is gated on comprehensive semantic equivalence,
      artifact, runtime, Test262, npm compatibility, and performance checks —
      not merely successful TypeScript 7 typechecking.
- [ ] Mutation tests for missing, altered, stale, and tampered facts fail closed
      without a late TypeScript or Acorn query.

## Risks

- **Rebuilding a type checker downstream.** If the IR accepts arbitrary AST
  shapes and asks consumers to derive semantics, the boundary has failed. Keep
  frontend analysis in adapters and require explicit facts or abstention.
- **Schema explosion.** Recording TypeScript implementation details would make
  the schema unstable and couple TS6/TS7. Record only lowering/runtime facts,
  stable identities, provenance, and explicit outcomes.
- **Unstable source identities.** Paths, declaration order, and compiler object
  identity can change across processes. Use canonical source keys, content
  fingerprints, stable ranges, and deterministic collision handling.
- **Incorrect JavaScript scope or hoisting behavior.** Acorn syntax alone is not
  a binder. Incorrect `var`, function, Annex B, closure, or module behavior can
  silently change runtime semantics.
- **Lost narrowing or overload-selection facts.** A coarse type record can
  produce a valid-looking but wrong carrier or call. Record the selected fact,
  its inputs/provenance, and fail closed when it is absent.
- **Unsound Acorn inference.** JavaScript's dynamic properties, getters,
  proxies, `eval`, and `with` make optimistic inference dangerous. Prefer
  dynamic runtime semantics or withdrawal.
- **Snapshot invalidation and cache poisoning.** Source contents, options,
  adapter version, schema version, runtime capabilities, and dependency graph
  must all participate in fingerprints and compatibility checks.
- **Performance and memory cost.** Over-serializing every compiler detail can
  cost more than live analysis. Start with a measured query family and bounded
  corpus; expand only when replay proves a downstream need.
- **Frontend disagreement.** TypeScript's JavaScript mode and Acorn may expose
  different information or diagnostics. Equivalence must classify conservative
  differences and require parity only where lowering depends on the fact.
- **Semantic equivalence versus byte identity.** Independent frontends or
  serializer versions need not emit byte-identical artifacts. ABI bindings,
  supported surface, and runtime behavior are the stronger contract.

## Dependencies and relationship to #3518

#3518 moves code generation behind Prepared IR and tracks the direct-codegen
retirement spine. This issue removes language-frontend objects and late frontend
queries from that downstream pipeline. They reinforce each other but are not
identical:

- #3518 and R1–R4 should continue independently; safe R1–R4 work must not wait
  for the complete snapshot architecture.
- Direct-codegen handler deletion should continue independently and must not be
  combined with the first snapshot slice.
- Reuse #3520 source-qualified identity and Program ABI, #3521 Prepared-component
  construction/sealing, route audits, receipts, and the #1930 TypeOracle seam.
- `PreparedIrProgram` is the downstream structural handoff, but its current
  `pending-production-wiring` reconciliation and frontend-shaped planning maps
  mean it is not yet the required serialized semantic IR.
- TypeScript 6 can remain a temporary producer while direct-codegen retirement
  proceeds. The later TS7/Acorn adapters must target the same downstream
  contract, not fork code generators.

## Recommended child issues

Do not allocate these IDs as part of #4617. They are proposed in dependency
order, with approximate risk:

1. **Raw TypeScript API inventory and ratchet** — low/medium risk; depends on
   #1930 and #3518. Classify all new direct uses below the oracle seam and
   establish the frontend-boundary report.
2. **Semantic schema and stable serialization** — high risk; depends on #3520
   and this issue's contract. Define records, versioning, provenance, hashes,
   and compatibility without recording compiler implementation details.
3. **TypeOracle record/replay** — medium/high risk; depends on the schema. Start
   with the `valueDeclarationOf`/`declarationsOf` family and fail closed.
4. **Frontend-free replay gate** — high risk; depends on child 3 and #3521.
   Poison TypeScript and Acorn, then consume a serialized snapshot through
   Prepared IR, ABI, Wasm, and runtime.
5. **First TypeScript corpus cutover** — medium risk; depends on child 4.
   Expand one bounded standalone corpus while keeping the TS6 producer and a
   kill switch.
6. **Acorn scope/module adapter** — high risk; depends on the schema and replay
   gate. Implement binder, hoisting, modules/CommonJS, classes, and init order
   for a bounded JS corpus.
7. **Cross-frontend JavaScript equivalence** — high risk; depends on child 6.
   Differentially compare TypeScript-JS and Acorn semantic/result surfaces and
   runtime parity.
8. **TypeScript 7 adapter** — high/externally gated risk; depends on the
   supported TS7 API/service boundary and child 7. Produce the same snapshot
   without downstream interface changes.
9. **Final TypeScript 6 removal gate** — critical risk; depends on all prior
   children plus comprehensive semantic, artifact, runtime, Test262, npm, and
   performance gates.

## Resume checkpoint

Measured so far: the #1930 ratchet reports 462 `getTypeAtLocation` occurrences
and 938 `ctx.checker` occurrences under `src/codegen`; the independent inventory
finds 95 affected files, 344 textual `ctx.oracle` member uses, 645 selected
TypeScript type/symbol/signature/checker references, 447 `ts.SourceFile`
references, and 238 frontend-object retention lines in maps/sets. The main
frontier crossings are `src/checker/index.ts`, `src/compiler.ts`,
`src/codegen/context/create-context.ts`, and
`src/ir/planning-identity.ts`. The existing downstream seams are
`src/ir/identity.ts`, `src/ir/program.ts`,
`src/codegen/program-abi-session.ts`,
`src/ir/prepared-component-sealing.ts`, and the body-route/receipt audits.

The first recommended implementation slice is a narrow record/replay
checkpoint, not a schema-wide rewrite:

- **Query family:** TypeOracle value-declaration resolution:
  `valueDeclarationOf` plus the singleton `declarationsOf` consistency check in
  `src/codegen/multi-prepared-function-value-import-target.ts:9-19`.
- **Fixture:** the exact `bench_loop` Prepared function-value route in
  `tests/issue-4590-bench-loop-prepared-cutover.test.ts:19-47,98-112`, using
  `website/playground/examples/benchmarks/loop.ts:1-15`. The route resolves the
  imported `bench_loop` value and its target through the oracle at
  `src/codegen/multi-prepared-function-value-import-target.ts:36-102`, then
  re-proves it at `:116-161` through
  `src/codegen/multi-prepared-scalar-leaf.ts:1455-1494`.
- **Positive test:** record the query facts during TS6 analysis, replay them
  during the `bench_loop` Prepared compilation, poison the live checker/oracle
  query path after the snapshot boundary, and require the existing exact
  Prepared outcome, Program ABI surface, Wasm surface, and runtime result
  (`1_783_293_664`) to match the live TS6 lane.
- **Negative tests:** omit the value declaration, alter the singleton
  declaration set, tamper with the imported target identity, and poison both
  the TypeScript module and the live query method. Each case must fail closed
  before requesting a direct-body skip; it must not consult TypeScript or guess.
- **Likely seams:**
  `src/checker/oracle.ts`, a new record/replay wrapper adjacent to the oracle,
  `src/codegen/multi-prepared-function-value-import-target.ts`,
  `src/codegen/multi-prepared-scalar-leaf.ts`,
  `src/ir/identity.ts`, `src/codegen/program-abi-session.ts`, and
  `tests/issue-4590-bench-loop-prepared-cutover.test.ts`.
- **Do not combine:** direct-codegen handler deletion, a TypeScript 7 adapter,
  the Acorn binder, a whole-repository schema migration, or broad TypeOracle
  rewrites. The slice should prove the boundary and its failure behavior before
  expanding the record vocabulary.

## 2026-08-28 C1 implementation plan — declaration-fact record/replay

This is Phase C's first executable checkpoint. It owns the exact
`valueDeclarationOf` / `declarationsOf` query population required by the
existing standalone `bench_loop` Prepared function-value route. It does not
make the whole compiler frontend-free, does not delete a direct handler, and
does not claim that an AST-free consumer exists yet. The TypeScript adapter may
inspect compiler-owned nodes while producing and reattaching the snapshot; the
published snapshot and every fact used to authorize the route must be
frontend-neutral, canonical, serializable, and replayed without a live oracle
query.

### Boundary and ownership

Add two deliberately separated boundary modules and one route-local consumer
helper:

- `src/ir/semantic-declaration-snapshot.ts` owns only the versioned record
  schema, structural validation, deep freeze, canonical ordering, and canonical
  JSON bytes. It must import no TypeScript, Acorn, checker, codegen, Wasm, or
  Node-only hashing API.
- `src/checker/oracle-declaration-snapshot.ts` is the temporary TypeScript
  adapter. It may translate exact compiler nodes to/from neutral records using
  one `IrPlanningIdentityContext`, but it must never place a `ts.Node`,
  `ts.Symbol`, `ts.Type`, `ts.Signature`, `TypeChecker`, `WeakMap`, absolute
  filename, display name, or syntax-kind number into the record.
- `src/codegen/multi-prepared-function-value-declaration-replay.ts` owns the
  exact reduction-body declaration-query proof/collector and the bounded
  capture/finalize/no-delegate-replay lifecycle. It may import the adapter,
  neutral schema, and `ts` syntax predicates, but it must not import
  `multi-prepared-scalar-leaf.ts` or allocate support, publish a claim, request
  a skip, or lower Wasm. Its API returns either a typed withdrawn detail or one
  replay-certified evidence value plus the retained replay receipt; the live
  capture callback may discover facts but cannot become returned authority.

The v1 record vocabulary is closed and minimal:

- one source-qualified query-site reference for an identifier;
- zero or one value-declaration reference;
- the complete ordered declaration-reference population returned for that
  binding; and
- declaration roles limited to the exact first-slice shapes required by the
  fixture: named import specifier, top-level function declaration, and local
  variable declaration inside the exact reduction body.

Every reference carries the exact `IrSourceId`, source-relative `start` and
`end`, and the closed semantic role. Source identity, not a path or spelling,
is authority. An explicit `null` value declaration and an explicit empty
declaration population are valid recorded answers; an absent query record is a
missing fact and may not be treated as either answer. Ranges must be finite safe
integers, non-negative, ordered, within the exact source, and resolve to one
node of the stated role. Unknown versions, roles, fields, sources, duplicate
query keys, duplicate declaration references, non-canonical ordering, a value
declaration absent from its declaration population, or a declaration whose
source/range/role no longer resolves fail closed.

Canonical query and declaration keys are derived only from the neutral fields.
The serializer sorts object keys and record populations deterministically and
rejects unsupported values rather than relying on insertion-order
`JSON.stringify`. Parsing and reserializing a valid snapshot must reproduce the
same bytes. Tests may SHA-256 those bytes, but the IR schema module stays
runtime-neutral.

### Capture is not authority; replay is

The adapter exposes a recording `Pick<TypeOracle,
"valueDeclarationOf" | "declarationsOf">` and a replaying implementation of
the same narrow surface:

1. The recorder delegates each first request to the live TS6 oracle and records
   the exact neutral answer. A first request through either narrow method
   proactively captures both the `valueDeclarationOf` answer and the complete
   `declarationsOf` population for that query site. Repeated identical requests
   must agree; an answer that changes during capture is an invariant, not
   last-write-wins.
2. Finalization validates, canonicalizes, serializes, parses, validates again,
   and freezes the snapshot. The parsed record, not the recorder's retained
   node map, is the replay input.
3. The replayer joins each neutral reference back to exactly one node in the
   current source inventory. It has no delegate. A missing query, stale source,
   copied AST, rebuilt or reordered inventory, range/role drift, or ambiguous
   join raises the snapshot's typed missing/invalid-fact error; it never asks a
   live oracle, searches by spelling, or returns a guessed declaration.
4. A frontend poison supplied after finalization must therefore be unreachable
   for the recorded query family. The poison is an anti-vacuity control, not a
   production fallback switch.

Keep `TypeOracle`'s broad existing interface unchanged in C1. The new adapter is
an explicit bridge for this query family; do not turn all oracle methods into a
partial proxy or let unrelated codegen silently consult the snapshot.

### Production consumption in the exact `bench_loop` route

Change only the declaration-resolution authority inside
`multi-prepared-function-value-import-target.ts` and the exact function-value
leaf in `multi-prepared-scalar-leaf.ts`:

1. Run the existing candidate proof once with the recorder solely to discover
   and capture every binding query used by the reduction body, the one
   function-value use, the named import, and the exported imported target. This
   pass may not allocate support, request a body skip, publish a claim, or
   authorize preparation.
2. Finalize and canonical-round-trip the snapshot, create a no-delegate
   replayer, then rerun the complete existing candidate proof. Only this replay
   result may allocate the trampoline/cache support, prepare the function, or
   request the direct-body skip. The replay result must identify the same exact
   declarations and source-qualified UnitIds already required by #4590.
3. Retain the frozen snapshot bytes and replay authority on the function-value
   route receipt. Every post-direct/currentness recheck, including
   `multiPreparedFunctionValueUseIsCurrent`, consumes that exact snapshot.
   `ctx.oracle` is not accepted as a late authority for these facts.
4. Missing or invalid replay evidence withdraws before the first support/body
   mutation, or fails invariantly if a previously certified receipt drifts.
   It must never reopen the live TS oracle or fall back after a skip has been
   requested.

The full candidate replay retains every existing local-binding oracle identity
check; C1 does not replace those checks with source structure or spelling. The
whole-source function-value scan must first filter identifiers by the exact
legacy identifier text so unrelated declaration roles are never queried or
recorded. That text is only a conservative candidate filter: the replayed
source-qualified declaration identity remains the sole authority for accepting
the use, import, target, reduction bindings, and route.

Do not change the scalar, array, Fibonacci, string, host, direct, fast, WASI,
or IR-disabled routes. Do not edit `src/ir/select.ts`, `src/ir/from-ast.ts`,
backend lowering, the Program ABI schema, or public compile-result options in
this checkpoint. Avoid `src/codegen/index.ts` unless the implementation proves
that the exact route cannot own capture/replay locally; a convenience wiring
change is not sufficient reason to overlap the broad standalone/Deno branch.
Keep `multi-prepared-scalar-leaf.ts` at non-positive net LOC by moving the exact
reduction declaration proof and generic snapshot lifecycle into the focused
route helper above. Do not add a LOC allowance for C1; the helper exists to
honor the regrowth ratchet without coupling the neutral schema to route policy.

### Non-vacuous tests

Extend `tests/issue-4590-bench-loop-prepared-cutover.test.ts` and add a focused
schema/adapter test file if keeping pure mutations separate improves clarity.
The positive matrix must:

- capture with TS6, serialize, parse, and replay after poisoning both live
  declaration-query methods;
- retain the existing exact zero-legacy Prepared outcome, terminal ownership,
  UnitIds, three Program ABI bindings, raw and optimized Wasm surface/body
  comparisons, and runtime result `1_783_293_664`;
- prove capture traversal/query reorder produces identical canonical bytes and
  digest; and
- prove the ordinary live-oracle lane and replay lane have the same route,
  terminal outcomes, ABI surface, imports/exports/DTS/string pool, binary/WAT
  observation, and runtime behavior.

Mutate one fact at a time and require rejection before support allocation or a
body skip for: missing query, explicit answer changed to missing, duplicate or
unknown query, wrong version or extra field, wrong source ID, range or role,
copied SourceFile/AST, value declaration not in declarations, empty or
duplicated singleton declaration population, same-spelled foreign import or
target, target UnitId mismatch, and stale inventory. A separate schema fixture
with two same-binding, allowed-role declarations must prove that reversing its
declaration population is rejected as non-canonical; merely calling a singleton
"reordered" is not evidence. After a valid route is certified, mutate the
retained snapshot/receipt and require the existing post-certification invariant
with zero target legacy rows. A spy that never throws is not evidence: at least
one control must deliberately run the old live-query path and observe the
poison.

The existing renamed-route and source-shape negative matrix remains unchanged.
The direct kill-switch control still restores the exact two `bench_loop`
legacy rows. C1 introduces no new shipping environment switch; test-only fault
injection must be parsed, exact, and fail if armed but unmatched.

### Landing gates and honest claims

Run the snapshot/schema tests, the complete #4590 suite, the scalar/array/
Fibonacci/string Prepared-route controls, TypeScript 7 and TypeScript 5,
Prettier/Biome, IR layering/dialect/fallback/oracle/optimization/dead-export
checks, and the LOC/function regrowth ratchets. Run both ratchets immediately
before the signed commit. Run every normal precommit and prepush hook without a
skip. Before each heavy command, commit, and push, require a fresh finite,
non-negative one-minute load strictly below `logical cores - 2` (10 cores means
`< 8`). Obtain an independent read-only review of the exact signed head before
push and open a ready PR.

Acceptance proves only Phase C for one declaration-query family and one bounded
standalone route. The snapshot still reattaches compiler-owned AST declarations
inside the temporary TypeScript adapter, so Phase D's neutral consumer and
Phase E's TypeScript/Acorn-unloaded end-to-end replay remain open. Do not claim
TS7 or Acorn support, a general semantic snapshot, direct-codegen deletion, or
repository-wide frontend neutrality from this checkpoint.

## 2026-08-28 C1 implementation checkpoint (clean-room re-derivation)

This is a **clean-room re-implementation from the approved plan above**. A prior
lane implemented and validated the same checkpoint, but its 13-file diff was
staged and never committed on a host that is no longer reachable, so nothing of
it survives. Only the committed plan was available; every number below was
measured on this branch, against current `main`
`f6c8e2ceaaa6dbaf0004596eb32dbe0a6d09310f`.

### What landed

Three new modules with the prescribed import boundaries:

| Module | LOC | Imports |
| --- | --- | --- |
| `src/ir/semantic-declaration-snapshot.ts` | 291 | none at all — no TypeScript, Acorn, checker, codegen, Wasm, or Node hashing |
| `src/checker/oracle-declaration-snapshot.ts` | 251 | `ts`, the neutral schema, and `IrPlanningIdentityContext`/`IrSourceId` types |
| `src/codegen/multi-prepared-function-value-declaration-replay.ts` | 484 | the adapter, the neutral schema, `ts` predicates, `IrInvariantError`, and `multi-prepared-function-value-import-target.ts` — **not** `multi-prepared-scalar-leaf.ts` |

Production consumption is confined to
`multi-prepared-function-value-import-target.ts` (its `oracle` parameter is now
supplied by the replayer) and the exact function-value leaf of
`multi-prepared-scalar-leaf.ts`, which moved its reduction declaration proof
into the new helper and shrank **1,530 to 1,468 lines (-62, non-positive net)**.
No LOC allowance was added. `src/codegen/index.ts` was not touched: the route
owns capture and replay locally, and the late
`assertMultiPreparedFunctionValueLeafRouteCurrent` seam already receives the
frozen route.

The v1 record vocabulary is closed: one source-qualified query-site reference,
zero-or-one value-declaration reference, the complete ordered declaration
population, and three roles (`named-import-specifier`, `top-level-function`,
`reduction-local-variable`). Canonical keys join `sourceId`, `start`, `end` and
(for declarations) `role` with a NUL separator, which no source key or role can
contain. The serializer emits schema-ordered keys, so parse-then-reserialize
reproduces the same bytes. On the `bench_loop` graph the certified snapshot has
**9 query sites**: six reduction-body locals (`s` three times, `i` three times),
the `bench_loop` function-value use, the `addBenchCard` import specifier in
`loop.ts`, and the `addBenchCard` top-level function in `helpers.ts`.

### Deviations from the plan (all minimal, all measured)

1. **`MultiPreparedFibonacciPairRoute` is now
   `Omit<MultiPreparedFunctionValueLeafRoute, "routeKind" | "declarationReplay">`.**
   Adding the replay receipt to the leaf route otherwise breaks the Fibonacci
   route's structural derivation. This is a type-level edit only; the Fibonacci
   pair keeps its pre-C1 live-oracle declaration authority, as the plan requires.
2. **The graph-wide reduction-candidate uniqueness scan
   (`collectMultiPreparedReductionLeafCandidates`) still runs on the live
   oracle.** It is *discovery*, not authorization: it decides only which single
   declaration is offered for certification. Every fact that authorizes support
   allocation, preparation, the direct-body skip, and each post-certification
   recheck comes from the replayed snapshot.
3. **The one-fact mutation matrix lives in its own test file**
   (`tests/issue-4617-declaration-replay-mutations.test.ts`) rather than inside
   the #4590 file, and its 16 cases stop at `generateMultiModule` over one
   shared `analyzeMultiSource` result. Measured reason, not preference: with all
   21 new cases inside #4590, a single-fork run at vitest's default 512 MB fork
   heap OOM'd (`Reached heap limit ... 510.4 MB`) while the same set passed at a
   1 GB heap. The route decision and its legacy audit are complete at
   `generateMultiModule`; binary/WAT/DTS emission would add memory, never
   evidence — so one case still carries the whole pipeline so the legacy AUDIT,
   not only the poison diagnostic, witnesses the emitted direct body. The plan
   explicitly permits "a focused schema/adapter test file if keeping pure
   mutations separate improves clarity"; this extends that to the route
   mutations for a memory reason.
4. **Two `#4590` C1 cases whose assertion is purely a diagnostic** (the poison
   anti-vacuity control and the armed-but-unmatched injection) also stop at
   `generateMultiModule`, and the live-versus-replay parity case asserts
   byte-for-byte binary equality instead of materialising two whole-module WAT
   renderings — binary equality subsumes the WAT comparison.
5. **Four obsolete physical pins in #4590 and one in #4591 were remeasured**
   (see below). All of them fail on clean `main` before this branch exists.

### Obsolete-pin remeasurement (verified on clean `origin/main` first)

The A/B was run by deleting the three new files and restoring the three edited
ones, so both sides are one `cp` apart:

| Pin | Was on `main` | Clean `f6c8e2c` | Clean `23bc3dd` (this branch's merge base) |
| --- | --- | --- | --- |
| #4590 raw Prepared bytes | 131,207 | 133,067 | **133,297** |
| #4590 raw direct bytes | 131,235 | 133,096 | **133,326** |
| #4590 exact Prepared reduction | 28 | 29 | **29** |
| #4590 direct trampoline function slot | 290 | 290 | **291** |
| #4590 direct cache global slot | 136 | 139 | **139** |
| #4591 direct `bench_fib` trampoline slot | 291 | 291 | **292** |
| #4591 direct `bench_fib` cache global slot | 136 | 139 | **139** |

The branch carries the right-hand column. The middle column is the same
measurement taken before `main` advanced under this work — the pins moved
**twice in one day** from unrelated allocator growth, which is the maintenance
cost these physical assertions carry.

Clean-main evidence: `tests/issue-4590-...` 18/21 with exactly those three
assertions red; `tests/issue-4591-...` 26/27 with exactly that one red. The
Prepared and direct byte counts are **identical with and without this branch**,
so C1 is artifact-neutral: the drift is unrelated allocator growth on `main`
since the pins were written — exactly the class #4590's own "current-main pin
maintenance" section describes. Slots 76 / 78 / 10 (Prepared) and 76 / 290
(direct source and trampoline) are unchanged.

### Validation (every command run bare; real exit statuses)

| Check | Result | Exit |
| --- | --- | --- |
| `tests/issue-4590-bench-loop-prepared-cutover.test.ts` | 26/26 | 0 |
| `tests/issue-4617-declaration-replay-mutations.test.ts` | 19/19 | 0 |
| `tests/issue-4617-semantic-declaration-snapshot.test.ts` | 6/6 | 0 |
| all four together, CI's exact flags, CI default 512 MB heap | 78/78 | 0 |
| `tests/issue-4591-fib-pair-prepared-cutover.test.ts` | 27/27 | 0 |
| `tests/issue-4589-multi-prepared-scalar-leaf.test.ts` | 15/15 | 0 |
| `tests/issue-3518-bench-array-prepared-cutover.test.ts` | 5/5 | 0 |
| `tests/issue-3518-bench-string-prepared-cutover.test.ts` | 3/3 | 0 |
| `tests/issue-3518-multi-prepared-string-leaf-planner.test.ts` | 71/71 | 1 (vitest RPC timeout, see below) |
| `tests/issue-3525-multi-prepared-program-census.test.ts` | 17/17 | 0 |
| `tests/issue-3525-multi-prepared-callable-bindings.test.ts` + `-module-init` | 13/13 | 0 |
| `tests/issue-2138-multi-module-ir-overlay.test.ts` | 6/6 | 0 |
| `tests/issue-4584-standalone-prepared-class-cutover.test.ts` | 4/4 | 0 |
| `tests/issue-3521-prepared-free-function-routing.test.ts` | 34/37 | 1 — **identical 3 failures on clean `origin/main`** |
| `pnpm run typecheck` (TypeScript 7) | clean | 0 |
| `pnpm run typecheck:ts5` (TypeScript 5) | clean | 0 |
| `pnpm run format:check` (Prettier) | clean | 0 |
| `pnpm run lint` (Biome, error level) | clean | 0 |
| `pnpm run check:ir-fallbacks` | no increases | 0 |
| `node scripts/check-ir-layering.mjs` | 86 import lines / 15 files, baseline 86 | 0 |
| `node scripts/check-ir-dialect.mjs` | 27 re-exports, no leaks | 0 |
| `node scripts/check-ir-optimization-retirement.mjs` | 50 rows | 0 |
| `pnpm run check:test-vacuity-shapes` | 0 gate-defeating callees | 0 |
| `node scripts/check-loc-budget.mjs` | no unallowed growth, 6 changed files | 0 |
| `node scripts/check-func-budget.mjs` | no unallowed growth | 0 |
| `node scripts/check-coercion-sites.mjs` | no net vocabulary growth | 0 |
| `npm run -s check:oracle-ratchet` | `getTypeAtLocation +0, ctx.checker +0` | 0 |
| `npm run -s check:dead-exports` | 23 known, 0 new | 0 |
| `LOC_GATE_BASE=f6c8e2c` LOC and function ratchets | both OK | 0 |

Changed-root denominator: **78/78** across the four files this branch touches
(#4590 26, #4591 27, mutations 19, schema 6); adjacent controls **195/198**,
where the three are the pre-existing
`issue-3521-prepared-free-function-routing` failures reproduced identically
without this branch.

**One honest caveat on the combined run.** All four files pass individually and
under the pre-commit hook (which invokes vitest once per file). Run *together*
in a single fork at the 512 MB default they sit close to the ceiling: one
ordering completed 78/78 and another OOM'd part-way. That is CI's advisory
`issue-tests` changed-file step, which is `continue-on-error`, so it cannot
turn the check run red or block the queue; the fatal pinned step runs only
`tests/issue-3529-selector-preclaim.test.ts`. The measures in deviations 3 and 4
were taken specifically to buy that margin back, and they cut the mutation
matrix from ~40 s to ~16 s of test time.

The `[vitest-worker]: Timeout calling "onTaskUpdate"` error seen on long
single-fork runs is an environment artifact, not a product signal: it fires for
#4591 and for the string-leaf planner on clean `main` without this branch, and
it clears at a 1 GB fork heap.

### Non-vacuity evidence

The replay is load-bearing, not a spy that never throws:

- With `JS2WASM_TEST_POISON_DECLARATION_ORACLE=bench_loop` the two live
  declaration methods throw after finalization and the route still reaches
  `terminal-ir`, zero `bench_loop` legacy rows, and runtime `1_783_293_664`.
- The **anti-vacuity control** arms the same poison *and* forces the pre-C1
  live-query path (`JS2WASM_TEST_DECLARATION_REPLAY_LIVE_ORACLE=bench_loop`):
  compilation fails with `live declaration oracle poisoned after
  semantic-snapshot finalization`. The old path would have been observed.
- The live lane and the replay lane are compared directly and agree on route
  audit rows, dispositions, IR outcomes, DTS, imports helper, import
  descriptors, string pool, byte-for-byte binary, `bench_loop` and trampoline
  WAT, Wasm import/export surface, and runtime.
- A fault injection that is armed but does not match the certified route fails
  the compile instead of passing silently, and an unknown mutation name is an
  invariant.
- 16 one-fact-at-a-time mutations each withdraw **before** support allocation
  and before the skip — proven by the direct body then running into its own
  poison, with one case carrying the whole pipeline so the legacy audit also
  witnesses the emitted `compileFunctionBody` row: `drop-query`, `answer-to-null`, `duplicate-query`, `unknown-query`,
  `wrong-version`, `extra-field`, `wrong-source`, `wrong-range`, `wrong-role`,
  `empty-population`, `duplicate-population`, `value-not-in-population`,
  `foreign-import` (same-spelled foreign declaration), `foreign-target`
  (same-spelled foreign target, which is also the imported-target UnitId
  mismatch), `copied-source`, `stale-inventory`.
- Post-certification, tampering the retained snapshot
  (`JS2WASM_TEST_TAMPER_DECLARATION_REPLAY=bench_loop`) yields the existing
  `drifted after direct-body certification` invariant with zero `bench_loop`
  legacy rows.
- The non-canonical-order proof uses a real two-declaration fixture (one binding
  with two `var` declarations in the reduction body): its forward population
  replays to both nodes, and reversing it is rejected as `non-canonical-order`.
  Calling a singleton "reordered" is not evidence, so no singleton is used.
- Capture-order independence is proven by capturing the same four sites in
  forward and reverse order and comparing canonical bytes and their SHA-256; a
  capture over a different site population is shown to differ, so the equality
  is not the trivial one.
- All test-only fault injection is `JS2WASM_TEST_*`, parsed, exact, and fails
  when armed but unmatched. No new shipping environment switch was introduced.

### Honest claims

Acceptance proves **Phase C for one declaration-query family
(`valueDeclarationOf` / `declarationsOf`) and one bounded standalone route** —
the exact `bench_loop` Prepared function-value leaf — and nothing more. The
snapshot still reattaches compiler-owned AST declarations inside the temporary
TypeScript adapter, so Phase D's neutral consumer and Phase E's
TypeScript/Acorn-unloaded end-to-end replay remain open. This checkpoint claims
no TypeScript 7 support, no Acorn support, no general semantic snapshot, no
direct-codegen handler deletion, and no repository-wide frontend neutrality.

## 2026-08-31 D1 implementation plan — neutral `bench_loop` facts without AST reattachment

This is Phase D's first bounded checkpoint. It removes one real source of
frontend authority from the C1 route: after finalization, the facts authorizing
this route's eligibility, support allocation, direct-body skip, import-target
choice, post-skip audit/outcome, and late route currentness must be read from a closed neutral record
instead of being recovered by joining ranges back to `ts.Node` objects. The
actual `lowerFunctionAstToIr` body construction still consumes TypeScript AST,
checker, and oracle inputs; neutralizing those type/body semantics is Phase E,
not D1.

D1 ships as two sequential, independently reviewable implementation PRs on
this issue. **D1a** first corrects the existing AST-authoritative C1 physical
baseline for the exact `bench_loop` function value: the Prepared support call
and its paired generic/direct function-value control must materialize the same
ordinary-function-declaration constructible wrapper and exact `{name, length:
0}` metadata. That semantic correction is allowed to change the old C1 type,
body, WAT, and binary pins, but every change must be explained, measured, and
locked. **D1b** then replaces the post-finalization AST authority with the
neutral record specified below and must be artifact-equal to the corrected D1a
baseline. D1b may not hide a physical materialization change inside the
authority migration.

The plan was re-grounded after #5336 and #5328 merged and refreshed through
protected `main` `a4d141321daf7f8874e540d7b75f58f8c3e2c2a7` (tree
`dc4b1248ee79a53f4b9bb71765c59195721ade21`). The intervening PRs #5350,
#5363, and #5366 touch `src/codegen/index.ts` only in unrelated
Object.create/boolean-boxing/finalizer-emission hunks. Later movement through
#5368, #5370, #5371, #5372, and the scheduled #1951 baseline sync changes only
benchmarks, generated reports, one unrelated issue plan, and the LOC baseline;
none changes a named D1 seam. C1 is already present there. Its
neutral schema is 291 lines, its TypeScript adapter is 251 lines, its route
replay helper is 484 lines, and the exact scalar-leaf route is 1,468 lines.
Do not resume or copy the stale `/private/tmp/js2-4617-*` worktrees: their C1
content has already landed.

### Scheduling gate and ownership

The plan-only checkpoint may land immediately. #5336 merged as
`e285c0f29dd557e702f7a473219513b560df7cb6`, and this plan branch was refreshed
through current protected `main`; that queue dependency is closed. Production
is still blocked while the parallel #3525/Program-ABI owner holds adjacent
callable/publication paths: the published receipt seam is stable, but the exact
support callback still rescans TypeScript syntax and the live oracle.
Production work starts only after all of the following are true:

1. #3525 has released, or D1 has exact ownership to add, a UnitId-only
   `prepareCertifiedFunctionValueSupport` handoff and a neutral route-claim
   ledger as specified below;
2. the implementation worktree starts from
   `a4d141321daf7f8874e540d7b75f58f8c3e2c2a7` or newer protected `main`, and
   any later change to an owned D1 hunk has been remeasured/reviewed; and
3. no concurrent owner is editing the D1 production paths below.

A 2026-08-31 Terra read-only ownership audit found the local
`codex/3525-m0-program-container-impl` worktree still dirty at `b8ed991` with a
modified `src/codegen/index.ts` and untracked
`src/codegen/multi-prepared-program.ts`. The M0 owner/callback seam has since
landed through protected #5009, and other historical reviewed #3525 slices have
landed, but no reviewed current remote ref exposes the required UnitId-only
certified-support handoff and neutral route-claim ledger. That stale worktree is
evidence that the gate remains closed, not an implementation base. Recheck
ownership at start; never copy from or edit inside it.

The implementation owns only:

- `src/ir/semantic-declaration-snapshot.ts`;
- two new focused neutral modules,
  `src/ir/semantic-function-value-route-facts.ts` and
  `src/ir/semantic-function-value-source-projection.ts`;
- two new codegen-local, frontend-free dependency leaves:
  `src/codegen/certified-function-value-authority.ts`, which owns only the
  exact Program-ABI currentness joins and private lifecycle brands enumerated
  by the 2026-09-01 D1a amendment below, and
  `src/codegen/certified-function-value-materialization.ts`, which registers,
  consumes, audits, publishes, settles, and aborts the one authenticated
  direct-materialization receipt without importing TypeScript or an IR
  backend;
- `src/checker/oracle-declaration-snapshot.ts`;
- `src/codegen/multi-prepared-function-value-declaration-replay.ts`;
- `src/codegen/multi-prepared-function-value-import-target.ts`;
- the exact function-value and route-claim sections of
  `src/codegen/multi-prepared-scalar-leaf.ts`, including the exact target-
  UnitId-keyed prepared-install request carrier, one-entry callback lookup,
  and post-prepare exact consumed-request census;
- only one optional structurally neutral
  `onPreparedUnitCallableInstalled(artifactUnitId)` field in
  `IrIntegrationOptions` and one invocation in `src/ir/integration.ts` after
  the normal non-deferred `replaceUnitCallableAt` succeeds and before
  `settlePreparedDerivedCallable`; no codegen type, request, map, receipt, or
  D1 import crosses into IR, and the deferred/publication and orphan-stub
  branches are unchanged;
- only the matching optional callback input and exact forwarding into the
  sealed `compileIrPathFunctions` call in `prepareIrBodies` in
  `src/codegen/ir-prepared-free-functions.ts`; no selection, lowering,
  withdrawal, routing, or fallback behavior changes;
- only a two-symbol import/export seam in `src/codegen/closures.ts` and a
  certified-metadata overload plus shared allocation core beside
  `ensureFuncClosureSingleton` in
  `src/codegen/closures/method-trampolines.ts`;
- only a preparation/materialization split around `fnMetaSlotOfMeta` in
  `src/codegen/function-instance-meta.ts`: new
  `prepareFnMetaSlotOfMeta` allocates and returns the
  exact field, metadata-global object, and canonical `{name,length}` recipe
  without returning reusable instructions; new
  `materializePreparedFnMetaSlot` emits the name
  first, resolves the global/type objects against the current layout, and then
  builds a fresh init sequence. The legacy wrapper calls both halves in order;
- only the missing `fnInstanceMetaGlobalByKey` and
  `nativeStrLiteralGlobals` value shifts beside the existing
  `funcClosureGlobals` and other absolute-global side-table shifts in
  `fixupModuleGlobalIndices` in `src/codegen/registry/imports.ts`; no import or
  global-allocation policy change. The latter is a pre-existing raw-index bug
  made non-vacuous by D1's required intervening import-global control, not a
  new string-allocation policy;
- only the distinct certified-support callback field and exact forwarding in
  `MultiPreparedProgramRoutePlanningInput` / `planExistingRoutes` in
  `src/codegen/multi-prepared-callable-orchestration.ts`;
- only the `MultiPreparedProgramEarlyRouteInput` callback, central route-claim
  extension, bounded neutral route/snapshot types, and D1-neutral branches in
  registration, `#snapshotRoute`, `#assertRouteFields`,
  `#assertRouteSnapshot`, `sealBodyBoundary`, `compileBodySource`,
  `withOverlayState`, `sealRoutesComplete`, `sealBeforePublication`,
  `complete`, the new read-only `sealAfterFinalFixups`, and the later
  whole-program stability/publication checks in
  `src/codegen/multi-prepared-program.ts`;
- only the support allocator split, exact multi-program callback, the
  target-UnitId-keyed read-only late support reauthentication branch, and the
  complete D1 function-value selection/currentness branch of
  `compileMultiIrOverlaySource`, including exact early owner-UnitId threading,
  registration of the one prepared-install request, and sealing of the exact
  expected receipt census before `prepareIrBodies`; and the D1 neutral
  skipped-slot audit/outcome
  calls in `consumeIrOverlayReport` / `recordObservedIrOutcomes` in
  `src/codegen/index.ts`; plus only the D1 receipt-conditional pre/post
  trampoline-finalization assertions surrounding the primary multi-source
  `finalizeMethodTrampolines` call and the call inside
  `compileMultiPreparedProgramOverlays`, and one receipt-conditional fresh
  revision-0 registry assertion immediately before each of
  `fillReflectIsConstructor`, `fillFunctionInstanceProps`, and
  `emitIsCtorClosureExport` in that file, plus one receipt-conditional
  `sealAfterFinalFixups` call immediately after `fixupExternConvertAny`. The
  single-source finalizer and the consumers/fixups themselves are unchanged;
- only the legacy receipt type derivation and distinct certified-support
  callback threading in `planEarlyMultiPreparedFunctionValueRoutes` in
  `src/codegen/multi-prepared-fibonacci-pair.ts`;
- only the exact D1 neutral physical-skip projection and callback in
  `src/codegen/multi-prepared-body-skips.ts`, and the matching exact
  source-ID/declaration-range/UnitId branch in `compileDeclarations` /
  `resolvePreparedFunctionBodyRoute` in `src/codegen/declarations.ts`;
- only D1 neutral skipped-function audit and terminal-outcome reconciliation
  inputs/branches keyed by the frozen source/terminal/selection projection in
  `src/codegen/ir-overlay-outcomes.ts`, and the minimal UnitId owner-projection
  helper they require in `src/codegen/ir-overlay-identity.ts`;
- only a source-ID lookup overload beside `directFunctionBodyReceiptAudit` in
  `src/codegen/legacy-body-audit.ts`; and
- only one post-DCE certified-materialization settlement call at the end of
  `eliminateDeadLayoutAndPlanProgramAbi` in
  `src/codegen/program-abi-finalization.ts`; no dead-elimination algorithm or
  Program-ABI planning order changes; and
- `tests/issue-4617-semantic-declaration-snapshot.test.ts`,
  `tests/issue-4617-certified-function-value-materialization.test.ts`,
  `tests/issue-4617-semantic-function-value-source-projection.test.ts`,
  `tests/issue-4617-declaration-replay-mutations.test.ts`, and
  `tests/issue-4590-bench-loop-prepared-cutover.test.ts`.

Do not edit `src/ir/select.ts`, `src/codegen/ir-prepared-free-functions.ts`
outside the exact neutral callback transport above,
function-instance metadata outside the exact two-step recipe seam above, any
async-analysis module, Program-ABI session/publication
modules, any callable/module-init orchestration outside the single callback
transport above, the timer-shim route, or the linear backend. Those surfaces
belong to #5092, #3525, #5336, #4588, or later R6/R8 work. The narrow
`index.ts`, declaration/skip/audit/outcome, orchestration, program-owner, and
certified function-instance allocation exceptions above are valid only after
those owners hand off the exact lines; D1 does not absorb their wider
implementation. The exact function value is materialized by the legacy
`main` body, not by the Prepared target's IR body; D1 therefore adds no IR
instruction, lowering-plan field, or backend behavior.

Implementation uses one Terra writer per checkpoint in isolated current-main
worktrees. D1a must land through the protected merge queue before D1b branches
from refreshed protected `main`; the two writers must never edit the shared
support/allocation seams concurrently. A fresh independent Sol review of each
exact signed head is required before its PR becomes ready.

D1a is limited to the early exact support-allocation site, the paired late
support site's read-only reauthentication of that same allocation, the shared
singleton allocation core and two-step metadata recipe needed to make their
physical artifacts agree, the two raw absolute-global side-table value shifts
(`fnInstanceMetaGlobalByKey` and `nativeStrLiteralGlobals`), the codegen-local
one-shot direct-materialization registry/emitter handoff, its dependency-only
current-authority leaf, the exact neutral post-replacement callback transport,
and post-DCE settlement, the #1916 stable-handle
assertions at those exact sites, the two
multi-source trampoline-finalizer boundary pairs and three pre-consumer
revision-0 assertions, and the terminal post-fixup audit enumerated above, the #4590
fixture/tests, and remeasured pins. Its receipt is authorized by the existing
C1 AST-backed candidate proof; it does not add the neutral schema or route
lifecycle. D1b owns the remaining
files and behavior listed above. The new direct-materialization lifecycle
module and current-authority module are two dependency leaves with the exact
split below. The lifecycle leaf may import codegen/Wasm data types and the
authority leaf; the authority leaf imports only its enumerated
Program-ABI/current-layout dependencies. Neither imports TypeScript, checker,
frontend, an IR backend, or `method-trampolines`; `method-trampolines.ts`
imports the lifecycle leaf, never the reverse.

### The exact authority being retired

C1's serialized records are neutral, but its decisive consumer is not. Today
`createDeclarationSnapshotReplayOracle` builds a `DeclarationSnapshotJoin`,
walks each referenced `ts.SourceFile` on demand with `ts.forEachChild`, and
returns live `ts.Declaration` objects. The retained
`MultiPreparedDeclarationReplayReceipt` also carries `oracle`, `identity`, and
`roleOf`, so every late currentness check can reattach the snapshot to the
TypeScript object graph. `resolveMultiPreparedFunctionValueImportTarget` then
repeats `ImportSpecifier -> NamedImports -> ImportClause -> ImportDeclaration`
parent joins and scans target `SourceFile.statements`.

D1 deletes that production authority. Moving those functions to another file,
wrapping them in a callback, or storing a `ts.Node` behind an opaque token does
not satisfy the checkpoint.

### Versioned neutral facts contract

Add a closed envelope version
`semantic-function-value-route-facts/1`. It is not an in-place
reinterpretation of `semantic-declaration-snapshot/1`. Every nested record
carries its own `kind` literal ending in `/1`; the envelope version and those
record-kind versions jointly govern the complete layout. The D1 reader accepts
only that exact combination. There is no implicit v1 migration.

The two new neutral `src/ir` modules must not import TypeScript, Acorn, checker,
codegen, Wasm, Program ABI, Node hashing, or a frontend callback. Their shared
facts contract is the following compact pseudotype; atomic source/unit/binding/key/
name components are validated non-empty and NUL-free, derived IDs contain only
the prescribed NUL separators, ranges and ordinals are non-negative safe
integers, and every object rejects unknown or missing fields:

    interface SemanticFunctionValueRouteFactsV1 {
      version: "semantic-function-value-route-facts/1";
      provenance: {
        kind: "provenance/1";
        frontend: "typescript";
        adapter: "typescript-compiler-api";
        adapterVersion: "1";
        frontendVersion: string;
        analysisMode: "checked";
        rule: "bench-loop-prepared-function-value/1";
      };
      target: {
        kind: "target/1";
        target: "standalone";
        backend: "wasmgc";
        environment: "none";
        capabilityPolicy: "explicit-only";
        semanticProviders: "native-first";
        hostValueInterop: "off";
        strictEnvImportGate: boolean;
        nativeStringsRequiredByPolicy: true;
        fast: false;
        wasi: false;
        standalone: true;
        nativeStrings: true;
        experimentalIR: true;
        disableIrFirst: false;
        irFirstExplicitlyDisabled: false;
        cutoverEnabled: true;
      };
      sourceProjection: SemanticFunctionValueSourceProjectionV1;
      route: SemanticBenchLoopRouteV1;
    }

    interface SemanticFunctionValueSourceProjectionV1 {
      kind: "source-projection/1";
      sources: readonly SemanticRouteSourceV1[];
      routeUnitAnchors: readonly [
        SemanticRouteUnitAnchorV1,
        SemanticRouteUnitAnchorV1,
        SemanticRouteUnitAnchorV1,
      ];
      declarations: readonly SemanticRouteDeclarationV1[];
      importLink: SemanticRouteImportLinkV1;
      queries: readonly SemanticRouteQueryV1[];
      callsites: readonly [SemanticRouteCallsiteV1];
      edges: readonly SemanticRouteEdgeV1[];
      candidateUses: readonly [SemanticRouteCandidateUseV1];
      blockers: SemanticRouteSourceBlockersV1;
      scalarLeafCandidateUnitIds: readonly [];
      reductionLeafCandidateUnitIds: readonly [string];
      reduction: SemanticReductionV1;
      callable: SemanticCallableV1;
    }

    interface SemanticRouteSourceV1 {
      kind: "source/1";
      sourceId: string;
      sourceKey: string;
      sourceKind: "entry" | "source";
      inventoryOrder: number;
      semanticOrder: number;
      declarationFile: boolean;
      utf16Length: number;
      text: string;
    }

    interface SemanticRouteUnitAnchorV1 {
      kind: "route-unit-anchor/1";
      role: "prepared-target" | "legacy-owner" | "imported-target";
      unitId: string;
      sourceId: string;
      unitKind: "top-level-function";
      unitOrdinal: number;
      declarationStart: number;
      declarationEnd: number;
      displayName: string;
      terminalOwnerUnitId: string;
    }

    interface SemanticFunctionValueSourceReprojectionInputV1 {
      kind: "source-reprojection-input/1";
      rule: "bench-loop-prepared-function-value/1";
      sources: readonly SemanticRouteLiveSourceInputV1[];
      topLevelFunctionUnits: readonly SemanticRouteLiveTopLevelFunctionUnitInputV1[];
    }

    interface SemanticRouteLiveSourceInputV1 {
      kind: "live-source-input/1";
      sourceId: string;
      sourceKey: string;
      sourceKind: "entry" | "source";
      inventoryOrder: number;
      semanticOrder: number;
      declarationFile: boolean;
      text: string;
    }

    interface SemanticRouteLiveTopLevelFunctionUnitInputV1 {
      kind: "live-top-level-function-unit-input/1";
      unitId: string;
      sourceId: string;
      unitKind: "top-level-function";
      unitOrdinal: number;
      declarationStart: number;
      declarationEnd: number;
      displayName: string;
      terminalOwnerUnitId: string;
    }

    interface SemanticRouteImportLinkV1 {
      kind: "import-link/1";
      id: string;
      importerSourceId: string;
      importStart: number;
      importEnd: number;
      moduleSpecifier: string;
      importedName: string;
      localName: string;
      localDeclarationId: string;
      targetSourceId: string;
      targetDeclarationId: string;
      targetExportStart: number;
      targetExportEnd: number;
      targetExported: true;
    }

    type SemanticRouteDeclarationRole =
      | "prepared-target"
      | "legacy-owner"
      | "named-import"
      | "imported-target"
      | "reduction-accumulator"
      | "reduction-induction"
      | "same-spelling-unanchored";

    interface SemanticRouteDeclarationV1 {
      kind: "declaration/1";
      id: string;
      sourceId: string;
      start: number;
      end: number;
      role: SemanticRouteDeclarationRole;
      declarationKind: "function" | "named-import" | "variable";
      name: string;
      lexicalOwnerDeclarationId: string | null;
      topLevel: boolean;
      exported: boolean;
      functionShape: {
        async: false;
        generator: false;
        parameterCount: number;
      } | null;
      unitId: string | null;
    }

    type SemanticRouteQueryPurpose =
      | "function-value-use"
      | "named-import-callee"
      | "imported-target-name"
      | "reduction-accumulator-use"
      | "reduction-induction-use";

    interface SemanticRouteQueryV1 {
      kind: "query/1";
      id: string;
      sourceId: string;
      start: number;
      end: number;
      purpose: SemanticRouteQueryPurpose;
      lexicalOwnerDeclarationId: string;
      outcome: "proven" | "absent";
      valueDeclarationId: string | null;
      declarationIds: readonly string[];
    }

    interface SemanticRouteCallsiteV1 {
      kind: "callsite/1";
      id: string;
      sourceId: string;
      start: number;
      end: number;
      lexicalOwnerDeclarationId: string;
      calleeQueryId: string;
      argumentQueryId: string;
      argumentOrdinal: 3;
      argumentCount: 4;
    }

    interface SemanticRouteCandidateUseV1 {
      kind: "candidate-use/1";
      id: string;
      queryId: string;
      sourceId: string;
      start: number;
      end: number;
      lexicalOwnerDeclarationId: string;
      useKind: "required-function-value-argument";
      callsiteId: string;
    }

    interface SemanticRouteSourceBlockersV1 {
      kind: "source-blockers/1";
      commonJsSourceIds: readonly string[];
      classDeclarationKeys: readonly string[];
      moduleInitSourceIds: readonly string[];
      directCallerActivationSourceIds: readonly string[];
      candidateNameCollisionKeys: readonly string[];
      candidateImportAliasKeys: readonly string[];
      unclassifiedCandidateUseKeys: readonly string[];
    }

    type SemanticRouteEdgeKind =
      | "query-declaration"
      | "function-value-owner"
      | "named-import-target"
      | "call-owner"
      | "reduction-binding";

    interface SemanticRouteEdgeV1 {
      kind: "edge/1";
      id: string;
      edgeKind: SemanticRouteEdgeKind;
      fromDomain: "query" | "declaration";
      fromId: string;
      toDomain: "declaration";
      toId: string;
    }

    interface SemanticReductionV1 {
      kind: "reduction/1";
      rule: "i32-wrapping-sum-loop/1";
      accumulatorDeclarationId: string;
      inductionDeclarationId: string;
      accumulatorInitial: 0;
      inductionInitial: 0;
      comparison: "strict-less-than";
      upperBound: 1000000;
      increment: "post-increment-one";
      update: "i32-wrapping-add";
      returnDeclarationId: string;
    }

    interface SemanticCallableV1 {
      kind: "semantic-callable/1";
      parameters: readonly [];
      result: "number";
      captureCount: 0;
      explicitThisParameter: false;
      eagerAsyncPromiseWrap: false;
      restParameter: false;
      constructibleWrapper: true;
      wrapperProfile: "ordinary-function-declaration-constructible";
      instanceMetadata: {
        kind: "function-instance-metadata/1";
        name: string;
        length: 0;
      };
    }

    interface SemanticTerminalOutcomeUnitV1 {
      kind: "terminal-outcome-unit/1";
      unitId: string;
      sourceId: string;
      lexicalOwnerUnitId: null;
      unitKind: "top-level-function";
      unitOrdinal: number;
      syntheticRole: null;
      declarationStart: number;
      declarationEnd: number;
      legacyKey: string;
      legacyMatchName: string;
      observedKind: "function";
      displayName: string;
      legacyOrdinal: number;
      line: number;
      column: number;
      terminal: true;
      terminalOwnerUnitId: string;
      containingTerminalOwnerUnitId: null;
      unownedReason: null;
      staticClassMember: false;
      legacyBodyAvailable: true;
      directFailure: null;
    }

    type SemanticAbiIntentV1 =
      | {
          kind: "abi-callable-intent/1";
          role: "target" | "trampoline";
          bindingId: string;
          terminalOwnerUnitId: string;
          structuralReferenceKey: string;
          displayName: string;
          origin: "source" | "support";
          slotSpace: "function";
          slotPolicy: "required";
          carrierProfile: "zero-args-f64" | "function-value-ref-to-f64";
          contractAuthority: "prepared-program-abi";
        }
      | {
          kind: "abi-global-intent/1";
          role: "cache";
          bindingId: string;
          terminalOwnerUnitId: string;
          structuralReferenceKey: string;
          displayName: string;
          origin: "support";
          slotSpace: "global";
          slotPolicy: "required";
          mutable: true;
          valueCarrier: "externref";
          contractAuthority: "prepared-program-abi";
        };

    interface SemanticBenchLoopRouteV1 {
      kind: "route/1";
      route: "multi-prepared-function-value-leaf";
      sourceId: string;
      legacyName: string;
      candidateDeclarationId: string;
      candidateUnitId: string;
      legacyOwnerDeclarationId: string;
      legacyOwnerUnitId: string;
      importedTargetDeclarationId: string;
      importedTargetUnitId: string;
      inventoryUnitIds: readonly string[];
      candidateUnitIds: readonly [string];
      componentTerminalUnitIds: readonly [string];
      priorClaimedSourceIds: readonly string[];
      priorClaimedTerminalUnitIds: readonly string[];
      priorClaimedTargetUnitIds: readonly string[];
      candidateOwnedDerivedUnitIds: readonly [];
      terminalOutcomeUnit: SemanticTerminalOutcomeUnitV1;
      abiIntents: readonly [SemanticAbiIntentV1, SemanticAbiIntentV1, SemanticAbiIntentV1];
    }

The record key formulas are exact:

- source key = `sourceId`;
- route-unit-anchor key = `unitId`;
- declaration ID =
  `sourceId + NUL + start + NUL + end + NUL + role`;
- query ID =
  `sourceId + NUL + start + NUL + end + NUL + purpose`;
- callsite ID = `sourceId + NUL + start + NUL + end + NUL + "callsite"`;
- import-link ID =
  `importerSourceId + NUL + importStart + NUL + importEnd + NUL + localName`;
- candidate-use ID =
  `queryId + NUL + lexicalOwnerDeclarationId + NUL + "required-function-value-argument"`;
- class-declaration blocker key =
  `"class-declaration" + NUL + sourceId + NUL + start + NUL + end + NUL + name`;
- candidate-name-collision blocker key =
  `"candidate-name-collision" + NUL + sourceId + NUL + start + NUL + end + NUL + name`;
- candidate-import-alias blocker key =
  `"candidate-import-alias" + NUL + sourceId + NUL + start + NUL + end + NUL + localName + NUL + importedName + NUL + moduleSpecifier`;
- unclassified-candidate-use blocker key =
  `"unclassified-candidate-use" + NUL + sourceId + NUL + start + NUL + end + NUL + spelling`;
- edge ID =
  `edgeKind + NUL + fromDomain + NUL + fromId + NUL + toDomain + NUL + toId`;
- ABI intent key = `bindingId`.

Endpoint and role domains are exact:

| Edge kind | From | To | Required join |
| --- | --- | --- | --- |
| `query-declaration` | any proven query | declaration | query `valueDeclarationId === toId` |
| `function-value-owner` | `function-value-use` query | `legacy-owner` declaration | same source as the use and route owner |
| `named-import-target` | `named-import` declaration | `imported-target` declaration | distinct sources, exact recorded module edge |
| `call-owner` | `named-import-callee` query | `legacy-owner` declaration | same callsite source and route owner |
| `reduction-binding` | accumulator/induction use query | matching reduction declaration | purpose and declaration role agree |

`callsites` has exactly one row. Its range is the full imported call; its
`lexicalOwnerDeclarationId` is the exact `legacy-owner`; its
`calleeQueryId` names the exact `named-import-callee` query; its
`argumentQueryId` names the exact `function-value-use` query; and the
function value is argument ordinal 3 of exactly four arguments. Both query
ranges must be strict children of the callsite range in the same source. This
record—not two unrelated owner edges—proves that the imported callee consumes
the candidate value at that exact call.

`prepared-target`, `legacy-owner`, `imported-target`, and
`same-spelling-unanchored` declarations are `function`, top-level, have null
lexical owners, and have a non-null top-level function UnitId. The first three
are exported, non-async, non-generator functions in the admitted fixture; the
prepared target and legacy owner have zero parameters and the imported target
has exactly four. `named-import` is a non-exported,
top-level `named-import` declaration with
`lexicalOwnerDeclarationId: null` and `unitId: null`. Both reduction locals are
non-exported `variable` declarations with
`lexicalOwnerDeclarationId === candidateDeclarationId` and `unitId: null`; all
non-functions have a null `functionShape`.
The three non-null route declarations join one-to-one with the three
`routeUnitAnchors`, whose source/range/name, top-level kind, unit ordinal, and
self terminal owner are independently projected from the complete neutral
planning inventory. The parser never derives a UnitId from spelling.
The admitted record has exactly one declaration in each of the first six roles
and zero `same-spelling-unanchored` declarations:

| Role | Exact count | Required reachability |
| --- | ---: | --- |
| `prepared-target` | 1 | route candidate, function-value query and ABI target |
| `legacy-owner` | 1 | route owner, function-value-owner and call-owner edges |
| `named-import` | 1 | named-import-callee query and named-import-target edge |
| `imported-target` | 1 | imported-target-name query, import edge and route target |
| `reduction-accumulator` | 1 | reduction record, three queries and return |
| `reduction-induction` | 1 | reduction record and three queries |
| `same-spelling-unanchored` | 0 | negative fixtures only; any admitted row withdraws |

Every declaration must be reachable from the route, reduction, callsite,
query, edge, or ABI population. An extra well-formed but unreachable row is an
error.
The positive `bench_loop` record has exactly nine proven queries: one
function-value use, one named-import callee, one imported-target name, three
accumulator uses, and three induction uses. It has one
`query-declaration` edge per query, one function-value-owner, one
named-import-target, one call-owner, and six reduction-binding edges. Any other
cardinality is a versioned-rule mismatch, not an extension point. Every query
records its exact containing declaration: the reduction queries are owned by
the prepared target, the callee/function-value queries by the legacy owner,
and the exported-target name by the imported target. The sole candidate-use
row is the complete source-wide census of references resolving to the
candidate declaration, joins the function-value query and callsite, and has
`useKind: "required-function-value-argument"`. A direct call or any second,
unclassified, differently owned, or differently positioned candidate use
withdraws v1.

`importLink` is the explicit module relationship, not an edge reconstructed
from parent pointers. It joins the importer/import-declaration range, exact
relative module specifier, imported/local spelling and local declaration to
one distinct target source and one top-level exported target declaration.
Both export and import ranges are strict ranges in their recorded sources.
Type-only/default/namespace/CommonJS/re-export forms and an ambiguous source
key or export target withdraw this rule.

Sources sort by `inventoryOrder`, then `semanticOrder`, then `sourceId`;
route-unit anchors occur exactly in prepared-target, legacy-owner,
imported-target order; declarations, queries, callsites, candidate uses, and
edges sort by their IDs; declaration-ID populations, blocker keys, and every route census sort
lexically; ABI intents occur exactly in target, trampoline, cache order. JSON
object keys serialize in the field order shown above. The parser validates
each stored ID by recomputing it, requires unique arrays, validates every edge's
allowed endpoint domains and role/purpose pairing, and proves full referential
closure. A query with outcome `proven` has a non-null
`valueDeclarationId` and its complete `declarationIds` population is exactly
`[valueDeclarationId]`; this preserves the current load-bearing
`declarationsOf(node).length === 1` and value/declarations identity proof. An
`absent` query has `valueDeclarationId: null` and `declarationIds: []`. A
second distinct declaration is rejection, not an ambiguous-but-usable query.
Every range must satisfy
`0 <= start < end <= source.utf16Length`, and `utf16Length` is measured in
UTF-16 code units and must equal the exact JavaScript string `text.length`.
The source array is the complete exact user-source denominator, including
unreferenced sources. `inventoryUnitIds` is the complete exact planning-unit
denominator and is unique/sorted. `inventoryOrder` is the planning-inventory order and
`semanticOrder` is the exact route input order. Candidate/component and prior
claim arrays are complete sorted populations, never opaque counts or
precomputed booleans. For the admitted fixture, `candidateUnitIds` and
`componentTerminalUnitIds` are each exactly `[candidateUnitId]`.
`candidateUnitIds` is not a receipt-authored singleton: it must equal the fresh
`sourceProjection.reductionLeafCandidateUnitIds`, while
`sourceProjection.scalarLeafCandidateUnitIds` must be exactly empty. Both
denominators are rerun from the complete source/top-level-unit input in every
currentness phase; the three selected route anchors cannot supply them.
`priorClaimedSourceIds`, `priorClaimedTerminalUnitIds`, and
`priorClaimedTargetUnitIds` are the complete central route-claim ledger before
D1 registers its own claim; each array is unique and lexically sorted, and the
candidate source/unit must be absent. `candidateOwnedDerivedUnitIds` is not a
whole-program derived inventory: it is the complete sorted subset of live
derived records whose `terminalOwnerId === candidateUnitId`. It is empty for
the admitted fixture; unrelated derived records are allowed and inert.

The source blocker arrays are instead complete facts reprojected from the
complete source texts: CommonJS-bearing sources, class declarations,
executable top-level/module-init sources, sources where any top-level function
observes its own `.caller` or `.arguments`, same/cross-file candidate-name
collisions, candidate import aliases, and candidate uses that the bounded
resolver cannot classify. They are all empty for the admitted fixture. V1
does not claim to serialize every owner in every legacy provider map. It
narrows that contract to the complete source-derived membership of this one
candidate: the candidate body and every resolved candidate use must match the
closed reduction/callsite graph above. During capture, the existing provider
collectors are a mandatory independent cross-check:
`preparedFunctionValueTargetUnitIds` must be exactly `[candidateUnitId]`, while
the candidate must be absent from imported-call-owner,
top-level-function-value-owner, host callback/Date, promise-delay,
suspending-async, timer, and direct-caller-activation families. A missing,
duplicate, foreign prepared target, a candidate in any disallowed family, or
disagreement with the neutral candidate-use graph withdraws. Unrelated owners
may remain in those legacy populations. After finalization the AST-keyed maps
are neither retained nor consumed by D1. This removes the previously
unprovable whole-program provider denominator without weakening any untouched
route.

### Independent neutral source reprojection

`src/ir/semantic-function-value-source-projection.ts` owns a small,
deterministic UTF-16 scanner and bounded structural parser. It imports neither
TypeScript nor Acorn and accepts only one closed
`SemanticFunctionValueSourceReprojectionInputV1`. Its `sources` are the complete
live source population with both independently supplied `inventoryOrder` and
`semanticOrder`; its `topLevelFunctionUnits` are the complete live population
of every top-level-function unit, with all eight fields shown above. Both
populations are unique and complete, and neither may be derived by filtering
the frozen route's three selected anchors. The parser selects and emits those
three route anchors only after joining its source proof to this full input.
It tokenizes identifiers, keywords, numeric/string/template
literals, comments, punctuation, and the exact operators needed by the route;
tracks balanced braces, parentheses, brackets, and lexical scopes; and records
token start/end offsets directly in UTF-16 code units. Invalid escapes,
unterminated tokens, unbalanced delimiters, duplicate source keys, or syntax it
cannot classify at a route-relevant boundary return an explicit `unknown`
failure. Silent empty output is forbidden.

The program owner creates a private `LiveSemanticSourceTextHandle` population
before finalization while the existing source maps are still authoritative.
Each handle binds one source ID to one exact entry of the owner's complete live
SourceFile array, but exposes only `.text` and `.isDeclarationFile` to the
reprojection adapter. On every later phase the adapter walks the owner's live
array again to derive `semanticOrder`, joins the handle's source ID to the
current complete neutral inventory to derive source key/kind/inventory order,
and reads the fresh text. It never looks up a SourceFile in either identity
map, traverses the node, or copies a frozen source record. Replacing/reordering
the live array, source handle, or neutral inventory is detected; deleting or
poisoning the old bidirectional SourceFile maps remains inert. This text-only
carrier is codegen-local and never enters the neutral facts API or canonical
bytes.

The bounded parser independently reconstructs:

- top-level named imports and their exact relative-module target, top-level
  exported function declarations, declaration names/ranges, lexical owners,
  local variable scopes, and exact joins to the neutral top-level-function
  unit anchors;
- the exact zero-parameter exported reduction function and all six bound local
  identifier uses in its closed `let`/`for`/wrapping-add/return grammar, plus
  its independently derived zero-capture/no-this/no-async/no-rest,
  constructible ordinary-function wrapper and `{name, length: 0}` metadata;
- the complete candidate denominators used by the existing planner across
  every source/top-level-function unit. `scalarLeafCandidateUnitIds` applies
  the exact syntax-only `hasExactNumericDeclarationSignature` plus
  `isSyntacticScalarLeaf` rules: named body-bearing non-async/non-generator,
  no type parameters, explicit numeric return and required identifier/numeric
  parameters, only identifier locals, no nested function/class, only
  `+ - * /` binary and unary `+/-`, no postfix operator, and none of the
  call/new/property/element/object/array/throw/try/for-in/for-of/with/spread/
  this/super/await/yield or non-local-identifier forms. The reduction census
  applies that same exact numeric declaration signature plus the closed
  source-identity reduction grammar above. Each accepted declaration joins its
  exact source/range/name to one supplied top-level UnitId; an unsupported
  construct at either candidate boundary returns `unknown`, never an omitted
  row. The admitted population is scalar `[]` and reduction
  `[candidateUnitId]`;
- the exact containing top-level owner, imported four-argument call, callee,
  argument-3 function-value use, and the complete source-wide census of every
  identifier token that can resolve to the candidate;
- all top-level function names/import aliases needed to derive collision rows,
  and conservative CommonJS, class, and executable-top-level/module-init
  blockers from every source, plus a complete scan of every top-level function
  body for the exact current-name `name.caller` / `name.arguments` shape or an
  element access whose key is an unescaped single- or double-quoted string
  literal or unescaped no-substitution template literal containing exactly
  `caller` or `arguments`. The receiver identifier activates when its token
  spelling equals that function declaration's name even if a nested binding
  shadows it or a frontend cannot resolve it; this deliberately reproduces the
  producer's `resolved-to-declaration OR same-spelling` fallback, with the
  spelling fallback winning. Every enumerated optional property/element form,
  including `name?.caller`, `name?.["caller"]`, and
  `name?.[\`arguments\`]`, activates identically. An escape in the key at this
  boundary produces explicit `unknown` rather than attempting to reproduce the
  TypeScript AST's cooked `key.text`; unrelated receivers remain nonblocking;
  and
- the explicit import/export link to the one target declaration.

Function bodies unrelated to the candidate may be traversed as balanced token
regions, but never silently ignored: any candidate spelling, alias, shadowing
declaration, unbalanced construct, self `.caller`/`.arguments` access, or
potentially executable top-level token inside such a region must either be
classified into the projection or produce `unknown`. A source that contains no
candidate spelling may remain opaque only after its top-level
imports/exports/declarations, classes, CommonJS forms, module-init status, and
direct-caller-activation status and every top-level function's scalar/reduction
candidate status have been classified. This is a rule-specific semantic
reprojector, not a second general TypeScript parser.

At capture, the TypeScript adapter still performs the existing checker/AST
proof, but it must also run this neutral parser from the exact source inventory
and require the two independently produced source projections to be
field-for-field equal before serialization. After finalization, the TypeScript
projection is discarded. Every `preallocation`, `post-support`, `pre-body`,
`late`, `pre-publication`, and `post-publication` descriptor reruns the neutral parser from fresh live source
texts, freshly rebuilt order fields, and the full live top-level-function unit
population, and carries its newly allocated `sourceProjection`; no range, owner,
module, import/export, query, callsite, edge, candidate-use, blocker, or
scalar/reduction-candidate census, reduction fact, or selected unit anchor is
copied from the receipt. The reader compares that entire
projection to the frozen one. Therefore a coherent range shift with unchanged
source text, even with all serialized IDs and external digests recomputed,
cannot become current.

`legacyName` is not the rule identity. It is one ASCII identifier matching
`^[A-Za-z_$][A-Za-z0-9_$]*$`, joined to the prepared-target declaration and
UnitId. ABI display names are derived exactly: target = `legacyName`,
trampoline = `__fn_tramp_${legacyName}_cached`, cache =
`__fn_closure_${legacyName}`. The existing all-uses rename to
`renamed_reduction` must therefore remain admitted with correspondingly
derived support names. `sourceProjection.callable.instanceMetadata.name` must equal that same
dynamic `legacyName`; its length, constructible ordinary-declaration profile,
and the other closed callable flags above are part of the producer proof, not
defaults supplied by codegen.

`terminalOutcomeUnit` is both the complete candidate-inventory projection and
the exact neutral base for the later D1 outcome row. Its source, UnitId,
root-lexical owner, closed top-level-function kind, unit ordinal, null synthetic
role, declaration range, terminal owner, key/name, observed kind, display name,
legacy ordinal, location, containing-owner/class flags, body availability, and
unowned/direct-failure state must join the route candidate and complete inventory
record. Unit and legacy ordinals are zero-based; line/column are one-based. It
is exactly one physical function terminal with an available direct body and no
direct preparation failure. The reader rejects a target whose inventory
projection does not match rather than asking a `SourceFile` to rediscover it
later.

D1 deliberately embeds the exact bounded source text and exact target-policy
projection instead of inventing an undefined whole-compiler-options projection.
The target projection includes every gate that can prevent the current early
route: `options.experimentalIR === true`, `options.disableIrFirst === false`,
and `explicitlyDisabled(JS2WASM_IR_FIRST) === false`, in addition to the
standalone/fast/WASI/native-string and D1-cutover fields shown above. The
normalized environment result is stored rather than an arbitrary raw string,
and is recomputed from the live option/environment inputs in every current
descriptor. Changing any one gate withdraws before support allocation.
The plain expected-provenance descriptor supplied to the reader contains the
current adapter version and exact `ts.version`; `frontendVersion` is
1–128 ASCII characters from `[0-9A-Za-z.+-]` and must match it. A frontend
upgrade therefore invalidates stale D1 bytes without asking a checker.

Canonical JSON is ASCII: string serialization escapes every control, quote,
backslash, non-ASCII code unit, and lone surrogate as fixed lowercase
`\uXXXX` (supplementary characters are two escaped UTF-16 code units).
This makes source text and ranges injective without relying on
`TextEncoder`'s treatment of lone surrogates. The test/evidence harness
reports:

- source SHA-256 over ASCII
  `"js2-semantic-source/1" + NUL + decimalByteLength + NUL + canonicalJson(text)`;
- envelope SHA-256 over ASCII
  `"js2-semantic-function-value-route-facts/1" + NUL + decimalByteLength + NUL + canonicalEnvelope`.

Lengths are decimal ASCII byte lengths of the following framed value. These
digests prove reproducibility but are not authenticators; production
currentness uses the exact embedded text/target records and the independently
rebuilt descriptor. A process-independent source blob store remains Phase E.

The semantic callable record owns `() -> number`. Neutral ABI intent owns the
three binding IDs, roles, owners, names, structural keys, origins, slot
spaces/policies, and carrier profiles. The frozen Prepared Program ABI remains
the independent authority for concrete backend contracts and final slots. The
D1 producer derives the target binding with
`irUnitCallableBindingId(candidateUnitId)`, the trampoline with
`irSupportFuncRef(candidateUnitId, "function-value-trampoline", derivedName)`,
and the cache with
`irSupportGlobalRef(candidateUnitId, "function-value-cache", derivedName)`;
each stored structural-reference key must equal that exact binding
descriptor's canonical key. The
D1 adapter must validate the complete #4590 projection: target `[] -> f64`;
trampoline exactly one canonical `ref`/`ref null` parameter and `f64`
result; cache mutable `externref`; exact source/support origins; and required
function/function/global slot spaces. Mutable final indexes and allocator
objects never enter the semantic snapshot.

### Producer-only TypeScript adapter

The TypeScript adapter may use the live checker, oracle, planning identity, and
AST while producing the record. It must perform the exact C1 declaration
queries plus the import-parent, exported-target, reduction grammar, binding,
graph/collision, semantic-signature, and expected-ABI-intent proofs. It emits
only neutral records.

Capture is still discovery, not authority:

1. run the exact producer proof once and collect a complete candidate record;
2. canonicalize, serialize, parse, validate, and freeze it;
3. discard the recording oracle and all AST-join helpers from the decision
   path; and
4. run the decisive eligibility proof against only the neutral reader and a
   fresh preallocation descriptor. Support and Prepared/ABI results do not yet
   exist; they are added and authenticated only in their tagged phases below.

Delete the production `DeclarationSnapshotJoin` and
`createDeclarationSnapshotReplayOracle` path. The producer must not return a
`ts.Declaration`, `ts.SourceFile`, `TypeOracle`, planning-identity map, role
classifier, or callback through the neutral facts API. Static type assertions
and layering checks must prove that the new module and its exported receipt do
not mention `ts.*`, Acorn, checker types, or codegen context.

### Exact neutral handoffs below certification

D1 must close eight current post-certification frontend seams. These are priced
implementation work, not assumptions about the existing #3525 receipt:

1. **Support allocation.** Today
   `prepareTopLevelFunctionValueTargetSupport` calls
   `collectPreparedTopLevelFunctionValueTargetUnitIds`, which traverses the
   source and calls the live oracle after C1 certification. Factor an internal
   `prepareTopLevelFunctionValueSupportForCertifiedUnit(ctx, proof)` that
   accepts only the frozen neutral proof containing the candidate UnitId and
   three ABI intents. It must not accept `IrOverlayPlan`, `SourceFile`, a
   declaration, a legacy-name lookup, or a fallback callback. It
   calls a new
   `ensureFuncClosureSingletonFromCertifiedMetadata(ctx, request)` path with
   the exact target handle/signature and frozen callable contract. Factor the
   existing singleton emitter into a shared lower-level allocation core, but
   make the certified entry validate `[] -> f64`, capture count zero,
   no explicit `this`, no eager-async result promotion, no rest marker,
   `constructible=true`, the exact ordinary-function-declaration wrapper
   profile, and exact `{name: legacyName, length: 0}` before its first write.
   This matches `normalizeOrdinaryFunctionConstructibility`. D1a must first
   remove the incorrect `false` assumption at the exact Prepared support call
   in `prepareTopLevelFunctionValueTargetSupport`. That early helper is the
   candidate's sole allocator, metadata preparer, Program-ABI planner, and
   direct-materialization registrar. It receives one closed
   `constructibleFunctionValueTargetUnitIds` set whose only non-empty producer
   is the existing certified C1 early route: after
   `resolveExactFunctionValueCandidate` succeeds, the function-value planner
   passes exactly `new Set([candidate.unitId])` to its support callback. The
   helper changes `constructible=false` to `true` only when the current target
   UnitId is in that set. The ordinary per-source support call,
   array/string/Fibonacci routes, route-disabled states, and every other
   top-level value keep an empty set and the literal legacy `false` behavior.

   The paired top-level-function-value site in
   `prepareMultiIrImportedLowering` must not allocate the candidate a second
   time. Extend the early `MultiPreparedFunctionValueSupportReceipt` with the
   exact frozen `CertifiedFunctionValueSingletonReceipt` and layout-cell
   identity returned by the early allocation. For an early function-value
   route, `compileMultiIrOverlaySource` passes the late helper one exact
   `ReadonlyMap<IrUnitId, MultiPreparedFunctionValueSupportReceipt>` containing
   only `[early.route.unitId, early.route.support]`; every other route passes an
   empty map. Inside the existing top-level-function-value loop, first require
   `valuePlan.target.binding.kind === "unit"`, then derive membership only from
   `valuePlan.target.binding.unitId`. Never use `valuePlan.ownerUnitId`, a loop
   owner, a legacy name, or source order as the support key.

   When that exact target UnitId is present, call a frontend-free
   `reauthenticateCertifiedFunctionValueSupportForLateProvider` instead of
   `ensureFuncClosureSingleton` and `planProgramAbiFunctionValue`. It requires
   the map key, value-plan target binding/name, target/trampoline/cache objects
   and stable handles, support binding IDs, singleton receipt, and layout cell
   to be the same early objects; freshly validates their live Program-ABI
   drafts, locators, current indices, signatures, and structural keys; and
   requires the direct-materialization entry already to be consumed at
   revision 0 with `expectedUseCount=1` and `observedUseCount=1`. This call
   occurs after legacy body emission, so a pending entry is not an acceptable
   late state. The helper snapshots every touched registry, module array/map,
   Program-ABI inventory, recipe/cell field, and counter before the check and
   proves them identical afterward. It performs no singleton allocation,
   metadata prepare/materialize, string/global/type/function allocation,
   `planUnits`, Program-ABI plan/observe, support planning, registry
   register/take/settlement, body write, or pending-row write. An absent,
   duplicate, foreign, owner-keyed, or identity-mismatched certified entry is
   fatal for the early function-value route. A top-level value outside this
   exact map follows the unchanged generic `constructible=false` allocation
   and ABI-planning path.

   Thus D1a's early and late physical call opportunities share one receipt and
   one layout cell: the early call writes once, the legacy `main` emitter takes
   once, and the late call only authenticates the consumed result. D1a derives
   constructibility and metadata from the existing C1 candidate/early-route
   authority without blanket-widening every function-value route. It exercises
   the actual lazy-cache materializer, records the expected physical delta from
   old C1, and establishes the corrected baseline. D1b replaces that
   source-derived early decision with the frozen neutral callable proof and
   carries the same exact singleton UnitId in its distinct certified-support
   callback. D1b bypasses `prepareMultiIrImportedLowering` for the candidate;
   this remains artifact-equal because D1a's candidate-specific late branch is
   provably zero-write. The shared allocation core prepares metadata through
   `prepareFnMetaSlotOfMeta`. Unrelated legacy callers of the unchanged
   `fnMetaSlotOfMeta` entry still invoke `materializePreparedFnMetaSlot`
   immediately. In contrast, both D1a's exact C1-authorized support branch and
   D1b's neutral-authorized branch carry the same recipe through the same
   one-shot registry to the actual direct consumer. Thus both checkpoints
   allocate/materialize the `bench_loop` name carrier at the identical legacy
   `main` emission point; D1b changes authority only, never string/global
   allocation order. The core returns one frozen
   `CertifiedFunctionValueSingletonReceipt`. The receipt owns stable symbolic
   target/trampoline/cache identities plus one authenticated
   `CertifiedFunctionValueLayoutCell`. Target and trampoline are #1916 stable
   `FuncHandle` values at or above `STABLE_FUNC_BASE`; they and the
   `funcClosureSingletonKeyByFuncIdx` key never shift under late imports or
   function-import DCE. The receipt does not freeze a resolved absolute
   function index, an absolute global index, a detached metadata instruction
   array, or a TypeDef object reference as a timeless value. At allocation
   revision 0 the cell records the exact constructible base-wrapper and final
   metadata-carrying allocation subtype identities, metadata field, cache and
   metadata `GlobalDef` object identities, the canonical `{name,length}`
   metadata recipe, target/trampoline stable handles, and their then-live
   function object identities. The only later cell mutation is the named
   post-DCE settlement described below. The
   certified allocator must not call
   `sourceFunctionDeclarationForHandle`, inspect `funcMapOwnerDecl` /
   `topLevelFunctionDeclarations`, call
   `parkedAsyncDeclarationWrapsPromise`, read `funcRestParams`, or pass a
   declaration to `fnMetaSlot`. The legacy `ensureFuncClosureSingleton` derives
   those values exactly as today and invokes the same core; no legacy caller is
   redirected through the certified assertions. After the preallocation proof
   and before planning either support binding, the D1 allocator must call the
   existing neutral `ctx.programAbiSourceCallables.planUnits([candidateUnitId])`
   exactly once. Before that write it proves registry/session/inventory object
   coherence and the observed handle/object against the neutral UnitId and
   recomputed target binding ID; after it, it independently validates the
   resulting target draft, locator, current index, signature, structural key,
   and order. This targeted plan is the only permitted write between
   `preallocation` and singleton/support allocation. Merely observing/looking
   up the source callable is not a planned ABI entry. The D1 support allocator then
   allocates and validates the existing source callable/trampoline/cache and
   authenticated function-instance allocation receipt without a source scan or
   oracle. Keep the old collector wrapper byte-for-byte authoritative for
   array, Fibonacci, string, every direct route outside the exact D1a
   `bench_loop` comparator, and other unprepared callers. Thread a distinct
   `prepareCertifiedFunctionValueSupport` callback through only the exact
   interface/pass-through seam in
   `MultiPreparedProgramRoutePlanningInput` / `planExistingRoutes`, the D1
   function-value leaf in `MultiPreparedProgramEarlyRouteInput`, and
   `planEarlyMultiPreparedFunctionValueRoutes`; Fibonacci keeps and continues
   to receive the distinct legacy plan/source callback.

   The receipt is not advisory. The exact `bench_loop` value is referenced by
   the legacy `main` body, which is intentionally excluded from
   `finalSelection.funcs`; the Prepared candidate body contains no
   `closure.new`. Therefore the authenticated receipt must cross the actual
   direct-emitter boundary, not an unreachable IR lowering-plan seam.

   Add one codegen-local
   `CertifiedFunctionValueDirectMaterializationRegistry`, keyed by the exact
   target WasmFunction object identity and `targetBindingId`, never by a
   durable numeric function index. After support allocation and before
   source-body emission, the D1 owner registers one frozen pending entry that
   owns the singleton receipt, stable layout-cell identity, exact legacy name,
   expected one-use census, and current revision-0 target/trampoline/cache,
   allocation-type, metadata-global-object, and canonical metadata-recipe
   identities. It retains no detached initializer instruction array.
   Duplicate target objects, binding IDs, or entries
   reject. On D1 withdrawal before body emission, owner abort removes the entry
   so the ordinary legacy path remains available; after the body boundary an
   unconsumed or multiply consumed entry is fatal.

   At the start of `emitCachedFuncClosureAccess`, before
   `normalizeOrdinaryFunctionConstructibility` or any declaration lookup, ask
   the registry for the exact `(ctx, targetHandle, funcName)` entry. The
   lookup requires a #1916 stable `FuncHandle` and resolves it through
   `definedFuncAt` to its live WasmFunction object; it never treats the handle
   as a phase-current absolute index. It then
   authenticates that object against the target binding locator; no entry takes
   the unchanged legacy path. One pending entry is atomically marked consumed
   and passed to a bounded `emitCertifiedCachedFuncClosureAccess` branch in
   `method-trampolines.ts`. That branch reauthenticates every live identity and
   canonical allocation/metadata projection. It first materializes the frozen
   metadata name through the existing string-literal primitive, because that
   operation may add import globals. Only afterward does it resolve the cache
   and metadata globals from their exact retained `GlobalDef` objects and the
   current import-global prefix, resolve the allocation/meta TypeDefs from the
   current module, and freshly build the small metadata-init instruction tree
   from the canonical `{name,length}` recipe. It then calls the existing lazy
   cache emission core with those current indices. The freshly built sequence
   is inserted immediately into the live owner body so later global-shift walks
   can see it. A stale receipt-time global index or detached instruction object
   is never used. It must not call
   `ensureFuncClosureSingleton`, the constructibility normalizer,
   `fnMetaSlot`, a checker/oracle, or any SourceFile map. A second take of the
   same target is an invariant rather than a fallthrough. The complete neutral
   candidate-use census proves that no other source use can consume the entry;
   the legacy owner's `compileBodySource` boundary and
   `sealRoutesComplete` independently require exactly one successful
   consumption before overlays or publication. This threads the proof through
   the actual lazy cache initializer while leaving every unrelated direct
   function value and every IR backend byte-for-byte authoritative.

   Dead layout elimination is an explicit phase boundary. The certified branch
   records the exact legacy-owner WasmFunction object and one emitted lazy-cache
   initializer occurrence. Stable `FuncHandle` identities remain unchanged,
   but no pre-DCE resolved absolute index, absolute global index, initializer
   operand, or TypeDef object is authoritative afterward. At the end of
   `eliminateDeadLayoutAndPlanProgramAbi`, after DCE and every retained
   Program-ABI planner have run, call
   `settleCertifiedFunctionValueMaterializationsAfterLayout(ctx)`. It resolves
   the three final ABI indices through their authenticated binding locators,
   separately proves the stable target/trampoline handles still resolve to the
   exact retained functions, finds
   exactly one canonical initializer in the retained legacy-owner body, reads
   the remapped `struct.new` operand and final TypeDefs from `ctx.mod`, rebuilds
   the metadata-init projection, and atomically changes the same cell from
   `{layoutState:"allocation", layoutRevision:0}` to
   `{layoutState:"compacted", layoutRevision:1}`. Missing/dead/ambiguous body
   evidence, a stale locator, a second settlement, or any canonical mismatch is
   fatal before ABI publication. This hook does not change DCE, a stable
   handle, or an emitted value itself; it authenticates the layout DCE already
   produced.

   This introduces no fourth helper or Program-ABI binding: target,
   trampoline, and cache remain the exact three #4590 artifacts.
   `targetBindingId` is always
   `irUnitCallableBindingId(candidateUnitId)` and must equal the role=`target`
   ABI intent, the source-callable draft, and the authenticated allocation
   receipt. It is never the trampoline or cache binding. Those two binding IDs
   remain separately authenticated by their support intents and by the ordered
   `[target, trampoline, cache]` support tuple.
2. **Route claims.** Extend `MultiPreparedRouteClaimSnapshot` with canonical
   `sourceIds` while retaining `sourceFiles` for legacy routes. The central
   `MultiPreparedProgramOwner.planEarlyRoutes` derives and inserts the exact
   source ID for every claimed route. D1 overlap after finalization compares
   only source ID, terminal UnitIds, and target UnitIds; it never calls
   `includes(sourceFile)`. Existing routes may continue their SourceFile
   compatibility check.
3. **Owner reauthentication and publication lifecycle.** Add a bounded neutral
   route/snapshot type beside the legacy AST route in
   `MultiPreparedProgramOwner.#assertRouteFields`, `#snapshotRoute`, and
   `#assertRouteSnapshot`. For D1 it validates source ID, declaration range
   record, terminal/owner UnitIds, canonical bytes, Prepared receipt, support
   receipt, and exact ABI-intent inventory. It must not call
   `ts.isFunctionDeclaration`, inspect declaration parents/bodies, or compare
   `claim.declaration`. Thread that neutral branch through registration,
   `sealBodyBoundary`, `compileBodySource`, `withOverlayState`,
   `sealRoutesComplete`, and the later whole-program stability checks.
   Build `post-support` inside the planner before it returns; rebuild
   `pre-body` after central claim registration in `sealBodyBoundary` and again
   immediately before the candidate direct-body skip; build `late` after all
   direct/overlay owners; and build compacted `pre-publication` last in
   `sealBeforePublication`. After publication, `complete` independently
   reads the published Program ABI and proves the exact target, trampoline, and
   cache entries before retaining the publication. After the three remaining
   mutating whole-module fixups, `sealAfterFinalFixups` performs the terminal
   fresh physical audit described below while retaining those published
   entries. Preserve the AST branch for every untouched route. Neither a check
   before publication nor `complete` can stand in for that final proof.
4. **Late selection/currentness.** The complete D1 function-value branch of
   `compileMultiIrOverlaySource` must not use the late
   `makeMultiIrSafeSelection` result as its authority: that path still walks
   AST-keyed imported calls/function values and checker-derived graph safety.
   It must bypass the whole AST/planning mutation chain for this route,
   including `removeMultiIrAttemptedCallableUnits`,
   `synchronizeIrSafeFunctionSelection`, and
   `prepareMultiIrImportedLowering`, rather than replacing only the first
   selector result. Project the exact singleton selection and lowering inputs
   from the neutral candidate UnitId and frozen Prepared/Program-ABI
   registries, then compare them with the retained early Prepared selection.
   Existing routes keep the current selector and mutation chain.
5. **Physical direct-body skip.** The neutral route supplies one frozen
   physical-skip entry containing exact source ID, source key, declaration
   range, legacy name, terminal UnitId, and `preserve=true` to
   `compileMultiPreparedScalarLeafDeclarations`. The D1-only branch in
   `compileDeclarations` authenticates the current source ID and maps the
   already iterated declaration body handle through that exact range/name
   record; it must not ask `unitIdByDeclaration` or a planning claim which unit
   to skip. It requires exactly one matched and skipped entry and returns the
   exact skipped UnitId. AST iteration remains only the Phase-E body-emission
   handle. The existing name/identity-map routing remains authoritative for all
   legacy routes.
6. **Direct-body receipt lookup.** Add
   `directFunctionBodyReceiptAuditForSourceId(sourceId)` beside the existing
   SourceFile overload. It validates the frozen source ID against the audit
   session's neutral `#sourceById` inventory and reads the existing
   source-ID-keyed receipt census directly; it must not consult
   `sourceIdBySourceFile`, `sourceFileBySourceId`, or accept a `SourceFile`.
   The D1 `recordObservedIrOutcomes` path uses only this overload. All legacy
   callers retain the exact SourceFile method.
7. **Post-skip terminal audit.** Add a closed D1 audit input containing the
   frozen source ID, exact terminal unit projection, neutral singleton
   selection/owner, and Prepared integration evidence. The D1 overload of
   `auditIrSkippedFunctionSlots` validates the one skipped UnitId and its
   terminal evidence without `SourceFile`, `IrOverlayIdentityPlan`,
   `collectObservedIrUnits`, or an AST-derived owner projection. Its result is
   still consumed by the shared fatal diagnostic path. Class-member,
   module-init, and every legacy function audit keep their current
   source/planning inputs.
8. **Observed terminal outcome.** `recordObservedIrOutcomes` must partition the
   D1 target before legacy reconciliation. A bounded neutral reconciler accepts
   the frozen source/terminal record, exact initial and prepared singleton
   UnitId sets, direct-body receipt audit, skipped UnitId, preparation failure
   census, integration report/evidence, existing outcome keys, and target. It
   emits the one exact target row or fatal diagnostics without `SourceFile`,
   `IrOverlayIdentityPlan`, `collectR2FreeFunctionUnitIds`,
   `collectObservedIrUnits`, `buildIrIntegrationOwnerProjection`, or any AST
   identity map. The legacy reconciler receives an exact excluded neutral-route
   record and must remove that target before every legacy AST/planning
   population, receipt, audit, and outcome pass; it continues to reconcile all
   other source units unchanged. Merge the neutral and legacy rows once in
   canonical inventory order, reject duplicate/missing target rows, and feed
   both diagnostic arrays through the existing fatal `reportErrorNoNode` path.

Currentness is phase-tagged; it must not require objects that do not yet exist:

    interface SemanticFunctionValueCurrentBase {
      expectedProvenance: SemanticFunctionValueRouteFactsV1["provenance"];
      target: SemanticFunctionValueRouteFactsV1["target"];
      sourceProjection: SemanticFunctionValueSourceProjectionV1;
      inventoryUnitIds: readonly string[];
      candidateUnit: SemanticTerminalOutcomeUnitV1;
      priorClaims: {
        sourceIds: readonly string[];
        terminalUnitIds: readonly string[];
        targetUnitIds: readonly string[];
      };
      liveClaims: {
        sourceIds: readonly string[];
        terminalUnitIds: readonly string[];
        targetUnitIds: readonly string[];
      };
      registries: {
        funcMapEntries: readonly {
          legacyName: string;
          handle: number;
        }[];
        occupiedFunctionNameCounts: readonly {
          legacyName: string;
          count: number;
        }[];
        occupiedFunctionKeys: readonly string[];
        liveFunctionBindingGlobalNames: readonly string[];
        funcClosureGlobalEntries: readonly {
          key: string;
          handle: number;
        }[];
        funcClosureSingletonKeyEntries: readonly {
          // Stable FuncHandle, never a resolved absolute function index.
          targetHandle: number;
          key: string;
        }[];
        declaredFunctionRefHandles: readonly number[];
        moduleGlobalNameCounts: readonly {
          name: string;
          count: number;
        }[];
        nativeStringLiteralGlobalEntries: readonly {
          key: string;
          currentIndex: number;
          globalObjectIdentity: unknown;
          globalName: string;
          valueTypeCanonical: string;
          mutable: false;
          initializerIdentity: unknown;
          initializerInstructionCount: number;
          initializerCanonical: string;
        }[];
        candidateOwnedDerivedUnitIds: readonly string[];
      };
      sourceCallable: {
        unitId: string;
        bindingId: string;
        displayName: string;
        functionName: string;
        handle: number;
        objectIdentity: unknown;
        typeIdx: number;
        typeObjectIdentity: unknown;
        signatureCanonical: string;
        localsIdentity: unknown;
        localCount: number;
        localsCanonical: string;
        bodyIdentity: unknown;
        bodyInstructionCount: number;
        bodyCanonical: string;
        exported: true;
      };
    }

    interface SemanticProgramAbiOrderProjection {
      sourceOrder: number;
      declarationOrder: number;
    }

    interface SemanticProgramAbiStructuralOrderProjection {
      sourceId: string;
      declarationOrdinal: number;
      domainOrdinal: number;
      roleOrdinal: number;
      derivedOrdinal: number;
    }

    type SemanticFunctionValueAbiProjectionCore =
      | {
          kind: "callable";
          role: "target";
          bindingId: string;
          displayName: string;
          slotSpace: "function";
          slotPolicy: "required";
          structuralReferenceKey: string;
          semanticTerminalOwnerUnitId: string;
          intent: {
            kind: "callable";
            origin: "source";
            unitId: string;
            sourceId: null;
            classId: null;
            signature: {
              params: readonly [];
              results: readonly ['{"kind":"f64"}'];
            };
          };
        }
      | {
          kind: "callable";
          role: "trampoline";
          bindingId: string;
          displayName: string;
          slotSpace: "function";
          slotPolicy: "required";
          structuralReferenceKey: string;
          semanticTerminalOwnerUnitId: string;
          intent: {
            kind: "callable";
            origin: "support";
            unitId: string;
            sourceId: null;
            classId: null;
            signature: {
              params: readonly [string];
              functionValueParam: {
                kind: "ref" | "ref_null";
                typeIdx: number;
              };
              results: readonly ['{"kind":"f64"}'];
            };
          };
        }
      | {
          kind: "global";
          role: "cache";
          bindingId: string;
          displayName: string;
          slotSpace: "global";
          slotPolicy: "required";
          structuralReferenceKey: string;
          semanticTerminalOwnerUnitId: string;
          intent: {
            kind: "global";
            origin: "support";
            unitId: null;
            sourceId: null;
            capability: null;
            mutable: true;
            valueType: '{"kind":"externref"}';
          };
        };

    type SemanticFunctionValueAbiDraftProjection = SemanticFunctionValueAbiProjectionCore & {
      phase: "draft";
      structuralOrder: SemanticProgramAbiStructuralOrderProjection;
      currentIndex: number;
    };

    type SemanticFunctionValueAbiEntryProjection = SemanticFunctionValueAbiProjectionCore & {
      phase: "published";
      order: SemanticProgramAbiOrderProjection;
      resolvedIndex: number;
    };

    interface SemanticCertifiedFunctionInstancePreDceRegistryProjection {
      signatureKey: "->f64";
      rawBaseWrapperCache: {
        closureInfoIdentity: unknown;
        structTypeIdx: number;
        structTypeObjectIdentity: unknown;
        structTypeCanonical: string;
        structSuperTypeIdx: number;
        funcTypeIdx: number;
        paramTypes: readonly [];
        resultType: '{"kind":"f64"}';
        minimumArgumentCount: null;
        effectiveMinimumArgumentCount: 0;
        hasCaptures: null;
        hasRestParam: null;
        nativeProtoVariadic: null;
        hostOneShotOnly: false;
        domCallbackOnly: null;
        needsCallSiteArity: null;
        inlineBody: null;
      };
      rootWrapperType: {
        typeIdx: number;
        typeObjectIdentity: unknown;
        typeCanonical: string;
      };
      liftedFunctionType: {
        typeIdx: number;
        typeObjectIdentity: unknown;
        typeCanonical: string;
        selfParam: {
          kind: "ref";
          typeIdx: number;
        };
        userParams: readonly [];
        results: readonly ['{"kind":"f64"}'];
      };
      liftedFunctionTypeCache: {
        keyCanonical: string;
        typeIdx: number;
        typeObjectIdentity: unknown;
      };
      metadataStructRegistry: {
        typeIdx: number;
        typeObjectIdentity: unknown;
      };
      metadataGlobalCache: {
        key: string;
        currentIndex: number;
        globalObjectIdentity: unknown;
        globalName: string;
        valueTypeCanonical: string;
        mutable: true;
        initializerIdentity: unknown;
        initializerInstructionCount: 1;
        initializerCanonical: string;
      };
      constructibleWrapperCache: {
        closureInfoIdentity: unknown;
        structTypeIdx: number;
        funcTypeIdx: number;
        paramTypes: readonly [];
        resultType: '{"kind":"f64"}';
        minimumArgumentCount: null;
        effectiveMinimumArgumentCount: 0;
        hasCaptures: null;
        hasRestParam: null;
        nativeProtoVariadic: null;
        hostOneShotOnly: null;
        domCallbackOnly: null;
        needsCallSiteArity: null;
        inlineBody: null;
      };
      closureInfoEntries: readonly [
        {
          role: "constructible-base";
          typeIdx: number;
          closureInfoIdentity: unknown;
          structTypeIdx: number;
          funcTypeIdx: number;
          paramTypes: readonly [];
          resultType: '{"kind":"f64"}';
          minimumArgumentCount: null;
          effectiveMinimumArgumentCount: 0;
          hasCaptures: null;
          hasRestParam: null;
          nativeProtoVariadic: null;
          hostOneShotOnly: null;
          domCallbackOnly: null;
          needsCallSiteArity: null;
          inlineBody: null;
        },
        {
          role: "metadata-allocation";
          typeIdx: number;
          closureInfoIdentity: unknown;
          structTypeIdx: number;
          funcTypeIdx: number;
          paramTypes: readonly [];
          resultType: '{"kind":"f64"}';
          minimumArgumentCount: null;
          effectiveMinimumArgumentCount: 0;
          hasCaptures: null;
          hasRestParam: null;
          nativeProtoVariadic: null;
          hostOneShotOnly: null;
          domCallbackOnly: null;
          needsCallSiteArity: null;
          inlineBody: null;
        },
      ];
      constructibleTypeIdxs: readonly [number, number];
      metadataSubtype: {
        baseTypeIdx: number;
        allocationTypeIdx: number;
      };
      metadataFamily: {
        allocationTypeIdx: number;
        fieldIndex: number;
      };
    }

    type SemanticCertifiedFunctionInstanceAllocationProjection =
      SemanticCertifiedFunctionInstanceAllocationProjectionCore &
        (
          | {
              layoutState: "allocation";
              layoutRevision: 0;
              preDceRegistries: SemanticCertifiedFunctionInstancePreDceRegistryProjection;
            }
          | {
              layoutState: "compacted";
              layoutRevision: 1;
            }
        );

    interface SemanticCertifiedFunctionInstanceAllocationProjectionCore {
      kind: "certified-function-instance-allocation";
      layoutCellIdentity: unknown;
      targetBindingId: string;
      constructible: true;
      wrapperProfile: "ordinary-function-declaration-constructible";
      metadata: {
        name: string;
        length: 0;
      };
      baseWrapperTypeIdx: number;
      allocationStructTypeIdx: number;
      metadataStructTypeIdx: number;
      metadataFieldIndex: number;
      // Fresh absolute index resolved from metadataGlobalObjectIdentity now.
      metadataGlobalCurrentIndex: number;
      metadataGlobalName: string;
      metadataGlobalValueTypeCanonical: string;
      metadataGlobalMutable: true;
      metadataGlobalInitializerIdentity: unknown;
      metadataGlobalInitializerInstructionCount: 1;
      metadataGlobalInitializerCanonical: string;
      baseWrapperCanonical: string;
      allocationStructCanonical: string;
      metadataStructCanonical: string;
      metadataRecipeCanonical: string;
      baseWrapperObjectIdentity: unknown;
      allocationStructObjectIdentity: unknown;
      metadataStructObjectIdentity: unknown;
      metadataGlobalObjectIdentity: unknown;
    }

    interface SemanticCertifiedPendingDirectMaterializationProjection {
      state: "pending";
      targetBindingId: string;
      targetHandle: number;
      legacyName: string;
      expectedUseCount: 1;
      observedUseCount: 0;
      emittedInitializerIdentity: null;
    }

    interface SemanticCertifiedConsumedDirectMaterializationProjection {
      state: "consumed";
      targetBindingId: string;
      targetHandle: number;
      legacyName: string;
      expectedUseCount: 1;
      observedUseCount: 1;
      emittedInitializerIdentity: unknown;
      emittedInitializerCanonical: string;
    }

    interface SemanticCertifiedPendingTrampolineFinalizationProjection {
      state: "pending";
      candidateIncidentRowCount: 1;
      targetHandle: number;
      trampolineHandle: number;
      trampolineBodyIdentity: unknown;
      objStructTypeIdx: -1;
      userParamCount: 0;
      wrapperUserParams: readonly [];
      wrapperResult: '{"kind":"f64"}';
      noThisParam: true;
      explicitThisParam: null;
      methodTargetsImport: false;
      methodUsesThis: null;
      eagerAsyncPromiseWrap: null;
    }

    interface SemanticCertifiedFinalizedTrampolineProjection {
      state: "finalized";
      candidateIncidentRowCount: 0;
      targetHandle: number;
      trampolineHandle: number;
      trampolineBodyIdentity: unknown;
      instructionCount: 1;
      forwardedTargetHandle: number;
      trampolineBodyCanonical: string;
    }

    interface SemanticFunctionValueCurrentSupportCore {
      // #1916 stable FuncHandles; neither field follows an fR layout map.
      targetHandle: number;
      trampolineHandle: number;
      // Fresh absolute global index resolved from cacheGlobalObjectIdentity now.
      cacheGlobalCurrentIndex: number;
      targetObjectIdentity: unknown;
      trampolineObjectIdentity: unknown;
      trampolineName: string;
      trampolineTypeIdx: number;
      trampolineTypeObjectIdentity: unknown;
      trampolineTypeCanonical: string;
      trampolineLocalsIdentity: unknown;
      trampolineLocalCount: 0;
      trampolineLocalsCanonical: "[]";
      trampolineExported: false;
      cacheGlobalObjectIdentity: unknown;
      cacheGlobalName: string;
      cacheGlobalValueTypeCanonical: '{"kind":"externref"}';
      cacheGlobalMutable: true;
      cacheGlobalInitializerIdentity: unknown;
      cacheGlobalInitializerInstructionCount: 1;
      cacheGlobalInitializerCanonical: '[{"op":"ref.null.extern"}]';
      // Exact order: target, trampoline, cache.
      bindingIds: readonly [string, string, string];
      abiDrafts: readonly [
        SemanticFunctionValueAbiDraftProjection,
        SemanticFunctionValueAbiDraftProjection,
        SemanticFunctionValueAbiDraftProjection,
      ];
    }

    type SemanticFunctionValuePendingAllocationSupport =
      SemanticFunctionValueCurrentSupportCore & {
        instanceAllocation: SemanticCertifiedFunctionInstanceAllocationProjection & {
          layoutState: "allocation";
          layoutRevision: 0;
        };
        directMaterialization: SemanticCertifiedPendingDirectMaterializationProjection;
        trampolineFinalization: SemanticCertifiedPendingTrampolineFinalizationProjection;
      };

    type SemanticFunctionValueConsumedAllocationSupport =
      SemanticFunctionValueCurrentSupportCore & {
        instanceAllocation: SemanticCertifiedFunctionInstanceAllocationProjection & {
          layoutState: "allocation";
          layoutRevision: 0;
        };
        directMaterialization: SemanticCertifiedConsumedDirectMaterializationProjection;
        trampolineFinalization: SemanticCertifiedFinalizedTrampolineProjection;
      };

    type SemanticFunctionValueConsumedCompactedSupport =
      SemanticFunctionValueCurrentSupportCore & {
        instanceAllocation: SemanticCertifiedFunctionInstanceAllocationProjection & {
          layoutState: "compacted";
          layoutRevision: 1;
        };
        directMaterialization: SemanticCertifiedConsumedDirectMaterializationProjection;
        trampolineFinalization: SemanticCertifiedFinalizedTrampolineProjection;
      };

    interface SemanticPreparedCandidateBodyProjection {
      receiptKind: "prepared";
      preparedComponentId: string;
      terminalUnitIds: readonly [string];
      selectedUnitIds: readonly [string];
      callableObjectIdentity: unknown;
      localsIdentity: unknown;
      localCount: number;
      localsCanonical: string;
      bodyIdentity: unknown;
      instructionCount: number;
      bodyCanonical: string;
      exported: true;
    }

    type SemanticFunctionValueCurrentDescriptor =
      | {
          phase: "preallocation";
          base: SemanticFunctionValueCurrentBase;
          ownClaim: null;
        }
      | {
          phase: "post-support";
          base: SemanticFunctionValueCurrentBase;
          ownClaim: null;
          support: SemanticFunctionValuePendingAllocationSupport;
        }
      | {
          phase: "pre-body";
          base: SemanticFunctionValueCurrentBase;
          ownClaim: {
            sourceIds: readonly [string];
            terminalUnitIds: readonly [string];
            targetUnitIds: readonly [string];
          };
          support: SemanticFunctionValuePendingAllocationSupport;
          prepared: SemanticPreparedCandidateBodyProjection;
        }
      | {
          phase: "late";
          base: SemanticFunctionValueCurrentBase;
          ownClaim: {
            sourceIds: readonly [string];
            terminalUnitIds: readonly [string];
            targetUnitIds: readonly [string];
          };
          support: SemanticFunctionValueConsumedAllocationSupport;
          prepared: SemanticPreparedCandidateBodyProjection;
        }
      | {
          phase: "pre-publication";
          base: SemanticFunctionValueCurrentBase;
          ownClaim: {
            sourceIds: readonly [string];
            terminalUnitIds: readonly [string];
            targetUnitIds: readonly [string];
          };
          support: SemanticFunctionValueConsumedCompactedSupport;
          prepared: SemanticPreparedCandidateBodyProjection;
        }
      | {
          phase: "post-publication";
          base: SemanticFunctionValueCurrentBase;
          ownClaim: {
            sourceIds: readonly [string];
            terminalUnitIds: readonly [string];
            targetUnitIds: readonly [string];
          };
          support: SemanticFunctionValueConsumedCompactedSupport;
          prepared: SemanticPreparedCandidateBodyProjection;
          publishedAbiEntries: readonly [
            SemanticFunctionValueAbiEntryProjection,
            SemanticFunctionValueAbiEntryProjection,
            SemanticFunctionValueAbiEntryProjection,
          ];
        };

The adapter normalizes absent optional Program-ABI intent fields to the explicit
nulls above, rejects any other provenance, and validates each closed
callable/global projection and canonical signature before constructing the
descriptor. Target params are empty. The trampoline's sole canonical parameter
string must parse to an object with exactly `kind: "ref" | "ref_null"` and a
non-negative safe-integer `typeIdx`, reserialize byte-exactly under
`canonicalProgramAbiValType`, and equal its closed `functionValueParam`; all
callable results are canonical `f64`.

Before publication, `post-support`, `pre-body`, `late`, and `pre-publication`
project identity, provenance, policy, key, and structural order from the exact `ProgramAbiDraft` returned by
`ProgramAbiSession.getDraft`, never a synthetic dense plan entry. Callable
signatures come from the authenticated
`ProgramAbiSession.currentCallableSignature(bindingId)` after any latest
`applyTypeLayoutRemap`, not the draft's frozen pre-remap signature; the current locator/index is
checked against the same binding/key. Each five-field `structuralOrder` must equal a fresh
`session.structuralOrder.forUnit(candidateUnitId, suborder)` result with the
exact callable/global domain and existing body/function-value-trampoline/
function-value-cache role ordinal; every numeric component is a non-negative
safe integer and `sourceId` is exact. `currentIndex` comes from the authenticated
draft binding/key/locator lookup after the same latest remap.

Only `post-publication` projects `ProgramAbiPlanEntry.order`. Its `sourceOrder`
must equal the candidate source's inventory order; declaration orders are
non-negative safe integers, distinct, and in exact
target-before-trampoline-before-cache relative order. They need not be
consecutive because unrelated bindings may lie between them. This phase reads
the actual dense order from each published entry rather than copying it from a
draft or semantic intent. The cache's actual global intent deliberately has
`unitId: null`: its `semanticTerminalOwnerUnitId` is independently derived by
recomputing the exact `irSupportGlobalRef` binding ID and structural key from
the candidate UnitId/role/name, checking the candidate inventory anchor and
draft/published order. Target and trampoline require their actual
callable-intent `unitId` to equal that same owner. The implementation must
preserve all six temporal variants.

Immediately before support allocation, build `preallocation` from independent
live state: the configured expected provenance; the complete target-policy and
activation-gate projection; the complete freshly parsed neutral source
projection; the complete sorted planning-inventory UnitId census; the
independently reprojected candidate inventory row; and the already
allocated/observed source callable handle and object. The target ABI entry does
not exist in `preallocation`; requiring it there would confuse registry
observation with ABI planning. Each descriptor independently rebuilds fresh
arrays for every relevant `ctx.funcMap` row, occupied function-name count and
suffix key, live function-binding global, `funcClosureGlobals` key/handle,
`funcClosureSingletonKeyByFuncIdx` target/key, raw `ctx.mod.globals` name
count, the complete ordered `ctx.mod.declaredFuncRefs` handle census, every
sorted `ctx.nativeStrLiteralGlobals` key/current-index/global
object/name relation, and candidate-owned derived record. No array,
Map, object projection, or parser result retained by the receipt or a prior
descriptor may be reused.

The source-callable projection closes the existing pre-support physical gate,
not just the later ABI draft. Every phase resolves `handle` through
`definedFuncAt`, proves the exact WasmFunction object and its current `typeIdx`,
and projects every live WasmFunction field: exact `name=legacyName`, current
TypeDef object/canonical `[] -> f64` signature, ordered LocalDef array identity/
count/canonical names and ValTypes, body-array identity/count/canonical
instructions, and `exported=true`. `preallocation` and `post-support` require
both exact arrays to be empty and canonical `[]`; this preserves
`exactAllocatedNumericCallable(..., requireEmptyBody=true)` as a zero-write
precondition rather than inferring it from a draft created afterward.
The one authorized Prepared commit may replace both initial empty arrays.
`pre-body` captures the exact installed locals and body arrays from the
authenticated receipt; `late`, `pre-publication`, and `post-publication`
require the same callable object and those retained Prepared array identities.
Each phase's fresh locals/body counts and canonical projections must equal the
independently projected `SemanticPreparedCandidateBodyProjection`; neither side
may reuse a receipt-time projection as the live scan. A foreign TypeDef, a
same-signature replacement callable, an in-place name/local/export mutation, a
nonempty early array, or an array replacement after the authorized commit
rejects in the phase where it appears.

The target/trampoline fields and singleton-map key above are freshly read but
remain stable `FuncHandle` identities, not absolute module indices. Every ABI
`currentIndex`, cache-global current index, and metadata-global current index is
instead resolved afresh from the exact binding/object against the phase-current
module layout. A descriptor rejects a live absolute function index supplied
where a stable handle is required, or a receipt-time global/index projection
supplied where a current one is required.

The native-string literal registry is another raw absolute-global-index
sidecar. Every projected entry must resolve its current index to the exact live
`GlobalDef` and close all four fields: expected `__strlit_*` name, immutable
`ref` ValType with the exact phase-current native/UTF-8 string type index,
`mutable=false`, and the exact initializer-array identity/count/canonical
instructions and operands derived from its `u16:` or `u8:` key. Unknown key
prefixes, duplicate keys, indices below the current import-global prefix, or a
map/index/object/shape mismatch reject. Before type DCE, pre-existing rows must
remain field-exact to the independently captured projection; the named
revision-1 settlement is the only place allowed to accept the corresponding
type-remapped canonical initializer. The
standalone prelude must make the existing `""` row non-vacuous before D1
support. When the test inserts an import global between support and the direct
owner, `fixupModuleGlobalIndices` shifts every affected
`nativeStrLiteralGlobals` value exactly once while preserving its key and
global-object identity, just as it shifts `fnInstanceMetaGlobalByKey`. A later
reuse of the already interned empty string must return the shifted index and
same object; materializing the metadata name may add a distinct row only after
that repair, under the exact `u16:${legacyName}` key and independently derived
shape. This check is independent of resolving the certified cache and metadata
globals after name materialization. An in-place mutation is detected by the
closed projection even though the object identity remains equal.

The fresh UnitId census must equal the frozen route `inventoryUnitIds`, and the
three freshly selected source-projection anchors must join those live records;
the complete candidate inventory row is then checked as the stronger terminal
projection of the prepared-target anchor.

The registry phase formula is closed. `preallocation` requires exactly the one
source callable under `legacyName`, zero trampoline-name entries, zero
`funcClosureGlobals` entries for the base or `$n` variants, and zero raw module
globals named `__fn_closure_${legacyName}`; the target also has no pre-existing
singleton key. `post-support` and later require
exactly the source and trampoline `funcMap` objects, exactly one
`funcClosureGlobals` base-key entry equal to the freshly resolved cache-global
current index, and
exactly one raw module global of the expected cache name at that current index and
object identity, plus the exact target-handle-to-`legacyName` singleton key.
Every phase closes the live cache `GlobalDef`: exact name,
`type={kind:"externref"}`, `mutable=true`, and the same initializer-array
identity containing exactly `[{op:"ref.null.extern"}]`; its canonical
projection is rebuilt from the object rather than copied from the ABI intent.
An in-place field or initializer edit rejects even though its locator and
object identity are unchanged;
suffix or half-registered pairs reject. Unrelated names remain
allowed and are retained in the complete arrays so a test cannot pass by
filtering before the census. `preallocation` has no candidate trampoline
handle to declare. `post-support` and every later phase require the exact
stable trampoline handle to occur once in the complete
`ctx.mod.declaredFuncRefs` array; its order is projected, and unrelated handles
remain present. Dropping, duplicating, retargeting, or replacing that row is a
currentness failure even when the trampoline object and ABI draft still exist.

The direct-materialization formula is also phase-exact. `preallocation` has no
registry entry. `post-support` and `pre-body` require exactly one pending entry
whose target binding, handle, name, singleton receipt, and physical identities
match the support projection and whose census is `expectedUseCount=1,
observedUseCount=0`; both carry allocation revision 0 and an explicitly null
emitted-initializer identity. The legacy owner body is
the only permitted consumer. The candidate's paired late-provider
reauthentication reads this cell but cannot mutate or retake it. `late`
requires that same revision-0 entry in consumed state with
`observedUseCount=1`, exactly one freshly built initializer
identity/canonical projection in that body, and current cache/metadata global
indices resolved after any intervening global-import shift. `pre-publication` and
`post-publication` require the same consumed cell after the one post-DCE
transition to compacted revision 1, reprojected from final locators/module
objects rather than compared to old raw indices. Missing, replaced,
consumed-early, duplicate-consumed, foreign, unremapped, or twice-remapped
entries reject. Aborting before body emission deletes the pending entry and
proves the legacy fallback has no retained D1 registry state.
Every resolved absolute function/global index in these descriptors is a fresh
phase-local projection; the #1916 function handles remain stable, and the
direct registry's stable key remains target WasmFunction object identity plus
`targetBindingId` across late-import and DCE remaps.

The trampoline projection also closes every live WasmFunction field at every
support-bearing phase: exact synthetic name, stable object, current lifted
TypeDef/canonical signature, the same empty LocalDef array identity/count/
canonical `[]`, the phase-required body below, and `exported=false`. Its local
array is independently scanned even though this zero-argument finalizer should
allocate no scratch locals. An in-place name/type/local/body/export edit cannot
hide behind stable function-object identity or an unchanged ABI draft.

The method-trampoline finalization sidecar is equally phase-exact and is not
subsumed by the callable, singleton, or body registries. `post-support` and
`pre-body` scan the complete live `ctx.pendingMethodTrampolines` array and
require exactly one row incident to any of the candidate target handle,
trampoline handle, or trampoline-body identity. That row must join all three
identities and have `objStructTypeIdx=-1`, `userParamCount=0`, empty
`wrapperUserParams`, canonical `f64` result, `noThisParam=true`,
`methodTargetsImport=false`, and absent `explicitThisParam`, `methodUsesThis`,
and `eagerAsyncPromiseWrap` normalized to `null`. Both handles are #1916 stable
handles and never follow `fR`. The complete-array incidence rule prevents a
duplicate or foreign row from disappearing behind a candidate-only filter.

The `pre-body` snapshot alone cannot prove later consumption because the
registration-time zero-parameter body is already `[call targetHandle]`. Add a
frontend-free
`assertCertifiedFunctionValueTrampolineFinalizationCurrent(ctx, receipt,
expectedState)` and call it at the actual finalizer boundaries. Immediately
before the primary multi-source `finalizeMethodTrampolines` call after body
emission, `expectedState="pending"` freshly repeats the complete-array exact-one
row proof. Immediately after that finalizer, `expectedState="finalized"`
requires zero candidate-incident rows and the exact final body below. Before
and after the post-overlay `finalizeMethodTrampolines` call,
`expectedState="finalized"` repeats the same zero-row/body proof; the D1
candidate may not be re-enqueued by an overlay. The single-source finalizer
call has no D1 receipt and is unchanged.

`late`, `pre-publication`, and `post-publication` independently repeat the
finalized-state proof, but their zero census is not treated as evidence that
the earlier pending row existed. Every finalized check re-reads the exact
registered trampoline object and the same in-place body-array identity and
requires exactly one instruction: a direct `call` whose `funcIdx` is the stable
candidate target handle. Its canonical form is rebuilt from that live
instruction, not retained from the pending row or receipt;
`forwardedTargetHandle` must equal `targetHandle`. These repeated scans ensure
neither a dropped/duplicate pending row nor a post-finalizer retarget can be
hidden by later settlement.

Settlement is not a cached acceptance oracle. `pre-publication` independently
rescans the retained legacy-owner body after DCE and the pre-publication
repair/peephole/inlining/finalizer passes and requires exactly one initializer
whose current operands and canonical projection match the compacted cell.
`post-publication` performs the same fresh exact-one scan plus all closed
target/trampoline/global shapes and published entries. Neither phase trusts an
occurrence identity or canonical string cached by settlement without finding
the exact live objects again.

Publication is not yet the terminal body-mutation boundary on current main:
`repairCrossHierarchyOperands`, `stackBalance`, and `fixupExternConvertAny`
run afterward. Add a receipt-conditional
`MultiPreparedProgramOwner.sealAfterFinalFixups()` immediately after
`fixupExternConvertAny`. It retains the published ABI entries and freshly
repeats the compacted initializer census, full target/trampoline WasmFunction
projections, closed cache/metadata/native-string GlobalDef projections, claim
ledger, and finalized-trampoline proof. No later codegen step may mutate a D1
body/local/global/type; the remaining host-import/frame/validation checks are
read-only. A terminal mismatch is a fatal post-certification compile failure,
not a repaired or accepted publication. This final audit is a named check over
the existing six descriptors, not a seventh authority phase.

For allocation revision 0, `post-support`, `pre-body`, and `late` also
reproject the complete candidate-owned relations in `funcRefWrapperCache`,
`constructibleFuncRefWrapperCache`, `closureInfoByTypeIdx`,
`constructibleClosureTypeIdxs`, `fnInstanceMetaSubtypeByBase`, and
`fnInstanceMetaFamilies`, plus the scalar `fnInstanceMetaStructTypeIdx` and the
exact `fnInstanceMetaGlobalByKey` row keyed by `0:${legacyName}`. The scalar
type index must address the same metadata-struct object carried by the
allocation projection; the metadata-global row's freshly resolved current
index must address its exact retained `GlobalDef`. Both the cache row and
allocation projection close that same object's live shape: expected
`__fn_instance_meta_*` name, `mutable=true`, current
`ref_null(metadataStructTypeIdx)` ValType, and the same initializer-array
identity containing exactly one `ref.null` of that current metadata type. The
canonical ValType and initializer are freshly rebuilt at every revision-0
scan and reprojected after the authorized type remap at settlement; ABI
metadata or object identity alone is insufficient. The exact `->f64` cache row must be the
constructible-base closure-info object. The raw
`funcRefWrapperCache['->f64']` row must separately be the exact
`closureInfoByTypeIdx` object for its raw base struct, and the hidden
`__funcRefWrapperRootTypeIdx` must resolve the exact retained root TypeDef.
The constructible wrapper's struct is a direct subtype of that raw base, and
its `funcTypeIdx` equals the raw row's lifted function type. The raw base is
either the root itself with `superTypeIdx=-1` or a direct subtype of the root;
the lifted function type's sole leading `ref` parameter names that exact root,
followed by no user parameters and one `f64` result. The registered trampoline
WasmFunction's current `typeIdx`/TypeDef/canonical signature and its Program-ABI
draft signature must equal that lifted type, including the root self
parameter. For this closed signature the locally recomputed `funcTypeKey` is
exactly `ref:${rootTypeIdx}|f64`; that key must occur once in
`ctx.funcTypeCache` and resolve the same type index and TypeDef object. No
private registry helper or newly exported API is required, and a later
equivalent type lookup must reuse the row rather than minting a duplicate. The
raw, constructible-base, and metadata-allocation closure-info
rows must have the closed zero-param/f64 contract, raw
`minimumArgumentCount:null`, derived effective minimum zero, and every other
optional `ClosureInfo` field normalized role-exactly: the ordinary raw-base row
has `hostOneShotOnly:false` because `observeAllocation(..., "ordinary")`
materializes that property, while the constructible-base and
metadata-allocation rows normalize its absence to `null`; all their other
optional fields use the explicit nulls above. Both
type indices must be constructible; and the subtype/family edges must be
exactly base→allocation and allocation→metadata-field. Unrelated registry rows
remain allowed.

The `late` descriptor is not the last revision-0 registry check. Keep a
frontend-free lifecycle facade
`assertCertifiedFunctionInstancePreDceRegistriesCurrent(ctx, receipt,
consumer)` in the certified-materialization module and call it immediately
before each later load-bearing consumer: `fillReflectIsConstructor`,
`fillFunctionInstanceProps`, and `emitIsCtorClosureExport`. The closed
`consumer` domain is exactly those three names. Each call freshly rebuilds the
entire raw/root/constructible/metadata projection above from the authenticated
layout cell and current module objects; it may not reuse the `late` descriptor,
a prior scan, or generated helper bodies as evidence. The assertion performs
no allocation or repair. The materialization facade owns only receipt/lifecycle
phase routing; it delegates every Program-ABI, locator, current-index,
canonical-signature, stable-handle, and live-layout join to private authority
implemented in `certified-function-value-authority.ts`. Thus a mutation after
`sealRoutesComplete` but before any finalizer fails at that consumer boundary
with no helper/publication prefix.

After DCE these type-index-keyed maps are not current authority:
revision 1 instead authenticates the exact emitted initializer, final type
objects/canonical shapes, and ABI locators from the compacted module. No
pre-DCE relation is silently interpreted under a remapped type index.

The claim formula is phase-exact. The frozen route's three
`priorClaimed*` arrays and every descriptor's `base.priorClaims` are the
complete unique/sorted live ledger immediately before D1 registration. In
`preallocation` and `post-support`, `ownClaim` is null and `liveClaims` must
equal `priorClaims` exactly. In `pre-body`, `late`, `pre-publication`, and
`post-publication`, `ownClaim` is exactly the singleton candidate source ID,
candidate terminal UnitId, and candidate target UnitId. Each own atom must
occur exactly once in the complete live ledger, must be absent from the frozen
prior ledger, and the full live ledger must equal the unique sorted union of
prior plus own. Exact subtraction of own from live must reproduce prior. The
builder rejects duplicate raw atoms before sorting; it never silently filters
the candidate. A missing, duplicate, foreign, early, or retained-after-abort
own claim is therefore observable.

The candidate-owned derived census is equally exact: filter the complete live
Program-ABI derived records by `terminalOwnerId === candidateUnitId`, reject
duplicate IDs, and compare the sorted result to the frozen empty route fact.
An unrelated derived unit is deliberately allowed and must not perturb D1; a
candidate-owned one withdraws in every phase.

The provider boundary is now the independently reprojected candidate-use graph
described above, not a purported complete serialization of legacy provider
maps. The TypeScript adapter runs all existing provider collectors before
finalization and requires the exact prepared-target singleton, zero candidate
memberships in every disallowed family, and exact agreement with the neutral
projection. After finalization, the D1 overlay branch neither
consumes nor mutates those AST-keyed maps. New ownership that can affect
emitted state must cross the fresh candidate-use/source-blocker projection,
claim ledger, registries, certified allocation receipt, or Program ABI, where
it is rejected. A mutation of a discarded legacy `IrOverlayPlan` provider map
alone is observationally inert for D1 and remains load-bearing in a paired
legacy-route control.

`unknown` object identities in the pseudotype above are codegen-local
reference-equality tokens, never serialized semantic facts. The adapter must
authenticate them against the live module arrays/registries in every phase.
`post-support`, `pre-body`, and `late` reproject allocation revision 0;
`pre-publication` and `post-publication` reproject compacted revision 1 after
the named settlement hook. Each projection contains the exact constructible
base wrapper, final metadata subtype, metadata family/global/recipe, and current
target/trampoline/cache objects plus their closed function/global fields for
that revision. Pending phases prove there
is no emitted initializer; `late` and both compacted phases additionally prove
the exact live initializer. Missing or stale physical identity rejects before
AST body construction or publication. The canonical strings above are closed,
lossless field/op/operand projections, not hashes: each is rebuilt from the live
type, recipe, or emitted instruction object and compared together with
reference identity, so in-place mutation cannot hide behind a stable object
token.
Immediately after `planUnits`, certified singleton allocation, and the two
support plans, build `post-support` and validate the receipt and all three ABI
drafts plus the pending direct-materialization entry before AST body
construction. After the planner returns, central claim registration and the
Prepared receipt must be reauthenticated in `pre-body` while that entry is
still pending; this is the descriptor consumed by `sealBodyBoundary`. Only
after the legacy owner has consumed exactly that entry may `late` include the
Prepared receipt, neutral singleton selection, and consumed materialization
census. After DCE and the settlement hook, `sealBeforePublication` builds
`pre-publication` from compacted revision 1. Only
`MultiPreparedProgramOwner.complete(publication)` may build
`post-publication`; it reads and projects the three exact entries from the
published ABI after publication, and retains the publication object only after
that projection passes. `sealAfterFinalFixups` does not create another
descriptor; it rebuilds the compacted physical projection and published-entry
joins once more after the last mutating fixup and is the terminal acceptance
audit.

This adapter may read SourceFile `text` but may not traverse an AST or call a
checker/oracle. The neutral reader compares the snapshot against each newly
rebuilt descriptor; comparing receipt fields with themselves is forbidden.

These changes are confined to the exact `index.ts`, program-owner,
function-value planner, scalar-leaf, callback-transport, physical-skip, and
neutral audit/outcome branches listed in ownership. If their current owners do not hand
off those lines on or after the re-grounded base, D1 stays blocked.

### Frontend-neutral reader and route receipt

The neutral module exposes a parsed/frozen reader with exact-key lookups and one
complete `requireBenchLoopFunctionValueProof()`-style operation. A missing or
ambiguous fact is a typed snapshot failure; no method returns a frontend object
or accepts a fallback delegate.

The decisive result is a frozen
`MultiPreparedFunctionValueSemanticProof` containing neutral records and exact
source/unit/support-intent identities only. Replace the C1 receipt's
`oracle`, `identity`, and `roleOf` fields with canonical bytes and the
frozen proof. External evidence may report the canonical-byte SHA-256, but the
runtime receipt neither computes nor trusts a digest. The route must never
recreate a declaration oracle after finalization.

Narrow import-target handling for this route into two responsibilities:

- the TypeScript producer proves and records the exact import relationship;
- the neutral reader resolves that relationship by record IDs and source/unit
  identities.

Do not delete or weaken
`resolveMultiPreparedFunctionValueImportTarget`,
`multiPreparedFunctionValueUseIsCurrent`, or their AST receipt: array,
Fibonacci, and string routes still consume them. Define a distinct
`MultiPreparedNeutralFunctionValueLeafRoute` for `bench_loop`, with no
`valueIdentifier`, `importedCall`, or `declarationReplay`. Extract a
`LegacyMultiPreparedFunctionValueUseReceipt` for untouched routes and update
Fibonacci's current `Omit<MultiPreparedFunctionValueLeafRoute, ...>` type
derivation to use it. Its only other edit threads the distinct certified-support
callback past the combined planner without changing Fibonacci's legacy
callback or behavior.

The D1 route may retain its already selected TypeScript declaration solely as
the existing `MultiPreparedLeafRouteBase` body-lowering handle because Phase E
has not serialized the lowering program. Neutral facts are the sole authority
to enter support/body preparation and to choose semantic identity/import/claim
edges. The AST may construct or reject the body, and the independently
authenticated successful Prepared-body receipt remains a required conjunct
before the direct-body skip. The AST handle cannot invent a route, retarget an
import, allocate support without the proof, or authorize late semantic
currentness.

After direct owners run, currentness compares the snapshot with a newly rebuilt
current descriptor, exact route UnitIds, the neutral claim ledger, Prepared
receipt, neutral singleton selection, support bindings, full Program-ABI
projection, and body object identity. The later post-publication owner phase
separately reprojects all three entries from `PublishedProgramAbi` and retains
the publication object only after they match. Neither phase may call
`ctx.oracle`, traverse source trees, inspect import parents, re-run graph
safety, or join ranges back to AST declarations. Snapshot or current-state
drift after a skip is the existing fatal post-certification invariant with zero
target legacy rows.

### Mutation-proof and non-vacuous acceptance

Pure schema tests must prove canonical capture-order independence and exact
parse/reserialize bytes. Mutate one fact at a time and require typed rejection
for at least:

- wrong schema/record kind, adapter version, frontend version, rule, analysis
  mode, target-policy or activation-gate field, source inventory/semantic order, source key,
  source text, UTF-16 length, range bound, declaration-file flag, complete
  inventory UnitId census, or route-unit anchor role/source/range/name/kind/
  ordinal/terminal owner;
- missing, extra, duplicate, reordered, malformed, unknown-purpose, or
  unknown-role records;
- null, foreign, dangling, or mismatched declaration kind/name/lexical owner/
  top-level/export/function-shape field, query owner, binding/call/import link or edge,
  import/export range, module specifier, callsite owner/range, callee query,
  argument query, ordinal, or count;
  for every proven query, add a second distinct declaration to its population
  and require rejection even when its `valueDeclarationId` is unchanged;
- wrong candidate, owner, target, terminal owner, UnitId, component census,
  signature, capture/this/async/rest/constructible flag, wrapper profile,
  instance metadata,
  terminal outcome lexical owner/kind/unit ordinal/synthetic role/range,
  key/name/observed kind/legacy ordinal/line/column/containing owner/class
  flag/body availability/failure, every draft structural-order field
  (sourceId/declaration/domain/role/derived ordinal), published ABI
  source/declaration order, callable/global intent provenance (including a
  forged cache `unitId`), derived semantic owner, canonical trampoline
  parameter, carrier intent, support role, or structural-reference key;
- every reduction field: accumulator, induction variable, initializers, bound,
  comparison, increment, wrapping update, and return binding; and
- missing/duplicate/foreign candidate-use rows, an unclassified candidate use,
  or a false CommonJS/class/module-init/direct-caller-activation/collision/
  import-alias blocker.

Also mutate complete candidate, component, scalar-leaf-candidate,
reduction-leaf-candidate, prior-claim, source-blocker, and candidate-use
populations by drop, duplicate, and foreign insertion. Negative
fixtures must cause the neutral parser and the existing producer collector to
agree on the exact prepared-target singleton and every disallowed candidate
membership; disagreement withdraws. Do not claim that a
manually deleted negative fact is detectable by schema validation alone—the
fresh source reprojection is the denominator. A complete extra user source
with an otherwise valid same-spelled declaration must change eligibility;
omitting that source from the snapshot or current descriptor fails closed.
Add one unrelated exact numeric scalar leaf and, separately, one second exact
reduction leaf under a different name/source. The fresh scalar denominator must
change from `[]`, the fresh reduction denominator from the required singleton,
and each fixture must withdraw exactly as the existing planner does.

At least one fixture has two same-spelled declarations in different sources and
one has a same-spelled but unanchored declaration. Range or spelling equality
must not satisfy a source-qualified edge. Duplicate and reorder controls must
contain at least two real rows; singleton “reorder” tests are vacuous.

Route tests must separately prove:

1. poisoning live `valueDeclarationOf`/`declarationsOf` after finalization does
   not affect the D1 route;
2. calling the old AST-reattachment path is impossible in production (the
   implementation and import are absent). A test-only legacy replayer or
   after-finalization AST-join spy must deliberately cross the forbidden phase
   boundary and observe the poison; separately, poison the producer before
   finalization and prove its permitted live queries are load-bearing;
3. deleting or replacing the producer-side source/identity maps after the
   canonical record is created does not affect the neutral reader. Prove the
   TypeScript-produced source projection and neutral-parser projection are
   independently allocated yet field-exact at capture; inject an unsupported,
   unbalanced, shadowing, aliased, or second candidate-use construct and require
   explicit `unknown`/withdrawal rather than an empty projection;
4. poisoning the live oracle immediately before
   `prepareCertifiedFunctionValueSupport` still allocates the exact support,
   while the legacy collector control observes the poison. Independently poison
   declaration resolution, explicit-`this`, async-body classification,
   rest-parameter state, and declaration-derived function metadata: the
   certified singleton path must not touch them, while one exact legacy
   singleton control must observe each relevant legacy dependency. Assert the
   D1 receipt and actual lazy cache initializer both use the constructible
   ordinary-function wrapper and exact `{name, length: 0}` metadata subtype;
   mutate the wrapper profile, base/allocation type, metadata field/global/init,
   receipt target binding ID, substitute either support binding ID, or change
   the ordered `[target, trampoline, cache]` tuple, layout-cell identity/state/
   revision, or current remapped locator and require
   zero lazy-cache-initializer/publication prefix. Before the first support
   write, replace the source callable, its TypeDef, or its body-array object;
   mutate its name, `[] -> f64`, LocalDef order/name/type, body instructions,
   or exported flag, including same-object in-place edits; or retain a
   receipt-time locals/body projection. Require the preallocation gate to
   reject with zero Program-ABI/support allocation. After Prepared compilation,
   mutate either retained array, the receipt identities/counts/canonical
   projections, exported state, or any join and require phase-local rejection.
   Repeat name/type/local/export mutations against the exact trampoline object.
   Before DCE, independently delete, retarget, or foreignize the exact `->f64`
   raw-wrapper cache row, constructible-wrapper cache row, the hidden root
   wrapper index/object, any raw/root/constructible TypeDef or canonical shape,
   the lifted function type/root-self parameter or its exact `funcTypeCache`
   key/index/object row, either
   base/allocation `closureInfoByTypeIdx` row, either
   constructible-set membership, the base→allocation metadata-subtype edge,
   the allocation→field metadata-family edge, `fnInstanceMetaStructTypeIdx`,
   and the `fnInstanceMetaGlobalByKey['0:'+legacyName]` current-index/object
   relation. Swap the ordinary raw row's `hostOneShotOnly:false` with an absent
   value, or add `false` to either row that must normalize absence to `null`;
   retarget the trampoline's type or ABI draft away from the lifted type.
   Every mutation must reject before consumption. Repeat representative
   deletion, foreign-index, and wrong-family mutations in the gap after
   `sealRoutesComplete` and immediately before each of
   `fillReflectIsConstructor`, `fillFunctionInstanceProps`, and
   `emitIsCtorClosureExport`; require the named fresh revision-0 scan to reject
   before that consumer emits a helper body and before publication. Drop,
   duplicate, pre-consume,
   retarget, or replay the direct-materialization entry; require the exact
   pending→consumed one-shot census, fatal duplicate take, and abort cleanup.
   Instrument the two physical support opportunities. Require exactly one
   early singleton allocation, one metadata preparation, one
   `planUnits([candidateUnitId])`, one Program-ABI support plan, one direct
   registry registration, one legacy-emitter take, and one late read-only
   reauthentication. The early allocator, route receipt, registry entry, late
   validator, and emitter must expose the same target/trampoline/cache objects,
   stable handles, singleton receipt, and layout-cell identity. Snapshot all
   module/registry/Program-ABI counters and collections around the late call
   and require a byte- and identity-exact zero-write delta while it observes
   `observedUseCount=1`. Calling `ensureFuncClosureSingleton`,
   `prepareFnMetaSlotOfMeta`, `materializePreparedFnMetaSlot`,
   `planProgramAbiFunctionValue`, `planUnits`, register, or take a second time
   is fatal. Drop, duplicate, or foreignize the late receipt-map row, key it by
   `valuePlan.ownerUnitId` instead of `valuePlan.target.binding.unitId`, or
   substitute a same-name receipt/layout cell; every mutation must reject with
   no new allocation or publication prefix. The ordinary adjacent function
   value must still exercise the unchanged generic late path.
   In the exact gap after `pre-body`/legacy body emission and immediately
   before the primary trampoline finalizer, drop or duplicate the candidate's
   `pendingMethodTrampolines` row, retarget `methodFuncIdx` to a foreign
   same-signature function, replace `trampolineFuncIdx` or `trampolineBody`, or
   mutate any wrapper shape/flag; the named pending-state boundary assertion
   must reject before the finalizer. After that finalizer, require the
   candidate-incident census to be zero and the canonical body; re-enqueue a
   candidate row or retarget the live body before the post-overlay finalizer
   and require its finalized-state precheck to reject. Separately mutate the
   live body between settlement and each publication scan and require zero
   publication prefix.
   Force a late import-global insertion between support allocation and the
   legacy `main` consumption. Seed and authenticate the pre-existing interned
   `""` row before support, then prove `fixupModuleGlobalIndices` shifts the
   affected `nativeStrLiteralGlobals` and `fnInstanceMetaGlobalByKey` values
   exactly once while preserving their keys/object identities. Reuse `""`
   after the shift and require the same object at the repaired index; an
   omitted/double/stale map shift must reject. On the same retained objects,
   mutate cache/metadata/native-string name, ValType/typeIdx, mutability,
   initializer array/op/order/operand, and initializer-array identity one at a
   time; every closed live projection must reject without relying on a changed
   object identity. Prove the certified emitter
   materializes the metadata name first, then resolves the cache and metadata
   globals from their exact retained objects, builds a fresh initializer, and
   emits current indices; substituting the receipt-time absolute global index
   or a detached pre-shift initializer must reject before a body/publication
   prefix.
   Force non-empty function and type DCE remaps and prove settlement changes
   revision 0→1 exactly once, resolves the remapped absolute indices/TypeDefs from the
   final module, and rejects a frozen old index/object, missing/duplicate final
   initializer, skipped settlement, or second settlement. The same control must
   prove the #1916 target/trampoline `FuncHandle` values and
   `funcClosureSingletonKeyByFuncIdx` key remain byte-identical and at or above
   `STABLE_FUNC_BASE`, while `absoluteFuncIndex` and the authenticated ABI
   `currentIndex` follow the non-empty `fR`. Supplying a live absolute index as
   the singleton key or confusing that stable handle with the remapped current
   index rejects before settlement. Mutate the retained initializer after
   settlement but before `sealBeforePublication`; the fresh pre-publication
   body scan must reject, and a separate post-publication scan mutation must
   not be masked by the settled cell. Inject one body/local/global mutation
   after `complete` and before each of `repairCrossHierarchyOperands`,
   `stackBalance`, and `fixupExternConvertAny`, and inject a drift from each
   real pass; `sealAfterFinalFixups` must reject every survivor before a
   successful compile result.
   A paired `Reflect.construct`/function-name/function-length runtime control
   must match the direct route. Spy that
   `planUnits([candidateUnitId])` runs exactly once after preallocation and
   before support planning; drop, duplicate, or retarget its target entry or
   locator, substitute a foreign registry observation, and replay the callback
   after the targeted plan. Require exact idempotent target identity or a typed
   invariant, with zero singleton/support/body allocation on every mismatch;
5. forged source-ID route claims, owner snapshots, neutral selection, current
   descriptors, or ABI entries reject without falling into the legacy
   SourceFile/selection/currentness branches; cover preallocation,
   post-support, pre-body, late, pre-publication, and post-publication
   substitution separately. Mutate
   each fresh registry population independently: the candidate `funcMap`
   handle, occupied-name count, occupied suffix key, live binding-global name,
   `funcClosureGlobals` key/handle, singleton target/key, candidate trampoline
   `declaredFuncRefs` row, raw module-global name count/object, and prior claim.
   In preallocation/post-support require a null own claim and exact
   live=prior ledger; in pre-body/late/pre-publication/post-publication drop,
   duplicate, or foreignize
   the singleton own source/terminal/target atom and prove the exact
   union/subtraction formula rejects. Add one unrelated derived record and
   prove it is inert; add one candidate-owned derived record and require
   rejection. Separately drop/duplicate/foreignize the exact prepared-target
   singleton and insert the candidate into each disallowed producer provider
   family before finalization; every mismatch with the source-derived graph
   withdraws. Add a sibling top-level function in the candidate source that
   reads its own `.caller` and, separately, `['arguments']` and
   `?.["caller"]`; the neutral parser must emit that source in
   `directCallerActivationSourceIds`, the legacy
   collector must place the candidate in the direct-activation family, and the
   route must withdraw. Add one same-spelled receiver shadowed by a nested local
   and one unresolved same-spelled receiver; the producer's spelling fallback
   and the neutral parser must still activate. An escaped string/template key
   at that boundary must return explicit `unknown`, while an unrelated
   `.caller` property receiver remains a non-blocking control. After
   finalization, mutating only the
   discarded legacy plan provider map is inert for D1 but load-bearing in the
   paired legacy route. At publication, mutate
   an entry's source order, duplicate/reverse the three declaration orders,
   forge cache intent provenance, and substitute one exact final index/object.
   Before publication, mutate each of the five structural-order fields and one
   authenticated current index independently; none may be reinterpreted as a
   dense published order;
6. missing or malformed facts withdraw before the first support allocation,
   Prepared preparation, direct-body skip, or audit/outcome prefix;
7. a dropped, duplicated, foreign, range-shifted, or `preserve=false` neutral
   physical-skip entry rejects before the declaration body is skipped; a
   foreign/unknown receipt-audit source ID rejects before reconciliation.
   Poison both SourceFile identity maps after finalization and spy that D1's
   source-ID receipt lookup remains current without touching them, while the
   paired legacy SourceFile lookup observes the poison. A
   dropped/foreign terminal row, owner, selection, or patched evidence rejects
   in the neutral post-skip audit with zero accepted target outcome prefix.
   Exercise those same mutations through the actual
   `recordObservedIrOutcomes` path; spy on every legacy population/owner helper
   and prove none receives the D1 target, while a legacy sibling row still uses
   and is load-bearing on the old reconciliation;
8. tampering canonical bytes, inventory, route IDs, or support intent after
   certification fails invariantly with no target legacy row; and
9. a coherent tamper changes a valid semantic/source/target fact, canonicalizes
   it, recomputes every reported SHA-256, and still rejects against the
   independently rebuilt current descriptor. A digest-only mismatch is not
   sufficient evidence. Include a coherent declaration/query/callsite/reduction
   range shift under unchanged source text and UnitIds; it must reach the
   preallocation descriptor comparison and reject before any support allocation
   or Prepared/body write. The all-uses rename control must certify
   `renamed_reduction` and its derived support names. An armed-but-unmatched or
   unknown injection also fails.

No new shipping kill switch is allowed. Exact `JS2WASM_TEST_*` seams are
permitted only when parsed, named, non-vacuous, and removed from ordinary output.

### Optimization and compatibility parity

D1 must preserve the complete existing #4590 evidence, not merely the runtime
answer:

- the exact `bench_loop` terminal-IR route, zero target legacy rows, imported
  call edge, terminal ownership, and three Program-ABI bindings;
- raw and optimized Prepared-versus-direct `bench_loop` body/WAT and normalized
  trampoline equality;
- exact ordinary-function constructibility plus observable `name === legacyName`
  and `length === 0`, with no fourth helper/ABI binding;
- exports, imports, DTS, helper/import descriptors, string pool, and runtime
  result `1_783_293_664`;
- the existing direct kill-switch as an observational control; and
- non-vacuity through exact route movement, not binary-size drift.

Parity is phase-honest:

- D1a compares against old C1 and the paired direct/generic control on the same
  exact base. It must explain and lock every type/body/WAT/binary/slot change
  required by the constructible wrapper and metadata initializer, prove exact
  `Reflect.construct`, `name`, and `length` behavior, and remeasure the complete
  #4590 evidence. Add an adjacent ordinary top-level function value that is not
  the certified early-route target and prove its support call still receives
  the empty constructible-target set, retains the literal legacy `false`
  profile, and is byte-identical to old C1. Put distinct string literals before
  and after the `main` function-value use; prove D1a and D1b allocate the
  `bench_loop` metadata-name carrier at the same direct-emission point and keep
  exact string/global order, WAT, and binary bytes. No unrelated artifact may
  move.
- The resulting signed D1a artifacts are the corrected C1 baseline. D1b starts
  only after D1a lands, refreshes every baseline pin from protected `main`, and
  must produce equal generated Wasm, WAT, Program ABI, outcomes, audits,
  runtime, and optimization evidence for the exact neutral route and its
  corrected control.
- Any physical pin changed by unrelated `main` movement is independently
  remeasured on clean current `main` and documented. Neither checkpoint
  receives an unexplained size, runtime, slot, or optimization waiver.

Scalar/array/Fibonacci/string behavior and artifacts, and every host/direct/
fast/WASI/IR-disabled lane outside the exact corrected `bench_loop`
function-value comparator, remain unchanged. TypeScript 5 behavior and the
public compile API also remain unchanged. Fibonacci's only edits are its legacy receipt type derivation and
the pass-through of a distinct certified-support callback that it never
consumes; its existing legacy support callback, AST resolver, and currentness
path are preserved. C1 v1 fixtures continue to parse
only under their v1 reader; feeding v1 bytes to the D1 reader must yield
`unsupported-version`.

### Landing gates and honest claim

For D1a, run the complete #4590 suite plus the direct/generic materialization
control, exact early-allocation/late-reauthentication identity and zero-write
census, constructibility/name/length runtime mutations, adjacent
function-value routes, and all static gates below. Land and refresh protected
`main` before D1b. For D1b, run the pure schema/adapter tests, the complete #4590 suite, declaration replay
mutations, adjacent scalar/array/Fibonacci/string Prepared routes, callable and
module-init publication controls affected by the stable #3525 handoff, and the
current changed-root denominator. Then run TypeScript 7 and TypeScript 5,
Prettier/Biome, IR layering/dialect/fallback/oracle/optimization/dead-export,
host-import policy, test-vacuity, and LOC/function regrowth gates.

Keep `multi-prepared-scalar-leaf.ts` at non-positive net LOC and do not add a
LOC or function-budget allowance for moving the old AST replayer. Run LOC and
function ratchets immediately before the signed commit. Run every normal
precommit and prepush hook without a skip. Before each heavy command, commit,
and push, require a fresh finite, non-negative one-minute load strictly below
`logical cores - 2` (10 cores means `< 8`).

Acceptance proves Phase D only for the exact standalone `bench_loop`
function-value route: its declaration/import/reduction/graph/signature/ABI
facts are serialized with provenance and consumed by a frontend-neutral reader,
without AST reattachment in route eligibility, support entry, import choice,
claim ownership, or late semantic currentness. It does **not** prove that
TypeScript can be unloaded, that body construction/type semantics are
frontend-neutral, that the prepared body is serialized, that Acorn or
TypeScript 7 is supported, that every frontend fact is neutral, or that direct
codegen can be deleted. Those remain Phase E and later checkpoints.

## 2026-09-01 D1a amendment — split physical lifecycle from current authority

The first D1a implementation review made one ownership detail non-optional.
The one-shot physical lifecycle and the independent Program-ABI currentness
authority cannot remain both auditable in the single
`certified-function-value-materialization.ts` file under the repository's
1,500-line hard ceiling. Compressing the full draft below that ceiling would
hide phase transitions and repeat currentness joins instead of simplifying
them. D1a therefore owns one additional dependency leaf:

- `src/codegen/certified-function-value-authority.ts` owns only the exact
  Program-ABI draft, structural-order, reverse-reference, locator,
  current-index, canonical-callable-signature, and stable-handle joins, plus
  private `WeakMap`/`WeakSet` brands for allocation, support, owner-transition,
  trampoline-finalization, and final-layout authority;
- `src/codegen/certified-function-value-materialization.ts` owns the exact
  non-empty receipt census, pending→taken→emitted→settled/aborted lifecycle,
  atomic publication of one freshly built initializer into the exact live
  owner body, recursive exact-one body census, and the sole
  revision-0→revision-1 layout-cell transition. It retains canonical and body-
  census evidence, never a detached initializer as authority; and
- `src/codegen/closures/method-trampolines.ts` remains the sole legacy/frontend
  boundary. It authenticates declaration→UnitId→stable-handle→function and
  the in-progress `FunctionContext` body before asking the two neutral leaves
  to bind the current owner transition. Neither neutral leaf may inspect
  `sourceFunction`, a TypeScript declaration, checker/oracle state, source-file
  maps, or a `FunctionContext`.

The dependency direction is strict: method trampolines may import the lifecycle
leaf; the lifecycle leaf may import the authority leaf; neither leaf may import
method trampolines, `src/codegen/index.ts`, `func-space.ts`,
`program-abi-planning.ts`, `registry/imports.ts`, a multi-prepared owner, a
frontend, or an IR backend. Runtime imports from apparently neutral IR binding
helpers are also forbidden when their transitive graph reaches `ts-api`.
Stable function joins use `absoluteFuncIndex` from
`src/emit/resolve-layout.ts`. Callable-signature comparisons use canonical
semantic equality because `currentCallableSignature()` returns a fresh frozen
object. `resolveCurrentIndex` receives the current module, never a locator;
exact locator identity is checked independently.

Authority is phase-specific and cannot be synthesized from caller-supplied
opaque objects or caller-supplied canonical strings:

1. allocation authenticates the exact target UnitId/binding/key, source
   callable object and stable handle, current callable signature,
   candidate-scoped absence of the exact trampoline/cache IDs, locators, and
   registry rows, and allocation-era type/global objects before the first
   write. Unrelated support artifacts remain valid;
2. the post-allocation support result independently rejoins the exact target,
   one `function-value-trampoline` support callable, and one
   `function-value-cache` support global against their Program-ABI drafts,
   structural roles, locators, current positions, and retained objects before
   the singleton receipt is minted;
3. early registration records the exact expected legacy owner
   UnitId/handle/function and issues one one-shot branded owner-transition
   request. A generally callable leaf API may not mint authority from a plain
   owner tuple. At take, the method-owned boundary consumes that exact request,
   proves the same owner plus `ctx.currentFunc === fctx` and the exact compiling
   body, and returns it to the authority leaf, which rejoins the submitted
   neutral tuple to the stored early owner. Final settlement requires that
   exact function to own that exact body after normal body installation;
4. prepared-target installation and trampoline finalization are authenticated
   one-shot transitions over retained array identities and lifecycle-derived
   canonical bytes, never callbacks that canonicalize their own values; and
5. post-DCE settlement derives the current metadata type index from the final
   module, proves the remapped `$fnmeta` field points to that index, rejoins all
   current locators/signatures/handles/globals/types and the exact-one owner
   initializer, then performs the sole layout-cell mutation.

Prepared-target installation crosses one narrow neutral callback seam. Early
D1 registration returns an opaque prepared-install request only after the
exact target and legacy-owner UnitIds have both joined the certified candidate.
The codegen owner retains that request in its existing support receipt, keyed
by the exact target UnitId, and seals the one-receipt expected census before
entering `prepareIrBodies`. Before IR's patch loop starts, codegen must prove
that every retained request key is one exact selected physical target and that
no request is missing, duplicated, foreign, already consumed, or associated
with a deferred component.

`IrIntegrationOptions` gains only this optional structurally neutral hook:

```ts
readonly onPreparedUnitCallableInstalled?: (
  artifactUnitId: IrUnitId,
) => void;
```

The normal non-deferred patch branch invokes it exactly once, immediately
after `replaceUnitCallableAt(...)` returns the installed callable and before
`settlePreparedDerivedCallable(...)` or compiled/evidence bookkeeping. The
hook is not called by orphan-stub recovery, failed/withdrawn patches, or
`deferPreparedPublication`; it receives no function, array, index, receipt,
request, context, or canonical string. `prepareIrBodies` merely forwards the
hook. A codegen closure looks up the UnitId in its private request map and asks
the lifecycle leaf to stage the live target; unrelated successfully installed
units are ignored, while the exact target must consume its request once. After
`prepareIrBodies` returns, codegen requires that exact one-entry request census
to be fully consumed. A callback throw is an invariant failure of the compile
invocation, never a typed legacy fallback or permission to continue emitting a
direct owner against an unstaged target.

The D1 route does not use aggregate/deferred cross-source publication. Deferred
patches install later through prepared-component publication and therefore
must never consume a D1 request through this seam. Supporting that lane would
require a separately planned publication-time neutral capability after the
aggregate ABI commit; it is not D1a scope. Add non-vacuous controls for a
missing exact callback, wrong/foreign target key, duplicate invocation,
invocation before replacement, replay after staging, and an unrelated installed
unit beside the exact target. Every failure leaves the legacy owner body and
D1 lifecycle state unchanged; no failure may publish a compiled/evidence row
for the exact target.

The bounded authority leaf may document the existing
`function-value-cache` global-role ordinal `2` locally and must validate it
through a fresh `structuralOrder.forUnit` result. It must not import the general
Program-ABI planner merely to read that constant. Extracting all global-role
constants into another shared module is follow-up refactoring, not D1a scope.

Add non-vacuous mutations for an unbranded/cross-context allocation proof, a
no-op or foreign support observation, a real nonidentity metadata-type DCE
remap, nested instruction and initializer drift between prepare and publish, a
foreign/duplicate/shared-body owner, a self-certifying phase/final proof, and
two parent edges aliasing the same initializer array. Every pre-publication
mutation must leave the owner body and lifecycle state unchanged; every
post-certification mutation must fail invariantly. The recursive census counts
parent-edge occurrences and uses only an active recursion stack for cycle
protection, never a global visited set that collapses aliases.

This amendment adds no route, backend instruction, optimization exception,
kill switch, LOC allowance, or physical artifact change. The authority and
lifecycle leaves and `method-trampolines.ts` remain at or below the 1,500-line ceiling;
existing giant-file and total-LOC ratchets remain non-growing. All original
D1a/D1b ordering, exact #4590 parity, strict load gate, normal hooks, protected
merge queue, and fresh Sol exact-byte review requirements remain unchanged.

## 2026-09-01 D1a amendment — extract physical evidence from lifecycle authority

The repaired D1a draft proved that the preceding two-leaf split is still one
neutral boundary short. After the first exact Sol audit closed singleton
overwrite, transition replay, mutable-layout escape, native-witness replay,
canonical-clone publication, and incomplete terminal-currentness false-passes,
the honest authority and lifecycle implementations measured about 1,750 and
1,700 lines. Consolidating their duplicate registries and recipes removed real
code, but the remaining phase joins cannot fit below 1,500 without either
hiding them in dense conditionals or treating canonical strings as authority.
Neither is acceptable. D1a therefore owns one final dependency leaf:

- `src/codegen/certified-function-value-evidence.ts` owns only immutable
  physical evidence: the canonical instruction/value walker, exact array and
  top-level/nested occurrence identity/path captures, native-name before/after
  index-space snapshots and exact zero-or-one-global witness, and final
  publication-recipe/occurrence reprojection;
- `src/codegen/certified-function-value-authority.ts` continues to own every
  Program-ABI/current-layout join and every receipt, support, owner-transition,
  trampoline, and settlement authority brand. It may consume branded physical
  evidence but may not move a lifecycle transition into the evidence leaf; and
- `src/codegen/certified-function-value-materialization.ts` continues to own
  the pending/taken/emitted/settled-or-aborted registry, the sole native-name
  callback invocation, atomic owner-body publication, prepared-install and
  trampoline transitions, and the sole revision-zero to revision-one commit.

The runtime dependency graph is acyclic and exact:

```text
method-trampolines
        |
        v
certified-function-value-materialization
        |                         |
        v                         v
certified-function-value-authority ---> certified-function-value-evidence
```

The evidence leaf is the bottom dependency. It may import Wasm/IR value types
and codegen context types with `import type`, but it may not import the
authority or lifecycle leaves, method trampolines, `index.ts`, `func-space.ts`,
Program-ABI planning, registry/import owners, a multi-prepared owner, a
frontend, an IR backend, or `ts-api`. Authority and materialization may both
consume its branded read-only evidence. No evidence token is accepted by
structural shape, canonical text, a caller-supplied phase, or a caller-built
receipt census.

Physical evidence is not permission to mutate. The evidence leaf may read the
module/context surfaces explicitly passed by its callers and may mutate only
its own private `WeakMap`/`WeakSet` brand state. It must not allocate a Wasm
function/global/type, invoke the native-name callback, write an owner body,
change a Program-ABI session, or advance the D1 lifecycle. A native-name
witness is prepared before the callback and consumed exactly once afterward;
it retains exact map key, object, absolute/current index, name, ValType,
mutability, initializer-array identity, canonical initializer, and the complete
bounded import/function/type/global side-space snapshot. Cache hit permits no
index-space delta; cache miss permits exactly one matching literal global and
no unrelated delta. Callback throw terminally consumes the lifecycle attempt.

Publication evidence retains the exact pushed instruction objects and every
nested array path, plus a fresh canonical projection. Revision zero requires
those exact occurrences. The branded post-DCE settlement may refresh canonical
operands only over the same six retained top-level arrays, owner-body array,
and published occurrence identities; it never accepts a replacement array or
canonical clone. Revision one captures the refreshed canonicals over those same
objects, and the terminal audit re-finds exactly one occurrence and rejoins the
current Program ABI, type cells, globals, and native-name witness. Aliased
parent edges are counted per occurrence; an active recursion stack rejects
cycles without globally collapsing aliases.

This extraction changes no route, hook, ABI, instruction, native-string
allocation policy, optimizer, fixture, expected binary, or acceptance oracle.
It grants no LOC or function-budget exception. The authority, evidence,
materialization, and method-trampoline leaves must each remain at or below
1,500 lines, the existing oversized-file ratchets must not regrow, and all
three neutral leaves require a fresh exact-byte Sol review before the D1a PR is
marked ready. The original strict load gate, normal precommit/prepush hooks,
protected merge queue, D1a-before-D1b order, and full #4590 artifact/runtime
parity remain mandatory.

### Frozen implementation handoff

The 2026-09-01 repair session stopped before publication and left no staged,
committed, or pushed compiler/test bytes. Its reproducible local checkpoint is
the worktree `/private/tmp/js2-4617-d1a-function-value-baseline`, branch
`codex/4617-d1a-function-value-baseline`, based on
`c11206262088a69815d6126787b10942df148b6d`. The two unfinished core leaves are:

- `certified-function-value-authority.ts`: 1,725 lines, SHA-256
  `ed9d3c00117059c9a43c847c710a594baf7a34ac528757a2f9707638ef8591b1`; and
- `certified-function-value-materialization.ts`: 1,649 lines, SHA-256
  `c853e9ef6946cfd4ec248bdbe1d0cd4b17ac7e51b5559fa9ab99f9406e2bbaa5`.

Those bytes close unconditional active-singleton rejection, one-shot owner
request/transition linkage, private layout state, prewrite physical
reauthorization, private registry-entry/seal state, staged prepared installs,
one-shot native-name witnessing, exact published occurrence identity, and the
settlement-token dispatcher. They are not acceptance-ready: both exceed the
hard 1,500-line ceiling, the evidence leaf is absent, and settlement-only
canonical reprojection is still outstanding. Current `git diff --check`
passes; the last TS7 typecheck passed before the final small edits and therefore
must not be treated as a validation of these exact hashes.

The unfinished test migration is
`tests/issue-4617-certified-function-value-materialization.test.ts`, 1,522
lines, SHA-256
`4c22a6cf1d5464db7db2ec86ffcff31ccac1c318941c1f7cc03fdf5c8e146b34`.
It begins the ctx-only lifecycle and opaque-layout conversion but retains stale
old-arity negative cases and lacks the required second-receipt, native-witness,
occurrence, settlement, and terminal-revision coverage. It was not formatted,
typechecked, or run after its final edits. A continuation must first extract
the evidence leaf, wire it through the two core leaves, bring all three below
their ratchets, finish the test migration, and then run the full strict-gated
validation and fresh exact-byte Sol review. It must not present this frozen
checkpoint as a draft implementation PR or acceptance evidence.
