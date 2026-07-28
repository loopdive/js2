---
id: 3672
title: "ESLint linter.js: keep checker-only roots out of bounded codegen"
status: in-progress
created: 2026-07-26
updated: 2026-07-28
priority: critical
feasibility: hard
reasoning_effort: max
task_type: performance
area: compiler, codegen, observability
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
required_by: [1400, 2693]
es_edition: n/a
related: [824, 1282, 1400, 1573, 1942, 3654, 3655, 3656, 3657]
# Intentional growth for the #1400/#3654-#3672 ESLint graph slice: real-package
# CJS/module-global identity work + compile-phase telemetry lands across the
# codegen barrel and call-dispatch modules in one reviewed change-set.
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/array-methods.ts
  - src/codegen/expressions/call-identifier.ts
  - src/compiler.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/registry/imports.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/statements/variables.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/calls.ts
  - src/import-resolver.ts
  # calls-closures.ts +20: the #1400 closure-call fix — resolve the callee's
  # module global from its OWN declaration (moduleGlobalAtIdentifier) before
  # the process-wide bare-name map, and decline dispatch when the resolved
  # global is numeric (a number cannot carry a closure; loading it into the
  # __fn_wrap_* self slot produced the invalid local.tee f64-vs-ref that
  # blocked the ESLint graph). Semantic fix validated by the equivalence
  # shards going green at this head; net-zero golf would mean re-touching
  # just-proven dispatch code, so the growth is accepted and extraction is
  # deferred to the consolidation plan.
  - src/codegen/expressions/calls-closures.ts
  # string-ops.ts +9: the #3687-park residue fix — the tagged-template tag-call
  # capture prepend used raw cap.outerLocalIdx (declaring-frame index), which
  # is out of range when a lifted nested function recurses via a tagged
  # template (test262 tagged-template/tco-member 'local index out of range'
  # compile error). The frame-correction mirrors call-identifier.ts's
  # captureLocalIndex; extraction deferred to the consolidation plan.
  - src/codegen/string-ops.ts
func-budget-allow:
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/statements/nested-declarations.ts::emitSetExtrasArgv
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/compiler.ts::runPipeline
  # compileLiftedClosureBody +15: reserve compiler identities for nested
  # function declarations before body statements compile — the #1400 fix for
  # esquery's `function m(){}` colliding with the `ms` package's numeric `m`
  # ("already compiled" false positive skipped the body). Same reviewed slice,
  # extraction deferred to the consolidation plan.
  - src/codegen/closures.ts::compileLiftedClosureBody
  # compileArrayMethodCall +10: declaration-scoped receiver resolution
  # (moduleGlobalAtIdentifier) replacing the process-wide bare-name map, which
  # proxied ms's numeric `var s = 1000` into esquery's lexical array `s`
  # receiver slot (f64-vs-ref validation failure blocking the ESLint graph).
  - src/codegen/array-methods.ts::compileArrayMethodCall
  # compileTaggedTemplateExpression +9: the same frame-correction (see the
  # string-ops.ts loc-budget note above).
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
# moduleGlobalForSymbol/functionDeclKeys need raw checker symbol identity for
# same-named module-global disambiguation (above what ctx.oracle expresses).
oracle-ratchet-allow:
  - src/codegen/function-identity.ts
  - src/codegen/index.ts
---

# #3672 — Bound full codegen for the resolved ESLint Linter graph

## Problem

After #3654 restores ESLint's physical pnpm package context and exact virtual
module edges, and #3655 materializes static JSON, direct
`eslint/lib/linter/linter.js` analysis completes with 146 canonical checker
sources. The entry has zero TS2307 diagnostics and the resolver reports no
failure.

The honest next frontier is scale: this Node-host WasmGC probe does not return
within the 180-second budget used by the first ESLint integration test:

```sh
node --max-old-space-size=2048 --import tsx \
  tests/helpers/compile-project-probe.ts \
  node_modules/eslint/lib/linter/linter.js \
  '{"allowJs":true,"target":"gc","platform":"node"}'
```

The bounded probe eventually exited 134 after about 45 minutes. V8 reported
repeated mark-compacts at 2,031 MB followed by:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

It emitted no structured compile result. This is not a TS2307 resolver failure
and must not be folded back into #3654.

## PR #3687 merge-queue park resolution (2026-07-28)

The first merge-group build of PR #3687 (run `30355079783`, merge head
`242d5bd70d349709bcdcefc9d299b90d06394f3d`) exposed real regressions rather
than baseline drift. Against the then-current honest Test262 baseline, passes
fell from 30,120 to 29,831: 331 pass-to-non-pass transitions, 302 after
compile-timeout noise, versus 41 improvements (fine-gate net -261).
`null_deref` traps grew from 153 to 1,205. The baseline was only two
non-Test262 commits behind the merge-group parent, so changing the baseline or
masking the paths would have hidden compiler defects.

The failures came from six binding/frame families introduced or exposed by the
declaration-scoped ESLint work:

1. Function-identity recovery assumed every transformed identifier had a
   source file, compared reparsed source files by object identity, and treated
   ambient declarations as runtime bindings. That combination crashed
   synthetic nodes and blocked same-file Annex B/top-level variable recovery.
2. A named function expression's self-name was classified as an ordinary local
   shadow, so recursive calls left the registered function path and loaded an
   uninitialized local.
3. The inlined-IIFE `var` hoister preallocated numeric storage for a name also
   owned by an Annex B block function, making the function value impossible to
   store in the binding.
4. Same-file `var` redeclarations minted separate Wasm globals even though
   JavaScript defines one binding; initializers and reads consequently targeted
   different globals.
5. A top-level `var f = function (...) {}` binding was mistaken for a foreign
   local shadow of its own registered closure. Calls then used the generic
   padded-arity path, corrupting `arguments.length`.
6. Tagged-template calls prepended a captured local using the declaring
   frame's raw index. Lifted recursive bodies have a different frame, so the
   index could be out of range; the capture must be resolved by name in the
   current frame when necessary.

These are binding-identity fixes, not special cases for the failing Test262
files. Permanent reduced coverage in `tests/issue-3672.test.ts` now exercises
all six families plus the transformed top-level-`this` crash. A conflict-focused
standalone fixture also combines the tagged-template frame repair with #3753's
`lastIndexOf` NaN-position lowering, because both changes meet in
`string-ops.ts`. The exact `108c41ecf166b195741a6f2509539471868156b7`
current-main simulated merge passes all 21 tests in that issue suite, including
the two real esquery collision canaries.

For the final differential, the control is the successful merge-group artifact
from run `30394184030` at exact main
`89c947994d7a751c40b1539e5e797732cadc1946`: Test262
`63829c6d925e24a3f5f307b08754aaa1c412c6a6`, oracle v12/honest, WasmGC
JS-host target, proposals enabled, compiler pool 4, no path scope, IR-first
disabled, and the dynamic 72-shard partition (47,826 merged host rows). The PR
remains under the automation-applied `hold` while the guarded exact-head
candidate runs, so no result can enter the merge queue before the differential
and required checks are green. The exact-main #3769 Test262 merge-group run
`30396311352` succeeded by its intentional no-op path: its only incoming change
was the benchmark-sidebar generator, the detector skipped every shard and
report-upload step, and the run has no artifact. The earlier full artifact is
therefore retained as the honest JS-host control: the intervening #3768
compiler change is confined to standalone RegExp lowering, while #3769 is
workflow/config- and compiler-byte-disjoint. This avoids inventing provenance
for a nonexistent #3769 report.

## Investigation and implementation (2026-07-26)

The resolved graph mixes two kinds of source:

- 146 files / 1,734,946 source bytes are needed by the TypeScript Program;
- only 77 files / 853,579 source bytes are executable from `linter.js`.

The other 69 roots arrive through checker-visible JSDoc and declaration edges.
`analyzeMultiSource` correctly orders the executable import graph first, but
then preserved `compileMulti`'s historical behavior by appending every other
input root to `MultiTypedAST.sourceFiles`. `compileProject` therefore lowered
checker-only bodies too. The largest was Acorn's 230,947-byte distribution
file (36,695 AST nodes), which is not executable from the Linter entry.

When exact `projectResolutions` are present, those roots now remain in the
TypeScript Program for type queries but are excluded from codegen unless the
entry's executable import graph reaches them. Plain `compileMulti` retains its
existing all-input behavior.

`JS2WASM_PROFILE_COMPILE=1` now emits machine-readable
`__JS2_COMPILE_PROFILE__` records at these boundaries:

- project graph expansion and total;
- multi-source preprocessing, checker, pipeline, and optimization;
- codegen extern collection, prepasses, declarations, function bodies, IR
  overlay, finalization, and total;
- binary, WAT, and declaration/helper artifact emission.

Every record contains elapsed time, current RSS/heap fields, and Node's max-RSS
high-water mark. Phase records also include relevant source, diagnostic,
function, type, import, global, or output-byte counts.

The deterministic regression has four checker roots: the entry and runtime
dependency plus a JSDoc declaration and a checker-only JavaScript body carrying
the known fatal dynamic-destructuring shape. The Program sees all four; codegen
sees two; the Node JS-host binary executes and returns 42.

## Required investigation

- [x] Add phase timing and peak-memory telemetry around graph expansion, checker
      construction/diagnostics, reachability, declaration collection, function
      lowering, Wasm emission, and optimization.
- [x] Determine whether the compiler is making forward progress, repeating work,
      or expanding code that is unreachable from the direct Linter entry.
- [x] Record source/function counts entering each phase and identify the dominant
      files/functions.
- [x] Keep the probe in the WasmGC JS-host lane under Node. Standalone/WASI work is
      not required for the first ESLint rung.
- [x] Do not hide the problem by increasing the test timeout without a measured
      upper bound and a CI-safe regression budget.

## Acceptance criteria

- [x] A deterministic reduced fixture reproduces the dominant repeated-work or
      reachability failure if one exists.
- The direct real `linter.js` child probe remains within an explicit,
  measured CI-safe time and memory budget and emits a structured result.
- The result records the compile/validate split even if a later semantic
  blocker still prevents execution.
- The Tier 1 test fails clearly on timeout or abnormal child exit; it never
  treats missing output as an expected compiler diagnostic.
- Phase timing and peak-memory evidence are recorded here before the issue is
  closed.

## Handover status (2026-07-26)

Work is paused at the user's budget cutoff and is published as a draft PR. The
first proof remains deliberately in the WasmGC JavaScript-host lane under Node:
`node:*` dependencies are passed through as host imports (the permanent stress
test asserts `env.__node_path`) rather than being reimplemented for
standalone/WASI.

The resolved executable graph is now bounded to 137 codegen files (178 checker
files, 1,923,212 source bytes). The direct Linter entry compiles to a roughly
9.3 MiB binary in 688–747 seconds and emits a structured probe result, so the
original timeout/OOM blocker is resolved. Validation currently stops at:

```text
WebAssembly.Module(): Compiling function #4883:"__closure_2056" failed:
local.tee[0] expected type (ref null 819), found global.get of type f64
```

Closure `2056` maps to esquery 1.7.0's minified `nth-child` matcher:

```js
function(e,t,r){return P(e,t,r)&&m(e,t,C,r)}
```

Binary inspection proved that `P` dispatches correctly but the second call reads
numeric `$global$3` (the `ms` package's `m`) as a callable instead of calling
esquery's registered `$m` helper. The branch contains declaration-scoped
function/module-global identities, nested-function reservation, and a
scope-aware transformed-node lexical recovery. The latest scope-aware shadow
change passes the focused suites but its full ESLint run was intentionally
interrupted at about five minutes for this handover, so it is not yet proven to
change closure `2056`.

Verified before handover:

```text
109 passed, 3 skipped across the focused 10-file regression set
23 passed across #2930, #2931, and #3672 identity/live-binding tests
pnpm run typecheck: passed
pnpm run check:ir-fallbacks: passed
```

Next action:

```sh
pnpm vitest run tests/stress/eslint-tier1.test.ts --reporter=verbose
```

If closure `2056` is unchanged, add an opt-in diagnostic at
`compileIdentifierCall` for the esquery `m` identifier and record
`functionDeclKey`, `funcName`, `lexicalModuleGlobal`, checker declarations, and
the matching `funcSourceText` keys. Do not mark #1400 or this issue done until
the stress test validates, instantiates, and `Linter.verify("const x = 1;", {})`
returns `0`.
