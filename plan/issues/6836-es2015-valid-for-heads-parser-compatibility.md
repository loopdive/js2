---
id: 6836
title: "ES2015 valid for-head grammar: TypeScript parser compatibility"
status: ready
created: 2026-10-03
updated: 2026-10-03
assignee: ttraenkler/es2015_valid_for_heads_plan_astra
priority: high
feasibility: hard
reasoning_effort: xhigh
task_type: investigation
area: compiler, parser, frontend
language_feature: iteration-statements
es_edition: es2015
related: [143, 1928, 3514, 3518, 3520, 3525, 4712, 5144, 5158, 5267, 5271]
---

# 6836 — Valid ES2015 for-head grammar

## Status and authority

The bounded source-only investigation is complete. `ready` means ready for
owner-reviewed implementation design, **not approved for production edits**.
Root reserved this ID and verified the upstream claim/PR scan; the assignee
records this planning assignment, not ownership of compiler or IR source.

After the completed planning/review handoff, root verified and released the
planning assignment through the maintained registry tool (session 60113,
terminal exit 0; release verified on `upstream/issue-assignments`). There is
no current 6836 production claim. The retained frontmatter assignee denotes
the historical planning actor only; production ownership and all implementation
acceptance remain open. Main was untouched and no CI was triggered by release.

Astra owns this Markdown and ignored `.tmp/6836/` parser receipts only in
`6836-valid-for-heads-plan-astra`, based on upstream
`7cd84317ac9f5ad1b48a138e33113b98c8392b8e`. Source, tests, runner, dependencies,
configuration, registry and published branches were not edited. No compiler,
runtime or Wasm build/execution occurred; the concurrent authoritative full-run
owner retained its exclusive heavy-work lease.

The two originals remain inside the frozen 11,778-original ES2015 goal.
Historical `cd123eca` census `20261002-184918` reported 24 compile errors,
including these two. The newer `7cd84317` run `20261002-234453` was live at
assignment. This document does not turn its partial state, or the old census,
into a fresh final verdict. Root must append the final authoritative result
separately. No exclusions, weakened guards/oracle, input alterations, diagnostic
suppression, or estimated two-test gain are authorized.

## Fresh source-only evidence

Command in this worktree:

`node --import tsx .tmp/6836/parser-probe.mts`

Terminal exit 0; elapsed approximately one second. Node was **22.23.2**, not
the authoritative full-run Node 24 environment. TypeScript was **5.9.3**,
`ts.createSourceFile`, Latest target, parent pointers enabled, explicit JS
ScriptKind; the two originals were also parsed with TS ScriptKind. Node
`vm.Script` was used only as an independent syntax check, never to execute
source. No checker or project compiler was invoked.

Retained ignored artifacts, relative to this worktree:

- `.tmp/6836/parser-probe.mts`, SHA-256
  `31e8cbd1fc29639f07c9cbf9df14eec54d54d40e21cacd7e1969239b92507768`.
- `.tmp/6836/parser-receipts.json`, SHA-256
  `f2b338c32086cfd26632d7328629a7c7c216e6ece20c4a023e7d6ef077052d72`.
- Loaded `node_modules/typescript/lib/typescript.js`, SHA-256
  `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`.

The two original byte hashes are:

- `test/language/statements/for/head-lhs-let.js`:
  `8b86eddac198ea57fff2829f34d2ded2a772fb81aa1210794fd4e73f85e8e5cf`.
- `test/language/statements/for-of/dstr/array-elem-init-in.js`:
  `ca1f9739c987c76c5a1f76603306298eebabb09ce2746a0f16a792d5e270ae16`.

For each untouched original, the actual applicable normalization functions were
called in current single-source pipeline order: Script HTML-comment
normalization, standalone Iterator-static prelude, CJS rewrite, eval/super
rewrite, import/timer preprocessing, default-optimization ground folding, and
standalone dead-binding elision. Every stage returned **identical bytes**.
Mode was standalone non-WASI JavaScript Script, no defines, default optimize,
IR inventory disabled; no stdin prelude applies. `requiresTsGrammar` was
false. This tests the preprocessing leaves, not the whole compiler or assembled
Test262 harness. The latter still needs matched runtime acceptance.

Both raw and normalized originals produce the same defects:

1. **Identifier `let` head.** The assignment form at original line 32 reports
   TS1134 twice, TS1109 and TS1128; first offset 781, one-based column 11.
   The first bare `for (let;;)` at offset 687 instead has a
   `VariableDeclarationList` initializer with text `let`.
   The isolated bare-head control produces **zero parse diagnostics but this
   same wrong AST**. The assignment-head recovery also invents a declaration
   list (`let =`) and splits the remaining statement. Node accepts the original.
2. **Array assignment default containing `in`.** TS1005 at offset 1121,
   original line 31 column 16, says comma expected. A ForOfStatement survives
   error recovery, but its array elements are not licensed by a valid parse.
   Node accepts the original. Ordinary destructuring assignment, object-pattern
   for-of, lexical array-binding for-of, parenthesized default RHS and
   call-argument-nested `in` controls parse without TS diagnostics.

The retained matrix has 24 source controls: Node accepts 18, TypeScript reports
no parse diagnostics for 16. Those counts are **not conformance scores**:
three Node-invalid controls are TS diagnostic-free (strict `let`, an invalid
parenthesized destructuring target, and an invalid for-in assignment LHS),
and the bare-`let` and for-in-`let` ASTs are wrong despite clean diagnostics.
This is a positive and negative instrument check, not evidence of a new
runtime failure in those unexecuted shapes.

## Proven first losses

At this dependency pin, `typescript.js::parseForOrForInOrForOfStatement`
near line 37339 selects a variable declaration whenever the token is
LetKeyword. It does not call the contextual `isLetDeclaration` lookahead
used elsewhere near line 37677. That is the first AST misclassification for
the sloppy identifier case, before any JS2 lowering or Test262 wrapper.

The non-declaration branch invokes `disallowInAnd(parseExpression)`.
`parseArrayLiteralExpression` near line 37116 parses members with
`parseArgumentOrArrayLiteralElement` without clearing that context;
`parseBinaryExpressionRest` near line 36304 stops at InKeyword under it.
By contrast `parseArgumentExpression` and `parseParenthesizedExpression`
clear the restriction. This explains the array/default, object, binding and
parenthesized control split. It also reproduces in valid ordinary-for array
initializers and for-in array assignment heads: the cause is not exclusive
to the for-of body’s later assignment-pattern interpretation.

Current maintained frontend is `src/frontend/typescript.ts` re-exporting the
installed TypeScript namespace through `src/ts-api.ts`.
`src/checker/index.ts::analyzeSource` creates the user SourceFile at about
line 1018; program syntactic diagnostics then reach `compiler.ts` around
line 1647. The incremental service follows the same parser family.
There is no existing for-head compatibility transform in the examined normal
pipeline. Changing JS versus TS ScriptKind does not cure either original.

**Do not fix these by dropping TS1005/TS1134 or accepting an error-recovered
tree. A parse-error-only retry also misses the silent bare-`let` defect.**

## Primary semantics fetched before planning

[ES2015 iteration grammar, §13.7](https://262.ecma-international.org/6.0/#sec-iteration-statements)
distinguishes the ordinary-for/for-in `let [` lookahead from for-of’s
`let` restriction. Sloppy identifier use must not become a lexical declaration.
[Array literals, §12.2.5](https://262.ecma-international.org/6.0/#sec-array-initializer)
and [assignment patterns, §12.14.5](https://262.ecma-international.org/6.0/#sec-destructuring-assignment)
enable `In` inside elements/default initializers independently of the
outer head’s restriction.

[For evaluation, §13.7.4.7](https://262.ecma-international.org/6.0/#sec-for-statement-runtime-semantics-labelledevaluation)
evaluates the initializer before the body with abrupt-completion propagation.
[ForIn/OfBodyEvaluation, §13.7.5.13](https://262.ecma-international.org/6.0/#sec-for-in-and-for-of-statements-runtime-semantics-forin-ofbodyevaluation)
interprets assignment patterns, assigns each yielded value, and preserves
iteration environments, labelled completion and iterator closing.
These requirements rule out treating the input as an empty declaration or
eagerly moving a default initializer outside the loop.

## Existing work and migration boundary

- 143, 5158 and 5271 deferred the `let` parser case. The 5271 X3
  “wont-fix without a parser fork” statement is historical scope, not proof
  that a fork is necessary and not permission to exclude a valid goal input.
  The 5158 shorthand describing this original as `for(let in {})` is not
  its literal body; the original here contains two ordinary-for heads.
- 5144’s 2026-09-28 source-only appendix already located raw TS1005.
  Its earlier “for-of head reparse” hypothesis should not be revived.
  5267 deferred the same parser case. This issue owns the future compatibility
  decision, not another implementation of their iterator work.
- 4712 fixed an already-parsed parenthesized for-of assignment-target write.
  It explicitly excludes destructuring; it is not a solution to these parses.
- 1928 is completed position remapping, not a new normalizer or open parser
  fix. Reuse its mapping contract, subject to present provenance consumers.
- 3514 is a ready optional Porffor-to-JS2-IR POC, not the default frontend.
  Its explicit boundary forbids synthesizing TypeScript nodes from ESTree
  and feeding them to an unbound checker. Do not implement that POC here,
  turn Porffor mandatory, or claim its existence already repairs these inputs.
- 3518 (frontend retirement), 3520 (source-qualified identity), and 3525
  (whole-program driver) are in-progress. In particular 3525’s owner-A scope
  explicitly includes `compiler.ts` and `compiler/output.ts`.
  The other-machine migration’s exact present edit set cannot be established
  from local frontmatter. Integration **overlaps an actively owned boundary**;
  even a new isolated normalizer leaf requires an agreed insertion API.

## Candidate implementation sequence — all ownership-held

### P0: owner-approved parser boundary, not a production patch

Recommend **GPT-6.1 Sol, xhigh** for the bounded design/proof.
First ask the migration owner which maintained frontend entry owns normalization
for single-source, multi-source, incremental and object-output compilation.
Keep one source unit and one genuine checker-bound parse; do not add a second
AST-to-IR lowering path.

A source-preserving TypeScript parser correction would avoid inserted-offset
hazards, but the relevant parser functions are private dependency internals.
The namespace facade has no supported hook for changing just these functions.
A maintained upstream fix/pinned dependency patch is an architectural option,
requiring separate dependency/version/build approval and parity testing; editing
shared `node_modules`, monkey-patching private parser state, or silently
selecting another parser is not an implementation plan.

A bounded compiler-owned compatibility normalization remains a proof candidate.
The independent review below found concrete strictness, target-validity and
name-inference hazards; parse-clean spellings are not sufficient admission
evidence. Neither a sound recognizer nor full source mapping is implemented. If the owner
has no suitable insertion/mapping boundary, stop with the architectural choice
rather than manufacture a broad rewrite.

### L: contextual identifier `let`

Recommend **Sol high** after P0 and exact ownership approval.

Candidate under review: insert parentheses around only a proven sloppy
IdentifierReference token at ordinary-for initialization. This preserves the
token spelling and outer NoIn context, but binding and name-consumer behavior
still require proof. `for((let);;)` and `for((let)=3;;)` parse in TypeScript and
Node. A separate source-only three-shape check also accepted
`for((let) in {})` and still rejected `for((let)="x" in {};;)`.
The latter avoids the hazard of wrapping the whole initializer and accidentally
legalizing an otherwise prohibited top-level `in`.

First admission, if approved, must be limited to unescaped `let ;` and
`let =` with an explicitly approved limited RHS (initially the original
numeric shape), in affirmatively proven sloppy ordinary-for contexts.
The independent review rules out treating general `let =` as ready:
parenthesized assignment targets bypass an existing function-name producer.
Broader operations, RHS forms and for-in remain separate proof obligations.
The numeric restriction is only a possible explicitly unfinished first slice,
not the final repair or a test-shaped acceptance boundary. Completion must
preserve supported identifier-assignment NamedEvaluation semantics across RHS
forms, or use an approved text-preserving parser correction.
Detect grammar, not
a filename or diagnostics alone. Lexical `let x`, `let [x]`, `let {x}`,
and forbidden bare-`let` for-of forms must remain untouched. Preserve strict
and Module-goal rejection, escaped identifier rules, shadowing, getters,
unresolvable-reference throws, comments, templates and regex literals.
Do not rename every `let` or rewrite variable declarations.

Required proof: the final checker-bound initializer contains the original
identifier reference/assignment and resolves to the original binding.
The bare read must actually happen; test a throwing getter or unresolvable
binding so an empty declaration cannot pass vacuously.

### A: array-element default `In` context

Recommend **Sol xhigh**, separate from L.

Candidate: within a grammar-proven array assignment pattern in a loop head,
parenthesize only a default initializer RHS whose `in` belongs to that
RHS, e.g. `[x=("x" in {})]`. This parses in both controls.
First admission requires an explicitly valid assignment target (initially a
bare identifier) and complete RHS extent; the current early-error traversal
does not prove target validity, as the reviewed `f()` counterexample shows.
Wrapping the whole assignment element, `[(x="x" in {})]`, is **not** a
solution: TypeScript reports no diagnostic but Node correctly rejects it.

The recognizer must prove full head boundaries, assignment versus lexical
binding context, default-RHS extent, and correct nested delimiter/token
interpretation. An isolated expression parse with In enabled can supply
candidate RHS structure only after those boundaries are independently proven;
do not splice its nodes into a different bound SourceFile or trust extents
from the already broken recovery tree. A scanner must handle regex/division,
template substitutions, comments, nested defaults, commas/conditionals and
nested function bodies. If that proof becomes a parallel general JS parser,
reassess the approved dependency-parser route instead.

Retain top-level NoIn and invalid-target early errors. Default RHS must run
only for undefined, once per applicable iteration, at its original lexical
scope, with unchanged inferred function names/direct eval semantics.
Ordinary array-expression and for-in analogues are blast-radius controls, not
unmeasured extra gains or permission to broaden the first patch.

### Exact approval question

“Does the IR migration owner clear a new
`src/compiler/for-head-parser-compat.ts` leaf plus only the JavaScript
normalization call/map composition in `src/compiler.ts::compileSourceSync`
(or its explicitly named replacement frontend entry), and focused
`tests/issue-6836*.test.ts`? Which owner supplies the corresponding
multi-source/incremental/object-output, original-source diagnostic/source-map
and IR source-unit provenance contract?”

This is a **proposal**, not granted scope. Do not edit `html-like-comments.ts`
to hide an unrelated transform. Additional `checker/index.ts`,
`checker/language-service.ts`, `compiler/output.ts`,
`compiler/ir-outcome-inventory.ts`, `compiler/ir-cutover-invocation.ts`,
`codegen/context/source-pos.ts`, `emit/sourcemap.ts`, `position-map.ts`,
or any `src/ir/` change needs individually resolved ownership. No blanket
permission for all these files is requested. If original-column preservation
cannot be achieved in the initial scope, return for that precise extension.

## Normalization, mapping and identity readers/mutators

A new source-edit producer affects more than diagnostic display. Inventory
at this base (paths are relative to `src/`):

- Single-source normalization owner: `compiler.ts`. Existing producers are
  `compiler/html-like-comments.ts` (length preserving),
  `compiler/define-substitution.ts`, `process-stdin-prelude.ts`,
  `iterator-statics-prelude.ts`, `cjs-rewrite.ts`,
  `compiler/validation.ts::rewriteEvalSuperCallWithMap`, and
  `import-resolver.ts::preprocessImports` (including timer and import stubs).
  `compiler/ground-call-fold.ts` and `deadcode-elide.ts` preserve lengths;
  CJS standalone environment/nested-require folds also preserve offsets.
- `PositionMap` copies/sorts SourceEdits in its constructor; composition
  chains output-to-input mappings. Generated text is anchored to an original
  span; compiler-origin annotations have separate semantics. Existing producer
  maps are composed in `compiler.ts`. Insert parentheses as insertion edits,
  not one replacement covering user expressions, so retained inner offsets
  remain exact. Never label original user functions as compiler support.
- Direct offset/provenance readers: `compiler.ts::remapDiagnosticPosition`,
  `compiler/ir-cutover-invocation.ts` telemetry/declaration-range remapping,
  `compiler/ir-outcome-inventory.ts::makeIrInventoryOptions`, and
  `ir/identity.ts` compiler-origin lookup.
- `elideWithIrIds` builds canonical pre-elision inventories and ordinal maps,
  then supplies callbacks keyed by declaration ranges and kinds. Edits must
  preserve source-qualified unit/binding identities and lexical owners, not
  just filenames or display names.
- The multi-source path separately applies define/CJS/timer/ground transforms,
  retains real imports and currently reports diagnostics directly without
  PositionMap remapping. `compiler/output.ts::compileToObjectSource` separately
  preprocesses imports. A single-source fix must not silently claim parity
  with these distinct roots.
- `checker/index.ts` and `checker/language-service.ts` create/cache real
  SourceFiles and bind program identity. Source text/version/ScriptKind must
  agree; no post-bind mutation of identifiers, positions or parent links.
- Emitted mapping readers are not automatically covered by the diagnostic map:
  `codegen/context/source-pos.ts` reads AST positions;
  `compiler.ts::runPipeline` passes emitted map entries plus original
  sourcesContent to `emit/sourcemap.ts`. Codegen errors, fallback telemetry,
  legacy-body audit and allocation labels also read AST line/column.
  Their original-position contract needs explicit proof before variable-length
  source insertion can ship.
- Early-error handlers read raw SourceFile text as well as AST kinds (including
  strict/escaped `let` checks). Function source reflection and direct-eval
  capture are further observable consumers; retain original text and binding
  provenance instead of assuming parentheses are invisible to every consumer.

Do not “repair” broad existing mapping debt in this issue. Demonstrate correct
composition at the approved boundary, or obtain a narrowly stated ownership
extension. A parser dependency correction that keeps original text avoids
many of these hazards but still requires full AST/checker/identity parity.

## Acceptance and measurement gates

1. **Parser/AST instrument.** Re-run both untouched byte-hashed originals on
   parent and candidate; record TypeScript/Node versions and all normalization
   stages. Assert actual loop and initializer kinds, child `in` operator/RHS,
   token coverage, binding symbol/declaration identities and no invented
   missing nodes. Zero diagnostics alone is insufficient.
2. **Positive and negative grammar controls.** Retain all 24 receipts as
   diagnostic references. Cover ordinary for, valid for-in, valid array
   for-of assignment, nested array/object defaults, lexical binding contrast,
   NoIn at the outer head, malformed delimiters, invalid assignment targets,
   strict directives and Modules, escaped names, comments/string/template/
   regex lookalikes, labels and line terminators. No current negative may
   become accepted because normalization moved a grammar boundary.
3. **Observable runtime controls.** Under the authoritative runner, preserve
   `let` values 1, 3 and 4 in the first original, and false/default execution
   with counter 1 in the second. Also check read/assignment side effects,
   local/parameter/catch shadowing, unresolvable/TDZ throws, initializer
   single evaluation, defaults skipped for defined values, nested defaults,
   iterator closing on abrupt completion, and labelled continue/break order.
   Include direct-eval binding access and inferred-function-name/reflection
   controls when transformed expressions can contain those features.
4. **Positions and identities.** Assert exact original line AND column inside,
   before and after insertions, including composed define/import/timer edits.
   Assert emitted maps against original sourcesContent and stable original
   source/unit/lexical-owner identities, including two same-named functions,
   nested closures, repeated/incremental calls and multiple sources.
   Reuse 1928 controls; no synthetic TypeScript node grafting.
5. **Real acceptance.** After approval and heavy-lease release, use fresh
   parent/candidate commits, same frozen original inputs, harness assembly,
   flags, Node version, runtime provider and authoritative standalone runner.
   Record compiler/runtime/provider hashes, actual imports, terminal session
   IDs and every original row. Keep adjacent for/for-in/for-of and strict
   early-error positives; run proportional frontend/equivalence/identity and
   source-map gates, then the required whole-goal verification.
6. **Honest accounting.** Parse success, valid Wasm, or two tiny probe passes
   are not two original gains. Any remaining lowering/runtime failure stays
   visible. The denominator is 11,778; neither historical deferral nor current
   ownership hold changes it. No compiler flag, guard, exclusion or oracle
   change is part of this plan.

- [x] Fresh source-only original reproduction and instrument controls saved.
- [x] First parser/AST losses separated from normalization and runner hypotheses.
- [x] Relevant historical plans, frontend ownership and mapping consumers reviewed.
- [ ] Migration owner chooses/clears an exact maintained frontend boundary.
- [ ] Bounded candidate recognizer and negative/identity proofs accepted.
- [ ] Both originals pass unchanged through matched authoritative runtime testing.
- [ ] Proportional regressions and final whole-goal verification complete.

## Architecture handoff: smallest sufficient insertion contract

Read-only follow-up at the same frozen `7cd84317` base; no grammar repro was
repeated and no source ownership was granted. This section refines P0 rather
than expanding 6836 into the frontend migration. **There is no existing
supported hook that installs a variable-length compatibility transform across
the maintained entry paths while preserving all original-source consumers.**

### Actual entry-path comparison

- **Single-source executable, including its incremental branch:**
  `compiler.ts::compileSourceSync` owns transformations and map composition
  before selecting `analyzeSource` or `languageService.updateSource` near
  lines 1593–1604. Both can receive the same normalized text without changing
  checker internals. Syntactic diagnostics are mapped near line 1654;
  `finalizeSingleSourceIrTelemetry` separately maps selected audit locations.
  These are two different consumers, not one general location service.
- **In-memory multi-source/project-incremental executable:**
  `compileMultiSource` near line 1730 applies define/CJS/timer/ground stages to
  every file, then chooses `analyzeMultiSource` or
  `IncrementalProjectLanguageService.updateProject`. Its string-returning
  stages do not retain a per-file PositionMap for `collectMultiDiagnostics`.
  The original graph names and import resolution remain authoritative.
- **Incremental services:** `updateSource` versions changed text/name/ScriptKind;
  `updateProject` reuses unchanged per-file documents and versions the graph.
  They return genuine Program-bound SourceFiles, but accept no original-text,
  normalization-map or source-goal sidecar. They are usable downstream of an
  owner-held normalization record, not substitutes for that record. If two
  requests yield identical processed text but different original text/maps,
  checker reuse may remain valid while location metadata must still refresh.
- **Object output:** `compiler/output.ts::compileToObjectSource` near line 296
  separately preprocesses imports and calls `analyzeSource`, then materializes
  diagnostics directly from processed positions. It does not use the shared
  executable pipeline. Standalone object output currently refuses before
  parsing pending Prepared IR integration; retain that refusal. A parser fix
  must not claim to make this target available.
- **Disk project entry:** `compileFilesSource`/`checker::analyzeFiles` directly
  use `ts.createProgram` with filesystem resolution and no rewriting host.
  This adjacent public route cannot be covered by an in-memory entry hook.
  Its adapter needs an owner-supplied per-user-file read/parse boundary if it
  is included; do not rewrite files on disk or change tsconfig policy.

`analyzeSource` is shared with object output, but does not own multi-source
hosts or the Language Service's parser. `frontend/typescript.ts` is only a
namespace re-export, not a parse callback registry; changing it would be a
dependency-wide parser intervention. `preprocessImports` misses multi/disk
paths; the HTML-comment helper misses those paths and has a length-preserving
contract. None is a hidden leaf-only integration point.

### Proposed contract the migration owner can clear

Keep the normalizer a synchronous, deterministic frontend leaf. Its conceptual
input is `{ text, sourceName, sourceLanguage, sourceGoal }`; its result is a
discriminated unchanged/changed/unclassified result carrying processed text
and ordered, non-overlapping **insertion edits in input UTF-16 coordinates**.
`sourceLanguage` describes the original user language, separately from a later
forced TS ScriptKind for injected declarations. `sourceGoal` records the
owner's Script/Module and inherited strict-context decision, not a guess from
an import already erased by preprocessing. Nested directives and inherited
strictness require affirmative original-context evidence before admitting an
edit; delegating them solely to current downstream syntax checks is unsound.
Exact field names remain the owner's choice.

The leaf does not create Program/SourceFile objects, bind symbols, modify a
checker, add executable units, change imports, read the filesystem, register
global hooks, or edit an existing map. Unclassified input retains original
text and ordinary validation; it is not accepted through recovery and is not
a new exclusion. This does not certify that the unchanged validator is
complete. A changed result requires proof that the original admitted syntax
is valid, not merely that the transformed tree has no reported errors.
No fallback is selected solely by diagnostic absence.

The **owner integration** must provide these six guarantees:

1. **One invocation per user source revision, before syntax consumers.**
   In the current single-source order, the natural candidate is after
   lexical/define preparation and before stdin/Iterator/CJS/import parsing.
   The owner must approve this order, preserve existing rewrite behavior, and
   avoid applying the transform again to generated preludes. No original
   filename, graph key or source order changes. Declaration/library files and
   non-JavaScript inputs remain untouched unless separately approved.
2. **An immutable per-source provenance record.** Retain original text,
   processed text, original goal/language, selected final ScriptKind and the
   composed output-to-original PositionMap together. Compose this stage's map
   in actual pipeline order; never flatten by guessing deltas. The map is
   invocation/revision-owned, not a global filename-only cache. Identity
   results preserve the exact input and identity map.
3. **One bound parse.** Feed the final processed text to the existing normal
   or incremental host before Program construction. Keep canonical filenames
   and bindings; no recovered-node patch, second AST graft or post-bind
   position mutation. Cache ownership must distinguish request provenance
   even when TypeScript can reuse its unchanged processed snapshot.
4. **Explicit coordinate domains.** Route each processed diagnostic, source-map
   entry, public audit range and relevant reflected source range through its
   source's provenance record exactly once. An original-position diagnostic
   must not be mapped again. `CompileError` currently lacks a universal
   coordinate-domain tag, so blindly remapping the final mixed error list is
   unsafe. Owner-selected conversion boundaries or internal typed locations
   are required; this plan does not authorize a public diagnostic redesign.
5. **Preserved unit identity.** Supply existing compiler-origin callbacks before
   inventory construction and build pre-elision ordinal anchors from the same
   normalized coordinate space used by the final parse. Parentheses create
   no executable source units and need no invented compiler-support origin.
   Current IR IDs derive from source key/order/kind and lexical owner/unit
   ordinal, not raw character offsets; this makes reuse of existing APIs
   plausible, not automatically proven. Verify IDs, roles and retained range
   lookup under edits, elision, nested functions and multiple files.
6. **An explicit route contract.** The owner identifies which entry adapters
   receive the record and which remain unchanged pending their own migration.
   A first single-source patch may be scoped honestly, but cannot claim
   multi-source, disk, incremental-project or object-output parity by analogy.
   The unchanged authoritative originals must be tested on their real route.

### Existing API reuse and the exact remaining blockers

`SourceEdit`, `PositionMap` construction/composition,
`makeIrInventoryOptions`, the existing `elideWithIrIds` callbacks, and
`updateSource`/`updateProject` already supply useful pieces. No change to
`position-map.ts`, the IR identity algorithm, or incremental service internals
is inherently required for a **single-source** integration if the owner keeps
the provenance record outside those services and proves the invariants above.
That is narrower than preemptively requesting all mapping/identity files.

However, `PipelineInput` currently carries original `sourcesContent` and an
optional inventory configuration, **not per-file processed-to-original maps**.
`getSourcePos` reads processed AST positions, and `runPipeline` passes emitted
entries directly into `generateSourceMap`. A narrow owner-provided mapping of
those entries before serialization could preserve emitted maps without editing
every codegen caller, but that bridge is not present today. It also would not
by itself fix already-materialized codegen errors, other audits or function
source reflection. Each retained observable domain must have a named existing
or approved conversion boundary; diagnostic-map success alone is insufficient.

Thus the minimum request is **two explicitly partitioned responsibilities**:

- 6836 implementer: the pure new compatibility leaf and focused tests, using
  an owner-approved signature; no checker/backend/IR dependency expansion.
- Migration owner: named adapter insertion and provenance transport/conversion
  sites, initially the approved single-source entry and output boundaries
  (currently in `compiler.ts`, or their migrated replacements). The owner
  either wires the other routes or states their separate scope and acceptance.

If `compiler.ts` is not clear, the leaf can be independently developed only
after its contract is approved; it cannot be connected to production through
an unrelated helper as a workaround. If the owner cannot supply complete
position/reflection coverage for insertion edits, choose a separately approved
text-preserving parser correction or postpone integration. There is no evidence
that an existing API eliminates both adapter ownership and provenance work.

**Actionable clearance question:** “Can the migration owner supply/clear a
per-source normalization result plus exactly-once original-location transport
at the maintained single-source entry, before preprocessing and inventory, and
name the source-map/error/reflection conversion sites? May 6836 then own only
the pure leaf and its tests? Which other adapters are included in this first
slice?” This exercise itself answers none of those permissions.

Recommended Sol effort remains xhigh for the P0 contract/provenance proof,
high for the bounded `let` leaf after that proof, and xhigh for array-default
recognition. No additional parser experiments, builds, runtime acceptance,
commits, dependency changes or registry actions were performed in this follow-up.

## Independent semantic review: findings and admission gates

Reviewed by GPT-6.1 Sol Medium at the same `7cd84317` base. Frozen review files
are read-only under
`/Users/thomas/Code/js2/.codex-worktrees/6836-parser-plan-review-sol/.tmp/6836-review/`:

- `notes.md`, SHA-256
  `1dc2299e36fe3696d7327de7c6d37e3fa385a55c01011e4137459385f1a50405`.
- `probe.mts`, SHA-256
  `023ada9dc9f2b3954546a4d3d1d6ba5ad9424839e09c56eb6da4b8f90fa53805`.
- `receipt-summary.json`, SHA-256
  `802e69c04c1b54fa2d909ebc6c2226f5c9747a79251da0c1bd2f419716a7e893`.

Hashes were checked while integrating this review. The reviewer ran 20 manual
paired spellings once on Node 22.23.2 / TypeScript 5.9.3, terminal chunk
`3f6b2a`, exit 0: JS parsing, the maintained early-error traversal, and
`vm.Script` syntax checks only. The JSON contains **selected excerpts**, not
a complete serialized transcript. No recognizer, checker, source program,
compiler, IR, Wasm or provider was executed. Module-goal examples cannot use
`vm.Script` rejecting `export` as an independent Module grammar verdict.

### Concrete hazards that revise L and A

1. **Strict bare reads were masked by the old negative fixture.**
   `"use strict";for((let);;)break;` and an inherited-strict function variant
   have no TS parse or maintained early error, but Node rejects them.
   The previous `var let` fixture can fail on its declaration independently
   of the reference. The bare untransformed ordinary-for also has this hole;
   this is a baseline validation gap, not a measured runtime regression.
   `node-checks.ts` near line 929 checks selected binding/shorthand parents,
   not this ParenthesizedExpression reference.
2. **For-in expansion removes a working strictness guard.**
   `"use strict";for(let in {}){}` has one existing early error; replacing
   its target by `(let)` removes it although Node still rejects the input.
   `module-rules.ts::checkForInLetReference` near line 447 recognizes the
   empty-declaration-list shape. The separate strict-assignment guard does
   not establish read/for-in safety. Keep for-in outside first L admission.
3. **A can erase the only rejection of an invalid target.**
   `for([f()="x" in {}] of [[]]){}` has TS1005; changing only the RHS to
   `("x" in {})` makes both parser and early-error results clean, while Node
   rejects both as invalid assignment targets. The permissive target tail in
   `compiler/early-errors/assignment.ts` near line 130 is not an admission
   oracle. Prove the original assignment-target grammar before inserting.
4. **L's target parentheses bypass a name-inference consumer.**
   `codegen/function-instance-meta.ts::fnInstanceNameOf` near lines 477–486
   requires a direct Identifier on a simple assignment's left side.
   `(let)=function(){}` supplies ParenthesizedExpression instead. Its RHS
   parenthesis walker does not repair this LHS mismatch. This is a
   source-proven consumer hazard, not a measured runtime-name failure.
   General assignment admission needs anonymous function, arrow and class
   name/reflection controls and, if necessary, separately approved producer
   work. Do not silently expand 6836 ownership to that producer.
5. **Escapes and for-of are real admission boundaries.**
   Sloppy `for(\u006cet;;)break;` is Node-valid, but token parentheses expose
   an existing escaped-keyword rejection in `node-checks.ts` near line 2029.
   Decline escaped spellings in first L admission; do not incorrectly label
   them invalid. Conversely, rewriting forbidden `for(let of []){}` to
   `for((let) of []){}` makes it valid in both parsers. It must receive zero
   edits rather than rely on post-transform rejection.

### Required admission proof and implementation order

Before returning any changed result, establish original source goal/strictness,
complete ordinary-for or for-of head boundaries, legal target grammar and
the exact permitted expression extent. Require explicit zero-edit assertions
for unsupported shapes, not just parser outcomes. Do not widen diagnostics
tolerance lists or rely on today's incomplete early-error traversal.

For L, start only with proven sloppy ordinary-for, literal unescaped `let ;`
or the approved numeric assignment shape. For A, start only with the original
for-of array assignment slice and validated bare identifier targets. Retain
strict/inherited-strict/real Module negatives, call targets, rest defaults,
rest-not-last, lexical heads and forbidden for-of negatives. Probe the actual
recognizer with regex/template/comment lookalikes, malformed delimiters,
conditional/chained RHS, comma versus parenthesized comma, nested defaults
and `in` inside nested functions. Manually spelled paired examples do not
test a future recognizer's decisions.

Order remains: P0 owner-approved API and validity contract; concrete admission
matrix; separate L and A proofs; mapping/identity/eval/name/source-reflection
proof; then owner-cleared integration and matched unchanged-original runtime
acceptance after the heavy lease is available. If affirmative validity or
observable-name preservation cannot fit the approved boundary, stop and
reconsider the source-preserving parser route. All production ownership holds
and the frozen 11,778-original acceptance requirements remain unchanged.

A numeric-RHS-only or original-test-shaped recognizer cannot be called the
complete repair merely because it avoids the naming hazard. Unsupported valid
forms remain tracked semantic obligations, never exclusions from the 100%
goal. A bounded first patch must report its incomplete scope explicitly;
completion requires faithful supported identifier-assignment naming semantics
or the approved text-preserving parser route. The independent Module grammar
instrument was still open at this review; the bounded follow-up below supplies
that instrument, not a production Module-semantics repair.

### Completed validation follow-up: independent Module syntax instrument

Sol completed 17 manually paired syntax cases at the same frozen `7cd84317`
base, using Node **24.19.0** at
`/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`
with `--experimental-vm-modules --import tsx`. The independent instrument was
real `vm.SourceTextModule` construction; accepted modules remained **unlinked**.
TypeScript 5.9.3 JS/Latest parsing and the maintained early-error traversal
with `moduleGoal: true` supplied the compiler-side comparison. No source was
linked or evaluated, and no checker, compiler, IR, Wasm, provider or build ran.

The first terminal output was truncated; the same bounded probe was captured
once more to retain the complete report. Both invocations ended with exit 0;
the retained capture was chunk `f34fb4`, approximately 0.524 seconds.
The report contains all 17 pairs with exact source strings, UTF-8 lengths,
SHA-256 hashes, Module verdicts, TS diagnostics and early errors. Unlike the
earlier Script review's excerpt summary, this is the full retained report.

Read-only files under
`/Users/thomas/Code/js2/.codex-worktrees/6836-parser-plan-review-sol/.tmp/6836-module-syntax-proof/`:

- `report.json`, SHA-256
  `63e9a5c2798814072857c912182691a62eeda3055580a3d2d45c38bdb21cff31`.
- `notes.md`, SHA-256
  `e6ebdf5dd7806991ef198d0b68573e3f2738d385c1113dabe6c29ee9b7ef7427`.
- `probe.mts`, SHA-256
  `47254fbf72ae7e2287da263f3cd0fe660e1626d63aab1aaef0455fbd7db4b5f4`.
- `terminal-receipt.json`, SHA-256
  `036c90e12990cfadce559c20ee7dfe2baee05d4642c446acd96251d1939ef25f`.

Astra read the full report, notes and terminal receipt and independently
checked these four artifact hashes before updating this task.

Bounded factual results:

- Genuine Module parsing rejects bare/inherited-strict `let` references
  before and after token parentheses, while TS/early-error traversal remains
  clean for the read cases. The assignment counterpart has a maintained
  strict-assignment error; it cannot stand in for the missing reference check.
- Both for-in arms are Module-invalid. The maintained empty-declaration-list
  rejection disappears after target parentheses, confirming the guarded-shape
  loss. Both for-of arms are also Module-invalid; this differs from the prior
  sloppy Script invalid-to-valid transition, because Module strictness rejects
  the parenthesized identifier reference.
- Escaped `let` is Module-invalid on both arms. That does not overturn the
  Node-valid escaped IdentifierReference result in sloppy Script code.
- The identical lexical ordinary-for, lexical for-in and lexical array-binding
  for-of controls are Module-valid and TS/early-error clean on both arms.
  The valid array-assignment default is Module-valid before and after RHS-only
  parentheses; its original TS1005 disappears in the paired spelling.
- Module parsing rejects `f()`, `this` and rest-default targets on both arms.
  The maintained strict-assignment rule rejects the Module `f()` case even
  after TS1005 disappears. Keep this separate from the earlier sloppy Script
  `f()` case with zero maintained early errors; neither stratum substitutes
  for the other in recognizer admission tests.
- The deliberate whole-RHS NoIn example changes from Module-invalid to valid
  when parentheses move the `in` inside the RHS. This is an unsafe manually
  specified transformation demonstrating the boundary hazard, not a
  implemented normalizer, accepted repair or conformance gain.

- [x] Independent Module syntax instrument validated for these exact paired
      controls and its full report/terminal receipts reviewed.

The 6836 planning claim remains released; the frontmatter actor is historical.
This completed validation does not acquire production ownership or reopen a
production claim. Recognizer validity, mapping/identity, full supported naming
semantics, unchanged-original runtime acceptance and all source approvals
remain open. No input exclusions or test-shaped final repair are authorized.
