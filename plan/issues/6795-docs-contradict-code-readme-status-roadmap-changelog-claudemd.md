---
id: 6795
title: "docs: README/STATUS/ROADMAP contradict their own numbers and the code (standalone 85.9 % 'trails' host 81.3 %; eval/Proxy/Temporal listed unsupported; wrong package name), CHANGELOG stops at 0.52 on a 0.71 package, CLAUDE.md names files and flags that do not exist"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: m
feasibility: easy
reasoning_effort: low
task_type: docs
area: docs
language_feature: n/a
goal: contributor-readiness
related: [885, 6794, 5230]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H22/#8/#5"
---

# #6795 — generate the numbers, delete the prose, or keep both honest

Every item below was checked against HEAD `e303c5c7` on 2026-09-30.

## README.md / STATUS.md / ROADMAP.md

- README line 16 prints host **39,229 / 48,232 (81.3 %)**; line 24 prints
  standalone **41,410 / 48,232 (85.9 %)**; line 69 then says the standalone
  path is "meaningfully lower than the JS-host path" and line 286 says it
  "trails". STATUS/ROADMAP repeat "trails". The numbers say the opposite.
- ROADMAP: "currently ~75 %", "Last updated: July 2026".
- README: "scored against the 43,106 official tests" — the denominator
  printed above is 48,232.
- README: "CI runs this sharded on every PR" — `test262-sharded.yml` header
  "(#4153) The shard matrix does NOT run at PR time"; shard job
  `if: github.event_name == 'merge_group'`.
- README FAQ: "keeps a linear-memory backend for WASI-oriented targets" —
  `src/index.ts:526` maps `wasi` to WasmGC; linear is `target: "linear"` (see #6793).
- README: `import { compile } from "js2wasm"` — the package is `@loopdive/js2`.
- README/STATUS "not yet supported": eval, Proxy, WeakRef, SharedArrayBuffer,
  Temporal; STATUS says the eval fallback is "not a shipped feature".
  Code: `src/interp` (6,408 lines), `docs/runtime-eval-interpreter.md`
  ("Tiers 0/1/3 landed"), `src/temporal-provider.ts`; tracked host-lane
  passes: `language/eval-code` 526/816, Temporal 1,221/4,524, Proxy 67/311,
  `with` 16/181, WeakRef 18/29, SharedArrayBuffer 34/104.

## CHANGELOG.md (published in `files`)

`## Unreleased` then sprint sections ending `## Sprint 52 - v0.52.0`; no
0.53–0.71 entries; `package.json` / `jsr.json` = 0.71.0. `docs/releases/`
stops at 0.61.0; its "Current test262 status" reads **15,155 / 48,174 =
31.5 %** (2026-03-31) and links `/Users/thomas/Documents/…/ts2wasm/…` local
paths.

## CLAUDE.md (~60 KB)

- `tests/equivalence.test.ts` named as "main" and in the run command — the
  file does not exist (`tests/equivalence/`, 223 files; see #6785).
- `.github/workflows/test262-baseline-validate.yml` cited as the per-PR
  validator — missing.
- "`bgIsolation` is `worktree` … the `none` unblock has been removed" —
  `.claude/settings.json:270` is `"bgIsolation": "none"`.
- CLI Flags lists `--nativeStrings` — not parsed by `src/cli.ts`.
- "IR Fallback Budget": "Once a bucket hits zero, the rejection reason gets
  added to `STRICT_IR_REASONS`" — `src/codegen/index.ts:2222-2247` states the
  opposite (corpus-zero is necessary, not sufficient) with a reasoned
  promotion bar. The code is right; the doc is wrong.
- The auto-enqueue description ("takes only {CLEAN, HAS_HOOKS}; UNSTABLE
  excluded") — `scripts/enqueue-green-prs.mjs:319-322, 1276`:
  `mergeStateStatus` is "deliberately NOT a parameter" (#4094); `ENQUEUEABLE`
  (`:114`) is dead code. Effect preserved (any failing check → ineligible),
  reason wrong.

## Correction

1. README/STATUS/ROADMAP: replace every hand-written conformance figure and
   "unsupported" list with output of `scripts/sync-conformance-numbers.mjs`
   (it already exists with a `--check` mode wired into CI — extend it to
   cover the standalone line, the denominator, and a per-area table derived
   from `benchmarks/results/test262-current.json`), and delete the prose
   comparisons that can go stale ("trails", "~75 %").
2. CHANGELOG: generate from `git tag` + PR titles for 0.53–0.71 in one pass
   (`scripts/release.mjs` should append on every release thereafter — make
   `publish-release` refuse without a CHANGELOG entry). Purge local paths
   from `docs/releases/`.
3. CLAUDE.md: fix the six items above; add `node scripts/check-claude-md-paths.mjs`
   that greps every backticked path/flag in CLAUDE.md and fails when it does
   not exist (paths: file exists; flags: appear in `cli.ts --help`).

## Acceptance

- `pnpm run sync:conformance:check` fails when README numbers drift from the
  JSON (extend the test in `tests/` for it).
- README has no sentence comparing the two lanes that is not generated.
- CHANGELOG has an entry per tag from 0.53.0 to 0.71.0.
- The CLAUDE.md path check passes on main.
