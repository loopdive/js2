---
id: 6941
title: "Compile time on large JS (Octane box2d 229 KB: 88 s gc / 325 s standalone): per-site whole-file AST walks (`bindingHasWrites`, descriptor scans, capture analysis) and 1,055 full-module global-index rewalks from host property-key imports"
status: ready
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
language_feature: compiler-internals
goal: compiler-architecture
related: [874, 4415, 1058, 2710, 6940]
assignee: "ttraenkler/claude-session-c-octane-box2d-compile-time-20261010"
---

# #6941 — box2d compile time: three hotspots are quadratic in source size

Found by the Octane triage for [#874](https://js2wasm.loopdive.com/dashboard/issue.html?slug=874-benchmark-compare-all-js-to)
(Session C, 2026-10-10, main `01e4888aae`). Octane `box2d.js` + `base.js`
(≈242 KB, 105 `new X(` sites, 2,922 imports in the output) through the public
`compile()` with `allowJs`, `skipSemanticDiagnostics`, `validate: false`:

| lane | wall (this box, 4 cores, load ≈5) | brief's figure |
| --- | --- | --- |
| gc | **88 s** (146 s with tracing on) | 78 s |
| standalone | **325 s** | 242 s |

For scale: the whole test262 corpus compiles at ~0.4–0.5 s per file (#4415).
This is about the compiler, not the program — V8 parses+compiles box2d in
milliseconds.

## Profile (gc lane, `node --cpu-prof`, 134 s run, main thread)

`node --cpu-prof --cpu-prof-dir=.tmp/prof --import tsx .tmp/oct-repro.mjs box2d gc`,
summarised with `.tmp/prof-summary.mjs` (self time; tsx line numbers are lost, so
functions are named):

| self | % | function | file |
| ---: | ---: | --- | --- |
| 20.7 s | 15.4 | `shiftGlobalIndices` (+2.9 s `fixupModuleGlobalIndices`) | `src/codegen/registry/imports.ts` |
| 11.6 s | 8.6 | `visitNode2` / `forEachChild*` (TypeScript AST walking, ~20 s total across rows) | typescript.js |
| 9.0 s | 6.7 | anonymous visitors | `src/codegen/closures/arrow-phases.ts` |
| 8.8 s | 6.6 | anonymous visitor (`bindingHasWrites`) | `src/codegen/expressions/builtin-prototype-constructor.ts` |
| 5.4 s | 4.0 | anonymous visitor (`runtimeAccessorDescriptorKey`) | `src/codegen/property-access.ts` |
| 3.6 s | 2.7 | GC | — |

Inclusive: `addStringConstantGlobals → fixupModuleGlobalIndices` **23.6 s
(17.7 %)**; `tryCompileBuiltinPrototypeConstructorNew → resolveBuiltinPrototypeConstructor → bindingHasWrites` **22.2 s (16.5 %)**;
`compileArrowAsClosure → compileLiftedClosureBody` 57 s (that is the real work,
the two above sit inside it).

### Hotspot A — 1,055 full-module rewalks for late string imports (≈18 %)

Every string-constant import added after code exists rewalks every live body
(`fixupModuleGlobalIndices`, imports.ts:463–654). The `JS2_HOLE_TRACE` count
for box2d: **1,055 fixups**, of which **916 come from
`addHostStringConstantGlobal` ← `registerHostPropertyKey`** (host-property-key.ts:11)
called by `reserveMemberSetDispatch` (534) / `reserveMemberGetDispatch` (259) /
`staticHostPropertyKeyInstrs` (123), i.e. one rewalk per first-seen property
name. #1058 already built the batching mechanism for exactly this
(`ctx.deferredStringConstants`, `deferrableStringConstantGlobalGet`,
`registerLateReadStringConstant`, resolved once in
`resolveDeferredStringConstants`, imports.ts:287–360), but
`addHostStringConstantGlobal` (imports.ts:372–409) bypasses it and calls
`fixupModuleGlobalIndices` directly. The same eager path is what #6940 tripped
over, so batching also shrinks that bug class's exposure window.

### Hotspot B — `bindingHasWrites` walks the whole source file per `new` site (≈16 %)

`builtin-prototype-constructor.ts:93–130`: for every `new <identifier>(…)` whose
identifier is a `var` alias (box2d is minified — `var K = Box2D.Common.Math.b2Vec2`,
then `new K(…)` 105 times), `resolveBuiltinPrototypeConstructor` calls
`bindingHasWrites(ctx, declaration)`, which does `ts.forEachChild(declaration.getSourceFile(), visit)`
over the **entire 229 KB AST**, calling `ctx.oracle.valueDeclarationOf` on every
assignment target. Nothing is memoised, and the answer is needed only when the
alias's initializer could resolve to `X.prototype.constructor` — which it never
does in box2d. ≈200 ms per site × 105 sites.

### Hotspot C — per-site whole-file / whole-closure walks in two more places (≈11 %)

- `property-access.ts::runtimeAccessorDescriptorKey` (L792–L913): two
  `visit(receiver.getSourceFile())` whole-file walks (the fnctor-prototype
  descriptor scan and the #3374 `Object.defineProperty` fallback) for every
  dynamic member access whose receiver is a module global. 5 call sites.
- `closures/arrow-phases.ts` (`hasReferenceOutsideClosure`,
  `referencedBindingDeclaration`, `closureReferencesOnlyUnboundName`,
  L400–L480): one full closure-body walk with oracle lookups **per candidate
  capture name per closure**; box2d has ~2,000 lifted closures.

Standalone (325 s) was not profiled; it shares A–C and adds native-string
lowering. Profile it separately before claiming the same split.

## Implementation Plan

Order by payoff/risk; each step is independently landable and measured with
the same driver (`node --import tsx .tmp/oct-repro.mjs box2d gc`, 3 runs,
median; capture `.tmp/base` numbers FIRST per CLAUDE.md).

1. **B — memoise + reorder (`builtin-prototype-constructor.ts`).**
   In `resolveBuiltinPrototypeConstructor::visit`, compute
   `const target = visit(declaration.initializer)` FIRST and only call
   `bindingHasWrites` when `target !== undefined`. Then memoise
   `bindingHasWrites` per declaration (`WeakMap<ts.VariableDeclaration, boolean>`
   on `ctx`, reset per compile like the #4415 derivation-flag cache) — the
   answer is a property of the declaration, not of the `new` site. Same for
   `prototypeConstructorHasWrites` (per source file + builtin name). Expected:
   −20 s on box2d, zero behaviour change (pure function of the AST).
2. **A — route host property keys through the #1058 deferred batch
   (`registry/imports.ts`, `host-property-key.ts`).** In
   `addHostStringConstantGlobal`, when `ctx.deferredStringConstants` is active
   and `!ctx.nativeStrings`, register via `registerLateReadStringConstant` and
   hand callers a `deferrableStringConstantGlobalGet` placeholder instead of a
   baked index; `reserveMember{Get,Set}Dispatch` and
   `staticHostPropertyKeyInstrs` take the `Instr[]` form. `resolveDeferredStringConstants`
   already patches marked reads in the one shift walk. Constraint: callers
   that store the returned NUMBER (not an Instr) must be audited —
   `grep -n "addHostStringConstantGlobal\|registerHostPropertyKey"` — any that
   bake the number into a side table need the finalize-time patch the
   `inModuleInitFlagReads` idiom (imports.ts:≈420) uses. Expected: 1,055 →
   ≈140 walks, −20 s. Risk: medium (index bookkeeping — #2710 class); the
   `tests/issue-1690.test.ts`, `issue-6940` and the lodash/acorn stress tests
   are the guards.
3. **C1 — index descriptors once per source file (`property-access.ts::runtimeAccessorDescriptorKey`).**
   Build a per-`ts.SourceFile` map `receiverSymbol → Set<propName>` of
   `Object.defineProperty(recv, "k", {get/set})` and fnctor-prototype
   descriptor literals in one walk (WeakMap on `ctx`), then answer each call
   from the map. Pure refactor of two read-only scans.
4. **C2 — arrow-phases capture scans.** Collect all identifier references of a
   closure once (`Map<name, Identifier[]>` per closure node, WeakMap) and let
   the three predicates consume that list instead of re-walking per name.
   Pure refactor; order of evaluation untouched.
5. **Measure standalone** with the same profiler after 1–4 and file the
   residual (native-string specific) as its own issue if it is a distinct
   root cause.

Regression tests: `tests/compile-time-box2d-shape.test.ts` is NOT the right
tool (wall-clock asserts flake). Instead assert the counts: a unit test that
compiles a 50-`new K()` alias program and asserts `bindingHasWrites` runs ≤ 1×
per declaration (spy/counter behind a test hook), and one that compiles a
program with 30 first-seen property names and asserts
`fixupModuleGlobalIndices` fires ≤ 2× (after step 2). Behavioural guards:
existing `tests/issue-1690*.test.ts`, `tests/issue-3396-*.test.ts`, the acorn/
lodash stress suites, and the #6940 test.

## Acceptance criteria

- box2d gc compile ≤ 45 s on this box (≥ 2× faster; from 88 s), measured as
  median of 3 with the base run recorded in the PR.
- No emitted-byte change on `tests/equivalence/` fixtures for steps 1, 3, 4
  (pure refactors) — check with a before/after `.wasm` hash on a sample.
- No test262 regression (merge_group), equivalence gate green.

## Ownership note

Session A's WasmGC/shared area; implementation by Session C at the project
lead's direction. Exact functions: `expressions/builtin-prototype-constructor.ts::
{bindingHasWrites, prototypeConstructorHasWrites, resolveBuiltinPrototypeConstructor}`;
`registry/imports.ts::{addHostStringConstantGlobal, registerLateReadStringConstant,
deferrableStringConstantGlobalGet, resolveDeferredStringConstants}`;
`host-property-key.ts::{registerHostPropertyKey, staticHostPropertyKeyInstrs}`;
`member-get-dispatch.ts::reserveMemberGetDispatch` / `member-set-dispatch.ts::
reserveMemberSetDispatch` (call-shape only); `property-access.ts::
runtimeAccessorDescriptorKey`; `closures/arrow-phases.ts::{hasReferenceOutsideClosure,
referencedBindingDeclaration, closureReferencesOnlyUnboundName}`.

## Overlap check (2026-10-10)

- #4415 (done) did the previous compile-hot-path pass (allocation + env reads);
  these three hotspots were not in its profile (test262-sized inputs never hit
  them). #1058 built the deferral mechanism step 2 reuses. #2710 is the
  structural umbrella for hotspot A (cite). #3673/#4157 are about the
  *generated* code's speed, not compile time.
- Open PRs (32, checked file-by-file via `gh api …/pulls/N/files`): none touch
  `builtin-prototype-constructor.ts`, `host-property-key.ts`,
  `member-{get,set}-dispatch.ts` or `statements/loops.ts`. Adjacent diffs to
  merge `origin/main` across before starting: #5748 (`codex/5387-unsoundness-audit`)
  edits `registry/imports.ts`; #5784 (`codex/4376-deno-realm-main-sync`) edits
  `array-holes.ts` and `closures/arrow-phases.ts`; #6548
  (`codex/6878-delete-result-boolean-sol61`) edits `property-access.ts`. #6605
  ("native prototype constructor binding recovery") does not touch these files.
- Claim ledger: no claim on this id; ids 6934–6936 and 6931 are taken by open
  docs PRs, 6939–6941 are free.
