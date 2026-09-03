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

## Implementation Plan

Written 2026-09-03 by the Fable lane from a read of
`scripts/check-ir-kind-neutrality.mjs` at `origin/main` `68246a740c`. Line
numbers below are from that revision.

### Where the line leaks in

| site | what it does today | brittle part |
| --- | --- | --- |
| L1042-1060 (R2 loop) | finds each `cite.quote` in `cite.file`; on hit pushes `` `${cite.file}:${lineOf(text, at)}` `` | the pushed string carries the **derived** line |
| L1076-1084 (`table[kind]`) | persists `declaredAt: `${info.file}:${info.line}`` and `evidence: cites` | both fields are line-bearing |
| L1181-1183 (`sameTable`) | `JSON.stringify({ratchet, counts, kinds: table})` on both sides | any line drift ⇒ "verdict table no longer matches" ⇒ `quality` red |
| L1131-1134 (`write`) | `JSON.stringify(computed, null, 2)` | expanded arrays; committed baseline is prettier-compact, so raw output fails `format:check` |

`info.line` comes from the population scan of `src/ir/nodes.ts` /
`src/ir/dialect/js.ts` (the `readonly kind` discriminant's line) and is
just as brittle as the evidence cites: a comment added above any interface
in `js.ts` moves every `declaredAt` below it.

### Change (one file + one tool-written baseline migration)

1. **Split "what we compare" from "what we print".** Keep a `report` view
   with lines for the console output (L1198+), and build the persisted
   `table[kind]` from **stable keys only**:
   - `declaredAt: `${info.file}#${info.interface}`` — the interface name is
     the stable identity of the declaration site (`info.interface` already
     exists, see L1013).
   - `evidence: [`${cite.file}#${shortHash(cite.quote)}`]` where
     `shortHash` is the first 12 hex chars of `sha1(cite.quote)`; a quote
     that survives verbatim hashes identically wherever it sits. Keep the
     `(absent from …)` cite string as is — it has no line.
2. **`sameTable` (L1181) compares the stable table.** Nothing else about R1–R4
   changes: R2 still fails on a missing quote (L1051-1057) and still needs
   ≥1 cite (L1061).
3. **Writer emits prettier-compatible JSON.** Replace `JSON.stringify(computed,
   null, 2)` with a pass through prettier's API (`prettier.format(json, {
   parser: "json", ...resolvedConfig })` — prettier is already a dev
   dependency) so `--update` / `--update-on-decrease` output commits as-is.
   If importing prettier into the script is unwelcome, run
   `pnpm exec prettier --write scripts/ir-kind-neutrality-baseline.json`
   from the script via `child_process.execFileSync` — either way the gate
   owns the format of the file it writes.
4. **Migrate the committed baseline with the tool**, never by hand:
   `pnpm run check:ir-kind-neutrality -- --update` on the fixed script, in
   the same PR. The PR body records a field-by-field diff: only `declaredAt`
   and `evidence` strings change shape; `verdict`, `where`, `why`, `counts`,
   `ratchet` byte-identical.

### Measurement order (each a separate command, exit code read bare)

1. Base reproduction on a scratch branch: insert one blank comment line above
   `resolveModuleBindingGlobal` in `src/ir/integration.ts` (any line < 7347
   works), run the gate → must fail with "verdict table no longer matches".
   Record the failing cite (`forof.string` evidence `:7347 → :7348`).
2. Apply the script change, regenerate baseline, re-run with the same
   inserted line → green, table byte-identical.
3. Delete the `forof.string` quote text from `js.ts` on the scratch branch
   → still fails with the R2 "cited evidence is gone" message (the check is
   not weakened).
4. `pnpm run check:ir-kind-neutrality -- --update-on-decrease` then
   `pnpm exec prettier --check scripts/ir-kind-neutrality-baseline.json` →
   clean without a manual pass.

### Tests

`tests/issue-5298-kind-neutrality-stable-evidence.test.ts`: run the script
via `execFileSync` against a temp copy of the two evidence files with (a) a
line inserted above a quote → exit 0, (b) a quote removed → exit non-zero
and the R2 message. (b) is red on base only in the sense that (a) is red on
base; assert both and record it.

### Gates and budget

Script-only change under `scripts/` — no `src/` LOC growth, no coercion or
oracle sites. Run `check:ir-kind-neutrality` itself, `check:ir-dialect`,
`check:ir-fallbacks`, `check:ir-only` (READY unchanged), `prettier --check`,
and the biome lint. No baseline JSON other than
`scripts/ir-kind-neutrality-baseline.json` is touched, and that one only
through the tool.
