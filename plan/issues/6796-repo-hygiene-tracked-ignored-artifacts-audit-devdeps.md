---
id: 6796
title: "repo hygiene: 259 MB tracked — an 18 MB jsonl CLAUDE.md says is no longer committed, `binaryen.js` twice (28 MB), 29 npm tarballs (22 MB), 437 stale ci-status JSONs, `.tmp/` files despite .gitignore, a raw NUL byte in a source file; 3 critical audit advisories; 23 devDeps with zero src imports"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
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
