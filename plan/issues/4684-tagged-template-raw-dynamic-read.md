---
id: 4684
title: "Standalone tagged-template calls to inline function expressions are dropped"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
feasibility: medium
horizon: s
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: tagged-templates
goal: test262-conformance
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/object-runtime.ts
  - src/codegen/string-ops.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #4684 — standalone tagged-template calls to inline function expressions are dropped

## Scope and measured baseline

The supplied standalone baseline artifact
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
contains 57 rows under `test/language/expressions/template-literal/`: 43
passes and 14 assertion failures. Thirteen of those failures form a coherent
`tv-*` family. They use an inline function expression as the tag and invoke it
as a tagged template; the remaining `evaluation-order.js` failure is a
separate closure/evaluation-order defect and is intentionally out of scope.
The target family was therefore 0/13 before this change and is 13/13 after it.

The diagnosis is based on minimal probes compiled from the clean current-main
checkout. The counter-only probe
`/private/tmp/issue4684-tag-counter.js` (clean-main SHA
`e4f7703b16c8`) reports `calls === 0`. The cooked-only and raw-only probes
(`/private/tmp/issue4684-tag-cooked.js` and
`/private/tmp/issue4684-tag-raw.js`, clean-main SHA `7902879cac69`) fail with
the same result before either property read can execute. Thus the callback is
not invoked; the earlier hypothesis about `.raw` dispatch was unsupported.

The 13 artifact rows are the before-count source of truth. Each must also be
reproduced and counted with the authoritative `runTest262File(file,
'standalone')` runner after the call-lowering fix.

## Root cause

Two adjacent lowering gates drop the effect. First, the module-init collector's
expression allow-list records ordinary calls but intentionally excluded tagged
templates, so a discarded top-level tagged statement never reached codegen.
Second, once that statement is retained, `compileTaggedTemplateExpression`
emits the inline closure call but returns `null` for a void tag. The
transactional `compileExpression` wrapper interprets that `null` as “no usable
value”, rolls back the emitted template construction and call, and substitutes
its default. The clean-main counter probe therefore remains at zero, before any
`.raw` or cooked-segment read can execute. The fix retains the effectful
top-level tag and propagates the existing `VOID_RESULT` sentinel for void tag
calls so the call-lowering transaction preserves the side effect. The same
inline JavaScript callbacks type their `strings` parameter as `any`; the
existing `.raw` property arm only recognized statically vector-shaped receivers,
so it also needs to guard and downcast a dynamic template vector before the
callback's raw-segment assertions can pass.

## Implementation plan

1. Extend module-init collection/classification to retain top-level tagged
   template statements as effectful calls. Return `VOID_RESULT` from the
   existing `compileTaggedTemplateExpression` void-call paths so
   `compileExpression` preserves the emitted inline closure call when the
   result is discarded, while retaining template construction, substitutions,
   and evaluation order.
2. Let the standalone property dispatcher recognize a dynamic (`any`/`unknown`)
   template-string receiver for `.raw`, using the existing `ref.test` guard so
   ordinary dynamic properties remain unchanged. Normalize CR and CRLF source
   line endings to LF while constructing the raw segment vector, as required by
   the template literal TRV.
3. Add focused regression coverage for inline tagged calls, including a
   counter-only callback and cooked/raw segment reads. Keep named-tag and
   ordinary call/property controls to demonstrate zero loss.
4. Run every one of the 13 artifact `tv-*` rows through the authoritative
   standalone runner, record exact before/after counts and zero-loss evidence,
   and run formatting, lint/type checks, and scoped regression tests.

## Acceptance criteria

- All 13 in-scope `tv-*` rows pass with `runTest262File(..., 'standalone')`.
- `evaluation-order.js` remains explicitly tracked as the separate residual;
  this issue does not claim it as fixed.
- Inline tagged calls execute their callbacks whether or not the result is
  consumed, and cooked/raw tagged-template reads plus ordinary calls retain
  their existing behavior.
- The issue records the exact artifact baseline, exact runner results, scoped
  checks, commit, and PR evidence.

## Test Results

### Authoritative Test262 rows

The baseline artifact is 43/57 passing, with 14 assertion failures. The
coherent target is the following 13 rows (13/13 after the fix):

```
tv-template-middle.js
tv-no-substitution.js
tv-template-tail.js
tv-template-characters.js
tv-character-escape-sequence.js
tv-line-terminator-sequence.js
tv-template-character.js
tv-hex-escape-sequence.js
tv-line-continuation.js
tv-utf16-escape-sequence.js
tv-zwnbsp.js
tv-null-character-escape-sequence.js
tv-template-head.js
```

Each row was run by the authoritative absolute-path
`runTest262File(file, "issue-4684", 60000, "standalone")` invocation. The
after result is 13 pass, 0 fail, with result hashes:

```
tv-template-middle.js                  9725c0ca584e
tv-no-substitution.js                  82542f354415
tv-template-tail.js                    c7ad773107d7
tv-template-characters.js              28057fb5a7a3
tv-character-escape-sequence.js        1f17735c1e5b
tv-line-terminator-sequence.js         b3eb4c05553e
tv-template-character.js               f6601165540d
tv-hex-escape-sequence.js              2e8337b7998c
tv-line-continuation.js                cc397fdf3be6
tv-utf16-escape-sequence.js             a045317972bc
tv-zwnbsp.js                            d44590abf76e
tv-null-character-escape-sequence.js    9a93cda4a0de
tv-template-head.js                    552e4679387f
```

The full 57-row directory run observed 53/57 pass and 4 fail. The one
source-level residual is the out-of-scope `evaluation-order.js` CompileError.
The other three failures are the baseline-passing
`invalid-legacy-octal-escape-sequence{,-8,-9}.js` controls, which require a
QuickJS provider artifact absent from this isolated worktree; they fail before
test execution with the harness's explicit missing-provider error. All 40
other baseline-passing controls remained green, so no runnable pre-existing
pass was lost.

### Focused and minimal probes

The focused Vitest regression in
`tests/issue-4684-tagged-template.test.ts` passes 1/1. It observes both the
discarded inline tag invocation and cooked/raw segment reads, while an ordinary
call in the same module remains observable. The clean-main minimal probes
establish the before behavior (`counter: 0`, cooked/raw: undefined); the same
probes pass after the fix.

## Implementation and handoff

The implementation changes are in `declarations.ts`,
`module-init-collection.ts`, `string-ops.ts`, and `object-runtime.ts`. The
source changes retain effectful tagged-template statements, preserve void tag
calls with `VOID_RESULT`, dispatch dynamic `.raw` reads to template vectors,
and normalize CR/CRLF in raw segments to LF. The commit, scoped gate results,
and upstream PR URL are recorded in the handoff message for this change.

The merge-queue QuickJS provider exposed one synchronous-runner interaction:
top-level-await fixtures are parsed as a tagged template whose identifier tag
is `await`. The collector now excludes only that recovery shape while retaining
all genuine tagged calls. The classifier and focused regression suite pass
49/49; the exact provider build requires the CI image's clang-18 and CMake
toolchain, which is not installed in the local worktree environment.
