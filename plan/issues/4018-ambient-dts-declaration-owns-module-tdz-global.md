---
horizon: s
id: 4018
title: "An ambient .d.ts declaration can win the module-TDZ lookup and abort the compile"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
assignee: ttraenkler/claude
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bug
area: compiler, codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 3672, 4001, 4019]
---

# #4018 — an ambient `.d.ts` declaration must not own a module TDZ global

## Problem

Compiling the ESLint `linter.js` graph aborted with a single hard codegen error:

```text
Codegen error: module TDZ global minimatch was observed before its value global
```

Thrown from `observeModuleBinding` in
`src/codegen/program-abi-global-planning.ts`. No binary was emitted.

This became reachable only after #4001: before that, the compile never got far
enough to hit it.

## Root cause

`ctx.tdzLetConstNames` is **graph-global** — `collectDeclarations` accumulates
into it across every source file. But `prepareModuleTdzGlobals(ctx, sourceFile)`
iterates that whole set while `registerModuleTdzGlobal` looks the owning
declaration up **by name**, scanning only the source file it is currently
visiting.

The structural-ABI sidecar keys its bindings by `ts.VariableDeclaration` **node
identity**. So when a package ships both an implementation and its `.d.ts`, the
same name is declared twice and the two sides can disagree about which node
owns the binding. Instrumented output from the real graph:

```text
[tdz] name=minimatch
      tdzDeclFile=minimatch@10.2.4/node_modules/minimatch/dist/esm/index.d.ts pos=4093
      valueObservedFor=minimatch@10.2.4/node_modules/minimatch/dist/esm/index.js@230
```

The **value** global was observed for the runtime declaration in `index.js`; the
**TDZ** global was attached to `export declare const minimatch` in `index.d.ts`.
That ambient node is skipped by `collectDeclarations`, so it never receives a
value global — and observing a TDZ global for a declaration with no value global
is exactly the invariant the sidecar exists to enforce. The invariant fired
correctly; the lookup that fed it was wrong.

Same defect class as #1282's ambient-function skip (commit `0ef5a422`, "skip
ambient function declarations inside a `.d.ts`"), on the variable side.

## Fix

`findRuntimeTopLevelDeclaration` replaces the two inline name searches in
`registerModuleTdzGlobal` and skips ambient declarations — both
`sourceFile.isDeclarationFile` and a `declare` modifier on the statement. The
predicate deliberately mirrors the ambient test used by `collectDeclarations` /
`statementListHasEagerClass`: **a declaration that cannot receive a value
observation must not receive a TDZ observation.**

When the ambient file is skipped the TDZ global is still allocated; the
observation simply lands later, when `prepareModuleTdzGlobals` runs for the
source file that actually owns the runtime declaration.

## Result

The real `minimatch` package now compiles end to end:

| | before | after |
| --- | --- | --- |
| `success` | false | **true** |
| binary | 0 bytes | **119,213 bytes** |
| hard errors | 1 (`TDZ … before its value global`) | 0 |

On the ESLint graph the TDZ abort is gone and the compile advances to the next
frontier (#4019, then two further blockers — see #4001's follow-up list).

Remaining on minimatch, tracked separately: the emitted module does not yet
*validate* — `Compiling function #78:"expand_" failed: array.len[0] expected
type arrayref, found local.get of type (ref null 2)`. That is a distinct codegen
type defect, not this one.

## Verification

`tests/issue-4018-ambient-tdz-and-type-cycles.test.ts`.

**The fixture is the real installed `minimatch` package, deliberately.** Four
synthesized approximations were tried first and **none reproduced the defect**:

1. a virtual `.d.ts` handed to `compileMulti` alongside a same-named `const`,
2. the same with a hoisted use-before-declaration (to defeat TDZ elision),
3. an on-disk package with `package.json` `types`/`main` pointing at both files,
4. minimatch's own shape — an exported arrow `const` self-referenced from
   another function body.

All four compiled clean on the **unfixed** base. Shipping one of them would
have been a vacuous test that passes for the wrong reason, so the test uses the
verified reproducer and skips (with a visible suffix) when minimatch is not
installed, following the existing `ESLINT_DEV_DEPENDENCY_SKIP` pattern.

Non-vacuity is confirmed directly: on the unfixed base the minimatch rung fails
with `expected [ Array(1) ] to deeply equal []` — the array being the TDZ error.

The test also asserts `success === true` and a non-empty binary, so it cannot
pass by merely aborting somewhere else before the TDZ error.
