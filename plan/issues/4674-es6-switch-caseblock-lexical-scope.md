---
id: 4674
title: "ES2015 standalone switch CaseBlock lexical scope and closure lifetime"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
assignee: codex/es6-switch-wave3b
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
goal: standalone-mode
es_edition: ES2015
related: [4444, 1805]
files:
  - src/codegen/statements/control-flow.ts
  - src/codegen/statements/shared.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/identifiers.ts
  - tests/issue-4674-switch-caseblock-lexical-scope.test.ts
loc-budget-allow:
  - src/codegen/statements/control-flow.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/statements/control-flow.ts::compileSwitchStatement
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# #4674 — ES2015 switch CaseBlock lexical scope and closure lifetime

## Problem

The ES2015 `switch` runtime creates one declarative environment for the whole
`CaseBlock`. The codegen currently emits the discriminant, case selectors, and
case bodies without activating a matching lexical scope. A `let`/`const`, class,
or statement-position function declared directly in a case therefore fails to
shadow an outer binding while the switch runs, and closures made by selectors or
case statements capture the wrong slot. The case binding also remains visible
after the switch in shapes where the enclosing scope has no same-named binding.

This is a bounded slice of umbrella #4444's approximately 23 residual switch
rows. Dynamic-eval `scope-var-none-*` rows remain owned by #2928, and the
placeholder `scope-lex-let.js` row has no CaseBlock declaration to lower; those
rows are not part of this issue.

## Reproduction on upstream/main

Base: `upstream/main` at `d407273bd` (2026-08-25). The authoritative local
original-harness runner (`runTest262File`, standalone target) reproduced:

| Test shape | Result | Observed failure |
| --- | --- | --- |
| `scope-lex-const.js` | fail | expected runtime `ReferenceError`, but `x` resolved after switch |
| `scope-lex-open-case.js` | fail | selector closure returned `"outside"`, expected `"inside"` |
| `scope-lex-open-dflt.js` | fail | default-body closure returned `"outside"`, expected `"inside"` |
| `scope-lex-close-case.js` | fail | first case closure returned `"outside"`, expected `"inside"` |
| `scope-lex-close-dflt.js` | fail | default closure returned `"outside"`, expected `"inside"` |
| `scope-lex-async-generator.js` | fail | expected runtime `ReferenceError`, but `x` resolved after switch |
| `cptn-dflt-final.js` | pass | control/fall-through known-good control |
| `cptn-a-fall-thru-nrml.js` | pass | control/fall-through known-good control |
| `S12.11_A1_T1.js` | pass | matching known-good control |
| `S12.11_A1_T3.js` | pass | matching known-good control |

The recent standalone result artifact independently showed the same family:
the 112-row switch slice had 12 failures, with the non-eval failures confined to
`scope-lex-*`; ordinary matching/fall-through rows passed.

## Implementation plan

1. Collect direct CaseBlock `let`/`const` (and resource) names without
   descending into nested blocks. Preserve the function-body pre-hoist slot when
   it already belongs to the CaseBlock; hide and freshly allocate only a real
   same-named outer binding.
2. After evaluating the discriminant and before evaluating case selectors,
   save any outer same-name codegen bindings, pre-allocate missing CaseBlock
   names with TDZ flags, and activate those locals for selector/body emission.
   This preserves the spec's selector-vs-discriminant environment boundary and
   lets closures capture the shared CaseBlock slot.
3. At switch exit, remove the temporary CaseBlock locals/TDZ metadata and restore
   the saved outer binding metadata. Keep the change in the shared scope helper
   so `localMap`, TDZ, const-write, null-guard, boxed-capture, and direct-eval
   state cannot drift independently.
4. Keep top-level bare references to direct CaseBlock lexical names in module
   initialization and force an outside reference to class, generator, or async
   function CaseBlock declarations through the ReferenceError path instead of a
   flat function/class registry entry.
5. Add focused standalone tests for open/close case/default captures, fresh
   function-local shadows, and non-leaking `const`/`let` bindings. Verify the
   standalone module remains host-import free.
6. Re-run the focused suite and a 10-path switch before/after comparison on the
   same base/candidate tree. Record every transition and require zero
   pass-to-nonpass transitions.

## Acceptance criteria

- [x] Case selectors evaluate in the CaseBlock environment; the discriminant
      still evaluates in the enclosing environment.
- [x] Case/default closures observe the shared lexical slot, including fallthrough.
- [x] Direct CaseBlock lexical names are unavailable after the switch when no
      outer binding exists (runtime `ReferenceError`).
- [x] Focused standalone tests pass with no standalone host imports.
- [x] Same-base representative comparison records before/after counts and zero
      pass-to-nonpass transitions.
- [x] Typecheck, issue integrity, and budget gates pass with the allowances
      granted in this issue's frontmatter.

## Results

Implementation is complete on base `upstream/main` at `d407273bd` (2026-08-25).
The authoritative local original-harness runner (`runTest262File`, standalone
target) used the same 10 paths in `.tmp/switch-repro-paths.txt` before and after:

| Candidate | pass | fail | pass→nonpass | fail→pass |
| --- | ---: | ---: | ---: | ---: |
| upstream/main baseline (`.tmp/switch-runner-before.json`) | 4 | 6 | — | — |
| CaseBlock fix (`.tmp/switch-runner-after.json`) | 10 | 0 | 0 | 6 |

The six fixed rows are `scope-lex-const.js`, `scope-lex-open-case.js`,
`scope-lex-open-dflt.js`, `scope-lex-close-case.js`,
`scope-lex-close-dflt.js`, and `scope-lex-async-generator.js`. The additional
direct lexical spot check also passes `scope-lex-async-function.js`,
`scope-lex-generator.js`, and `scope-lex-class.js`; the placeholder
`scope-lex-let.js` remains outside this issue because it declares no lexical
name in its CaseBlock. The two `scope-var-none-*` rows remain dynamic-eval
failures owned by #2928.

Focused regression test:

```text
node node_modules/vitest/dist/cli.js run tests/issue-4674-switch-caseblock-lexical-scope.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
  1 file, 6 tests passed
```

The standalone runner reports all 10 representative controls and targets as
passing after the change, with no host-import link failures. Prettier check and
TypeScript typecheck pass. `check:loc-budget` and `check:func-budget` pass using
the three path/function allowances declared above; the allowances cover the
intentional additions to the existing god-files and are not baseline edits.
