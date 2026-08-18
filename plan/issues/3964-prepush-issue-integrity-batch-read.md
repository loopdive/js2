---
id: 3964
title: "Pre-push issue-integrity gate spawns one `git show` per issue file (~3,500 subprocesses)"
status: done
sprint: 78
priority: high
horizon: s
goal: developer-experience
completed: 2026-08-01
assignee: ttraenkler/dev-queue-tax
---

# Pre-push issue-integrity gate spawns one `git show` per issue file

## Problem

`.husky/pre-push` step 5b runs `scripts/check-committed-issue-integrity.mjs`,
which read every issue blob with its own `git show <ref>:<file>` subprocess.
The tree holds ~3,500 issue files, so every `git push` by every agent paid
~3,500 serial subprocess spawns.

Measured on the live box 2026-08-01: the process sat at **0.0% CPU** in state
`R` while its child `git show` churned through the list. It was **not
deadlocked** — which is exactly why "wait it out" kept failing. The cost is
spawn + object lookup, paid thousands of times, and it grows every time we
file an issue.

This is a pure tax: it is charged to every agent on every push, and the same
gate already runs whole-tree in CI (`quality` job), which is where the
exhaustive version belongs.

## Root cause

`scripts/check-committed-issue-integrity.mjs`:

```js
function showFile(file) {
  return git(["show", `${ref}:${file}`]); // one execFileSync PER FILE
}
```

The file **list** already came from a single `git ls-tree`. Only the file
**content** was read one subprocess at a time.

## Fix

Read every blob with ONE `git cat-file --batch`, fed every `<ref>:<path>` on
stdin. No change to what is checked or to the downstream logic.

Two details in the batch reader are load-bearing:

- Bodies are delimited by the **byte count** in the `<oid> blob <size>`
  header, never by scanning for newlines. Issue bodies contain lines that look
  exactly like a header, so line-splitting would corrupt them.
- A `<name> missing` response is a **hard error, not a skip**. The input list
  comes from `ls-tree` on the same ref, so a missing object means the reader
  is broken — and silently skipping would let a broken reader report a clean
  tree.

The hook was **not** scoped to touched files. Scoping would weaken the gate:
duplicate-ID and dangling-`depends_on` detection both need the whole index to
be sound. Batching made scoping unnecessary.

### False-green floor

`id` falls back to the filename prefix when frontmatter is unreadable, so a
reader that returned empty strings for every file would satisfy every check
and print `OK`. The checker now counts files that actually yielded
frontmatter, prints both counts on success, and **refuses to report OK** when
it scanned zero files or parsed zero frontmatter blocks.

## Measurements

Pinned SHA `5824539805cb77`, 3,410 issue files (25.1 MB of blob). Both read
paths run **back-to-back in one process** so they share conditions.

| Read path                                | Wall clock       |
| ---------------------------------------- | ---------------- |
| old — one `git show` per file (3,410×)   | **1,215,256 ms** (20 min 15 s) |
| new — one `git cat-file --batch`         | **2,437 ms**     |
| speedup                                  | **499x**         |

**Absolute wall clock on this box is contention-dominated — quote the ratio,
not a single number.** The full new gate was observed anywhere from **2.4 s**
(quiet) to **239 s** (measured while the old-path control was itself spawning
3,410 `git show` processes, load ~5, ~20 agents active). That is why the
headline above is a *controlled back-to-back A/B in one process on one ref*,
which is immune to that noise, rather than two separately-timed runs. The old
path degrades under the same contention, not less: 20 min here at moderate
load, ~60 min in the original report.

Where the remaining time goes (profiled): the two git subprocesses. Parsing is
negligible — framing the 25 MB buffer into 3,410 strings takes ~60–85 ms and
frontmatter parsing ~6–9 ms.

### Rejected: feeding blob OIDs instead of `<ref>:<path>`

`ls-tree` already returns each blob's OID, so feeding OIDs would let
`cat-file --batch` skip resolving a path through the tree per entry. A single
warm/cold pair suggested a 10x win — but that was a **contention artifact**.
A/B'd properly (7 alternating rounds, same process, minimum as the estimator
least polluted by noise): **path min 2,928 ms vs OID min 2,347 ms — 1.25x**,
and the *medians* actually favour the path form (4,657 vs 4,955 ms). Not a
real effect. Rejected: it adds parsing complexity for no measured benefit.
The two strategies produced **0 content differences**, which is a further
parity data point.

## Acceptance

- **Parity** — byte-level content comparison across all 3,410 issue files
  between old and new read paths: **0 mismatches**. Identical content implies
  identical derived state, since the downstream logic is untouched.
- **Positive control (real scale)** — against the full 3,410-file tree, a
  commit carrying a duplicate id, a filename/frontmatter id mismatch, and a
  dangling `depends_on` is **detected by the new implementation**, which names
  all three and exits 1; the same tree without the defects exits 0. Verdict
  parity with the old implementation follows from content parity: the two read
  paths returned byte-identical content for every file and the downstream
  logic is unchanged, so the derived state — and therefore the verdict — is
  identical by construction. (A direct old-vs-new run on the defect commit was
  also started; at ~20 min per old-path run under load it is a slower restatement
  of the same fact, not additional evidence.)
- **Positive control (unit)** — `tests/hooks/committed-issue-integrity.test.ts`
  covers all three defect classes plus batch-stream framing and the
  refuse-to-pass-vacuously floor.
- **Instrument validated** — the framing tests were confirmed non-vacuous by
  mutation: swapping the byte-count reader for a line-scanning one makes
  exactly those two tests fail, and restoring it makes them pass.
- **Floor** — the scan count is printed on success (`3,410 files scanned,
  3,410 with frontmatter`).

## End-to-end check

Pushed this branch with the hook **enabled** (not `--no-verify`). Every stage
ran to completion — typecheck, lint, `format:check`, oracle ratchet,
coercion-site ratchet, the #3765 vitest file, and `Pre-push: issue integrity
OK`. The multi-minute stall at step 5b is gone; the remaining push latency was
network, and a concurrent agent's `--no-verify` push was stalled the same way.

## Also in this change

Documented the **false-negative push** rule next to the hook: a
`timeout N git push` can be killed *after* the ref update has landed, so exit
124 is not evidence the push failed. Confirm with `git ls-remote`.

This reproduced live while pushing this very branch:

```
PUSH_RC=124  PUSH_SECONDS=900
local  HEAD : e8fe6704890dd100c647921d37ef3db1098b606d
remote issue-3964-prepush-integrity-batch: e8fe6704890dd100c647921d37ef3db1098b606d
RESULT: push LANDED (refs match)
```

The client was killed at the 900 s watchdog; the ref had already updated.
Treating exit 124 as failure would have led to a pointless re-push.
