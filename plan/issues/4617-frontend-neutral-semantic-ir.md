---
id: 4617
title: "Frontend-neutral semantic IR snapshot for TypeScript 7 and Acorn"
status: ready
created: 2026-08-22
updated: 2026-08-22
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
  - src/compiler.ts
  - src/ts-api.ts
  - src/ir/identity.ts
  - src/ir/planning-identity.ts
  - src/ir/program.ts
  - src/ir/prepared-component-sealing.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - src/codegen/multi-prepared-function-value-import-target.ts
  - src/codegen/program-abi-session.ts
  - tests/issue-4590-bench-loop-prepared-cutover.test.ts
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
