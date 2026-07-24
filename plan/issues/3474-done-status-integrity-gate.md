---
id: 3474
title: "Done-status integrity: complete the false-done triage + add a CI gate blocking status:done while an issue has live test262 citations"
status: done
completed: 2026-07-24
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

## DONE (2026-07-24) — Part B (gate + audit) + Part A (dispositions applied)

### Part B — the durable fix, a PERIODIC audit

`scripts/check-done-status-integrity.mjs` keys on **code state** (the
baselines-repo JSONL: which tests actually fail and which issue each cites), not
a commit-message grep — so it catches drift even when the "fix" never cited the
issue (the #3449-class miss).

- **Delivered as a PERIODIC sweep** (`.github/workflows/done-status-audit.yml`,
  daily), **not a per-PR gate.** The check needs a ~93MB both-lane baseline fetch
  that isn't justified on every impl PR (most flip their own fresh issue to
  `done`, which has 0 live cites), and a cheap per-PR variant is impossible: a
  committed cite-baseline is stale for exactly the fixing PR (its just-passing
  tests aren't reflected until the next sweep), which would false-flag legitimate
  done-flips. The sweep goes RED (exit 1) on a genuine false-`done` — visible +
  actionable, blocks no PR. `check:done-status-integrity` (change-scoped gate
  mode) remains for local pre-check.
- **Cite extraction** is robust to BOTH forms — parenthesized `(#N)` and bare
  `#N:` / prose `deferred to #N.` — excludes Wasm function-index noise
  (`function #N`, `#N:"name"`), and cross-references issue-file existence. (An
  earlier parenthesized-only cut silently dropped #1387/#1472, both bare-cited.)
- **`done_cited_ok: true`** frontmatter flag (YAML inline comment allowed, so the
  reason is recorded inline) = the exemption for legitimate detector / umbrella /
  intentional-refusal issues.
- Tests in `tests/issue-3474-done-status-integrity.test.ts` (12: extractor +
  verdict + frontmatter incl. the inline-comment form). Verified live: touching
  `done` #2043 (42 cites) FAILS the local gate; the periodic sweep exits 0 after
  the Part-A dispositions below.

### Part A — dispositions (tech lead's calls, applied 2026-07-24)

Guiding principle: a `done` issue whose deliverable is a detector / loud-refusal
/ host-scoped-or-deferred feature → **exempt** (the failing cites are the
intended refusals, tracked under #2860); a `done` issue that CLAIMS to have fixed
the failing behavior but hasn't → **reopen**.

**Exempted (`done_cited_ok: true`, reason recorded inline in each file):** #2961
(detector/leak-guard), #1387 (`with` permanently deferred), #2717 (host-only
flat/flatMap + refuse-rest), #1474 (eliminate HOST RegExp — standalone-native is
#1539), #3371 (loud-refuses Reflect.construct ~160), #1906 (native
defineProperties + refuse-rest), #1907 (built-in static reads: refuse
unsupported), #1539 (partial native RegExp + refuse complex patterns).

**Reopened:** #2043 (`done`→`ready`) — genuine false-`done`: claims to retire the
late-import index-shift class but 42 tests still emit invalid Wasm citing it. The
same #1177 minefield as #3559; tagged `model: fable` / `sprint: Backlog` (rejoins
the suspended fable-tier substrate backlog — not worked here).

Below threshold (noise, no action): #2029 (8), #2177 (6), #21/#14 (2),
#10/#2978/#13/#11 (1). After these dispositions the periodic sweep reports **0**
non-exempt false-`done` issues.

## Notes
- Audit method + evidence: the sprint-73 harvest (error-field `#NNNN` extraction,
  both lanes) and #3427 (the first three reopenings).
