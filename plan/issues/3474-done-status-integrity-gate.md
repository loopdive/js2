---
id: 3474
title: "Done-status integrity: complete the false-done triage + add a CI gate blocking status:done while an issue has live test262 citations"
status: in-progress
assignee: ttraenkler/dev-opus-3
sprint: current
priority: high
task_type: infrastructure
related: [2093, 2961, 1472, 2026, 680, 2046]
---

## Problem

A 2026-07-20 harvest cross-reference found a **systemic false-`done` problem**:
**16 issues marked `status: done` still have ≥15 live test262 failures citing
their `#NNNN` in the error field.** The `done` status is unreliable — the top
failure causes are nearly all marked done while their tests still fail.

Already reopened (PR #3427): #2026 (2,924 live), #1472 (958), #680 (398).

## Scope — two parts

### Part A — complete the false-`done` triage
Triage the remaining `done`-with-live-citations candidates and reopen the genuine
ones (set `status: ready`, cite the live count). Distinguish **genuine
false-done** (feature meant to work, still fails) from **legitimate
done-but-cited** (a detector/umbrella like #2961, or an intentional refusal like
#1387 with-statement / #1696 dynamic-import — citations are the expected "we
refuse this").

Candidates to triage (17–61 live each): **#1907, #1888, #221, #2620, #2717,
#2043, #258, #222, #223, #230**. Re-run the audit for the full list:
extract error-field `#NNNN` from failing records in both baselines-repo lanes,
join against `plan/issues/*.md` status, flag `done` + citations > threshold.

### Part B — CI gate (the durable fix)
Add a gate (wire into `quality`, sibling to the #2093 probe gate) that **fails a
PR flipping an issue to `status: done` (or leaving it done) when that issue's
`#NNNN` still has more than N live citations** in the current baselines-repo
JSONL (both lanes). Provide an explicit exemption for detector/umbrella/deferred
issues (e.g. a `done_cited_ok: true` frontmatter flag or a `task_type` allowlist)
so #2961/#1387/#1696-class issues don't trip it. This makes done-status
self-correcting instead of drifting.

## Acceptance criteria
- All genuine false-`done` issues among the candidates reopened; legitimate
  done-but-cited issues left done, with the exemption flag applied.
- CI gate present and green on main; a deliberately-mislabeled test issue fails it.
- Exemption mechanism documented.

## Part B — DONE (2026-07-24, this PR)

Shipped the durable fix (the CI gate + audit tool). `status` stays `in-progress`
because **Part A (the triage / reopen-vs-exempt calls on shared planning
artifacts) is deferred to the tech lead** per the dispatch decision — marking
this issue `done` while Part A is open would itself be a false-`done`.

- **`scripts/check-done-status-integrity.mjs`** — change-scoped gate (sibling to
  the #2093 probe gate). For each `plan/issues/*.md` a PR touches that is
  `status: done` and not `done_cited_ok: true`, it counts LIVE test262 failures
  citing its `#NNNN` across both baseline lanes and FAILS when the count exceeds
  `DONE_CITE_THRESHOLD` (default 15). Keyed on **code state** (the baseline
  JSONL), not a commit-message grep — so it catches status-drift even when the
  fix didn't cite the issue (the #3449-class miss). A PR touching no `done` issue
  does ZERO network work; a baseline-fetch failure WARNS and PASSES (safety net).
- **Cite extraction** is robust to BOTH forms — parenthesized `(#N)` and bare
  `#N:` / prose `deferred to #N.` — excludes Wasm function-index noise
  (`function #N`, `#N:"name"`), and cross-references issue-file existence. (An
  earlier parenthesized-only cut silently dropped #1387/#1472, both bare-cited.)
- **`--audit` / `--json`** whole-tree mode powers Part A.
- **`done_cited_ok: true`** frontmatter flag = the exemption for legitimate
  detector / umbrella / intentional-refusal issues.
- Wired into the required `quality` job (`.github/workflows/ci.yml`);
  `package.json` `check:done-status-integrity`; tests in
  `tests/issue-3474-done-status-integrity.test.ts` (11: extractor + verdict +
  frontmatter). Verified live: touching `done` #2043 (42 cites) FAILS the gate.

### Part A audit (2026-07-24) — for the tech lead's reopen-vs-exempt calls

`node scripts/check-done-status-integrity.mjs --audit` (both lanes, threshold
15) → **9 `done` issues over threshold, not yet exempt**:

| issue | cites | nature (my read) | proposed |
| --- | --- | --- | --- |
| #2961 | 3646 | detector/umbrella (strictNoHostImports leak guard — cites ARE it working) | **exempt** (unambiguous) |
| #1387 | 32 | `with` statement intentionally deferred (`#1387: with statement`) | exempt (refusal) |
| #2717 | 16 | Array flat/flatMap "not yet supported in --target standalone (#2717)" | exempt (refusal) — but was in #3427-era reopen batch; confirm |
| #1474 | 99 | standalone RegExp refusal; Phase-2 is #1539 | **ambiguous** |
| #3371 | 89 | title says Reflect.construct "refused — ~160 tests" yet `done` | **ambiguous / likely reopen** |
| #1906 | 78 | standalone defineProperties "unsupported descriptor shape (#1906)" | **ambiguous** |
| #1907 | 53 | standalone built-in static value reads | **ambiguous** |
| #1539 | 44 | standalone RegExp engine (Phase 2 of #1474) | **ambiguous** |
| #2043 | 42 | "retire the late-import index-shift bug class" — but it STILL emits invalid Wasm 42× | **likely genuine false-done → reopen** |

Below threshold (noise, no action): #2029 (8), #2177 (6), #21/#14 (2), #10/#2978/#13/#11 (1).
Cited-but-NOT-done (already correct, no action): #2046 (in-progress), #2928 (backlog), #680/#1472/#1888/#2620 (ready).

I did **not** touch any of these issue files — the reopen-vs-exempt calls are the
tech lead's. Once Part A lands (reopen the genuine ones, `done_cited_ok: true`
the legitimate ones), flip this issue to `done`.

## Notes
- Audit method + evidence: the sprint-73 harvest (error-field `#NNNN` extraction,
  both lanes) and #3427 (the first three reopenings).
