---
id: 6795
title: "docs: README/STATUS/ROADMAP contradict their own numbers and the code (standalone 85.9 % 'trails' host 81.3 %; eval/Proxy/Temporal listed unsupported; wrong package name), CHANGELOG stops at 0.52 on a 0.71 package, CLAUDE.md names files and flags that do not exist"
status: done
assignee: "ttraenkler/claude-dev-6795"
branch: "claude/issue-6795-docs-sync"
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
completed: 2026-10-02
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

## Implementation Plan

Three commits, checkpoint-pushed, matching the three Correction parts.

1. **Generated conformance claims** — `scripts/sync-conformance-numbers.mjs`:
   - `STATUS.md` joins `TARGETS` (required `conformance` block).
   - New opt-in anchor pairs (a file without the pair is skipped, a file that
     carries it and lacks the data is an error): `conformance-standalone`
     (existing, now also STATUS/ROADMAP), `conformance-scope` (the denominator
     and its standard / Annex B / proposal split, computed, and worded
     differently if the standalone total ever diverges from the host total) and
     `conformance-areas` (a prettier-padded per-area table from the
     `categories` array of `test262-current.json`, plus rows for eval, Proxy,
     Reflect, Temporal, SharedArrayBuffer, Atomics, WeakRef,
     FinalizationRegistry; a category missing from the report skips its row
     with a warning rather than reddening every PR). `processStandaloneFile`
     became the generic `processOptionalBlock`.
   - Prose deleted from README/STATUS/ROADMAP: every "trails" / "meaningfully
     lower" / "Lower today" / "~75 %" / "Last updated: July 2026", the 43,106
     denominator, "CI runs this sharded on every PR", the eval / `with` / Proxy
     / WeakRef / SharedArrayBuffer / Temporal "unsupported" lists (replaced by a
     "Gaps" list that points at the generated table), `import ... from "js2wasm"`
     (the package is `@loopdive/js2`), `npm install js2wasm`, and the README FAQ
     claim that WASI uses the linear backend (`wasi` is WasmGC; linear is
     `target: "linear"`). ROADMAP's CLI flag names (`--nativeStrings`, `--target wasi`, `--optimize`) were corrected too.
   - The four `git add` lines in `baseline-summary-sync.yml` (x2),
     `refresh-baseline.yml` and `test262-sharded.yml` now stage `STATUS.md`;
     without that, main would drift from the JSON after the first merge.
2. **CHANGELOG** — one-pass generator (not committed; one-shot) over
   `git tag` + first-parent `Merge pull request` titles per tag range, for the 23
   tags v0.56.0..v0.71.0; the four stale `Unreleased` items moved into the
   release that first shipped them (found by tag ancestry of the introducing
   commits); the hand-written "Current test262 status" block (31.5 %, `/Users/…`
   paths) replaced by a pointer to STATUS.md. `scripts/release.mjs` gained
   `hasChangelogEntry()` and refuses before touching anything when the target
   version has no `## vX.Y.Z` heading; `docs/releasing.md` gained step 0.
3. **CLAUDE.md** — the six items, each re-verified against the tree first
   (see Resolution), plus `scripts/check-claude-md-paths.mjs`
   (`check:claude-md-paths`, a `quality` step in `ci.yml` after `check:issues`).

## Resolution

**Done.** Branch `claude/issue-6795-docs-sync`; no `src/` change.

### README / STATUS / ROADMAP

| Before | After |
| --- | --- |
| README host 81.3 % vs standalone 85.9 % with "trails" / "meaningfully lower" / "Lower today" | both lines generated; no sentence compares them |
| denominator printed as 43,106 beside 48,232 | one generated sentence: 48,232 = 47,146 standard + 1,086 Annex B, 503 proposals excluded |
| ROADMAP "currently ~75 %", "Last updated: July 2026" | removed; ROADMAP carries the generated host + standalone + scope blocks |
| eval / Proxy / Temporal / WeakRef / SAB "not yet supported" | generated per-area table in STATUS.md (e.g. Proxy 241/311, Temporal 3,397/4,603 at the 2026-10-02 baseline) + a "Gaps" list pointing at it |
| `import { compile } from "js2wasm"` | `@loopdive/js2` |

Findings that differ from the issue text, from reading the tree:
- `with` is **implemented** (`src/codegen/with-scope.ts`), so it is no longer
  listed as unsupported. The issue's per-feature figures (eval-code 526/816,
  Temporal 1,221/4,524, ...) do not match the committed baseline (307/347,
  3,397/4,603); the table uses the baseline and there is no `with` row because
  the report has no `language/statements/with` category.
- The per-area rows sum to 48,735 (they include the 503 proposal-stage files), not
  the 48,232 headline; the table's caption says so, computed.
- The standalone figure (85.9 %) is above the host figure (81.4 %); both are
  printed as measured, with no comment either way.

### CHANGELOG

- Entries for all 23 tags v0.56.0 .. v0.71.0 (incl. patch tags 0.59.1-0.59.5,
  0.60.1, 0.64.1). **v0.53.0-v0.55.0 were never tagged** and `package.json`
  stayed 0.52.0 until v0.57.0, so there is nothing to generate for them; the
  v0.56.0 entry says so. Each entry: tag range, compare link, PR counts, the
  test262 artifact at the tag, newest 20 feature / 10 fix PR titles with PR
  links, links to existing `docs/release-notes/` / `docs/releases/` files.
- `docs/releases/` held **no** local paths (grepped); the `/Users/thomas/...`
  links were in CHANGELOG.md itself and are gone.
- `release.mjs` refusal covered by `tests/issue-6795-changelog.test.ts`
  (unit cases for whole-token matching, an end-to-end refusal in a throwaway
  git repo, and a guard that every tag and the current `package.json` version
  have an entry).

### CLAUDE.md — six items, verified before editing

| Item | State on this checkout | Action |
| --- | --- | --- |
| `tests/equivalence.test.ts` | already fixed on main by #6785 (`tests/equivalence/`, `scripts/equivalence-gate.mjs`) | none; the new gate would catch a regression |
| `test262-baseline-validate.yml` | cited, file absent | now `pnpm run test:262:validate-baseline`, a manual tool (`docs/ci-policy.md`) |
| `bgIsolation` "worktree ... `none` removed" | `.claude/settings.json:270` is `"none"` | states the committed value, says to read the file, keeps the "always pass `isolation: worktree`" rule |
| `--nativeStrings` | not parsed by `src/cli.ts` | CLI Flags rewritten from `--help` (`--target <t>`, `--standalone`, `--utf8-storage`); `nativeStrings` described as a compile option |
| `STRICT_IR_REASONS` promotion | doc said "zero => add"; code (`src/codegen/index.ts:2222-2247`) says necessary, not sufficient | doc now states the code's bar |
| auto-enqueue `{CLEAN, HAS_HOOKS}` | `mergeStateStatus` not consulted (#4094); `ENQUEUEABLE` dead | both places reworded: draft / hold / `mergeable` / zero failing checks / required checks green |

The gate's first run on main found 8 more dangling references, all fixed in
CLAUDE.md: `src/foo.ts` (an illustrative A/B example, now
`src/codegen/peephole.ts`), `benchmarks/results/report.html`
(`website/public/benchmarks/results/`), `plan/milestones/` (gone),
`website/npm-compat.html` (`website/public/`), `playground/examples/`
(`website/playground/examples/`), and two deleted workflows named in prose
(`refresh-committed-baseline.yml`, `queue-unstick.yml`; reworded).

**`<!-- historical -->` uses: 0** in CLAUDE.md (a test caps it at 3).

Gate scope decisions: flags are checked only in the `## CLI Flags` section
(every other `--flag` in CLAUDE.md belongs to git, pnpm, gh or a script, not
`cli.ts`); a bare `name.yml` is read as `.github/workflows/name.yml` (with a
repo-root fallback for `pnpm-lock.yaml`); existence means "known to git"
(tracked, or untracked and not ignored) so a gitignored local file cannot pass
here and fail in CI.

### Tests added

`tests/issue-6795-conformance-blocks.test.ts` (19), `tests/issue-6795-changelog.test.ts`
(10), `tests/issue-6795-claude-md-paths.test.ts` (19); `tests/issue-3947.test.ts`
fixture gained `STATUS.md`. 71 tests across these and the related
`issue-4211` / release tests pass.

### Gates (bare, exit codes)

`check-loc-budget` 0, `check-func-budget` 0, `check-coercion-sites` 0,
`check:oracle-ratchet` 0, `check:dead-exports` 0, both with
`LOC_GATE_BASE=origin/main` 0, `typecheck` 0, `format:check` 0,
`check-compiler-boundaries --mode inventory` 0, `check:ir-dialect` /
`ir-kind-neutrality` / `jstag-seam` / `ir-layering` / `codegen-fallbacks` /
`any-box-sites` / `speculative-rollback` / `stack-balance` / `pushraw` /
`host-import-policy` / `ir-only` / `ir-adoption` / `issues` /
`done-status-integrity` / `issue-spec-coverage` / `harness-compile-budget` /
`verdict-oracle` / `claude-md-paths` / `lint` all 0, `check:ir-fallbacks` 0,
`sync:conformance:check` 0. No budget allowances were needed.

### Left out on purpose

- ROADMAP's targets ("Near-Term: >=80 %", "Medium-Term: 85 %") are PO-owned and
  untouched; the near-term target is already met by the generated figure, which a
  PO should re-set.
- ROADMAP's hand-written "69 development sprints / 2,700+ merged pull requests"
  and the benchmark snapshot were not in the issue and are untouched.
- Flags outside `## CLI Flags` and bare script names (no directory) are not
  checked by the CLAUDE.md gate.
