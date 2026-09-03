---
id: 5298
title: "check:ir-kind-neutrality baselines derived `file:line` cites, so any edit above a quote breaks `quality` on unrelated PRs"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: tooling
area: ci
goal: backend-agnostic-ir
related: [5289, 3518]
requested_by: ttraenkler/orchestrator
---

# A robust check with a brittle record

Rule R2 of `scripts/check-ir-kind-neutrality.mjs` (line ~108) is sound: each
verdict's evidence is a `{file, quote}` pair and the gate fails only when the
**quote** is gone from the file — the verdict was derived from something that
no longer exists, so it must be re-derived.

The record is what is brittle. Line 1059 converts every surviving quote into a
derived cite, `${cite.file}:${lineOf(text, at)}`, and those strings are what
`scripts/ir-kind-neutrality-baseline.json` stores under `evidence`
(e.g. `"evidence": ["src/ir/dialect/js.ts:722", "src/ir/integration.ts:7347"]`
for `forof.string`) and what the verdict-table comparison diffs against.

Measured on PR #5525 (#5289): the PR added **14 comment lines** to
`resolveModuleBindingGlobal` in `src/ir/integration.ts` (~line 5740), the
`forof.string` quote at line 7347 moved to 7361, and `quality` went red with a
"verdict table mismatch" — on a PR that changed no instruction kind, no
verdict, and no count (total 85 / neutral 55 / js 27 / unresolved 3, all
unchanged). The fix was a one-line baseline re-citation, plus a prettier pass
because the gate's `--update-on-decrease` writer emits expanded arrays while
the committed file is prettier-compact (raw output fails the format lane).

Cost: one full CI cycle per affected PR, and every future PR editing
`src/ir/integration.ts` or `src/ir/dialect/js.ts` above a cited quote pays
it again. Both files are on the R-spine's hot path.

## Fix

Store and compare the evidence by **identity of the quote**, not by its
current line:

- Baseline `evidence` entries become `file#<stable-key>` where the key is the
  quote itself (or a short hash of it); the line is still computed and printed
  in diagnostics, never persisted.
- The verdict-table comparison ignores line drift when the quote resolves.
- The writer runs prettier (or emits prettier-compatible compact arrays) so
  `--update-on-decrease` output is committable as-is.
- One migration of the committed baseline, done by the tool, in the same PR.

## Acceptance criteria

1. Reproduce first: on a scratch branch, insert a blank comment line above the
   `forof.string` quote in `src/ir/integration.ts`; the gate must go red on
   base and **green** after the fix, with the verdict table byte-identical.
2. A genuinely removed quote still fails with the R2 message (pinned test in
   `tests/` red if the check is weakened).
3. `npm run -s check:ir-kind-neutrality -- --update-on-decrease` output passes
   `prettier --check` without a manual pass.
4. No verdict, count, or ratchet value changes in the migrated baseline
   (field-by-field diff recorded in the PR body).
