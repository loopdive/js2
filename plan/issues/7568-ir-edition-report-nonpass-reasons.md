---
id: 7568
title: "The merge-queue ES5 IR report prints the ranked reasons why rows do not pass"
status: in-progress
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/ir-nonpass-reasons
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, test262
goal: ci-hardening
sprint: current
horizon: s
es_edition: ES5
related: [7551, 7354]
---

# #7568 — rank why ES5 rows do not pass on the IR path

## Problem

Since #7551 every merge-queue run measures the current edition (ES5) on the IR
(Prepared) path, and `scripts/test262-edition-scope.ts report` prints how many
rows pass and which rows changed. It does not say WHY the ~7,000 non-passing
rows fail, so nobody can rank the work toward "100 % of ES5 on the IR path,
frequent errors first". Agents cannot download artifacts (only job logs are
readable), and compiling the 9,029 tests locally takes hours. The data is
already in `ir-measurement/results.jsonl` when the report runs.

## Implementation Plan

- **Module.** A small sibling module `scripts/lib/test262-nonpass-reasons.ts`
  (the report script is already ~515 lines) exporting one builder and one
  renderer. `cmdReport` in `scripts/test262-edition-scope.ts` calls them, adds
  the section to the markdown summary and stdout, and adds `nonPassReasons` to
  the JSON report. On by default; no workflow change and no new flag.
- **Reuse.** A reason starts from `normalizeErrorSignature`
  (`tests/test262-shared.ts`) — the normaliser that already stamps every row's
  `error_signature` (line/column, offsets, hex, numbers, whitespace). It moves
  to a shared module so the report and the row writer call the same function;
  row output stays byte-identical. The report adds only what that signature
  keeps but the ranking must not: file paths, and quoted literals in
  value-mismatch messages. Quoted names that ARE the cause (`identifier "Array"
  is not in scope`, `direct call to "X"`) stay.
- **Content.** Per non-pass status: top 40 reasons (count, share of all rows,
  rows including `harness/propertyHelper.js`, up to 3 example paths). For
  `compile_error`: missing built-in / identifier → rows. Rows without error
  text group under `(no message)`. Sorted count desc, reason asc; lines
  capped; the whole section ≤ 120 lines.
- **Safety.** Building the section never changes the exit code or verdict: a
  throw prints one line and the report continues without the section.
- **Quality criterion.** One normaliser (no second one beside the writer's),
  one builder + one renderer, no baseline, no pinned numbers.

## Acceptance criteria

- Unit test on a synthetic ~12-row results.jsonl: grouping across paths/lines,
  ordering, propertyHelper count, missing-built-in table, `(no message)`, and a
  malformed row that does not change the exit code.
- Real-data section from a local run on the Prepared path pasted below (or the
  synthetic output, with the reason the real run was not possible).
