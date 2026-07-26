---
id: 3658
title: "ESLint linter.js: keep checker-only roots out of bounded codegen"
status: in_progress
created: 2026-07-26
updated: 2026-07-26
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
---

# #3658 — Bound full codegen for the resolved ESLint Linter graph

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
23 passed across #2930, #2931, and #3658 identity/live-binding tests
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
