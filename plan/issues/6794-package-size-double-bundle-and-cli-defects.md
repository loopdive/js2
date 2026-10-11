---
id: 6794
title: "packaging/cli: 48.8 MB unpacked package (compiler bundled twice), `-v` means both --version and --verbose, error-severity diagnostics hidden on success, compile cache written into the user's source tree, raw stack on missing input, docs/flag drift"
status: in-progress
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
assignee: "ttraenkler/claude-dev-6794"
branch: "claude/issue-6794-packaging-cli"
priority: high
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: bug
area: tooling
language_feature: n/a
goal: developer-experience
related: [6782, 2520]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H19/H21/#3/#4/#7/#9/#10"
---

# #6794 — packaging and CLI defects (all verified against `dist/` or by running `cli.ts`)

## 1. Package ships the compiler twice — 48.8 MB unpacked, 1,803 files

`npm pack --dry-run` (2026-09-30): package size 9.4 MB, unpacked 48.8 MB.
`dist/runtime-<hash>.js` (the compiler chunk, 20.0 MB) and
`dist/test262-worker.js` (20.6 MB, built by `scripts/build-test262-cli.mjs`)
each contain a full compiler bundle; 1,738 `.d.ts` files (6 MB) are shipped
for a library whose public surface is `src/index.ts` + 4 runtime entries.

Fix: make the test262 worker `import("./index.js")` instead of bundling; emit a
single rolled-up `index.d.ts` (vite-plugin-dts `rollupTypes`), or restrict
`files` to the entry declarations. Target: < 25 MB unpacked, < 100 files.

## 2. `-v` collision — `--verbose` is unreachable

`src/cli.ts:45` `if (args.includes("--version") || args.includes("-v"))`
prints the version and exits before the arg loop; `:369`
`arg === "--verbose" || arg === "-v"` never runs. `--help` advertises both
(`:106`, `:166`). `js2wasm add.ts -v -o out` prints `0.71.0` and compiles
nothing. Fix: `-V` for version (npm/cargo convention) or drop the short form.

## 3. Error-severity diagnostics are hidden on a successful compile

`src/cli.ts:520-527` prints only `severity === "warning"`. `success` can be
true with `severity: "error"` entries (tolerated codes,
`src/compiler.ts:949-956`). `switch (x) { case 2: }` with `x: 1` →
`errors: [["error", 2678, "Type '2' is not comparable…"]]`; the CLI wrote
four artifacts, printed nothing, exit 0. Fix: print every `result.errors`
entry tagged by severity.

## 4. `compileProject` writes into the user's source tree

`src/package-linker.ts:1724`
`cacheDir = packageCacheDir ?? join(input.rootDir, ".js2wasm-cache", "npm-modules")`,
`rootDir = dirname(entry)` (`src/index.ts:1362`), `mkdirSync` at `:1244`;
linking is on unless `packageLinking === false` (`:1399`). Any CLI entry
with a relative import (`cli.ts:487-490`) gets a cache directory next to the
source. Undocumented in `--help` and `docs/cli.md`. Fix: `node_modules/.cache/js2wasm`
when a `node_modules` exists, else the OS cache dir; document `--cache-dir`.

## 5. Missing input file dumps a raw Node stack

`src/cli.ts:438` `readFileSync(absInput)` unguarded → `node:fs:440 …
readFileUtf8` stack. Fix: try/catch → one-line error, exit 1.

## 6. `compileFiles` gate diverges from `compile`/`compileMulti`

`src/compiler.ts:1962-1968` applies no `TOLERATED_SYNTAX_CODES` and no
`allowJs` exemption (`compileMultiSource` has both, `:1829-1845`); `:1945-1960`
collects diagnostics from every file with no entry filter. A JS project that
compiles via `compileProject` fails via `compileFiles` on sloppy octals /
decorators. Fix: share the multi gate (#1927 named this).

## 7. Library optimizer writes to stderr and masks failures

`src/optimize.ts:687` unconditional `process.stderr.write` inside
`compile({ optimize })`; bare `catch {}` at `:322` / `:356` turn a thrown
binaryen abort into the generic "wasm-opt not available" warning
(`:360-366`). Fix: put `e.message` in the returned `warning`; the CLI prints.

## 8. Docs vs CLI drift (each verified against `cli.ts`)

- CLAUDE.md "CLI Flags" and ROADMAP list `--nativeStrings` → "Unknown option".
- `docs/getting-started.md:52,132` and `docs/cli.md:15` say output lands
  "alongside the input"; `cli.ts:456` defaults to cwd (README.md:82 is right).
- `docs/cli.md` `--target` table omits `web|node|deno|standalone`; its `--ts7`
  cites `@typescript/native-preview` while `src/ts-api.ts:158-172` loads the
  `typescript7` alias.
- `--out=<dir>` is rejected (`cli.ts:239` takes only a separate arg) although
  `--target=` / `--link=` / `--emulate=` accept `=`.

## Acceptance

- `npm pack --dry-run` unpacked size and file count recorded before/after in
  the PR; worker imports `index.js`.
- `js2wasm x.ts -v` compiles verbosely; `js2wasm -V` / `--version` prints.
- Tolerated-error compile prints the diagnostics; exit code policy stated in
  `docs/cli.md`.
- No `.js2wasm-cache` appears next to a compiled entry by default.
- `js2wasm missing.ts` prints one line, exit 1.
- `docs/cli.md`, `docs/getting-started.md`, CLAUDE.md flag list match
  `cli.ts --help` (add a test that diffs the help text against the doc table).

## Implementation Plan

Done in this order on `claude/issue-6794-packaging-cli`, one commit per part:

1. **CLI (parts 2, 3, 5, 8)** — `src/cli.ts`: the early version check takes
   `--version` / `-V` only, so `-v` reaches the arg loop as `--verbose`; a bare
   `js2wasm -v` gets a hint. `readFileSync(absInput)` is wrapped: one
   `Error: cannot read input file <path>: no such file` line, exit 1.
   `printDiagnostic()` is shared by the failure path and a new success-path
   loop that prints every non-warning `result.errors` entry plus a one-line
   `note:` (exit stays 0). `--out=<dir>` accepted. Docs: `docs/cli.md` gained
   the 14 flags `--help` lists but it did not, the full `--target` table, the
   `typescript7` alias for `--ts7`, the CWD output default and the
   tolerated-error exit policy; `docs/getting-started.md` and `ROADMAP.md`
   fixed.
2. **Cache dir (part 4)** — `defaultCacheDir(startDir, subdir)` in `src/env.ts`
   (the environment-probing layer; reads env through `readEnv()`): nearest
   ancestor's `node_modules/.cache/js2wasm/<subdir>`, else the OS user cache
   dir. `src/package-linker.ts` uses it when `packageCacheDir` is unset; the
   CLI exposes `--cache-dir <dir>`.
3. **compileFiles gate (part 6)** — `collectMultiDiagnostics()` in
   `src/compiler.ts` is the one gate for `compileMultiSource` and
   `compileFilesSource` (tolerated syntax codes, allowJs entry-only policy).
   The #6782 Node 20.0–20.15 error lives in `analyzeFiles()`, untouched.
4. **Package size (part 1)** — `scripts/build-test262-cli.mjs` resolves the
   worker's dynamic `import("../src/linked-provider-runtime.js")` to the
   packaged `./runtime.js` and fails the build if any `src/` module is bundled
   into the worker. New `scripts/prune-dist-declarations.mjs` (a `build` step)
   keeps only the `.d.ts` files reachable from the `types` entries in
   `package.json`.
5. **Part 7 left out** — see Resolution.

## Resolution

**Status stays `in-progress`:** parts 1–6 and 8 are fixed; part 7 and the
`< 100 files` target remain (below).

`npm pack --dry-run --json`, each after a full `pnpm run build` (2026-10-02):

| | Before | After |
|---|---:|---:|
| packed size | 9,444,060 B | 4,332,114 B |
| unpacked size | 48,904,546 B | 23,205,814 B |
| files | 1,844 | 224 |
| `.d.ts` files (bytes) | 1,779 (5,439,910) | 159 (1,222,662) |
| `dist/test262-worker.js` | 21,612,369 B | 129,316 B |

The worker now imports only `./index.js` / `./runtime.js` (forked it: it
reports `ready` and compiles a job through `dist/index.js`). `tsc --noEmit`
over the five entry declarations: 0 errors before and after the prune.

CLI probes (`npx tsx src/cli.ts`), before → after:

| Case | Before | After |
|---|---|---|
| `x.ts -v` | printed `0.71.0`, compiled nothing | compiles; lists each dropped host import |
| `-V` | `Unknown option: -V`, exit 1 | prints version |
| `missing.ts` | 14-line `node:fs` stack, exit 1 | one line, exit 1 |
| TS2678 switch case | 4 artifacts, nothing printed, exit 0 | `path:2:21 - error: …` + `note:`, exit 0 |
| `--package-linking separate`, npm import | cache in `src/.js2wasm-cache/` | `node_modules/.cache/js2wasm/npm-modules` |
| `compileFiles(octal.js, {allowJs})` | FAIL | ok (matches `compile`/`compileProject`) |

Tests: `tests/issue-6794-cli.test.ts` (12, spawns the CLI asynchronously;
includes the `--help` ↔ `docs/cli.md` / getting-started / arg-parser diff) and
`tests/issue-6794-compile-files-gate.test.ts` (3; the two octal cases fail on
the base `compiler.ts`). Passing alongside: `tests/dist-esm-smoke.test.ts` on
the rebuilt dist, and 10 existing CLI test files. Pre-existing failures,
reproduced with the base file swapped in: `tests/issue-2520-…` (its fixture no
longer produces allowlist warnings), `tests/issue-2856-async-delay-ir.test.ts`
(2 cases); `tests/issue-1557.test.ts` (eslint `compileProject`) fails in a
codegen stack-balance invariant and wrote no provider cache in either
location.

Gates (all exit 0): loc/func budget (also with `LOC_GATE_BASE=origin/main`),
coercion-sites, oracle-ratchet, dead-exports, typecheck, format:check, lint,
compiler-boundaries (no unclassified modules), the 17 `check:*` quality gates
in the brief, `check:ir-fallbacks`. No budget allowance needed.

**Left out:**

- **Part 7** (`src/optimize.ts` writes to stderr and masks binaryen aborts):
  `src/optimize.ts` is receipt-pinned in
  `scripts/compiler-extension-boundaries.json`; any edit fails
  `check:dead-exports` until a human re-signs the receipt. Needs that re-sign.
- **CLAUDE.md "CLI Flags"**: not edited here (agent-instruction changes need
  a human). Since fixed on main by #6795, which also adds
  `check:claude-md-paths` to keep that list in sync with `src/cli.ts`.
- **`< 100 files`**: 159 entry-reachable `.d.ts` + 50 `examples/` files
  remain. One rolled-up `index.d.ts` (vite-plugin-dts `rollupTypes`) needs
  `@microsoft/api-extractor`, which is not a dependency today.
