---
id: 4218
title: "Oracle backend: in-house binder + annotation propagation — make the TS5 checker droppable (JS-mode first, TS-mode second)"
status: in-progress
sprint: Backlog
assignee: "ttraenkler/fable-remote"
created: 2026-08-08
updated: 2026-08-13
# Phase-1 slice adds the `oracleBackend` option to the two option bundles
# (CodegenOptions is a type barrel, CompileOptions' resolver is the driver) —
# +14 / +2 LOC of option + doc comment. There is no subsystem module to put a
# public option field in; it has to live where the bundle is declared.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/compiler.ts
  # Kill-order item 1/4 dual-path slice (2026-08-14): the lib walk gains a
  # syntactic branch NEXT TO the checker branch (extern-declarations), and
  # from-ast/integration/index thread the oracle option. The checker branches
  # are deleted in Phase 3, returning the LOC.
  - src/codegen/extern-declarations.ts
  - src/ir/from-ast.ts
  - src/codegen/index.ts
  - src/ir/integration.ts
  # Phase-1 CP1 (2026-08-14): oracle-source plumbing + candidate helper in
  # module-bindings (+30) — replaces four raw getSymbolAtLocation preludes.
  - src/ir/module-bindings.ts
# Same slice: a few lines of index construction / option threading inside the
# existing drivers (no new logic in the god-functions themselves).
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
# Kill-order item 1 (syntactic lib walk) REMOVES ~254k runtime checker calls;
# the +1 static ctxChecker count in extern-declarations.ts is an inlining
# artifact of restructuring the user-path else-branches (net behavior change
# is a large DECREASE in checker usage — see the 2026-08-14 audit section).
oracle-ratchet-allow:
  - src/codegen/extern-declarations.ts
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: refactor
area: checker, codegen, ir
goal: platform
related: [1029, 1288, 1290, 1930, 2855, 3273]
origin: "2026-08-08 assessment: does js2wasm still need the TypeScript package at all? Split the dependency into parser vs checker and found the checker is replaceable with machinery the IR already has. Follow-on from the TS7/tsgo compile-speed question (#1029)."
---

# #4218 — Oracle backend: in-house binder + annotation propagation

## Problem

js2wasm depends on the `typescript` npm package for two separable things:

1. **Parser + AST shape** — the entire front end is written against the TS
   AST: ~344k LOC in `src/codegen/` + ~80k LOC in `src/ir/`, 2,730
   `SyntaxKind.*` sites (measured 2026-08-08). The AST *shape* is
   load-bearing and stays. The *implementation* behind it is swappable:
   tsgo (TypeScript 7 Go port) emits a property-compatible AST — validated
   in #1029's audit (identical `SyntaxKind` values, node props, `.parent`
   chains) — and parsing never required the still-missing Corsa
   programmatic API.
2. **TypeChecker as type oracle** — ~190 call sites through `ctx.oracle`
   (wrapping only ~10 checker primitives: `getTypeAtLocation`,
   `getSymbolAtLocation`, `getTypeOfSymbol`, `getContextualType`,
   `getReturnTypeOfSignature`, `getPropertiesOfType`, declarations), plus
   ~445 legacy raw `checker.`/`ctxChecker` references still in codegen
   under the oracle-ratchet (#1930/#3273) baseline.

The checker is the reason we cannot move the compile pipeline to tsgo.
**Update 2026-08-13**: TS7 GA (`typescript@7.0.2`, npm `latest`) ships a
synchronous subprocess Checker API after all (`typescript/unstable/sync`, see
the #1029 GA re-audit) — but at ~0.12ms/IPC-query it only becomes viable
once this issue's kill order shrinks query volume from ~264k to the ~1.6k
residual. The in-house backend remains the plan of record for the hot path;
the TS7 checker is a candidate for TS-mode differential validation.

This issue removes that blockage from our side: back `ctx.oracle` with an
**in-house binder + annotation-propagation engine** so the TS5 checker
becomes droppable, independent of when/what upstream ships.

## Why the checker is replaceable (evidence)

- **Plain-JS inputs get near-zero value from the checker.** The test262
  corpus (43k files) has no annotations; codegen already degrades
  gracefully to dynamic representations when type facts come back unknown.
- **The oracle's fact vocabulary is deliberately small.** Top consumers
  (measured): `staticJsTypeOf` (31), `valueDeclarationOf` (30),
  `typeFactOf` (30), `variableDeclarationOf` (21), `declaredNameOf` (11),
  `signatureOf` (9), `builtinReceiverOf` (8). Symbol/scope binding is
  ordinary scope analysis; type facts on annotated TS are mostly
  annotation-reading plus local propagation.
- **The IR already owns type machinery**: `src/ir/propagate.ts`,
  `type-evidence.ts`, `TypeMap`, `passes/monomorphize.ts`. The IR-fallback
  buckets "better TypeMap propagation" (#1376/#2855) are explicitly about
  owning type resolution in-house. This issue converges with that work
  rather than competing with it.
- **The oracle-ratchet has been forcing the right shape** — one narrow
  interface that can be re-backed. The blocker is not design; it is the
  ~445 un-ratcheted raw checker references in legacy codegen.

## What is genuinely hard (scope the risk here)

- **`lib.d.ts` builtin knowledge** (`oracle.builtinReceiverOf`,
  well-known-symbol members): needs a curated builtin-shape table, not a
  full lib.d.ts interpreter.
- **Generics instantiation and contextual typing**: out of scope for the
  in-house engine; the few sites that need raw `ts.Type` identity already
  carry `oracle-ratchet-allow:` grants and can keep TS5 until TS-mode
  phase-out.
- **Module resolution**: `src/checker/index.ts` uses `ts.createProgram`
  with real fs resolution — this is what makes npm-compat work. Module
  resolution must be preserved (in-house resolver or tsgo project load),
  and is the riskiest slice; keep it last.

## Plan

**Phase 0 — ratchet to zero (prerequisite, mergeable in slices).**
Drive the ~445 raw `checker.`/`ctxChecker` references in codegen through
`ctx.oracle`, extending the oracle's fact vocabulary only where a real
consumer needs it. Pure refactor; each slice lands under the existing
ratchet gate.

**Phase 1 — JS-mode without the checker.**
In-house binder (scope/symbol resolution → `valueDeclarationOf`,
`variableDeclarationOf`, `declaredNameOf`, `isUnresolvableIdentifier`) +
builtin-shape table. For inputs with no type annotations, back the oracle
entirely in-house; assert conformance parity on test262 (which exercises
exactly this mode). This also unlocks the tsgo batch-parse fast path from
#1029 Phase 1 for JS inputs — no TS5 program construction at all.

**Phase 2 — TS-mode annotation propagation.**
Annotation reading + propagation (reuse/extend IR `TypeMap` machinery) to
answer `typeFactOf`/`staticJsTypeOf`/`signatureOf` for the annotated
subset js2wasm actually consumes (`type i32 = number`, typed params/returns,
class shapes). TS5 checker stays available behind a flag as a differential
oracle for validation.

**Phase 3 — decide the endgame.**
With phases 0–2 landed, the TS5 checker is a dev-time validation tool, not
a runtime dependency. Whether to delete it, keep it as an optional
strict-mode, or swap the parser to tsgo (same AST, ~6× cold / ~170× warm
measured in #1288) becomes a cheap, reversible decision.

## Acceptance criteria

- [ ] Raw checker references in `src/codegen/` reduced to the
      `oracle-ratchet-allow:` grant list only (Phase 0).
- [ ] JS-mode (unannotated input) compiles with the in-house oracle backend
      and zero TS5 `createProgram`/`getTypeChecker` calls; test262
      conformance within drift of baseline (Phase 1).
- [ ] TS-mode answers the oracle fact vocabulary from annotations +
      propagation; differential run against the TS5-checker-backed oracle
      shows no conformance regression on the equivalence suite (Phase 2).
- [ ] Module resolution / npm-compat unaffected (explicitly re-run the
      npm-compat suite before any phase that touches `checker/index.ts`).

## TS5 API dependency audit — measured (2026-08-13)

Instrumentation landed with this audit: `src/checker/ts5-trace.ts` (an
env-gated recording proxy wrapped at the three `program.getTypeChecker()`
sites in `checker/index.ts`, zero overhead when `JS2WASM_TRACE_TS5` unset)
and `scripts/audit-ts5-checker-usage.mts` (compiles the playground-examples
corpus + 8 unannotated plain-JS snippets under both oracle backends and
diffs the traces). Re-run any time with:

```bash
npx tsx scripts/audit-ts5-checker-usage.mts
```

### Static surface (grep, 306 distinct `ts.*` members in src/)

| class | members (occurrences) | TS7 status |
| --- | --- | --- |
| AST shape: `SyntaxKind`/enums, ~200 `is*` predicates, node type names, `factory`, `forEachChild` | ~95 % of all occurrences | tsgo-compatible (#1029 audit: identical enum values, node props, `.parent`) |
| Syntactic helpers: `getModifiers` (47), `canHaveModifiers` (37), `tokenToString` (13), `isExternalModule` (12), `getJSDocType`/`getCombined*Flags`/`setTextRange`/`skipOuterExpressions`/… | ~170 occurrences total | pure-syntax; shim or reimplement, no checker needed |
| Parser/program: `createSourceFile` (40), `createProgram` (8), `sys`, `resolveModuleName` (3), `createScanner` (3), config-file readers, language-service surface (`createLanguageService` (4), `DocumentRegistry`, `ScriptSnapshot`) | TS5-bound | replaced by tsgo project parse (#1029) once the checker is out of the hot path |
| `ts.TypeChecker` runtime calls | measured below | the actual migration blocker |

### Dynamic measurement (corpus = 13 examples + 8 plain-JS snippets)

| backend | checker calls | compile parity |
| --- | --- | --- |
| `checker` (default) | 271,405 | — |
| `inhouse` (#4218 P1) | 263,748 | **21/21 byte-identical wasm** |

Findings:

- **Perfect parity**: the inhouse backend produced byte-identical output on
  the whole corpus. Phase 1 works; the oracle surface is sound.
- **The oracle was never the traffic**: flipping the backend removes only
  ~3 % of checker calls. The mass is legacy raw `ctx.checker` sites.
- **96 % of the remaining dependency is ONE mechanism**: the
  `extern-declarations.ts` lib-file walk (`getTypeAtLocation` 155k,
  `getSignatureFromDeclaration` 34k, `getReturnTypeOfSignature` 34k,
  `getSymbolAtLocation` 30k). Whenever `sourceUsesLibGlobals()` fires (any
  lib-global identifier or regex literal in user code), codegen walks every
  `lib.*.d.ts` in the program issuing per-member checker queries
  (`collectExternDeclarations`/`collectDeclaredGlobals`,
  `src/codegen/index.ts:4441-4450`). This is fixed per-compile overhead
  proportional to lib.d.ts, not to user input — a large slice of the
  "TypeScript is 90 % of compile time" complaint.
- **3 % is `type-mapper.ts`** (`getBaseConstraintOfType` 8.2k).
- **The tail is ~1.6k calls over ~25 live sites** (ir/module-bindings,
  ir/integration, expressions.ts, closures, literals, index.ts) — NOT the
  ~933 grep-count `ctx.checker` references; most raw sites are cold on real
  inputs.
- **JS-mode is close but not checker-free**: a single unannotated snippet
  still makes ~276 checker calls under the inhouse backend, dominated by
  `ir/module-bindings.ts:789` (`getSymbolAtLocation`, 196).
- **8 direct `new TsCheckerOracle(checker)` constructions bypass the
  backend option**: `ir/from-ast.ts` (×4), `ir/fmod-selection.ts:36`,
  `ir/update-retyped-bindings.ts:24` — they hit TS5 even under
  `oracleBackend: "inhouse"`.

### Kill order items 1 + 4 — LANDED (2026-08-14)

- **Item 1 (lib walk → syntactic)**: `src/codegen/lib-decl-index.ts` — a
  one-shot name-keyed index over the program's `lib.*.d.ts` files plus a
  TypeNode→ValType mapper mirroring `mapTsTypeToWasm` decision-for-decision
  (lib files are fully annotated, so every checker query in the walk was
  answerable from syntax). The lib-file scan in `extern-declarations.ts`
  now passes a `libIndex` and issues ZERO checker calls; the user-file
  `declare` path keeps the checker (input-driven, cheap). Same traversal
  order ⇒ identical import/type tables.
- **Item 4 (constructor bypasses)**: `oracle?: TypeOracle` threaded through
  `AstToIrOptions`/`LowerCtx` (from-ast) and `fmodRefFor`; integration
  passes `ctx.oracle`, so the former ad-hoc `new TsCheckerOracle(checker)`
  sites now honor `oracleBackend`. Ad-hoc wrap remains only as no-oracle
  fallback. (`update-retyped-bindings.ts` already accepted an oracle; its
  module-bindings caller still passes a checker — part of the tail.)

Measured (same corpus/audit as above):

| backend | before | after | Δ |
| --- | --- | --- | --- |
| `checker` | 271,405 | 35,403 | **−87 %** |
| `inhouse` | 263,748 | 27,658 | **−89.5 %** |

Wasm output byte-identical to the pre-change baseline on all 21 corpus
inputs, BOTH backends. `type-mapper.ts getBaseConstraintOfType` (item 2)
disappeared with the lib walk — it was only ever called from it. The
remaining traffic is now dominated by `ir/module-bindings.ts`
`getSymbolAtLocation`/`getResolvedSignature` (binder-shaped work → Phase 1
`valueDeclarationOf` territory) plus the ~25-site tail.

### Phase-1 CP1 — module-bindings helpers + oracle memoization (2026-08-14)

The four binding-resolution helpers in `ir/module-bindings.ts` (the largest
consumer after the lib-walk kill) now resolve declaration candidates through
`valueDeclarationOf`/`declarationsOf`, and `TsCheckerOracle` memoizes both
per node (the "memoized" invariant previously covered only `typeFactOf`).
Total corpus checker calls: 35,403 → **15,121** (−94.4 % cumulative from
271,405). Byte-identical output vs the original baseline, both backends.

**Flat-tail finding (updates the plan).** After CP1 the remaining traffic
has NO concentrated consumer: the top site is the oracle's own memoized
resolution (~130 calls), everything else ≤75 calls spread across ~30 files
(import-collector, identifiers, usage-inference, propagate, host-extern,
resolved-signature sites…). Consequences:

- Per-compile TS5 checker cost is now ~15k memoized queries — milliseconds,
  no longer a compile-time lever. The compile-time story moves to parser/
  program construction (#1029 tsgo batch parse).
- The remaining Phase-0 sweep (routing the flat tail through the oracle so
  the INHOUSE backend reaches zero) is mechanical, parallelizable,
  per-file work — dev-lane material, not a single hard slice. The audit
  script's site list is the worklist.
- Symbol-identity comparison sites (`getSymbolAtLocation(a) ===
  getSymbolAtLocation(b)`, ~10 sites in module-bindings) need one new
  oracle query ("same binding") before they can convert.

### Measured kill order (refines the Plan phases above)

1. **Extern-declarations lib walk → build-time table** (−96 %): the lib
   shapes are static per TypeScript version; generate the
   `ExternClassInfo`/globals table once at build time (or curate it, per
   "What is genuinely hard") instead of re-deriving it through the checker
   on every compile. Also a straight compile-time win independent of TS7.
2. **`type-mapper.ts` constraint path** (−3 %).
3. **Ratchet the measured ~25-site tail through oracle facts** — the
   audit's site list IS the Phase-0 worklist; the other ~900 grep sites can
   be swept mechanically later since they're cold.
4. **Honor `oracleBackend` at the 8 direct `TsCheckerOracle` constructions.**

Then JS-mode compiles are checker-free, the tsgo batch parser (#1029) can
carry the pipeline, and typescript@5 remains only as the optional TS-mode
checker / differential-validation dev tool.

**Bottom line for "does the compiler, given the AST, still need TS5?"** —
Yes, today: one lib-scan mechanism + ~25 live call sites + 8 constructor
bypasses. No, architecturally: parity is already byte-identical where the
oracle answers, and every remaining dependency is enumerated above with a
measured, bounded fix.

## Non-goals

- Replacing the TS AST *shape* (oxc/swc/home-grown parser): rewriting a
  ~424k-LOC front end for no user-visible gain. Ruled out.
- Reimplementing full TypeScript inference (generics, conditional types,
  flow narrowing). The oracle vocabulary defines the ceiling.
- Waiting on the TS7 API was the plan's original non-goal; GA has now shipped
  it (`typescript/unstable/sync`) and the audit's measurement confirms the
  reasoning: per-node IPC queries cost ~0.12ms each, so at today's ~264k
  calls/compile the TS7 checker cannot back the hot path — an in-house
  backend avoids that architecture problem entirely. The TS7 checker becomes
  useful only after the kill order lands (residual ~1.6k queries ≈ 0.2s),
  and then only as a TS-mode validation/differential backend.
