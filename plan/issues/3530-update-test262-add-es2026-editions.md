---
id: 3530
title: "Update test262 to latest + add ES2026 to the ES editions"
status: ready
sprint: current
created: 2026-07-21
updated: 2026-07-21
priority: medium
horizon: m
feasibility: medium
task_type: chore
area: tooling
language_feature: n/a
es_edition: n/a
goal: test262-conformance
related: [959]
---

## Problem

Two coupled gaps:

1. **The `test262` git submodule is stale.** It's pinned at `63829c6d92`
   (`.gitmodules` → tc39/test262). Newer upstream test262 has finalized ES2025
   coverage and the ES2026-draft tests we don't yet run.
2. **ES2026 is not represented in the ES-editions categorization.**
   `scripts/generate-editions.ts` maps test262 `features:` tags → edition years
   in `FEATURE_EDITION`. That map currently reaches **ES2025** (set-methods,
   iterator-helpers, Float16Array, explicit-resource-management, import-attributes,
   regexp-modifiers, … at ~L265). There are **no ES2026 entries**, so any ES2026
   tests fall through to a heuristic/earlier edition and the editions view
   (`test262-editions.json` → landing page) has no ES2026 row. `CURRENT_DRAFT_EDITION`
   is already `2026` (L51), so the scaffolding exists — the feature mappings and the
   updated corpus are what's missing.

## Acceptance criteria

1. **`test262` submodule bumped** to a current tc39/test262 commit; the runner
   (`pnpm run test:262`) still executes without harness breakage. Bump
   `test262-fyi/data` too if the fyi lane needs it.
2. **ES2026 feature tags added** to `FEATURE_EDITION` in `scripts/generate-editions.ts`
   (a new `// ES2026` block after the ES2025 block), each mapped to `2026`. Use the
   **actual Stage-4/finished tags from the updated test262** (do NOT hand-guess the
   set) — pull them from the submodule's `features.txt` / proposal front-matter.
   Candidates as of the 2026 draft: `Error.isError`, `Math.sumPrecise`, `RegExp.escape`,
   `uint8array-base64`/`uint8array-hex`, etc. — but the submodule is authoritative.
3. **Editions output regenerated** — `npx tsx scripts/generate-editions.ts` produces a
   `website/public/benchmarks/results/test262-editions.json` that contains a non-empty
   **ES2026** section, and the landing-page editions view renders it.
4. **Draft handling verified** — confirm `CURRENT_DRAFT_EDITION = 2026` still reads
   correctly (2026 as the in-development edition). If upstream now ships ES2026 as
   final, advance the draft to 2027 and treat 2026 as released in the display.
5. **`scripts/feature-t262-features.json`** reconciled — add any ES2026 landing-page
   feature rows and keep names in sync with `scripts/generate-feature-examples.ts`
   (per its `_comment`), so section/row counts still reconcile.

## Implementation notes

- Key files: `.gitmodules` + the `test262` submodule pointer; `scripts/generate-editions.ts`
  (`CURRENT_DRAFT_EDITION` L51, `FEATURE_EDITION` map, ES2025 block ~L265);
  `scripts/feature-t262-features.json`; `scripts/generate-feature-examples.ts` (FEATURES catalog).
- **Baseline impact — coordinate.** A submodule bump changes the test corpus
  (new tests, possibly a new `total`), so the conformance denominator and per-edition
  counts shift. Expect the landing-page pass/total to move and the baseline to need a
  refresh — do the bump on a branch, re-run test262, and let the promote/baseline
  path re-anchor (see the `promote-baseline` / trap-growth gate — a corpus change can
  trip the ratchet, so watch for a required re-baseline). Don't bundle this with an
  unrelated conformance PR.
- Skip-list check: new ES2026 proposal tests may need skip filters if the feature is
  unimplemented (mirror the existing Temporal/Proxy/etc. skip handling in the runner).

## Origin

Requested 2026-07-21: "update test262 and the ES editions adding ES2026."
