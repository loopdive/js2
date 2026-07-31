---
id: 3880
title: "claim-issue.mjs wedges 10min+ under concurrency and reports success on silent failure"
status: ready
created: 2026-07-31
priority: high
feasibility: medium
horizon: m
task_type: bugfix
area: ci
goal: ci-hardening
sprint: current
related: [2531, 3879]
---

# #3880 — the advisory lock is the fleet's biggest tax, and it fails silently

## Measured, 2026-07-30/31

- **Four agents** lost time to it. One spent **~50 minutes** unable to claim a single
  issue across four attempts (280 s foreground timeouts; one earlier attempt ran
  **10 minutes at 0:00 CPU** before being killed).
- **`--allocate` wedged for three agents.** In at least one case it **threw with
  empty stdout while the caller reported success** — reserving nothing. That is the
  #2531 collision hazard in reverse: a half-reserved id would be green at PR time and
  fail only in the `merge_group`.
- **Two claim releases reported success and silently failed**, leaving stale locks on
  **#3661** and **#3685** that had to be cleared by hand via the contents API.
- **#3420's claim ref is permanently out of sync** — the work merged (PR #3864) while
  the record still shows a different agent's stale entry.

## Fifth occurrence — first on `--release`, and the strongest single argument for priority

2026-07-31, one agent handing #2916 back to the queue. **Three release attempts,
zero effect** — `2916.json` still read `status: in-progress` afterwards.

| # | attempt | outcome |
| --- | --- | --- |
| 1 | `--release 2916` | **Node crash** mid-run. The caller nearly recorded success: the shell reported `EXIT=0`, which was `tail`'s status from a pipe, not the script's. |
| 2 | `--release 2916` | **exit 1**, cause captured verbatim: `error: cannot lock ref 'refs/claim-issue/base': is at 9619a610… but expected c5faa81c…` |
| 3 | `--release 2916` after manually force-updating the mirror (`+issue-assignments:refs/claim-issue/base`) | **wedged >560 s**, killed |

Three firsts in this one episode:

1. **First failure observed on `--release`.** Prior evidence covered `claim` and
   `--allocate`; this extends the fault to a **third entry point**, so it is the
   shared-ref layer rather than any one code path.
2. **First verbatim capture of the lock error**, naming
   `refs/claim-issue/base` — the shared mirror every agent fetches into — as the
   contended resource.
3. **First case where a manual mirror force-update did not rescue the retry.**
   That workaround had previously worked; here the retry wedged anyway.

### Why this is the argument for prioritising, not just more evidence

**This issue's own acceptance criterion says "a failed release/allocate can never
be mistaken for success by its caller." Occurrence 1 is exactly that failure,
and it was caught only because the caller read the record back instead of
trusting the exit code.** Had it not been, #2916 would now sit falsely claimed by
a departed agent.

So the tool built to prevent stranding **nearly caused a stranding, then wedged
while trying to undo it.** The eventual mitigation was to bypass the tool
entirely: a `Claim status: STALE` note written into the issue file, because
hand-editing a shared ref that other lanes read trades a bookkeeping problem for
a corruption risk. **When the claim ref cannot be corrected, the durable record
has to carry the truth instead** — which means the claim ref is currently not
authoritative for anything.

**Note on occurrence 1's near-miss** (this is a caller-side hazard worth fixing
in the docs as well as the tool): `cmd | tail -2; echo $?` reports the *pipe's*
last stage, so a crashed script reads as success. Use `cmd > file 2>&1; echo $?`,
`${PIPESTATUS[0]}`, or run bare — and verify the **effect** (read the record
back), not the exit code. Two agents hit this same trap within an hour on
2026-07-31, one of whom had it written in their own memory at the time; vigilance
did not prevent it, so the rule needs to be mechanical.

## Root cause

The failure is `cannot lock ref 'refs/remotes/origin/issue-assignments': is at X but
expected Y` — concurrent agents all fetch into the **same shared mirror ref** while
`claim-issue.mjs` is fetching it. The script has **no retry** on this. With several
agents active it is reproducible, not a flake.

The hang is in the first-push-wins retry/backoff loop around the `git push` (~L414).

## The silent-success half is the more dangerous half

Callers wrote `node scripts/... 2>&1 | tail -4; echo "EXIT=$?"` — which reports
**`tail`'s** status, not the script's. Two failed operations therefore looked clean.
The same trap made a pre-dispatch **STOP** print `EXIT=0` earlier the same session.

Any fix must ensure the script's own **exit code is non-zero on failure** and that its
failure is legible without relying on the caller's pipe discipline.

## Fix

1. **Retry with backoff on the ref-lock race** — it is transient and expected under
   concurrency.
2. **Use a per-invocation mirror ref** (or fetch to a temp ref) so concurrent agents
   do not contend on one shared `refs/claim-issue/base`.
3. **Fail loudly**: non-zero exit, an error on stderr, and never an empty-stdout
   throw that a caller can read as success.
4. Document `set -o pipefail` / `${PIPESTATUS[0]}` in the dev protocol — pipe-swallowed
   exit codes bit this repo three times in one session.

## Why priority high

The lock is **advisory**. A standing instruction now says an advisory lock that
cannot be acquired in a few minutes must not stop work — verify the record's `status`
directly and proceed. But that is a workaround: the lock exists to prevent duplicate
dispatch, and while it is wedged the fleet is running without that protection.

**The workaround has a sharp edge worth stating explicitly.** "Proceed if the
record says `released`" is safe only while the **reader** path is sound — it
assumes a wedge can lose a *write* but never return a stale *read*. Nothing
currently guarantees that. If a wedge ever produced a stale read, two agents
could both see `released` and both start, which is precisely the duplicate
dispatch this lock exists to prevent. So the workaround does not merely leave
the fleet unprotected while wedged; under one plausible failure mode it is
itself the mechanism. Any fix should confirm the read path cannot go stale
independently of fixing the write path.

## Acceptance

- Concurrent claims from 4+ agents succeed within seconds, or fail fast with a
  non-zero exit and a legible error.
- A failed release/allocate can never be mistaken for success by its caller.
- `--allocate` either reserves an id or exits non-zero — never both nothing and 0.
