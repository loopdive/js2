---
id: 4151
title: "claim-issue.mjs --allocate is unusable in containers without the `gh` CLI — the open-PR scan ENOENTs, refuses (exit 6), and tells you to `Fix gh auth`, leaving --allow-unscanned as the only path"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: tooling
language_feature: none
goal: dogfood
related: [2531, 3880, 3598, 3636, 4045, 4117]
origin: "Hit while allocating an id from a Claude-Code-on-the-web remote execution container, 2026-08-04"
---

# #4151 — `--allocate` refuses where `gh` does not exist, and its advice is unactionable

## Symptom

In a remote-execution container (Claude Code on the web, GitHub Action runners
without `gh`, any environment whose GitHub access is via the MCP server rather
than the CLI), `claim-issue.mjs --allocate` refuses outright:

```
$ node scripts/claim-issue.mjs --allocate --by ttraenkler/claude
warning: open-PR id scan FAILED after 3 attempts (gh offline/unauthenticated/rate-limited/slow).
         The id universe does NOT include in-flight PRs.
the open-PR id scan DEGRADED (gh offline/unauthenticated/rate-limited), so the id universe is
incomplete and the reserved id would not be verified against in-flight PRs.
Nothing was reserved. Fix gh auth and re-run, or pass --allow-unscanned to reserve anyway.
claim-issue: FAILED — … (exit 6)
```

The refusal is **correct policy** (#3880: an id reserved without the scan must
not be handed out as clean). The problem is that the diagnosis is wrong and the
remedy it names does not exist.

## Root cause

`scripts/lib/open-pr-issue-files.mjs:86` invokes the CLI directly:

```js
return execFileSync("gh", args, { … });
```

In this class of container **`gh` is not installed at all** — not offline, not
unauthenticated, not rate-limited:

```
$ which gh
/bin/bash: line 1: gh: command not found
```

The environment's own operating notes say so explicitly: *"You do NOT have
access to the `gh` CLI, `hub` CLI, or direct GitHub API access. Instead, use the
GitHub MCP server tools (prefixed with `mcp__github__`)."* GitHub is perfectly
reachable there — just not through this code path.

Two consequences follow from conflating "absent" with "degraded":

1. **The advice is unactionable.** "Fix gh auth and re-run" cannot be followed;
   there is no `gh` to authenticate. An operator who takes it literally burns
   time before concluding the only way forward is `--allow-unscanned`.
2. **ENOENT is retried.** `open-pr-issue-files.mjs` retries 3× with backoff
   (`attempt * 1000` ms, capped at the deadline). A missing binary is not a
   transient condition — every retry is guaranteed to fail, so the caller pays
   the backoff for nothing.

## Why this matters beyond ergonomics

`--allow-unscanned` is the only remaining path, and it removes **the one check
standing between `--allocate` and an id an in-flight PR already uses** — exactly
the failure #2531/#3636 exist to prevent and #3880 built the refusal to stop.
So an environment-shaped gap silently converts a hard guarantee into an honour
system, in precisely the environment where an agent is most likely to be
allocating ids unsupervised.

The `check:issue-ids:against-main` / open-PR-collision gate still arbitrates at
PR time, so this is not a correctness hole in `main` — it is a hole in the
*local* guarantee, and it surfaces as a wedged `merge_group` rather than a clean
refusal.

## What was done in the meantime (the manual procedure, undocumented)

Recorded here because it is currently tribal knowledge and it is what the fix
should automate:

1. `mcp__github__list_pull_requests` (state `open`) to enumerate open PRs.
2. For each, `mcp__github__pull_request_read` with `method: get_files`, grepping
   for added `plan/issues/<id>-*.md`.
3. Compare against `git ls-tree origin/main plan/issues/` and the reservation
   ref, then `--allocate --allow-unscanned`.

That reproduces the scan's semantics, but the reservation record still stamps
`pr_scan: "degraded"`, so the record does not reflect that a scan actually
happened. The provenance is lost even when the work was done.

## Proposed direction

Not prescriptive about the mechanism, but the shape:

- **Distinguish ENOENT from a degraded scan.** A missing binary should not be
  retried and should produce its own message naming the real remedy (supply the
  id set another way — below) rather than "fix gh auth". Keep the refusal; only
  the diagnosis and the retry behaviour change.
- **Accept an externally-supplied open-PR id set**, e.g.
  `CLAIM_OPEN_PR_IDS_FILE=<path>` or `--open-pr-ids <a,b,c>`, so a caller with
  GitHub access by some other route (MCP tools, a CI step that already has the
  data, a preceding API call) can satisfy the scan honestly. Stamp it as a
  distinct provenance value — `pr_scan: "external"` — so it is neither silently
  equated with `"ok"` nor lumped in with `"degraded"`. A record must keep saying
  what actually happened.
- **Document the fallback in CLAUDE.md** next to the existing `--allocate`
  guidance, so the manual procedure above is not rediscovered per-session.

## Acceptance criteria

- [ ] With `gh` absent, `--allocate` fails fast (no 3× backoff) and its message
      names the missing binary, not authentication.
- [ ] An externally-supplied open-PR id set lets `--allocate` reserve without
      `--allow-unscanned`, and the reservation record distinguishes that
      provenance from both `"ok"` and `"degraded"`.
- [ ] `--allow-unscanned` still works and still warns exactly as it does today —
      this issue does not widen any escape hatch.
- [ ] The refusal remains a refusal: no path added that reserves an id while
      pretending the id universe is complete when it is not.
- [ ] CLAUDE.md documents the no-`gh` path.

## Notes on scope of the evidence

Verified in one container (this session's remote execution environment). The
environment class is documented as gh-less, but I did not survey other runners,
so "every remote-exec container" is an inference, not a measurement. The code
path and the ENOENT-vs-degraded conflation are read directly from source and
hold regardless of how many environments are affected.

This issue is also the id (#4151) reserved for it; it was allocated before the
work it was originally intended for turned out to be already fixed on `main` by
#4141, and is reused here rather than abandoned (an abandoned reservation is a
permanent hole in the sequence).
