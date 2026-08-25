---
id: 4452
title: "analyzeFiles hardcodes its own compilerOptions — self-host front-end rejects the compiler's own source (rootDir, interop, 121-error strictness cluster)"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: self-hosting-dogfood
# +3 lines in the driver: `compileFilesSource` is the only `analyzeFiles`
# caller in the pipeline, so threading `CompileOptions.tsconfig` through to it
# has to land there. No subsystem module can hold it.
loc-budget-allow:
  - src/compiler.ts
---

# #4452 — self-host front-end: honor the project's tsconfig in `analyzeFiles`

The #4420 baseline sweep (22 entries over the compiler's own `src/**`) showed
10 of 22 entries fail **in the compiler's own front-end**, before codegen
runs, in three buckets that all trace to `analyzeFiles`
(`src/checker/index.ts:1188`) hardcoding its `ts.CompilerOptions` instead of
reading the project's `tsconfig.json`:

1. **`rootDir` pinned to `dirname(entry)`** — any subdir entry importing
   across `src/` fails with `File 'src/x.ts' is not under 'rootDir'`
   (hit: `emit/binary.ts` warnings, `checker/oracle.ts`,
   `compiler/early-errors/index.ts` with 858 errors).
2. **CJS default-import interop off** — `Module '"typescript"' can only be
   default-imported using the 'esModuleInterop' flag` (hit: `import-resolver`,
   `oracle`, `cjs-rewrite`, `shape-inference`). The project's tsconfig uses
   `moduleResolution: "bundler"` (which implies `allowSyntheticDefaultImports`);
   `analyzeFiles` uses `Node10` with no interop flags.
3. **The 121-error strictness cluster** — `resolve.ts`, `wit-generator.ts`,
   `runtime.ts`, `compiler.ts`, `index.ts` all fail with an identical set led
   by `Argument of type '{ declaration…funcIdx }' is not assignable to
   parameter of type 'never'` and `Property 'statements' does not exist on
   type '{}'` — checker verdicts under `analyzeFiles`' options
   (`strict: true`, `Node10`, ES2022 libs) that do not occur under the
   project's own options (the project typechecks clean under its tsconfig).
   Each of these also burns ~215 s before failing.

The project tsconfig (repo root): `target: ES2022`,
`moduleResolution: "bundler"`, `strict: true`, `rootDir: "./src"`.

## Implementation Plan (Fable, 2026-08-15)

1. **Config discovery**: in `analyzeFiles`, resolve the nearest
   `tsconfig.json` upward from the entry file via `ts.findConfigFile` +
   `ts.readConfigFile` + `ts.parseJsonConfigFileContent`, and use its
   `options` as the BASE. Keep the current hardcoded object as the fallback
   when no tsconfig exists (arbitrary user input files must keep working —
   that fallback is load-bearing for the playground/dogfood paths). Preserve
   the existing overrides that the pipeline requires regardless of config
   (`noEmit: true`, the JSX switch for `.tsx` entries — read the current
   code for the full list and keep each deliberately, with a comment saying
   which are pipeline-required vs default).
2. **`rootDir`**: when a tsconfig is found, take its `rootDir` (resolved);
   otherwise KEEP the current `dirname(entry)` behavior. Do not invent a
   common-ancestor heuristic in this issue.
3. **Opt-out**: add `analyzeOptions.tsconfig?: string | false` — a path to
   force a specific config, `false` to force the legacy hardcoded options.
   Thread it through `CompileOptions` (grep how `analyzeOptions` flows from
   `compileFiles`). Default = auto-discovery.
4. **Measure the delta** (this is the acceptance evidence): re-run the sweep
   over the 10 failing baseline entries (harness pattern:
   `.tmp/selfhost-sweep.mts` in the `compiler-speedup` worktree — copy it,
   note its `globalThis.require` shim) before/after. Record per-entry error
   counts. Expect buckets 1–2 to vanish outright; report what remains of
   bucket 3 honestly — if the 'never'/'{}' cluster persists under project
   options, characterize the first error precisely (file, line, construct)
   and file it as a follow-up rather than forcing it into this issue.
5. **Tests**: `tests/issue-4452*.test.ts` — (a) a fixture directory with a
   tsconfig (e.g. `paths`-free, `bundler` resolution) + entry importing a
   sibling above its own dirname compiles without rootDir errors; (b) no
   tsconfig → legacy behavior unchanged (pin with an existing-style
   compileFiles test); (c) `tsconfig: false` forces legacy. Keep fixtures
   tiny.
6. **Do not** touch the checker's diagnostic filtering/severity model, and do
   not chase individual bucket-3 type errors here — measure, report, file.

## Acceptance criteria

- [x] `analyzeFiles` derives options from the nearest tsconfig with the
      documented pipeline-required overrides; fallback + `tsconfig: false`
      preserve legacy behavior.
- [x] Sweep delta over the 10 baseline failures recorded in Results
      (before/after error counts per entry).
- [x] rootDir + interop buckets eliminated for the compiler's own source.
- [x] Tests green; typecheck + quality gates green.

## Implementation

`src/checker/index.ts`

- `resolveProjectCompilerOptions(resolvedEntry, tsconfigOption)` —
  `ts.findConfigFile` upward from the entry (or an explicit path) →
  `ts.readConfigFile` → `ts.parseJsonConfigFileContent`, returning only
  `.options`. Program roots stay entry-anchored, so the config's
  `include`/`exclude`/`files` are deliberately ignored. Returns `undefined`
  (→ legacy options) for `tsconfig: false`, no `ts.sys`, no config found, or a
  config found by SEARCH that fails to read. An EXPLICIT path that is missing
  or unreadable throws — the caller named it, so a typo must not silently
  degrade to a different option set.
- `EMIT_ONLY_COMPILER_OPTIONS` — `outDir`, `outFile`, `declaration`,
  `declarationDir`, `declarationMap`, `emitDeclarationOnly`, `sourceMap`,
  `inlineSourceMap`, `inlineSources`, `composite`, `incremental`,
  `tsBuildInfoFile` are stripped from the project's options. The program is
  type-only (`program.emit()` is never called), so they are inert at best, and
  `composite`/`incremental` provoke config-level complaints under `noEmit`.
- `analyzeFiles` now composes `baseOptions` (project options, else the legacy
  hardcoded set verbatim) with the **pipeline-required overrides**, each kept
  deliberately:
  - `noEmit: true` — always, over any base.
  - JSX for a `.tsx`/`.jsx` entry (#1531) — only when the config did not
    already choose a `jsx` mode.
  - `allowJs`/`checkJs` when the caller passed `allowJs` — the caller states
    the graph contains JS, which outranks the config.
  Everything else in the old hardcoded object (`target`, `module`,
  `moduleResolution`, `strict`, `noImplicitAny: false`, `rootDir:
  dirname(entry)`) is now a **default of the no-config fallback**, not an
  override.
- `AnalyzeOptions.tsconfig?: string | false`.

`src/index.ts` — `CompileOptions.tsconfig?: string | false`.
`src/compiler.ts` — threaded into the `analyzeFiles` call in
`compileFilesSource` (the only `analyzeFiles` caller in the pipeline).

**The one judgement call worth naming**: `noImplicitAny: false` is NOT treated
as pipeline-required. It is what caused bucket 3 — TypeScript's evolving
array/object inference ("improved any inference", TS 2.1) is enabled *only*
under `noImplicitAny`, so `const a = []` widened to `never[]` and `const o =
{}` to `{}` under the old `strict: true` + `noImplicitAny: false` pairing.
That is exactly the `codegen-linear/index.ts:219` /
`codegen-linear/index.ts:1504-1505` errors. Forcing it on would have kept the
cluster; leaving the project's strictness to govern eliminated it. It remains
the default in the no-config fallback, where there is no author intent to read.

## Results (2026-08-15)

Harness: `.tmp/selfhost-sweep.mts` (copied from the `selfhost-baseline`
worktree; `compileFiles` + `WebAssembly.validate`), plus
`.tmp/frontend-probe.mts` — an `analyzeFiles`-only probe that counts
category-1 TS diagnostics, which isolates exactly what this issue changes.
Before/after are both measured on this branch; the "before" full sweep
reproduced the #4420 baseline (10/10 fail, same counts, `early-errors` 859 vs
858 from main advancing).

### Front-end errors (`analyzeFiles` diagnostics, category 1) — the direct delta

Measured by A/B file swap of `src/checker/index.ts` (base copy in `.tmp/`).

| entry                             | before | after | bucket                     |
| --------------------------------- | -----: | ----: | -------------------------- |
| `src/import-resolver.ts`          |      1 | **0** | interop (TS1259)           |
| `src/checker/oracle.ts`           |      2 | **0** | rootDir (TS6059) + interop |
| `src/cjs-rewrite.ts`              |      1 | **0** | interop                    |
| `src/shape-inference.ts`          |      1 | **0** | interop                    |
| `src/resolve.ts`                  |    121 | **0** | strictness cluster         |
| `src/wit-generator.ts`            |    121 | **0** | strictness cluster         |
| `src/runtime.ts`                  |    121 | **0** | strictness cluster         |
| `src/compiler.ts`                 |    121 | **0** | strictness cluster         |
| `src/index.ts`                    |    121 | **0** | strictness cluster         |
| `src/compiler/early-errors/index.ts` | 859 | **0** | rootDir                    |

All three buckets are gone, including bucket 3 — **nothing of the 121-cluster
remains**, so no follow-up issue is needed for it. Its first error was
`src/codegen-linear/index.ts:219 TS2345 Argument of type '{ declaration:
ts.Node; legacyName: string; funcIdx: number; }' is not assignable to
parameter of type 'never'`, followed by
`src/codegen-linear/index.ts:1504/1505 TS2339 Property 'statements' does not
exist on type '{}'` — the `noImplicitAny` inference artefacts described above.

### Full compile (`compileFiles`) error counts

| entry                                | before | after           | before ms | after ms |
| ------------------------------------ | -----: | --------------- | --------: | -------- |
| `src/import-resolver.ts`             |      8 | **7**           |     9,735 | 4,317    |
| `src/checker/oracle.ts`              |      6 | **4**           |     6,911 | 2,120    |
| `src/cjs-rewrite.ts`                 |      9 | **8**           |     5,873 | 1,617    |
| `src/shape-inference.ts`             |      5 | **4**           |     6,049 | 1,522    |
| `src/resolve.ts`                     |    121 | TIMEOUT >1,200 s |   213,202 | —        |
| `src/wit-generator.ts`               |    121 | TIMEOUT >1,200 s |   236,607 | —        |
| `src/runtime.ts`                     |    121 | TIMEOUT >1,200 s |   241,466 | —        |
| `src/compiler.ts`                    |    121 | TIMEOUT >1,200 s |   230,341 | —        |
| `src/index.ts`                       |    121 | TIMEOUT >1,200 s |   240,037 | —        |
| `src/compiler/early-errors/index.ts` |    859 | TIMEOUT >1,200 s |   236,548 | —        |

Reading these two tables together:

- The four light entries compile **2.3–4.0× faster** and their remaining
  errors are no longer front-end verdicts at all — they are codegen bugs
  already tracked elsewhere: `Cannot access 'replacementText'/'imports' before
  initialization` (TDZ, #4453) and `Missing __make_getter_callback import`
  (#4454).
- The six heavy entries **no longer fail**; they now clear the front end
  (0 diagnostics, ~195–224 s of type-checking) and proceed into codegen, where
  they exceed a 20-minute per-entry budget. Before this change they were
  rejected at ~215 s by the front end and never reached codegen. So the
  self-host blocker for these modules has moved from "the compiler's own
  front-end rejects its own source" to "codegen throughput on a
  ~200-module graph" — a different problem, and one this issue deliberately
  does not touch.

### Validation

- `pnpm run typecheck` — exit 0.
- `npx biome lint src tests scripts --diagnostic-level=error` — exit 0;
  prettier clean on all changed files.
- `tests/issue-4452-analyze-files-tsconfig.test.ts` — 7/7 pass (within the
  default 512 MB per-fork budget).
- Collateral (`compileFiles` consumers): `tests/issue-1931.test.ts` 20/20,
  `tests/issue-1927.test.ts` 10/10, `tests/equivalence/multi-file-compilation.test.ts`,
  `tests/issue-2138-multi-module-ir-overlay.test.ts`,
  `tests/standalone-multimodule-to-primitive-fills.test.ts`,
  `tests/issue-2815-deno-not-found-warning.test.ts` — all pass.
  `tests/issue-2856-async-delay-ir.test.ts` has one failure
  ("composes callback, Date, and Promise finalization in one module") that is
  **pre-existing**: it reproduces on the shared `main` checkout, and the test
  drives the in-memory `compile()` path, which this change does not touch.
