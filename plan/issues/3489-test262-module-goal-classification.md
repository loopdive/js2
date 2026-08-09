---
id: 3489
title: "Test262 module-goal classification must ignore import/export text in comments and strings"
status: done
sprint: 73
completed: 2026-07-20
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: test262-runner
goal: test262-conformance
lane: A
related: [3370, 3419, 3427, 3473]
files:
  - scripts/test262-module-goal.mjs
  - scripts/precompile-tests.ts
  - tests/test262-runner.ts
  - tests/issue-3489-test262-module-goal.test.ts
---

# #3489 — Test262 module-goal classification must ignore import/export text in comments and strings

## Problem

The project Test262 runner and precompiler infer module goal with a raw-text
regular expression:

```ts
/\b(?:import|export)\b/.test(source);
```

That expression cannot distinguish JavaScript syntax from metadata, comments,
or string literals. It misclassifies these Script tests as Modules because
their descriptions or assertion messages contain the phrase "does not import
own property":

- `built-ins/TypedArray/prototype/slice/result-does-not-copy-ordinary-properties.js`
- `built-ins/TypedArray/prototype/subarray/result-does-not-copy-ordinary-properties.js`

The literal Test262 assembly includes two legal Script-level declarations named
`isPrimitive` (`assert.js` and `testTypedArray.js`). Script semantics are
last-declaration-wins, implemented by #3419. Once the runner incorrectly sets
`inferModuleStrictArguments=true`, those declarations are checked as Module
lexical declarations and compilation fails with `Duplicate identifier
'isPrimitive'`.

The project runner currently hides the classifier defect through #3427's
source-level declaration de-duplication. That makes its pass result silent and
non-equivalent: the literal assembly compiles under Script semantics while the
project classifier incorrectly requests Module strict-arguments semantics.

During the original investigation, an unmerged #3473 FYI parity branch also
carried the raw heuristic and exposed the failure directly. The adopted #3473
commit removed that FYI heuristic independently; #3489 fixes the still-latent
project-runner/precompiler classifier rather than adding a new FYI callsite.

## Evidence (2026-07-20)

- A path-exact current-main rerun covered all 3,472 standalone rows that passed
  the project baseline but failed the older FYI report.
- Every sampled async/module-init/stale singleton failure passed on current
  main. The two paths above remained the only persistent failures.
- For both assembled sources, the raw regex matches only text in Test262
  metadata or an assertion message; neither source contains static module
  syntax and neither test carries the `module` flag.
- Compiler Script-level duplicate-function semantics already pass the #3419
  controls. A new compiler semantics workaround is not required.

## Acceptance criteria

- Centralize module-goal classification so the project runner and precompiler
  use one definition.
- Test262 metadata/path categories that explicitly require Module goal remain
  authoritative, including `flags: [module]` tests without static imports or
  exports.
- Syntactic detection, when needed, uses the parser/AST and ignores keywords in
  comments, metadata, regexes, identifiers, and string/template literal text.
- Dynamic `import()` alone does not turn a Script into a Module; static
  `import`/`export` and `import.meta` are classified per JavaScript semantics.
- The two exact TypedArray paths are classified as Script, and their literal
  assemblies compile in both `gc` and `standalone` without deleting, renaming,
  or de-duplicating harness/test declarations.
- Existing positive and negative Module-goal Test262 controls keep their
  current classifications and verdicts.
- Add focused regression tests in `tests/issue-3489-test262-module-goal.test.ts`.

## Validation

- Run the focused module-goal classifier tests.
- Run both exact TypedArray paths through `scripts/run-test262-fyi.mjs` for
  `--target gc` and `--target standalone`.
- Run representative `flags: [module]`, static import/export, `import.meta`,
  dynamic import, comment-only, and string-only classification controls.

## Implementation findings (2026-07-20)

- Added `scripts/test262-module-goal.mjs` as the shared classifier. Test262
  `module` metadata and the `language/module-code`, `language/import`, and
  `language/export` path categories win first. All other sources use
  TypeScript's parsed external-module AST signal.
- The AST signal recognizes static imports, every export form, and
  `import.meta`, but not dynamic `import()`. It also ignores keywords in
  Test262 metadata, comments, regexes, identifiers, strings, and template
  literal text.
- `tests/test262-runner.ts` now imports and re-exports the shared classifier;
  `scripts/precompile-tests.ts` imports the same helper directly. The runner
  computes the result once per source and reuses it for strict-arguments and
  deferred-init options.
- Both exact test262.fyi assemblies retain both literal
  `function isPrimitive` declarations. With the helper's Script result, their
  primary and strict variants compile successfully in both `gc` and
  `standalone`; no harness declarations are deleted, renamed, or de-duplicated.

## FYI sequencing result

The adopted #3473 plumbing removed its temporary raw-text FYI heuristic
instead of creating another classifier consumer. No FYI callsite is added by
#3489. On the adopted #3473 commit (`c955`), a Node 25 path-exact rerun confirms
both non-BigInt slice/subarray records pass in `gc` and `standalone` (4/4).

## Validation results (2026-07-20)

- `tests/issue-3489-test262-module-goal.test.ts`: 7/7 pass, including the
  forced-Module duplicate-identifier reproduction and all 8
  literal assembly compile combinations (2 paths × primary/strict ×
  gc/standalone).
- Existing #3419, #3427, #1527, #990, and #2119 module-strictness controls:
  24/24 pass.
- `pnpm run typecheck`: pass.
- Adopted-#3473 Node 25 FYI CLI: both exact paths pass in `gc` and `standalone`
  (4/4); the FYI runner contains no module-goal heuristic or callsite.
