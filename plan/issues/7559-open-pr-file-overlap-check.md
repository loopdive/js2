---
id: 7559
title: "Automatic file-overlap check between a lane's work and every open pull request"
status: in-progress
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/overlap
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci
goal: ci-hardening
sprint: current
horizon: s
related: [7558]
---

# #7559 — automatic file-overlap check against open pull requests

## Problem

On 2026-11-27 four released PRs of one lane (L0b #7516, L0c #7519, W2 #7515,
A1a #7520) went into conflict with main because two PRs of another lane
(#7504, #7501) changed the same files (`src/ir/from-ast.ts`,
`src/backend/wasmgc/program/native-realm*.ts`,
`src/ir/function-object-lowering.ts`, `src/ir/source-plain-objects.ts`) and
landed first. Neither lane knew.

The project once had a manual lock table, `plan/method/file-locks.md`. It still
lists claims from April 2026: nothing forces an entry to be added or removed,
so a hand-kept lock rots. The truth already exists and is always current — the
changed-file lists of the open pull requests.

Owner decision (2026-11-27): build it.

## Implementation Plan

**Target structure.**

1. `scripts/lib/open-pr-files.mjs` — the one REST lister of open PRs and their
   changed files, plus the pure overlap logic:
   - `IGNORED_OVERLAP_PATHS` — ONE named constant of path prefixes that never
     conflict meaningfully (`plan/issues/`, `dashboard/`, `public/`: the
     planning artifacts CLAUDE.md's merge protocol resolves with
     `checkout --theirs` + regen).
   - `listOpenPrs({ ghJson })` — `GET repos/<repo>/pulls?state=open`, paginated
     by hand (`&page=k` until a short page), returning objects
     `{ number, title, author, branch, draft, hold, sha }`. Merge-queue state is
     not on REST and is left out.
   - `openPrFiles({ ghJson, cacheFile, ... })` — the list plus each PR's files
     (`pulls/<n>/files`, paginated the same way; a rename also contributes its
     `previous_filename`, a removal its path — both conflict). Runs ~8 calls in
     parallel under one total time budget; one retry for a transient failure
     (`isTransientGhFailure` from `gh-api-retry.mjs`).
   - Cache: `.js2wasm-cache/open-pr-files.json` under the SHARED git root (the
     parent of `git rev-parse --git-common-dir`, so all worktrees share it;
     `.js2wasm-cache/` is already gitignored). The PR list expires after 5 min;
     a PR's file list is keyed `number@headSha`, so a refresh re-fetches only
     PRs whose head moved. When the budget runs out, the files fetched so far
     are still written, so the next call finishes the warm-up.
   - Fail soft: any GitHub failure yields `{ checked: false, reason }`, never a
     throw — a coordination hint must not block work — and the caller prints
     `NOT CHECKED` loudly.
   - `findPathOverlaps(paths, prs, { excludePr, excludeBranch })` — pure; the
     overlapping PRs, most overlapping paths first.
   - `issuePlanPaths(text, exists)` — pure; backticked repo paths that exist,
     from an issue's `## Implementation Plan` section.
2. `scripts/pr-file-overlap.mjs` — the CLI (`--branch` default, `--paths`,
   `--issue`, `--json`, `--timeout`, `--max-lines`). Exit 0 whenever it ran,
   2 only for usage errors. Last line is the verdict:
   `pr-file-overlap: OK — …` / `… N open PR(s) touch M of your paths` /
   `… NOT CHECKED — <reason>`.
3. Wiring, advisory only:
   - `scripts/pre-dispatch-gate.mjs`: a FILE OVERLAP section from the issue's
     plan paths (or `--paths`); overlaps are warnings (exit 2), never blockers.
     Its open-PR title scan (section 2) moves onto `listOpenPrs`, removing its
     GraphQL-only `gh pr list` call, which fails in cloud sessions.
   - `.husky/pre-push`: a last section printing the overlap summary for the
     pushed branch, ≤10 lines, short timeout; it never fails the push and runs
     only after the existing (6) skip for deletes/tags.
4. Retire `plan/method/file-locks.md` (short note + the command) and repoint
   every document that tells agents to add/remove locks there:
   `plan/method/README.md`, `definition-of-done.md`,
   `pre-completion-checklist.md`, `.claude/agents/developer.md`,
   `.claude/skills/shutdown-dev/SKILL.md`, `.claude/skills/tech-lead-loop/SKILL.md`.
5. CLAUDE.md: one paragraph under "Agent work dispatch".

**Reuse / duplicates removed.** `gh-api-retry.mjs`'s transient classifier;
the gate's GraphQL `gh pr list` replaced by the REST lister. The stale default
repo `loopdive/js2wasm` in `open-pr-issue-files.mjs` becomes the shared
`UPSTREAM_REPO` constant (`loopdive/js2`; GitHub resolves the old name to the
same repository, so the change is behaviour-neutral).

**Not done here:** porting `openPrIssueFiles` (claim-issue / check-issue-ids)
onto the REST lister — see Follow-up.

**Acceptance criteria.**

- Hermetic tests (injected fetcher): overlap found / none; own PR excluded;
  ignored planning paths; file pagination; cache hit makes no second fetch;
  unreachable GitHub → NOT CHECKED and exit 0; the CLI verdict line.
- Live smoke run `--paths src/ir/from-ast.ts` names the open PRs touching it.
- Code quality: one lister, results are objects formatted only at the edge,
  no defensive branches for impossible cases, files within the size budgets.

## Follow-up (to be filed)

`claim-issue.mjs`'s open-PR scan (`openPrIssueFiles`) is GraphQL-only. GraphQL
is refused (HTTP 403) in Claude Code cloud sessions, so there the scan always
fails and cloud sessions must allocate with `--no-pr-scan --allow-unscanned`.
Porting it onto `openPrFiles` needs `claim-issue.mjs` to go async (a cold scan
is ~90 REST calls, which does not fit its synchronous 25 s budget); the
`number@headSha` cache makes the warm case cheap.
