---
id: 6796
title: "repo hygiene: 259 MB tracked — an 18 MB jsonl CLAUDE.md says is no longer committed, `binaryen.js` twice (28 MB), 29 npm tarballs (22 MB), 437 stale ci-status JSONs, `.tmp/` files despite .gitignore, a raw NUL byte in a source file; 3 critical audit advisories; 23 devDeps with zero src imports"
status: in-progress
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
assignee: "ttraenkler/claude-dev-6796"
branch: "claude/issue-6796-repo-hygiene"
priority: medium
horizon: m
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: maintainability
related: [916, 1528, 6795]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H23/H24/#MEDIUM"
---

# #6796 — one hygiene PR

Measured 2026-09-30 on HEAD `e303c5c7`: 14,567 tracked files, 259.7 MB.

## Tracked but ignored / duplicated

| path | size | note |
|---|---|---|
| `benchmarks/results/test262-current.jsonl` | 18.0 MB | matched by `.gitignore:41/153`; CLAUDE.md "Baseline JSONL is no longer committed (#1528)" |
| `loadtime/binaryen.js` (two copies) | 14.8 + 13.5 MB | one source, one symlink or build step |
| 7 files byte-identical between `benchmarks/results/` and `website/public/benchmarks/results/` | 2.05 MB | copy at build (`build:pages`), not in git |
| 29 npm tarballs in `tests/dogfood/fixtures/` | 22 MB | same versions as devDependencies (`three@0.185.1`, `webpack@5.109.2`, `react-dom@19.2.6`, `prettier@3.8.1`) — fetch from the lockfile at test time |
| 437 `.claude/ci-status/pr-*.json` | 1.8 MB | the feed is retired (CLAUDE.md); writer workflows are `workflow_dispatch` stubs (`ci-status-basic/feed/pending.yml`) |
| 19 `.tmp/*.mjs` | — | despite `.gitignore:79` |
| the #3518 and #6651 issue files (`3518-ir-only-default-and-direct-frontend-retirement.md`, `6651-es2015-standalone-100pct-execution-plan.md`) | 1.13 + 1.32 MB | issue files carrying logs; move logs to `plan/agent-context/` or `.tmp/` |

Also `src/codegen/nonnull-proof.ts:173` contains a **raw NUL byte** inside a
template literal (`${q.fnKey}<NUL>${simple}`); `grep` and `file` treat the
source as binary. Write `\0`.

## Dependencies

- `pnpm audit` (2026-09-30): **3 critical / 48 high / 72 moderate / 9 low**
  (131 advisories), all devDependencies (the only runtime dep is
  `typescript`). Critical: `decompress` via `@bytecodealliance/componentize-js`;
  `vitest < 3.2.6`. `hono` alone: 13.
- 23 of 44 devDependencies have **zero `src/` imports** (react, react-dom,
  react-test-renderer, create-react-class, prop-types, redux,
  styled-components, tailwindcss, three, webpack, jest, moment, hono, lit,
  lodash, lodash-es, axios, uuid, marked, jsdom, stylelint,
  web-streams-polyfill, deno) — dogfood fixtures. `monaco-editor` / `shiki` /
  `ts-morph` / `componentize-js` are website/scripts only.
- `peerDependencies` on `bun >= 1.3.14` and `deno >= 2.8.1` (optional):
  runtimes declared as library peers; unused in `src/`.

## Correction

1. `git rm --cached` the ignored paths; add `loadtime/binaryen.js` dedupe and
   the website results copy to the pages build; move the tarballs to a
   lazily-populated `tests/dogfood/.fixtures/` fetched by
   `tests/dogfood/*harness.mjs` from the lockfile versions (`pnpm store` has
   them).
2. Delete the three `ci-status-*.yml` stubs and `.claude/ci-status/`.
3. `pnpm audit --fix` for the criticals; bump `vitest`; open a follow-up for
   `componentize-js` if no fixed version exists.
4. Move dogfood devDeps into `packages/dogfood-fixtures/package.json` (a
   workspace already exists) so the root `package.json` lists only what the
   build and tests of the compiler need; replace `bun`/`deno` peers with an
   `engines` note in README.
5. Add a CI guard: `git ls-files | git check-ignore --stdin` must be empty.

## Acceptance

- `git ls-files -z | xargs -0 du -cb | tail -1` drops by ≥ 60 MB; the
  check-ignore guard passes.
- `pnpm audit --audit-level=critical` exits 0.
- `pnpm install` at the root pulls no React/three/webpack unless the dogfood
  workspace is installed.
- `grep -c $'\x00' src/**/*.ts` finds nothing.

## Implementation Plan

Executed 2026-10-02 on `claude/issue-6796-repo-hygiene`, one commit per step,
lowest risk first. Before removing any tracked file its basename was grepped
across `scripts/ .github/ website/ tests/ package.json vite*.ts docs/ .claude/`;
anything read at build/test time stayed and is listed under Resolution.

1. **Raw NUL bytes** → `\0` escapes. A byte scan found 11 in six `src/` files
   (not only `nonnull-proof.ts`): `runtime-eval.ts`, `codegen/regexp-standalone.ts`,
   `codegen/nonnull-proof.ts`, `codegen/host-import-allowlist.ts`,
   `codegen/regex/unicode.ts`, `codegen/context/errors.ts`. None is followed by a
   digit, so the escape yields the identical string.
2. **Retired CI feed and `.tmp/`**: deleted `.claude/ci-status/` (436
   `pr-*.json` + README) and the three `workflow_dispatch`-only
   `ci-status-{basic,feed,pending}.yml` stubs; `git rm --cached` the 19
   `.tmp/*.mjs`. `docs/ci-policy.md`'s bypass scope for ci-status bot commits now
   says it is retired.
3. **`test262-current.jsonl`**: NOT removed (see Resolution).
4. **binaryen.js twin**: untracked and gitignored
   `website/public/benchmarks/results/loadtime/binaryen.js` (a stale 2025 build).
   `scripts/generate-size-benchmarks.ts` (run by `build:pages`) copies
   `node_modules/binaryen/index.js` into it and into the committed
   `benchmarks/results/loadtime/binaryen.js`; the latter is the one
   benchmark-refresh.yml stages, benchmark-lifecycle.mjs requires and
   build-pages.js publishes.
   Also untracked seven ignored, unreferenced run logs in `benchmarks/results/`
   (`2026-04-10T17-18-28-260Z.{json,md}`, five `test262-2026-03-09T*.txt`).
5. **The 7 byte-identical public twins**: NOT removed (see Resolution).
6. **Logs in #3518 / #6651**: moved verbatim to `plan/agent-context/3518-log.md`
   and `plan/agent-context/6651-log.md`, located by exact heading text. Each
   issue keeps frontmatter, definition and newest records (where open PRs 6405
   and 6422 still write); a pointer section lists every moved heading.
7. **CI guard**: `scripts/check-tracked-ignored.mjs` → `pnpm run
   check:tracked-ignored`, wired into ci.yml `quality` after the dead-export
   gate. Runs `git ls-files -z | git check-ignore -z -v --stdin --no-index`,
   drops `!`-negation matches, fails on anything off a dated 15-entry allow-list
   and on stale allow-list entries. `tests/issue-6796-tracked-ignored.test.ts`.
8. **Audit**: `vitest` `^3` → `^3.2.6` (lockfile 3.2.4 → 3.2.7, only vitest and
   `@vitest/*` moved).
9. **Peers**: removed `bun`/`deno` from `peerDependencies(Meta)` (nothing in
   `scripts/` or `.github/` reads peers; both stay devDependencies); README notes
   the Node ≥ 20 requirement and that Deno/Bun are only for the optional
   standalone-CLI compile steps.

## Resolution

Status stays **in-progress**: three of the four acceptance bullets need the
carve-outs below, each of which changes how CI installs or reads baselines and
needs its own PR with CI evidence.

| measure | before | after |
|---|---:|---:|
| tracked bytes (`du -cb`, summed over all xargs chunks) | 294,770,234 | 279,591,554 (−15.2 MB) |
| tracked files | 15,116 | 14,653 (−463) |
| tracked-and-ignored paths (current .gitignore) | 57 | 31, all on the dated allow-list |
| `pnpm audit` critical / high / moderate / low | 3 / 48 / 73 / 9 | 2 / 48 / 73 / 9 |
| raw NUL bytes under `src/` | 11 in 6 files | 0 |
| #3518 issue file | 1,534,268 B | 417,434 B |
| #6651 issue file | 1,324,823 B | 177,170 B |

Measurement note: the acceptance command `git ls-files -z | xargs -0 du -cb |
tail -1` prints only the LAST xargs chunk's total (51 MB here), not the repo
total; the figures above sum every chunk's `total` line. Likewise
`grep -c $'\x00'` matches every line (bash cannot pass a NUL argument); the scan
used `grep -P '\x00'` and a Python byte check.

Gates (all exit 0): check-loc-budget, check-func-budget (also with
`LOC_GATE_BASE=origin/main`), check-coercion-sites, check:oracle-ratchet,
check:dead-exports, typecheck, format:check, lint, compiler-boundaries inventory
(no unclassified module), check:ir-dialect, check:ir-kind-neutrality,
check:jstag-seam, check:ir-layering, check:codegen-fallbacks, check:any-box-sites,
check:speculative-rollback, check:stack-balance, check:pushraw,
check:host-import-policy, check:ir-only, check:ir-adoption, check:issues,
check:done-status-integrity, check:issue-spec-coverage,
check:harness-compile-budget, check:verdict-oracle, check:tracked-ignored,
check:ir-fallbacks.
Tests (single fork): equivalence-gate, issue-6796-tracked-ignored,
benchmark-lifecycle, issue-3520-runtime-consumer-wiring all pass;
issue-4519/3192/1921 have three failures that are identical on the unmodified
base (pre-existing, not caused by the NUL change).

Deliberately left out — follow-ups:

- **`benchmarks/results/test262-current.jsonl` (18 MB) stays tracked.**
  test262-sharded.yml's `Compare against current main baseline` step runs on
  `push`/`workflow_dispatch` too, but only fetches the baseline from
  js2wasm-baselines on `pull_request`/`merge_group`; on a push it would hit
  "Missing baseline JSONL" (exit 2). `generate-editions.ts` (build:pages) and
  `website/dashboard/build-data.js` also fall back to it. Fix those readers to
  fetch first, then untrack.
- **The 7 public twins (2.05 MB) stay.** npm-compat-refresh/promote,
  baseline-summary-sync, refresh-baseline and the test262 promote job write and
  `git add` the `website/public/` copies explicitly, and
  `check-npm-compat-promotion.mjs` / `sync-test262-report-mirrors.mjs` require
  them. Moving the copy to `build:pages` means changing all of those together.
- **Remaining 2 critical advisories**: `decompress` ≤ 4.2.1 has no patched
  release; it arrives via `@bytecodealliance/componentize-js` 0.20 →
  `@bytecodealliance/weval` 0.4.1. componentize-js 0.23 / weval 0.5 drop it, but
  weval 0.5 also changes the weval binary the StarlingMonkey AOT benchmark lane
  (`generate-wasmtime-hot-runtime.mjs --aot`) downloads; needs a
  benchmark-refresh run as evidence.
- **Dogfood tarballs (22 MB) and the 23 dogfood devDeps**: not attempted, per
  the dispatch brief — both change how CI installs.
- **Allow-listed tracked-and-ignored paths** worth revisiting:
  `website/dashboard/data.js` + `data/` (2.8 MB, generated by build-data.js),
  `tests/test-1014-regression-debug.test.ts` (rename out of the debug pattern).
- `.claude/settings.json`'s FileChanged hook and
  `.claude/hooks/ci-status-watcher.sh` are now inert; `scripts/local-test262-merge.sh`
  counted null-conclusion ci-status stubs as in-flight CI (it read 45 stale
  stubs, now 0).
- Raw NUL bytes remain in `tests/issue-3176.test.ts`,
  `tests/issue-6430-fromcharcode-spread.test.ts` and three `scripts/` files
  (outside this issue's `src/` acceptance).
