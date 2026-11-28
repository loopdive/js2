---
id: 7631
title: "Move the CreateDynamicFunction source-text leaf out of src/interp into src/shared/contracts"
status: done
completed: 2026-11-28
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

The file's docblock is reworded to say it is listed in `INTERP_FILES` and must stay import-free. That is the only
text change in the file.

**The provider build still concatenates it.** `INTERP_FILES` in `scripts/runtime-eval-provider.mjs` lists files
relative to `src/interp`, and `tests/issue-2928.test.ts` imports the same list. Its entry becomes
`"../shared/contracts/function-source-text.ts"`, still ahead of `dynamic-function.ts`. The file is import-free, so
`stripModuleSyntax` behaves as before, and the concatenated provider source holds the same function text in the same
position. The two stacked JSDoc lines on `INTERP_FILES` fold into one comment: the list may name an import-free shared
leaf outside `src/interp`, and it is shared by `tests/issue-2928.test.ts` and `tests/interp/runtime-function-link-probe.mjs`.

**The runtime-link probe (review blocker).** `tests/interp/runtime-function-link-probe.mjs` kept a private copy of
`INTERP_FILES` and `stripModuleSyntax`, without `function-source-text.ts`, so it could drift from the real build. The probe now
imports both from `scripts/runtime-eval-provider.mjs`, as `tests/issue-2928.test.ts` does. `EMITTER_ONLY_FILES` stays,
because it is a different list. The probe reads `resolve("src/interp", name)`, so the `../shared/contracts/` entry
resolves there too.

**Boundaries.** The `moves` array in `scripts/compiler-boundaries.json` records
`src/interp/function-source-text.ts → src/shared/contracts/function-source-text.ts`.

**Reuse / duplicate removed.** Nothing new. This removes the codegen → interp and IR → interp import edges for this
helper.

**Layer edges.** None added. Every layer may import `foundation`
(`allowedEdges`). The edges `interp → foundation`, `codegen → foundation` and `ir → foundation` replace
`codegen → interp` and `ir → interp`. `check:import-cycles` and both boundary inventories (`--base HEAD^1`,
`--base origin/main`) must stay green.

**Byte identity.** The change is a pure move, so compiled output cannot change:
- gc, standalone and Prepared bytes are compared on the 20-program literal-`Function` corpus from PR #7441, plus
  the 11-program #7487 corpus (file-copy A/B);
- the runtime-eval provider source string is compared before and after (`buildRuntimeEvalProviderSource()`). It
  differs only in the reworded docblock, so the provider cache key changes once.

## Acceptance

- The leaf lives at `src/shared/contracts/function-source-text.ts`, classified `clean/foundation`. No `src/codegen`
  or `src/ir` file imports from `src/interp/function-source-text`.
- The provider source string differs only in the docblock comment, and the provider builds from source with its
  canaries verified.
- `grep -rn interp/function-source-text src scripts tests` finds only the `moves.from` entry. No re-export shim is left
  at the old path or at the top level.
- `tests/issue-2928-runtime-link.test.ts`: the provider-only case passes, and the provider builds under both the old and
  the new probe (2,930,895 and 2,924,123 bytes, no errors). The closure case was already red on main 234cf440, for a
  reason unrelated to this move: the probe's *user* module fails to compile with "prepared function-value target …
  could not allocate its exact singleton support" (`src/codegen/ir-imported-call-planning.ts`), and the probe then
  reports "BufferSource argument is empty" on that empty binary. It stays red here and is routed separately.
- `tests/issue-7487-*`, `tests/issue-2928*` and the #7363 tests pass unchanged, apart from the import paths.
- All gates are green, including `LOC_GATE_BASE=origin/main`, both boundary inventories and `check:import-cycles`.
- Code quality: a move only, with no new code, no wrapper and no re-export shim left in `src/interp`.
