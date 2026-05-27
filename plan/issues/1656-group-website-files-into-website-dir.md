---
id: 1656
title: "Consolidate all website/frontend files under website/"
status: done
sprint: 55
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: website, build, ci
related: [1583, 1590]
---

# Consolidate all website/frontend files under website/

## Problem / goal

Website and frontend assets are scattered at the repo root, mixed in with the
compiler sources and project tooling. A new contributor opening the repo root
cannot tell at a glance what is the compiler and what is the marketing/docs/
playground site.

Consolidate all website/frontend files into a single top-level `website/`
directory so the repo root cleanly separates **the compiler** (`src/`,
`tests/`) from **the site**. After the move, the root should contain no loose
site files; everything the site needs lives under `website/`.

This is a structural refactor only — no behavior change. The site must still
build and deploy exactly as before, and the dashboard must still read the
benchmark results it depends on.

## In scope — move under `website/`

All verified present at the repo root on `main`:

- `components/`
- `dashboard/`
- `playground/`
- `index.html`
- `public/`
- `frame-nav-sync.js`
- `playground.png`
- `screenshot.png`
- `vite.config.ts` — the **site/playground** build config. NOT
  `vite.config.lib.ts` (that builds the compiler library bundle and stays at
  root).
- `CNAME` — GitHub Pages custom domain (`js2.loopdive.com`). Verify whether
  Pages requires it at the Pages-source/artifact root and move/place it
  accordingly so the custom domain survives.

## NOT in scope (stay at root)

`src/`, `tests/`, `scripts/`, `plan/`, `benchmarks/` (benchmark harness — its
`results/` feed the dashboard but the directory stays at root), `examples/`,
`docs/`, `packages/`, `spec-compliance/`, `test262/`, all dotfiles,
`package.json`, `vite.config.lib.ts`, `vitest.config.ts`, `tsconfig.json`, and
all top-level markdown (README / CONTRIBUTING / etc.).

## Build / CI surface that MUST be updated as part of the move

This is why the issue needs an architect implementation spec before any dev
touches it: the move is mechanically simple but the path/config fan-out is
wide, and getting any one of these wrong silently breaks the deployed site.

- `vite.config.ts` — `root`, `publicDir`, `build.outDir`, and input paths
  (the site config likely references `index.html`, `playground/`,
  `dashboard/`, `components/` relative to its own location).
- `package.json` scripts — `dev`, `build:playground`, `dashboard:watch`,
  `build:pages`, and anything else that references `index.html`,
  `playground/`, `dashboard/`, or `components/`.
- `scripts/build-pages.js` — the GitHub Pages build; audit all path
  assumptions (input dirs, copy globs, output dir).
- `.github/workflows/deploy-pages.yml` — the Pages publish source / artifact
  upload path.
- `CNAME` placement — must end up wherever the Pages artifact root is so the
  custom domain (`js2.loopdive.com`) is preserved.
- All import / asset paths **inside** `components/`, `dashboard/`, and
  `playground/` that reference each other or root-relative assets
  (e.g. `dashboard/data*.js`, `components/*.js`, relative `../public/...`
  references, `<script src>` / `import` paths in `index.html`).

## Acceptance criteria

- All listed files live under `website/`; the repo root no longer has loose
  site files.
- `pnpm run build:playground` succeeds from the new layout.
- `pnpm run build:pages` succeeds from the new layout.
- GitHub Pages still deploys and the CNAME / custom domain
  (`js2.loopdive.com`) is preserved.
- No broken import / asset paths; the dashboard still reads its benchmark
  results from `benchmarks/results/`.

## Notes

- **Needs an architect implementation spec BEFORE a dev executes it.** The
  spec must enumerate: the exact move list (every path, old → new), every
  config/script/workflow edit with the precise key/line changed, every
  internal import/asset path rewrite, and a verification plan
  (`build:playground`, `build:pages`, and a check that the Pages artifact
  carries `CNAME`).
- This should land as **one PR** (a single coordinated move) — splitting the
  move from the path/config edits leaves `main` in a broken-build state.
- Tracked in the TaskList as `arch(#1656)`.
- Related: #1583 (landing feature-support table audit), #1590 (first-5-min UX
  docs) both touch the same frontend surface — sequence so this consolidation
  lands without colliding with in-flight site edits.

## Implementation Plan

### CRITICAL CORRECTION to the issue body — read before starting

The issue's "In scope" list says to move the **site/playground `vite.config.ts`**
and names the **root `vite.config.ts`**. That is **factually wrong** and following
it verbatim breaks the build:

- **Root `vite.config.ts` is the COMPILER LIBRARY build** (`lib.entry =
  src/index.ts`, `src/cli.ts`). It is *not* the site config. The `build` script
  uses `vite.config.lib.ts`; this root `vite.config.ts` is the dev-server / dts
  config for the library. **It does NOT move — it stays at root with `src/`.**
- **The actual SITE/playground build config is `playground/vite.config.ts`** —
  `package.json` `build:playground` and `dev` both invoke
  `vite build|serve --config playground/vite.config.ts`. It moves *with* the
  `playground/` directory (it lives inside it).

So: do **not** move root `vite.config.ts`. Move `playground/` (which carries
`playground/vite.config.ts` and the four `vite-plugin-*.ts`).

### Root cause / why this is risky, not trivial

`playground/vite.config.ts` sets **`root: projectRoot`** where
`projectRoot = resolve(import.meta.dirname, "..")`. Every Vite plugin under
`playground/` (`vite-plugin-test262.ts`, `vite-plugin-dashboard.ts`,
`vite-plugin-adr.ts`, `vite-plugin-compiler-bundle.ts`) and `frameNavSyncPlugin`
in the config compute `resolve(import.meta.dirname, "..")` to find the **repo
root**, then reference dirs that **stay at root**: `test262/`, `tests/`,
`benchmarks/`, `docs/adr/`, `scripts/`, `src/`, plus `public/` and `dashboard/`
(which move). `playground/main.ts` imports `../src/index.js` and
`../tests/equivalence/**`.

When `playground/` moves to `website/playground/`, every `resolve(dirname, "..")`
now points at `website/`, not the repo root — silently breaking all of them.
The fix is to change those traversals to `"../.."` for dirs that stay at root,
and keep `".."` (now → `website/`) for dirs that move with the site
(`public/`, `dashboard/`, `index.html`, `components/`, `frame-nav-sync.js`).
`build-pages.js` and friends live in `scripts/` (stays at root) and reference
everything via `join(ROOT, ...)`; those `join(ROOT, "playground"|"dashboard"|
"public"|"components"|"frame-nav-sync.js")` calls must be repointed at
`website/`.

### Target layout

```
website/
  index.html
  frame-nav-sync.js
  CNAME                 # see CNAME note below
  playground.png        # orphan asset (no code refs) — see note
  screenshot.png        # orphan asset (no code refs)
  components/
  dashboard/
  playground/           # carries vite.config.ts + vite-plugin-*.ts + image*.png
  public/
```

Stays at root: `src/`, `tests/`, `scripts/`, `plan/`, `benchmarks/`,
`examples/`, `docs/`, `packages/`, `spec-compliance/`, `test262/`, all dotfiles,
`package.json`, **root `vite.config.ts`**, `vite.config.lib.ts`,
`vitest.config.ts`, `tsconfig.json`, top-level markdown.

### Phase 1 — git mv (preserve history)

Run from repo root. One `git mv` per top-level entry:

```bash
mkdir -p website
git mv components website/components
git mv dashboard  website/dashboard
git mv playground website/playground
git mv public     website/public
git mv index.html website/index.html
git mv frame-nav-sync.js website/frame-nav-sync.js
git mv CNAME       website/CNAME
git mv playground.png  website/playground.png
git mv screenshot.png  website/screenshot.png
```

`playground/image-black.png`, `image.png`, `image-white.png` move automatically
inside `playground/`. They have **no code references** (verified) — orphan
assets; moving them inside `website/playground/` is fine, no path edits needed.
`playground.png` / `screenshot.png` are also unreferenced (verified — no HTML/JS/
TS/MD refs); they move for tidiness only.

### Phase 2 — config / script / plugin path edits

For each file below, **the `..` → repo-root assumption is what changes**. The
rule: a path that resolves to a dir **staying at root** gains one extra `..`
(or `ROOT` is recomputed); a path to a dir **moving into `website/`** is left as
`..` (now correctly → `website/`) or repointed `join(ROOT, "website", ...)`.

**File: `website/playground/vite.config.ts`** (was `playground/vite.config.ts`)
- `projectRoot = resolve(import.meta.dirname, "..")` → must still equal the
  **repo root** because `root:`, `publicDir: "public"` (→ `website/public`?),
  and the rollup inputs reference both moving and non-moving dirs. **Decision:
  keep `root` = repo root** (`resolve(import.meta.dirname, "../..")`) so that
  `tests/`, `test262/`, `benchmarks/`, `src/` (all root-stay) resolve, and set
  `publicDir` explicitly to the moved public dir.
  - `const projectRoot = resolve(import.meta.dirname, "../..");` (was `".."`).
  - `publicDir: "public"` → `publicDir: resolve(import.meta.dirname, "../public")`
    (absolute, points at `website/public`). Vite resolves `publicDir` relative
    to `root`; since `root` is the repo root, a bare `"public"` would now point
    at a non-existent root `public/` — make it absolute to `website/public`.
  - `frameNavSyncPlugin`: `outDir` default `resolve(projectRoot, "dist/playground")`
    stays correct (dist stays at root). The copy source
    `resolve(projectRoot, "frame-nav-sync.js")` → `resolve(projectRoot,
    "website", "frame-nav-sync.js")`.
  - `hasDashboardData`: `resolve(projectRoot, "dashboard", "index.html")` →
    `resolve(projectRoot, "website", "dashboard", "index.html")`; the
    `plan/issues` check stays (`plan/` is root).
  - `rollupOptions.input.index`: `resolve(import.meta.dirname, "../index.html")`
    → `resolve(import.meta.dirname, "../index.html")` is now `website/index.html`
    — **already correct** (dirname is `website/playground`, `..` = `website`).
    Leave as-is. `input.playground: resolve(import.meta.dirname, "index.html")`
    unchanged.
  - `server.fs.allow: ["."]` — relative to `root` (repo root) — leave as-is.
  - `resolve.alias` stub paths use `import.meta.dirname` (= `website/playground`)
    — unchanged (stubs move with playground).
  - `server.watch.ignored` globs are root-relative substrings — unchanged.

**File: `website/playground/vite-plugin-test262.ts`**
- Two `const projectRoot = resolve(import.meta.dirname, "..")` (lines ~5, ~222):
  these target the **repo root** (they read `test262/`, `tests/`, `benchmarks/`,
  and serve from `public/`). `test262`, `tests`, `benchmarks` stay at root →
  need `"../.."`. But `publicRoot = join(projectRoot, "public")` targets the
  **moved** public. Resolve by keeping `projectRoot` = repo root (`"../.."`) and
  changing `publicRoot` to `join(projectRoot, "website", "public")`.
  - line ~5: `projectRoot = resolve(import.meta.dirname, "../..")`.
  - line ~6: `publicRoot = join(projectRoot, "website", "public")`.
  - line ~222: second `projectRoot = resolve(import.meta.dirname, "../..")`.
  - Verify `testBase`, `jsonlPath`, `tests/...`, `report.json` (all root) now
    resolve via the recomputed `projectRoot`. The `publicPath` fallback that
    serves arbitrary files (line ~355) and its `startsWith(projectRoot)` guard:
    confirm requested URLs that target `website/public` assets still pass the
    guard (they do — `website/public` ⊂ repo root).

**File: `website/playground/vite-plugin-dashboard.ts`**
- line ~7: `projectRoot = resolve(import.meta.dirname, "..")`. This plugin reads
  `plan/issues` (root) AND `dashboard/` (moved). Keep `projectRoot` = repo root
  (`"../.."`); repoint dashboard references to `join(projectRoot, "website",
  "dashboard", ...)`. **Audit the whole file** for every `dashboard`/`plan`
  join and adjust: `plan/*` keeps root, `dashboard/*` gains `website/`.

**File: `website/playground/vite-plugin-adr.ts`**
- line ~62: `projectRoot = resolve(import.meta.dirname, "..")` → reads
  `docs/adr` (root). Change to `"../.."`. The `new URL("../scripts/
  build-adr-html.mjs", import.meta.url)` (line ~79) is relative to the plugin
  file at `website/playground/` → must become `"../../scripts/
  build-adr-html.mjs"`.

**File: `website/playground/vite-plugin-compiler-bundle.ts`**
- line ~79 `resolve(import.meta.dirname, "../scripts/compiler-bundle.mjs")` →
  `"../../scripts/compiler-bundle.mjs"` (scripts stays at root).
- line ~83 `resolve(import.meta.dirname, "..")` (root for `cwd` of the build) →
  `"../.."`.

**File: `website/playground/main.ts`**
- line ~15-17: `import ... from "../src/index.js" | "../src/optimize.js" |
  "../src/runtime.js"` → `"../../src/..."` (src stays at root).
- line ~28-29 `import.meta.glob(["../tests/equivalence/**", "../tests/
  ts-wasm-equivalence.test.ts"])` → `"../../tests/..."`.
- The compiler-bundle plugin's `REDIRECTED_SOURCES` set
  (`"../src/index.js"`, `"../src/optimize.js"`, `"../src/runtime.js"`) must be
  updated to the **new specifier strings** `"../../src/index.js"` etc. so the
  dev-mode redirect still matches what `main.ts` imports.
- `./examples/...`, `./wasm-treemap.js`, `./layout.js`, `./ts-lib-files.js` —
  relative within playground — unchanged.
- **grep `website/playground/main.ts` for every `"../` and `"../../` specifier
  and confirm each resolves: `../src`→`../../src`, `../tests`→`../../tests`;
  anything pointing at another playground file stays `./`.**

**File: `website/playground/layout.ts`, `wasm-treemap.ts`, `lib-loader.ts`,
`ts-lib-files.ts`, `empty-module.ts`** — grep each for `"../src`, `"../tests`,
`"../scripts`, `"../public`, `"../benchmarks` and bump root-stay targets by one
`..`. (Most are self-contained; verify.)

**File: `package.json`**
- `build:playground`: `--config playground/vite.config.ts` →
  `--config website/playground/vite.config.ts`.
- `dev`: `vite serve --config playground/vite.config.ts` →
  `--config website/playground/vite.config.ts` (the `dashboard:watch &` part is
  fine; see `dashboard` scripts below).
- `dashboard`: `node dashboard/build-data.js` → `node website/dashboard/
  build-data.js`.
- `dashboard:watch`: `node --watch ... website/dashboard/build-data.js`. The
  `--watch-path plan/issues` flags are root-relative and stay; only the script
  path changes.
- `deploy:registry-home`: `cp index.html .registry-home/index.html` →
  `cp website/index.html .registry-home/index.html`.
- `generate:feature-examples` → `scripts/generate-feature-examples.ts` writes
  `public/feature-examples.json`; see scripts section (the script's `ROOT/public`
  must move). No package.json change beyond the script itself.
- Leave `build` (uses `vite.config.lib.ts`), `test`, `test:262`, etc. untouched.

**File: `scripts/build-pages.js`** (stays at root; `ROOT = resolve(dirname,
"..")` = repo root, unchanged). Repoint moved-dir joins:
- line ~20 `DASHBOARD_DIR = join(ROOT, "dashboard")` → `join(ROOT, "website",
  "dashboard")`.
- line ~23 `PUBLIC_BENCH = join(ROOT, "public", "benchmarks", "results")` →
  `join(ROOT, "website", "public", "benchmarks", "results")`.
- line ~29 `PLAYGROUND_EXAMPLES_DIR = join(ROOT, "playground", "examples")` →
  `join(ROOT, "website", "playground", "examples")`.
- line ~244 `PUBLIC_REPORT = join(ROOT, "public", "benchmarks", "results",
  "report.html")` → `website/public/...`.
- line ~245 `PUBLIC_REPORT_SHORT = join(ROOT, "public", "benchmarks",
  "report.html")` → `website/public/...`.
- line ~346 `join(ROOT, "frame-nav-sync.js")` → `join(ROOT, "website",
  "frame-nav-sync.js")`.
- line ~358 `COMPONENTS_DIR = join(ROOT, "components")` → `join(ROOT,
  "website", "components")`.
- `PLAYGROUND_DIST = join(ROOT, "dist", "playground")` and `PAGES_DIST =
  join(ROOT, "dist", "pages")` — **unchanged** (`dist/` stays at root; the Vite
  build still emits there because `vite.config` `build.outDir` is
  `dist/playground` resolved against the repo root).
- The `DASHBOARD_DIR` derivatives (lines ~228, ~253, ~254, ~255, ~373) inherit
  the repointed `DASHBOARD_DIR`/`ROOT` — re-grep the file for any remaining bare
  `join(ROOT, "dashboard"|"public"|"playground"|"components"|"frame-nav-sync")`
  after editing and fix stragglers.
- `BENCHMARKS_RESULTS_DIR`, `TEST262_REPO_ROOT`, `EQUIV_DIR`,
  `TS_WASM_EQUIV_FILE`, `RUNS_DIR` → all root-stay, **unchanged**.
- The output artifact layout (`PAGES_DIST/...`) is unchanged → the deployed site
  URL structure and all `./`-relative refs in `index.html` keep working.

**File: `scripts/run-pages-build.mjs`** (stays at root)
- line ~18 `existsSync(resolve(ROOT, "dashboard"))` (the `hasPlanningArtifacts`
  gate) → `resolve(ROOT, "website", "dashboard")`. The `plan/` check stays.

**File: `scripts/build-adr-html.mjs`** (stays at root; output HTML is written
into the Pages artifact and references assets with `../../`):
- line ~44 `<script defer src="../../frame-nav-sync.js">` and line ~152
  `<script src="../../components/site-nav.js">` are **runtime-relative URLs in
  the generated Pages artifact** (ADR pages live at `/docs/adr/*.html`, so
  `../../` climbs to the Pages root where `build-pages.js` places
  `frame-nav-sync.js` and `components/`). The Pages artifact layout is
  unchanged → **these stay as-is**. Confirm `build-pages.js` still copies
  `frame-nav-sync.js` and `components/*` to the artifact root (it does, after the
  repoint above).

**File: `scripts/generate-feature-examples.ts`**
- line ~18 `OUT_FILE = join(ROOT, "public", "feature-examples.json")` and
  ~1169 `mkdirSync(join(ROOT, "public"))` → `website/public/...`.

**File: `scripts/generate-size-benchmarks.ts`**
- line ~26 `HELPERS_PATH = resolve(ROOT, "playground", "examples", ...)` →
  `website/playground/examples/...`.
- line ~28/30/32 `PUBLIC_PATH`/`LOADTIME_PUBLIC_PATH`/`LOADTIME_PUBLIC_DIR` =
  `resolve(ROOT, "public", ...)` → `website/public/...`.
- line ~485 `resolve(ROOT, "playground", entryPath)` → `website/playground/...`.

**File: `scripts/generate-browser-runtime-benchmarks.mjs`**
- line ~11/17/23 `resolve(ROOT, "public", ...)` and the `"public"` literal →
  `website/public/...`.

**File: `scripts/generate-wasmtime-hot-runtime.mjs`**
- line ~69 `PROGRAMS_DIR = resolve(ROOT, "public", "benchmarks", "competitive",
  "programs")` and ~74 `PUBLIC_PATH = resolve(ROOT, "public", ...)` →
  `website/public/...`.

**File: `scripts/generate-editions.ts`**
- line ~47 `OUTPUT_PATH = join(ROOT, "public", "benchmarks", "results",
  "test262-editions.json")` → `website/public/...`. (Other `test262/` joins are
  root-stay — unchanged.)

**File: `scripts/serve-report.ts`**
- line ~20 `PUBLIC_ROOT = join(ROOT, "public")` → `website/public`. (Dev-only
  report server; still update for consistency.)

**File: `scripts/jsconfig.json` and `scripts/tsconfig.json`**
- both line ~20 exclude/include `"../playground/dist"` → `"../website/playground/
  dist"`. (Editor-only; bump for correctness.)

**File: `dashboard/build-data.js` (now `website/dashboard/build-data.js`)**
- `ROOT = resolve(import.meta.dirname, "..")` (line ~12): currently → repo root.
  After the move, `import.meta.dirname` = `website/dashboard`, so `".."` =
  `website/`. But this script reads `plan/issues/**` (ROOT-relative, root-stay)
  and writes `dashboard/data/` (its own dir, moved). **Change `ROOT` to
  `resolve(import.meta.dirname, "../..")`** so `plan/` resolves; the `OUT =
  join(import.meta.dirname, "data")` (line ~13) is relative to the script's own
  dir and stays correct. Audit every `join(ROOT, ...)` in the file: all the
  `plan/*` ones must keep resolving to repo-root `plan/`.

**File: `dashboard/analytics.ts`, `dashboard/data.js`, `dashboard/index.html`**
- grep for any `../` traversal to `plan/`, `benchmarks/`, `scripts/`, `src/`.
  `data.js` is generated; `index.html` uses `./data.js` + `./data/*` (self-
  relative, fine). Adjust only genuine root-climbing refs (likely none for the
  static dashboard HTML, which fetches `./data/*`).

**File: `scripts/sprint-stats.ts` / `sprint-stats.sh` / `statusline-sprint.mjs`**
- `sprint-stats.ts` line ~15/117 writes `join(ROOT, "dashboard", "data", ...)` →
  `website/dashboard/data/...`. `sprint-stats.sh` line ~11 default
  `/workspace/dashboard/data/sprint-stats.json` → `/workspace/website/dashboard/
  data/sprint-stats.json`. `statusline-sprint.mjs` line ~15 `SPRINTS_JSON =
  join(ROOT, "dashboard", "data", "sprints.json")` → `website/dashboard/...`.
  (These feed the dashboard data the Pages build copies; must move together.)

### CNAME note (Pages custom domain)

There are **two** CNAME mechanisms; the move must not break either:
1. **Source `CNAME` at repo root** (16 bytes, `js2.loopdive.com\n`). Move to
   `website/CNAME` per the issue.
2. **`build-pages.js:355` UNCONDITIONALLY writes** `dist/pages/CNAME` =
   `"js2.loopdive.com\n"`. This is what actually ships in the Pages artifact
   (`deploy-pages.yml` uploads `dist/pages`). So the deployed custom domain does
   **not** depend on the source `CNAME` file's location at all — it's
   regenerated. Moving source `CNAME` to `website/CNAME` is cosmetic/safe; the
   live domain survives via the build-pages write. **Do not remove the
   `build-pages.js` CNAME write.** Verify after build that `dist/pages/CNAME`
   exists and reads `js2.loopdive.com`.

### `.github/workflows/deploy-pages.yml`

- The workflow uploads `path: dist/pages` (line ~80) — **unchanged**, since
  `dist/` stays at root and `build:pages` still emits there.
- The baseline-fetch step writes into `public/benchmarks/results` and
  `benchmarks/results/runs` (lines ~45-52). `benchmarks/` stays at root.
  **`public/` moves**, so `mkdir -p public/benchmarks/results` and the three
  `cp ... public/benchmarks/results/...` lines must become `website/public/
  benchmarks/results/...`. Verify `build-pages.js` `PUBLIC_BENCH` (repointed to
  `website/public/...`) reads the same location the workflow now writes.
- **CODEOWNERS covers `.github/workflows/`** — editing `deploy-pages.yml`
  triggers a code-owner review requirement on the PR. Flag to tech-lead; the
  dev cannot self-merge a workflow edit without the owner approval the branch
  protection requires. (See `docs/ci-policy.md`.) Keep this edit minimal and
  isolated so review is fast.

### Other workflows / configs to grep (do NOT assume zero)

Before pushing, run a repo-wide grep for stragglers and fix any that target the
moved dirs from a root-relative position:

```bash
grep -rnE '(^|[^./])(["'\''( ]|/)(public|dashboard|components|playground|frame-nav-sync\.js|index\.html)' \
  .github/ scripts/ *.json *.ts *.mjs *.cjs vite.config.lib.ts vitest.config.ts \
  | grep -vE 'node_modules|/website/|playground-data|playground-benchmark|dist/|test262|\.test\.|public access'
```

Pay special attention to: `.github/workflows/*.yml` (benchmark-refresh,
test262-sharded — check for `public/` or `dashboard/` writes), `vitest.config.ts`
(confirm it does not include/exclude `playground/` by a root-relative path —
if it references `playground/**`, bump to `website/playground/**`),
`.gitignore`/`.npmignore`/`.gitattributes` (any `public/`, `dashboard/`,
`playground/dist`, `frame-nav-sync` entries → prefix `website/`),
`.prettierignore`, `biome.json`, `tsconfig.json` include/exclude globs.

### Verification plan (run in order from repo root)

1. `pnpm install` (no-op; ensures lockfile unaffected).
2. `pnpm run build:compiler-bundle` — produces `scripts/compiler-bundle.mjs`
   (consumed by the playground build/dev).
3. `pnpm run build:playground` — **must succeed** and emit `dist/playground/`
   with `index.html` (landing) + `playground/index.html`. Confirm
   `dist/playground/frame-nav-sync.js` was copied (frameNavSyncPlugin) and the
   public assets (svg logos, `wasm-treemap.html`, `issues-graph.html`) are
   present.
4. `pnpm run dashboard` — regenerates `website/dashboard/data/*.json` from
   `plan/issues/**`; confirm it reads issues and writes into the moved dashboard.
5. `pnpm run build:pages` — **must succeed**; then assert on `dist/pages/`:
   - `dist/pages/CNAME` exists and == `js2.loopdive.com`.
   - `dist/pages/index.html` exists; `dist/pages/playground/index.html` exists.
   - `dist/pages/dashboard/index.html` + `dist/pages/dashboard/data/` exist
     (dashboard still bundled).
   - `dist/pages/components/site-nav.js` exists; `dist/pages/frame-nav-sync.js`
     exists.
   - `dist/pages/benchmarks/results/*.json` exist (sidebar, loadtime, size,
     test262-report) — confirms the moved `website/public` bench files were read.
   - `dist/pages/examples/` exists (from `website/playground/examples`).
6. `pnpm run dev` smoke (optional, time-boxed): start, load `/` and
   `/playground/`, confirm no 404s in console for `src`-bundle, examples, or
   public assets; Ctrl-C.
7. `pnpm run typecheck` — catches any broken relative import in `main.ts` /
   plugins / scripts.
8. `pnpm run lint` (`quality` CI check) — must pass.
9. Grep guard (must return nothing): re-run the straggler grep above and
   confirm no root-relative refs to moved dirs remain outside `website/`.

### One-PR discipline & risk flags

- **Land as ONE PR.** Splitting the `git mv` from the path edits leaves `main`
  with a broken build between commits.
- **CODEOWNERS / `.github/workflows/deploy-pages.yml`**: the workflow edit
  requires code-owner approval — **escalate to tech-lead before merge**; a dev
  cannot self-merge it. Consider asking tech-lead whether the `deploy-pages.yml`
  `public/` path edit should be a separate owner-reviewed commit *within* the
  same PR.
- **Large diff / merge-conflict risk**: this touches `scripts/`, `package.json`,
  and the whole `playground/`/`dashboard/`/`public/` trees. Coordinate timing
  with #1583 and #1590 (both touch the frontend). Merge `origin/main` into the
  branch immediately before pushing; planning-artifact conflicts under
  `website/dashboard/data/` resolve via regen (`pnpm run dashboard`).
- **Do not touch** root `vite.config.ts`, `vite.config.lib.ts`, `src/`,
  `tests/`, `benchmarks/` source — only their *references* from moved files.
- **`dist/` stays at root** — the Pages artifact layout is byte-for-byte the
  same, so all runtime `./`-relative URLs in `index.html` and ADR pages keep
  working without edits.
