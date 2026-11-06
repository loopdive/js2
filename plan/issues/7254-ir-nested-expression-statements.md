---
id: 7254
title: "IR: nested expression statements refused as `body-exprstmt-other` — measure the hidden value refusals"
status: in-progress
sprint: current
created: 2026-11-05
updated: 2026-11-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [5163, 7106, 7240]
assignee: "ttraenkler/c-lead"
# 2026-11-05: +~20 lines in select.ts — the catch-all attribution must sit with
# `shapeNo` / `probeShape`, whose first-wins detail state is module-private there.
loc-budget-allow:
  - src/ir/select.ts
---

# #7254: `body-exprstmt-other` hides the value refusal behind it

## Problem

`ir_only_pass` (standalone test262 passes with zero legacy units) is flat at
1088 / 48232. A blocked-by-one census (wrapped ledger, stride 40, standalone,
2026-11-05) found 9 files whose only blocker is `body-exprstmt-other`
(`src/ir/select.ts`, the catch-all of `isPhase1BodyStatement`): an expression
statement inside a nested body that no statement arm admits. The working
hypothesis was that these are shapes with an IR value lowering that only lack
the statement (discard) form, so they could be admitted next to #5163.

## Measurement (2026-11-05, before any code change)

Wrapped compile of every stride-40 test262 file, standalone, through
`measureSource` from `scripts/ir-claim-ledger.mts` with
`JS2WASM_IR_SHAPE_DIAG=1`, at `origin/main` e73e190c6c. The row is the unit's
first refusal. To see what the discard probe refused, `probeShape` was
temporarily patched to expose the inner detail (scratch only, not committed).

15 rows in 15 files, all in `<module-init>` (nested in `try` / block bodies of
the script). 13 of the 15 files have no other unsupported unit (one of them,
`intl402/.../toString-removed-tag.js`, does not compile on standalone).

| Statement shape | Rows | Example | Inner (value) refusal | Value lowering in IR? |
| --- | ---: | --- | --- | --- |
| IIFE `(function () { … }())` | 5 | `annexB/language/function-code/switch-case-func-skip-early-err.js` | silent `return false` — call with a non-identifier callee (`select.ts`, the call arm) | none |
| tagged-template IIFE `(function (p) { … })\`\`` | 1 | `language/expressions/tagged-template/template-object-frozen-strict.js` | `expr-unhandled:TaggedTemplateExpression` | none |
| `new` as a statement | 4 | `built-ins/RegExp/valid-flags-y.js` | `expr-new-regexp-target` (host-free standalone), `expr-new-extern-host-free` (`new Promise`), `expr-new-ctor-unknown` (`new Integer`), `expr-new-callee-nonident` (`new 1`) | refused in value position too |
| `delete` member | 2 | `built-ins/.../let-ary-init-iter-get-err-array-prototype.js` (`delete Array.prototype[Symbol.iterator]`) | `expr-delete-no-ir-lowering` (only the dynamic-parameter receiver of #7106 lowers) | none (keep refused, #2949) |
| `in` on a primitive | 1 | `language/expressions/in/S11.8.7_A3.js` (`"toString" in true`) | `expr-binary-op-in` | refused in value position too |
| `typeof await e` in a module | 1 | `language/module-code/top-level-await/syntax/typeof-await-expr-null.js` | `expr-await-outside-async` | refused in value position too |
| bare identifier / member read, `void`, comma | 0 | — | — | already admitted by #4459 |

### Finding

**No row is a statement-position gap.** The #4459 discard arm already re-tests
every such statement as a value through `isPhase1Expr`; each of the 15 rows is
there because the VALUE lowering is refused. Admitting a "discard form" would
need the value lowering first, which this slice's own rules exclude (a refused
value lowering stays refused; `delete` on a non-parameter receiver stays
refused, #2949). So the expected flip of 9 files is not available here.

The largest real bucket is the IIFE (6 of 15 rows, 5 sole-blocker files): it
needs a Phase-1 lowering of a call whose callee is a function expression
(closure creation, captures of module storage, `arguments`, Annex B
function-in-block hoisting in the body). That is a feature, not an `s` slice,
and is left for its own issue.

## What this issue ships

A diagnostics-only change, so the next census attributes these rows to the
missing value lowering:

- Under `JS2WASM_IR_SHAPE_DIAG=1`, the expression-statement catch-all labels
  (`body-exprstmt-other`, and the top-level `nontail-*` catch-alls) carry the
  declined probe's first-refusal arm, e.g.
  `body-exprstmt-other(expr-binary-op-in)`; a `delete` reads
  `body-exprstmt-other(expr-delete-no-ir-lowering)`.
- The silent refusal of a non-identifier callee now records
  `expr-call-callee-nonident`.
- Without the variable nothing changes: `shapeNo` records only under
  SHAPE_DIAG, the probe still restores detail and typed reason, and no claim
  decision reads the new state.

## Evidence (2026-11-06)

Wrapped stride-40 A/B, standalone, SHAPE_DIAG on, base e73e190c6c vs head,
per-file through `measureSource` (1340 stride paths, 1296 compiled, 44 skipped
by `shouldSkip`):

| | base | head |
| --- | ---: | ---: |
| compileOk / threw | 1117 / 0 | 1117 / 0 |
| units / invariants | 14433 / 0 | 14433 / 0 |
| units with a legacy body (legacy + both) | 13297 | 13297 |
| files whose route, select reasons or compileOk differ | — | 0 |
| bare `body-exprstmt-other` rows | 15 | 0 (all 15 qualified) |
| total detail rows | 4774 | 4774 |

Detail rows that moved (diagnostics only): the 15 catch-all rows gain their
inner arm (table above); 31 more rows now read `expr-call-callee-nonident`
instead of an outer label — `vardecl-init-expr` 28 → 3, `unattributed-arm`
23 → 18, `closure-body` 2 → 1. Those are IIFEs in initializers
(`var it = function* () { … }();`), `import(…)` calls and
`f.bind(null)()`. So the non-identifier callee is a 37-row first refusal on
the stride, the biggest single item this attribution uncovers.

Files with no legacy-only unit (compiled OK): 25 → 25 (no claim decision changes by design; the 13
sole-blocker files stay on legacy `<module-init>`).

## Sole-blocker census for the step-2 admission (2026-11-06)

Same wrapped stride-40 corpus, standalone, SHAPE_DIAG on, at this branch after
merging `origin/main` (2026-11-06). Per file: the units emitted ONLY by legacy
(`legacyBodyEmitted && !irBodyEmitted`, the ledger's "no legacy-only unit"
definition). 1340 paths, 44 skipped, 1118 compiled OK, 0 invariants,
**25 zero-legacy files** (matches the evidence above). 516 files have exactly
one legacy-only unit; their first refusal, restricted to the shapes in scope:

| Only blocker | Files | Paths (under `test262/test/`) |
| --- | ---: | --- |
| plain IIFE statement | 5 | `annexB/language/function-code/{if-decl-no-else-func-skip-early-err-try,block-decl-func-skip-early-err-try,if-decl-else-decl-b-func-skip-early-err-for,switch-case-func-skip-early-err}.js`, `built-ins/ArrayIteratorPrototype/next/args-unmapped-iteration.js` |
| plain IIFE initializer | 3 | `built-ins/Object/create/15.2.3.5-4-94.js`, `language/function-code/S10.4.3_A1.js`, `language/statements/function/S13.2.1_A1_T1.js` |
| generator IIFE (`function* () {…}()`) | 7 | out of scope (generator lane) |
| tagged-template IIFE | 1 | `language/expressions/tagged-template/template-object-frozen-strict.js` (`expr-unhandled`) |
| `delete` statement | 1 | `language/statements/for/dstr/let-ary-init-iter-get-err-array-prototype.js` (stays refused, #2949) |
| bare member-read statement | 0 | already admitted (#4459) |
| `f.bind(…)()` | 0 | — |

The census counts the unit's FIRST refusal, so an admitted IIFE can still
reveal a later one in the same unit; 8 is an upper bound for the plain IIFE.

### Why no IIFE is admitted (the chain)

A test262 file is unannotated JS, so a closure literal reaches the IR only
through a source plan (`src/codegen/function-member-closure-planning.ts`,
#7195 / #7198 / #7130): without one, `closureLiteralIsBuildable` refuses with
`closure-return-type` (no annotation). Two things are missing for an IIFE:

1. **No callee site.** The plan sites are `member-assignment`,
   `call-argument` (two shapes) and `script-var`; a FunctionExpression in
   callee position has none, and the selector's call arm refuses any
   non-identifier callee (`expr-call-callee-nonident`).
2. **The body proof refuses every candidate.** Even with an `iife` site, the
   shared open-body proof (`openBodyKey`) and the plan's result rules decline
   all 8 files:

| File | What its IIFE body needs | Plan rule that refuses it |
| --- | --- | --- |
| 3 annexB `*-func-skip-early-err-*` | nested `function() { f; }` passed to `assert.throws`, Annex B block function | `ts.isFunctionLike` in the body |
| annexB `switch-case-func-skip-early-err` | function declaration in `switch`, writes script vars `init` / `after` | nested function; script-level binding (`moduleGlobals` off) |
| `args-unmapped-iteration`, `15.2.3.5-4-94` | `arguments` | `arguments` identifier |
| `S10.4.3_A1` | `return this` (an object result) | `this` with a non-void, non-string result |
| `S13.2.1_A1_T1` | 32 nested IIFEs | nested function |

So every candidate needs new machinery — nested closure captures, an
`arguments` object, a non-string `this` result, or script-var writes from a
closure — on top of a new callee site and a selector + `from-ast` arm
(`lowerClosureExpression` → `lowerClosureCall`). That is a feature, not this
`s` slice. Per the brief, step 2 stops here; the diagnostics change ships.

## What is left

- The IIFE lowering above (callee site + nested-capture / `arguments` /
  `this`-result support), measured against these 8 files. Not filed yet.

## Acceptance

- Wrapped stride A/B (SHAPE_DIAG): every `body-exprstmt-other` row carries an
  inner arm; route, compileOk and invariant counts identical.
- Claim outcomes and binaries identical with and without SHAPE_DIAG
  (`tests/issue-7254-exprstmt-refusal-attribution.test.ts`).
