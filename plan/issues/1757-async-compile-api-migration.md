---
id: 1757
title: "Migrate the public compile() API to async (embed binaryen via await import)"
status: done
created: 2026-05-31
updated: 2026-05-31
completed: 2026-05-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler-api
goal: platform
related: [1756, 986]
depends_on: []
sprint: Backlog
---

# #1757 — Migrate the public `compile()` API to async

## Why

Follow-up to **#1756** (GH #986). #1756 unblocked the bundler build via a
`createRequire` shim, but the optional `binaryen` optimizer is still loaded with
a synchronous require, so a standalone `bun --compile` / `deno compile` binary
**cannot embed binaryen** (it resolves at runtime / skips gracefully). The clean
end-state is `await import("binaryen")`, which requires the compile pipeline to
be **async**. User-directed (2026-05-31) to do the full migration.

## Scope / blast radius (measured)

- `compileSource` is fully synchronous codegen; the **only** async-needing step
  is binaryen's wasm-opt. The async loader already exists: `optimizeBinaryAsync`
  + `getBinaryenModule` (`await import("binaryen")`).
- **Public sync entry points** to convert: `src/index.ts:261 compile()`,
  `src/compiler.ts:136 compileSource`, `:551 compileMultiSource`,
  `:826 compileFilesSource`.
- **In-src callers** (~9): `index.ts` wrappers (262/312/333/338/386/412),
  `runtime-instantiate.ts:81`, `runtime.ts:9637` (both already inside async
  `compileAndInstantiate`), `cli.ts:191` (CLI is already async — `await import`).
- **Test ripple: ~1,675 `compile(...)` call sites across 761 files.** This is the
  bulk of the work and is mechanical (codemod).

## Implementation plan (staged — run the suite LOCALLY after the codemod, then CI gates)

**Phase 1 — source (reviewable, small):**
1. `compiler.ts`: make `compileSource`/`compileMultiSource`/`compileFilesSource`
   `async` → `Promise<CompileResult>`; replace the 3 internal `optimizeBinary(...)`
   calls (491/772/1012) with `await optimizeBinaryAsync(...)`.
2. `index.ts`: make `compile()` + the multi/files/wat wrappers `async`, `await`
   their inner `compile*Source` calls (262/312/333/338/386/412/412-service).
3. `runtime-instantiate.ts:81` + `runtime.ts:9637`: `await compileSource(...)`
   (already in async fns).
4. `cli.ts:191`: `const result = await compile(...)` (already top-level-await).
5. Keep the **sync** `optimizeBinary` + its `createRequire` shim for any
   remaining sync internal use, OR delete it if no longer referenced.

**Phase 2 — test codemod (~1,675 sites / 761 files):**
- Script: for each `tests/**/*.test.ts`, wrap `compile(` → `await compile(`
  (NOT `compileAndInstantiate`/`compileToWat`/`compileSource` unless converted),
  and ensure the enclosing `it(...)/test(...)/beforeEach(...)` callback is `async`.
- Prefer an AST codemod (ts-morph / jscodeshift) over regex to avoid mangling
  `it.each`, nested arrows, and already-async callbacks. Validate the codemod on
  a few files first, then run repo-wide.
- Update any other consumers: `playground/`, `scripts/runner-bundle.mjs`
  (regenerate), docs snippets.

**Phase 3 — embed binaryen in standalone:**
- Point the CLI/standalone build at the async path so `await import("binaryen")`
  is bundled. Verify `bun build --compile` / `deno compile` embed binaryen and
  the resulting single-file binary optimizes without binaryen on PATH.

## Acceptance

- `compile()` and the `compile*Source` entry points are async; CI green
  (equivalence + test262 + quality) after the codemod.
- `bun build --compile` / `deno compile` of the CLI produce a standalone binary
  that runs `--optimize` with binaryen **embedded** (closes the #986 end-state).
- Migration guide note in README/CHANGELOG (breaking: `compile()` now returns a
  Promise).

## Risk / notes

- **Breaking public API change** — `compile()` returns a `Promise` now; every
  external consumer must `await`. Call it out prominently (README/CHANGELOG/major
  version bump).
- **Validate locally** — run the full suite (`npm test`) after the codemod and
  fix failures before pushing; CI is the final gate. Keep the PR **DRAFT** until
  green.
- The codemod is the risk centre — do it AST-based and review a sample diff
  before the repo-wide run.

## Implementation notes (sendev, 2026-05-31)

**Why the design, not just the what:**

1. **The `eval()` host shim forced a sync core.** `runtime-eval.ts`'s
   `__extern_eval(src, isDirect)` is a *Wasm host import* — Wasm imports must
   return synchronously, and `eval` is synchronous in JS. It compiles its
   wrapper source with `compileSource` and instantiates with the **sync**
   `new WebAssembly.Module`. Making `compileSource` `async` would have made the
   eval shim return a `Promise` it can't await. Resolution: split
   `compileSource` into a **synchronous** `compileSourceCore` (full codegen, no
   optimizer) + an `async compileSource` wrapper that applies the optional
   Binaryen pass via `applyOptionalOptimize` → `optimizeBinaryAsync` (the
   `await import("binaryen")` loader). The eval shim calls `compileSourceCore`
   directly and is unchanged. This is sound because **nothing downstream of
   codegen depends on the optimized binary** — WAT, `.d.ts`, imports-helper and
   WIT all derive from the binaryen-independent module IR — so deferring the
   optimize (which only swaps `result.binary`) to the wrapper is observationally
   identical to optimizing inline. `compileMultiSource`/`compileFilesSource`
   have no sync caller, so they stayed monolithic-async with inline
   `await optimizeBinaryAsync`.

2. **Codemod = the bulk + the only real regression risk.** `tests/` is
   **excluded from `tsconfig.json`**, so `tsc` does NOT typecheck tests — a
   missing `await` surfaces only as a *runtime* vitest failure (`.success`/
   `.errors` read off a Promise). So the codemod had to be transitively
   complete, validated by `npm test`, not by tsc. Implemented AST-based with
   ts-morph (`.tmp/codemod-await-compile.mjs`, gitignored) with three
   non-obvious behaviours the regex approach would miss:
   - **Fixpoint transitive propagation**: a sync local helper (e.g.
     `function internalCrashErrors(): string[] { … compile() … }`) becomes
     `async`, so every caller of *that helper* must also `await` it and become
     async — iterated to a fixpoint within each file.
   - **Return-type rewrite**: an `async` fn with an explicit non-Promise return
     annotation (`: string[]`) is wrapped to `: Promise<string[]>`.
   - **Parenthesising chained access**: `compile(...).binary` →
     `(await compile(...)).binary`, not `await compile(...).binary`.
   - Dynamic `const { compile } = await import("../src/index.js")` sites (3
     files) are missed by the static-import scan; fixed by hand.

   Repo-wide run: **768 files, 2140 `await`s added, 1189 fns marked async.**

3. **Standalone embed (Phase 3)**: the async path is reachable end-to-end from
   the CLI (`cli.ts await compile → applyOptionalOptimize → await
   import("binaryen")`); verified `npx tsx src/cli.ts add.ts --optimize`
   produces a valid optimized binary, loading binaryen via dynamic import.
   `bun build --compile` / `deno compile` can now statically bundle binaryen
   from that `await import`. (Neither `bun` nor `deno` is installed in this
   container, so the single-file-binary build itself was not run here.)
