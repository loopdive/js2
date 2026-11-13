---
id: 6843
title: "standalone: stylelint's `import { isDynamicPattern } from 'globby'` leaks as host import env.isDynamicPattern"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-16
completed: 2026-10-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, standalone, module-resolution
goal: standalone
requested_by: ttraenkler/wave9-6288-refresh
related: [6742, 2961, 1559, 6666, 7023]
loc-budget-allow:
  # 2026-10-16: one dispatch line in the declare-function branch of
  # collectExternDeclarationsImpl; the helper itself lives in
  # standalone-unavailable-globals.ts (#6843).
  - src/codegen/extern-declarations.ts
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

## Original plan (2026-10-05)

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

## Diagnosis (2026-10-16, upstream/main `ee58c1aa26`)

Reproduced without stylelint: a two-line entry `import { isDynamicPattern }
from 'globby'` compiled with `--target standalone` (`packageLinking: false`,
as the bundled fallback the large lanes take) retains `env.isDynamicPattern`.
It is not globby's binding. A trace of `addImport` names the producer:

```
registerAmbientParseImport  ← collectExternDeclarationsImpl (declare-function branch)
  sourceFile: node_modules/.pnpm/fast-glob@3.3.3/node_modules/fast-glob/out/utils/pattern.d.ts
```

fast-glob's compiled CommonJS does `require("./utils")` and
`require("./pattern")`. `ModuleResolver.resolve` asks TypeScript, which
substitutes the sibling declaration file for an extensionless relative
specifier (`./utils` → `out/utils/index.d.ts`). The graph walker then compiles
fast-glob's `.d.ts` files instead of its `utils/*.js` bodies. Every
`export declare function` in those files is a module export with no body, and
the extern-declaration pass registers it as a free-global `env.<name>` host
import. The `globby` specifier itself resolves correctly; its bare-package
`.d.ts` → body redirect (#1559) already exists. Only the relative edge lacks
one. The explicit `./x.js` form got its redirect in the Moment fix.

## Implementation Plan

1. `src/codegen/extern-declarations.ts`, where the free-global fallback is
   chosen. On standalone, a `declare function` or `declare class` from a
   package declaration file does not become an `env.<name>` import or an
   `env.<Class>_*` extern class. A package declaration file here means a
   `.d.ts` module under `node_modules/` with no linked-provider binding for the
   name. Such a declaration is a module export whose body is not in the
   program, not a host global, so a use throws at runtime, as a use of an
   unresolvable module already does. Each skipped declaration is reported as a
   `warning` that names the binding and the declaration file. The predicate
   lives in `src/codegen/standalone-unavailable-globals.ts`
   (`skipStandalonePackageStub`). It is gated on `ctx.standalone`, so the gc
   binary is byte-identical.
2. `scripts/generate-npm-compat-report.mjs` `firstCompileDiagnostic`: prefer
   the first `severity: "error"` diagnostic. A failed compile failed on an
   error. Without this, the new warnings, like the older leak warnings, would
   stand in for the real failure on the dashboard.
3. Regression test `tests/issue-6843-standalone-dts-shadowed-body.test.ts`:
   - (a) fast-glob/postcss shape: a package body `require`s
     `./pattern` / `./matcher` next to `pattern.d.ts` / `matcher.d.ts`, using
     an `export declare function` and an `export =` declared class. It
     compiles standalone with zero imports and a warning for each binding, and
     both uses throw.
   - (b) a declaration-only package compiles standalone with zero imports and
     a warning, and the call throws.
   - (c) control: an unresolvable package has zero imports and no #6843
     warning. This is already true on the parent.
   - (d) anti-vacuity: the gc target still imports `env.isDynamicPattern` and
     `env.Matcher*`.
4. Re-measure the stylelint lane and record the next error.

### Rejected: resolve the relative edge to the sibling body

The first plan above (2026-10-16 draft) was a standalone-only `ModuleResolver`
redirect. It would send an extensionless relative edge that TypeScript
resolved to `X.d.ts` to the sibling `X.js`, which is the rule the explicit
`./x.js` (Moment) edge already follows. It was implemented and measured, then
backed out:

- **What it got right.** It is the semantically right graph. postcss alone
  went to 0 leaks: its real `lib/*.js` bodies compiled where 21
  `env.Result__*` / `env.Stringifier__*` / `env.PreviousMap__*` extern
  classes had been.
- **Why it was backed out.** The stylelint graph grew from 379 to 414 files,
  and one of the new files is `typescript/lib/typescript.js` (9.1 MB).
  cosmiconfig's `dist/loaders.js` lazily does `require('typescript')`; the
  standalone nested-require hoist (#6666) links that edge, and only the
  `loaders.d.ts` face had hidden it. Codegen's `object-widening` phase took
  more than 30 min on that graph, against 6.6 s on base. The run was killed
  after about 2 h.
- **What it would need first.** A policy for giant optional lazy requires,
  for example leaving a function-nested `require` of an unreferenced package
  unlinked.

That redirect is the follow-up recorded in #7023.

## Acceptance

- The stylelint standalone-dynamic lane no longer reports
  `env.isDynamicPattern`.
- An unresolved named import is a diagnostic in standalone mode, never a host
  import.

## Resolution

Fixed on standalone in `extern-declarations.ts` through
`skipStandalonePackageStub` in `standalone-unavailable-globals.ts`. A
`declare function` or `declare class` in a `.d.ts` module under
`node_modules/` with no linked binding is now a `warning` and a throwing use.
It no longer becomes an `env.*` host import or an extern class.
`firstCompileDiagnostic` now prefers an error-severity diagnostic.

- **Regression test.** `tests/issue-6843-standalone-dts-shadowed-body.test.ts`:
  on the parent 2 fail / 2 pass, the 2 passes being the controls; with the fix
  4/4. `tests/issue-6675-*` and `tests/issue-6841-*` still pass.
- **gc unchanged.** gc binaries are byte-identical before and after (sha256):
  - the test's `fakeglob` fixture: `2c63e003c7b08452`, both with and without
    package linking;
  - postcss `parse`: 616,023 B, `025140621cc30fcb`.
- **stylelint leaks.** Direct `compileProject` of the lane driver: 46 → 25
  retained `env.*` imports, with nothing added. Gone are `env.isDynamicPattern`,
  `env.isAbsolute` (both fast-glob `out/utils/pattern.d.ts`) and 19 postcss
  extern-class members (`Result__*`, `Processor__*`, `Input__get_map`,
  `PreviousMap__*`, `CssSyntaxError__set_input`, `Stringifier__*`). The
  compile now reports 92 `#6843` warnings.
- **Codegen time.** 257 s with the fix at load ~40, against 263 s on the parent
  at load ~160. Both exceed the 120 s CI lane budget (#4287).
- **stylelint lane.** Run in-process with no budget, the lane reported
  - before:
    `compile-error: Unsupported new expression for class: String`, a warning
    that masked the real failure (268 s codegen);
  - after:
    `compile-error: emitted WebAssembly failed validation — "Root_toResult": call[0] expected type (ref null 13), found ref.null of type (ref null 2)`
    (2,186 s codegen at load 160–450; not comparable).

  The validation error is already present on the parent. It is the next
  blocker, filed as #7024. After it come the node-builtin and Web Crypto
  imports tracked by #6746.
- **postcss alone.** 21 extern-class leaks → 0.
- **Follow-up, #7023.** Compile the real bodies behind relative `.d.ts` faces.
  The resolver redirect for this was measured and backed out; see "Rejected"
  above.

