---
id: 6843
title: "standalone: stylelint's `import { isDynamicPattern } from 'globby'` leaks as host import env.isDynamicPattern"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, standalone, module-resolution
goal: standalone
requested_by: ttraenkler/wave9-6288-refresh
related: [6742, 2961]
---

# #6843 — stylelint: `isDynamicPattern` from globby becomes a host import

## Problem

The npm-compat `stylelint` `standalone-dynamic` lane fails in codegen, before
wasm-opt runs:

```
Host import leak (warning, #2961): host import "env.isDynamicPattern" survives into the
finished --target standalone binary and would fail instantiation in a runtime with no JS host
```

This was measured on 2026-10-05 on the #6742 refresh branch (main `b6324ee6d1`
plus #6742), in-process with no budget. Codegen took 867 s wall at load
80–390. On main, the lane's record only says
`exceeded the 120000ms harness budget (compile-budget)`. With #6742's phase
marker, that overrun now reads `during codegen`.

Source: `stylelint/lib/printConfig.mjs` L3,
`import { isDynamicPattern } from 'globby';`, called at L32.

The leaked name is a **named ES import** that ends up as an `env.*` import.
That suggests the `globby` specifier did not resolve inside the project graph,
so the binding fell through to a free-global host import.

Locally, `node_modules/stylelint` is a symlink into another worktree's pnpm
store. `globby@16.2.2` exists in this checkout's `.pnpm` store but is not
hoisted. Confirm the leak in a clean install, the way CI's npm-compat job
installs, before you treat it as a compiler bug.

## Implementation Plan

1. Reproduce in a clean install:
   `npx tsx scripts/generate-npm-compat-report.mjs --only stylelint --no-write --perf-only --lane standalone-dynamic --inspect-imports`.
   Check that `env.isDynamicPattern` is listed.
2. If it reproduces, find out why `compileProject` does not resolve `globby`
   from `stylelint/lib/printConfig.mjs`. Inspect the resolved module graph
   (`--inspect-ir` / the project-graph module list). globby 16 is ESM-only,
   with `exports` conditions; check the conditions the resolver passes.
3. Whatever the cause, **an unresolved named import must not become a
   standalone host import.**
   - If the specifier cannot be resolved, standalone compilation should report
     a module-resolution diagnostic that names the specifier and the
     importer.
   - It should not emit `env.<name>`.
   - Put this check where the free-global fallback is chosen for an import
     binding.
4. Regression test `tests/issue-6843-*.test.ts`:
   - a two-file project in which `b.mjs` does
     `import { f } from "missing-pkg"`, compiled with `--target standalone`,
     gets a resolution diagnostic and no `env.f` import;
   - control: the same import from a resolvable sibling module compiles with
     zero imports.
5. Re-measure the stylelint lane and record the next error.

## Acceptance

- The stylelint standalone-dynamic lane no longer reports
  `env.isDynamicPattern`.
- An unresolved named import is a diagnostic in standalone mode, never a host
  import.
