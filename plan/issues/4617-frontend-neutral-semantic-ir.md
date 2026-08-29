---
id: 4617
title: "Frontend-neutral semantic IR snapshot for TypeScript 7 and Acorn"
status: in-progress
created: 2026-08-22
updated: 2026-08-28
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
  - src/ir/planning-identity.ts
  - src/ir/semantic-declaration-snapshot.ts
  - src/ir/program.ts
  - src/ir/prepared-component-sealing.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - src/codegen/multi-prepared-function-value-declaration-replay.ts
  - src/codegen/multi-prepared-function-value-import-target.ts
  - src/codegen/program-abi-session.ts
  - tests/issue-4590-bench-loop-prepared-cutover.test.ts
  - tests/issue-4591-fib-pair-prepared-cutover.test.ts
  - tests/issue-4617-declaration-replay-mutations.test.ts
  - tests/issue-4617-semantic-declaration-snapshot.test.ts
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
   the #4590 file. Measured reason, not preference: with all 21 new cases in one
   file, CI's `issue-tests` job (single fork, vitest's default 512 MB fork heap)
   OOM'd — `Reached heap limit ... 510.4 MB` — while the same set passed in 106 s
   at a 1 GB heap. Split across two files the whole set passes at the CI default.
   The plan explicitly permits "a focused schema/adapter test file if keeping
   pure mutations separate improves clarity"; this extends that to the route
   mutations for a memory reason.
4. **Three obsolete physical pins in #4590 and one in #4591 were remeasured**
   (see below). All four fail on clean `origin/main` before this branch exists.

### Obsolete-pin remeasurement (verified on clean `origin/main` first)

The A/B was run by deleting the three new files and restoring the three edited
ones, so both sides are one `cp` apart:

| Pin | Was | Measured on clean `f6c8e2c` | Now |
| --- | --- | --- | --- |
| #4590 raw Prepared bytes | 131,207 | **133,067** | 133,067 |
| #4590 raw direct bytes | 131,235 | **133,096** | 133,096 |
| #4590 exact Prepared reduction | 28 | **29** | 29 |
| #4590 direct cache global slot | 136 | **139** | 139 |
| #4591 direct `bench_fib` cache global slot | 136 | **139** | 139 |

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
| `tests/issue-4617-declaration-replay-mutations.test.ts` | 18/18 | 0 |
| `tests/issue-4617-semantic-declaration-snapshot.test.ts` | 6/6 | 0 |
| all three together, CI flags, CI default 512 MB heap | 50/50 | 0 |
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

Changed-root denominator: **50/50** across the three files this branch owns
(26 + 18 + 6); adjacent controls **195/198**, where the three are the
pre-existing `issue-3521-prepared-free-function-routing` failures reproduced
identically without this branch.

Two environment artifacts, both reproduced on clean `main` and neither a product
signal: (a) `[vitest-worker]: Timeout calling "onTaskUpdate"` on long
single-fork runs on this loaded 4-core box — it also fires for #4591 and the
string-leaf planner without this branch, and clears at a 1 GB fork heap; (b) the
512 MB OOM described in deviation 3, which the file split resolves.

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
  poison: `drop-query`, `answer-to-null`, `duplicate-query`, `unknown-query`,
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
