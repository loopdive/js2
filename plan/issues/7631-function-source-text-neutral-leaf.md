---
id: 7631
title: "Move the CreateDynamicFunction source-text leaf out of src/interp into src/shared/contracts"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
goal: ir-full-coverage
related: [7487]
---

# #7631: a neutral leaf for the CreateDynamicFunction source text

## Problem

`src/interp/function-source-text.ts` holds two pure functions:

- `functionSourceText(name, params, body)`, which assembles the §20.2.1.1.1 text;
- `fitsFunctionSourceText(...)`, the separate-goal span check.

PR #7441 introduced the file and #7487 (PR #7556) extended its use. Its importers sit outside the interpreter:

- `src/codegen/expressions/eval-inline.ts` (the legacy literal-`Function` fold);
- `src/ir/literal-dynamic-code.ts` (the Prepared function kind);
- the interpreter's own `src/interp/dynamic-function.ts`.

So codegen and IR import from `src/interp`. The file stays there only because the runtime-eval provider build
concatenates the interpreter sources. Its boundary entry already says so: `unmigrated / mixed-needs-split`, destination
`foundation`, "becomes a foundation module once the runtime-eval provider build stops concatenating src/interp".
The lead asked for this follow-up on 2026-11-26.

## Implementation Plan

**Module.**
- `git mv src/interp/function-source-text.ts src/shared/contracts/function-source-text.ts`, a move only. The file
  imports nothing and uses no `ts`.
- Its entry in `scripts/compiler-boundaries.json` becomes `{ "state": "clean", "layer": "foundation" }`, the same
  as its sibling pure helpers in `src/shared/contracts/` (for example `string-surrogate.ts`). `foundation`'s root
  is `src/shared/contracts`.

**Importers.** Four import specifiers change, and nothing else:
- `src/interp/dynamic-function.ts`;
- `src/codegen/expressions/eval-inline.ts`;
- `src/ir/literal-dynamic-code.ts`;
- the two tests `tests/issue-7487-function-source-text.test.ts` and `tests/issue-7487-prepared-literal-function.test.ts`.

**The provider build still concatenates it.** `INTERP_FILES` in `scripts/runtime-eval-provider.mjs` lists files
relative to `src/interp`, and `tests/issue-2928.test.ts` imports the same list. Its entry becomes
`"../shared/contracts/function-source-text.ts"`, still ahead of `dynamic-function.ts`. The file is import-free, so
`stripModuleSyntax` behaves as before, and the concatenated provider source holds the same function text in the same
position. The comment on `INTERP_FILES` says the list may name an import-free shared leaf outside `src/interp`.

**Reuse / duplicate removed.** Nothing new. This removes the codegen → interp and IR → interp import edges for this
helper.

**Layer edges.** None added. Every layer may import `foundation`
(`allowedEdges`). The edges `interp → foundation`, `codegen → foundation` and `ir → foundation` replace
`codegen → interp` and `ir → interp`. `check:import-cycles` and both boundary inventories (`--base HEAD^1`,
`--base origin/main`) must stay green.

**Byte identity.** The change is a pure move, so compiled output cannot change:
- gc, standalone and Prepared bytes are compared on the 20-program literal-`Function` corpus from PR #7441, plus
  the 11-program #7487 corpus (file-copy A/B);
- the runtime-eval provider source string is compared before and after (`buildRuntimeEvalProviderSource()`), and it
  must be identical.

## Acceptance

- The leaf lives at `src/shared/contracts/function-source-text.ts`, classified `clean/foundation`. No `src/codegen`
  or `src/ir` file imports from `src/interp/function-source-text`.
- The provider source string is byte-identical, and the provider builds from source with its canaries verified.
- `tests/issue-7487-*`, `tests/issue-2928*` and the #7363 tests pass unchanged, apart from the import paths.
- All gates are green, including `LOC_GATE_BASE=origin/main`, both boundary inventories and `check:import-cycles`.
- Code quality: a move only, with no new code, no wrapper and no re-export shim left in `src/interp`.
