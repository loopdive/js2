---
id: 4452
title: "analyzeFiles hardcodes its own compilerOptions — self-host front-end rejects the compiler's own source (rootDir, interop, 121-error strictness cluster)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: self-hosting-dogfood
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

- [ ] `analyzeFiles` derives options from the nearest tsconfig with the
      documented pipeline-required overrides; fallback + `tsconfig: false`
      preserve legacy behavior.
- [ ] Sweep delta over the 10 baseline failures recorded in Results
      (before/after error counts per entry).
- [ ] rootDir + interop buckets eliminated for the compiler's own source.
- [ ] Tests green; typecheck + quality gates green.
