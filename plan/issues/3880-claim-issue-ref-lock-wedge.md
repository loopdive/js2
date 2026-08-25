---
id: 3880
title: "claim-issue.mjs wedges 10min+ under concurrency and reports success on silent failure"
status: done
completed: 2026-07-31
created: 2026-07-31
priority: high
feasibility: medium
horizon: m
task_type: bugfix
area: ci
goal: ci-hardening
sprint: 78
assignee: ttraenkler/dev-claim-reliability
related: [2531, 3079, 3636, 3879]
---

# #3880 — the advisory lock is the fleet's biggest tax, and it fails silently

## The sharpest finding: the READ path could go stale, and that is duplicate dispatch

Below, this issue used to say the stale-read hazard was hypothetical — _"it
assumes a wedge can lose a write but never return a stale read. Nothing
currently guarantees that."_ It is not hypothetical. One command demonstrates it
on the pre-fix script:

```console
$ CLAIM_ASSIGN_REMOTE=no-such-remote node scripts/claim-issue.mjs --check 3661
#3661 is UNASSIGNED.
$ echo $?
0
```

No pipe, no `tail`, no swallowed status. The read **failed**, and the tool
answered **"nobody holds this"** with a clean exit 0. Two agents reading that
answer both start the same issue — which is precisely the duplicate dispatch the
lock exists to prevent. The same mechanism on the write side:

```console
$ CLAIM_ASSIGN_REMOTE=no-such-remote node scripts/claim-issue.mjs --release 3661 alice
#3661 is not currently claimed — nothing to release.
$ echo $?
0
```

Root cause of both: `remoteAssignSha()` returned `""` when `git ls-remote`
**failed** and `""` when the ref **did not exist**, and every reader treated `""`
as "no claims". That single conflation explains the stale locks on #3661/#3685,
the false "nothing to release", and the false "UNASSIGNED".

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
all reported as failures.**

> **CORRECTION, measured later the same day.** This section originally said
> "zero effect — `2916.json` still read `status: in-progress` afterwards". That
> is **false**. The record has read `status: "released"` with a `released_at` of
> 08:55:03Z ever since: **one of the three "failed" attempts had in fact written
> it.** What made it _look_ unreleased was the dispatch gate, which
> tested `assignee` alone and so reported a `released` record as CLAIMED (see the
> `isHeld` section). The original sentence is left visible rather than deleted
> because the mistake is the point: an agent inferred "no effect" from three
> error messages, without reading the record back, and then documented the ref as
> unfixable. See "#2916 is the fully-traced instance" below.

| #   | attempt                                                                                                | outcome                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `--release 2916`                                                                                       | **Node crash** mid-run. The caller nearly recorded success: the shell reported `EXIT=0`, which was `tail`'s status from a pipe, not the script's. |
| 2   | `--release 2916`                                                                                       | **exit 1**, cause captured verbatim: `error: cannot lock ref 'refs/claim-issue/base': is at 9619a610… but expected c5faa81c…`                     |
| 3   | `--release 2916` after manually force-updating the mirror (`+issue-assignments:refs/claim-issue/base`) | **wedged >560 s**, killed                                                                                                                         |

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
in the docs as well as the tool): `cmd | tail -2; echo $?` reports the _pipe's_
last stage, so a crashed script reads as success. Use `cmd > file 2>&1; echo $?`,
`${PIPESTATUS[0]}`, or run bare — and verify the **effect** (read the record
back), not the exit code. Two agents hit this same trap within an hour on
2026-07-31, one of whom had it written in their own memory at the time; vigilance
did not prevent it, so the rule needs to be mechanical.

## Root cause — CORRECTED

The recorded root cause was _"the script has no retry on this."_ That is wrong,
and getting it wrong inverts the fix. **Retry was the amplifier, not the missing
piece.**

### Where the time actually went

`GIT_TRACE2_PERF` decomposition of ONE `git fetch +issue-assignments:…` in the
working repo:

| phase                                                                 | wall                    |
| --------------------------------------------------------------------- | ----------------------- |
| remote ref advertisement                                              | 0.6 s                   |
| `git rev-list --objects --stdin --not --all --quiet --alternate-refs` | **47.8 s**              |
| `git-remote-https` child (total)                                      | 77.8 s                  |
| **whole fetch**                                                       | **120 s**, at 6-7 % CPU |

Repeat measurements of the same command: **210 s / 127 s / 120 s / 65 s**. The
CPU figure is the tell — the process is _waiting_, not computing. The dominant
cost is git's connectivity check, which walks **all 6,680 local refs** in this
repo; it has nothing to do with the assignment ref's own size.

Now apply `MAX_RETRIES = 6`, with a fresh `ls-remote` + `fetch` on **every**
attempt: 390-1260 s. That is exactly the reported ">560 s", "600 s timeout" and
"10 minutes at 0:00 CPU". **Adding retries around a two-minute call is what
produced the ten-minute wedge.**

### The lock race, reproduced — and it is not the ref the issue named

Captured live:

```
error: cannot lock ref 'refs/remotes/origin/issue-assignments':
       is at 66960042… but expected 63b1549…
```

The contended ref is `refs/remotes/origin/issue-assignments` — which **nothing
asked for**. `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*` makes
git _opportunistically_ update the matching remote-tracking ref alongside the
requested refspec, and concurrent agents collide on that. `refs/claim-issue/base`
(the shared mirror, quoted in occurrence 2 above) is a second, independent
contention point.

**And it is not confined to the assignment ref.** While preparing this PR, a
plain `git fetch origin main` failed with
`cannot lock ref 'refs/remotes/origin/main': is at 96f1316 but expected ac32fbe`
— objects fetched fine, only the ref update lost the race. Same class, a third
ref, on one that **every** agent touches. Any shared remote-tracking ref in a
many-agent clone is exposed; the assignment ref was simply where it hurt most.

**And the fetch that printed that error SUCCEEDED at its actual job**: the
requested destination ref was created at the new tip. git still exited 1. The old
`fetchAssign()` used a throwing helper, so a fetch that worked crashed the script
— the "succeeds as failure" half, in one line of code.

### It is STARVATION, and it gets worse exactly as the fleet grows

The "hang" is not a hang. Evidence gathered by an agent that was losing the race
in real time, while it was losing it:

- `/workspace/.git/refs/claim-issue/` clean — **no stale lock, no `*.lock`**;
- the ref was **live and advancing** (`65f9d562` at 13:16:36Z) — other agents'
  writes were landing fine throughout;
- `refs/claim-issue/base` mtime updated **during** its retry — so its fetch
  succeeded and it then looped;
- verbatim: `cannot lock ref 'refs/claim-issue/base': is at fea409c7… but
expected ef945d25…` — another writer advanced the ref between its fetch and
  its push.

So: first-push-wins with re-scan on rejection, where each attempt spends 65-210 s
between reading the tip and pushing. With ~8 agents writing one orphan ref, a
slow writer loses **every** round and never converges — its entire retry budget
is consumed by other agents' successes.

**The property worth naming: unreliability scales with fleet size.** This tool
degrades precisely as parallelism rises, which is exactly when a dispatch lock
matters most. That is a stronger argument for fixing it than any count of
individual failures.

Independently confirmed by the PR-queue shepherd the same afternoon, with the
process count attached: `--allocate --json` ran **>20 minutes** and then failed,
with **7 concurrent `claim-issue.mjs` processes** at peak. Its output names
**both** contended refs at once —

```
allocate: ref moved (attempt 1/6) — re-scanning for a fresh id…
allocate: ref moved (attempt 2/6) — re-scanning for a fresh id…
error: cannot lock ref 'refs/claim-issue/base': is at 16521b7ce048 but expected 022efb97dcb4
error: cannot lock ref 'refs/remotes/origin/issue-assignments': is at 16521b7ce048 but expected 022efb97dcb4
```

— which is the decisive detail: this is a **LOCAL** ref-lock collision between
concurrent processes in one clone, not the remote first-push-wins race the retry
loop was built for. Retrying cannot help, because every process is fighting for
the same two local refs. Both disappear under the fix: the shared mirror
`refs/claim-issue/base` is replaced by a per-invocation ref, and
`refs/remotes/origin/issue-assignments` is only ever touched because of the
configured refmap, which addressing the remote by URL removes entirely.

The shepherd also ran it as `… 2>&1 | tail -20` and its harness recorded **exit
code 0** for a run that produced no id — `tail`'s status again, a fourth
independent hit on the same trap in one session. And the cost was not just time:
it was blocked from filing an issue _about a CI throughput defect_ for ~25 min
and ended up hand-picking an id, which is precisely the #2531 collision hazard
this tool exists to prevent.

It also explains the mirror-image symptom: an `--allocate` that **wrote its
reservation and then hung** is the same loop, failing to report after a
successful side effect.

This reframes the cache repo. It is not primarily a speed fix — it shrinks the
fetch→push window by two orders of magnitude, which is **what makes the
optimistic loop converge at all**. It does not make the loop _fair_, so the
contention budget is widened as well (`MAX_RETRIES` 6 → 12, jittered backoff
retained, `CLAIM_MAX_RETRIES` to override): affordable now that an attempt costs
~1 s rather than minutes.

**An attempt count does not bound wall time, so it cannot deliver "fail fast".**
Each attempt can internally spend `NET_RETRIES × NET_TIMEOUT_MS` on `ls-remote`,
again on the fetch, again on the push and again on verification. On a warm cache
12 attempts is tens of seconds; on the degraded network measured _this same day_
(a 3m29s fetch, two 6m40s tool timeouts) it is minutes per attempt. Quoting a
seconds figure without that condition would put a number in the durable record
that the issue's own evidence falsifies. The bound that actually holds is a
**wall-clock deadline** — `CLAIM_DEADLINE_MS`, default 120 s — checked between
attempts, which ends the loop with exit 5 and a verified "nothing was written"
regardless of how few attempts were consumed.

### The push's exit status is not evidence either

A push can land server-side and still report failure or time out. Two ids
(#3890, #3891) are permanent holes in the sequence because agents re-allocated
after an "apparent" failure whose reservation had already been written.

**Confirmed in both directions on the same day, in one stand-down.** One agent's
`--allocate` hung _after_ writing its reservation (a success that reads as a
failure), and the same agent's `--release 3896` / `--complete 3893` hung
_without_ writing (a failure that reads as a success). It only knew which was
which because it read the record back. That is the third independent
confirmation this session that **the exit code carries no information in either
direction** — which is why the fix reports the side effect actually performed
rather than what the subprocess claimed.

### `--complete` never actually cleared the lock — 45 % of "active claims" were phantoms

Found by running the fixed `--complete` against two real stale records (#3893,
#3896) and then re-reading them: the write landed perfectly (`status: "done"`,
`released_at` set) and `--check` **still said CLAIMED**.

The reader was wrong, not the writer:

```js
// before
return !!(entry && entry.assignee && entry.status !== "released");
```

`--complete` writes `status: "done"`, and `"done" !== "released"`, so a completed
issue stayed held **forever, for every reader** — including the pre-dispatch
gate. CLAUDE.md's dev protocol prescribes `--complete {N}` after a merge to
"clear the cross-dev lock"; it did not clear it.

Measured on the live ref (1,080 entries):

| status        | count   |
| ------------- | ------- |
| `in-progress` | 359     |
| `reserved`    | 315     |
| `done`        | **294** |
| `released`    | 109     |

`--list` was reporting **654** active claims = 359 in-progress + 294 done + 1.
**45 % were phantoms.** After the fix, the same command reports **359**.

This is the other half of "no claim file is unreliable in BOTH directions". A
45 % phantom rate is abstract; the concrete cost is that **it made real dispatch
decisions wrong on 2026-07-31**:

- **#2916** appeared to have "a claim nobody held" — it cost a routing decision
  and a hand-written `Claim status: STALE` banner in the issue file, because the
  ref could not be corrected. The claim was `done`; the reader called it held.
- **#2046** read `in-progress` with **three merged PRs** behind it, and an agent
  was dispatched onto it partly on that basis.
- **#3420** looked permanently claimed after its work merged in PR #3864.

Each was re-diagnosed independently as "the claim ref is unreliable", which is
why that conclusion kept being re-derived all session without ever resolving to
a mechanism. The mechanism is one operator in one predicate.

**#2916 is the fully-traced instance — the whole failure in one issue.** Its
record has read `status: "released"` since **08:55:03Z**. Yet for the rest of the
day the gate reported it CLAIMED, because the gate tested `assignee` alone. What
that one wrong predicate cost, in order: a deliberate handoff; **three** release
attempts, all reported as failures (node crash / `cannot lock ref` / wedge

> 560 s) of which **one had actually written the record**; a 24-line prose
> correction added to #2916's own issue file explaining that the ref could not be
> fixed — describing a state that had not existed for hours; a routing decision by
> the tech lead; and a task dispatched to an agent to release a claim that was
> already released. Three separate agents, including the dispatcher, held the same
> false belief from the same broken read.

It is also the **third independently confirmed "succeeds as failure" of the
day**, and the sharpest: the agent reported failure _while having written
successfully_, then documented the ref as unfixable. It trusted its error output
over the record. That is this issue's acceptance criterion, stated as an
incident.

**The largest consequence is a fleet-level conclusion that may be wrong.** Two
agents independently gated candidate work the same day and reported the queue as
saturated — one got **7 STOPs out of 8**, the other **6 of 7**, both on "hard
claim" blockers — and "the high-priority codegen tier is heavily owned" was
relayed upward as a finding. With **403 of 1,080** records mis-held _for the
gate_, a meaningful share of those blockers were plausibly terminal records, in
which case the conclusion is wrong and real work was skipped. The candidates
shelved on claim blockers are #2865, #2949, #2175, #2872, #3030, #3175, #2873,
#3024 and #3582; they should be re-gated once this lands. (#2864 was
independently confirmed genuinely live via merged work on main, so that one
stands.) A phantom rate is abstract; "the queue looked full and wasn't" is the
cost.

**And the dispatch gate had its own, worse copy.** `scripts/pre-dispatch-gate.mjs`
does not call `claim-issue.mjs`; it reads the ref itself and tested
`c.assignee` **alone, ignoring `status` entirely** — so for the gate every
`released` record blocked too, i.e. **403 of 1,080**, not 294. Fixing only
`claim-issue.mjs` would have left the exact path that mis-dispatched #2046
still broken, while this file claimed otherwise. Heldness now lives in
`scripts/lib/claim-record.mjs` and is imported by both readers, on the #3598
precedent (one implementation, no drift). Verified live: the gate on #3893 now
prints `claim file exists but is done — unclaimed` instead of a BLOCKER.

Id _reservation_ is unaffected — `idsFromAssignRef()` reads every entry's `id`
regardless of status, and there is a test pinning that.

**A terminal-state blacklist, deliberately, not an `in-progress` whitelist.**
The two errors are not symmetric: reading a free record as held blocks work
(annoying, safe), while reading a held record as free puts two agents on one
issue — the duplicate dispatch the lock exists to prevent. A whitelist sends an
unrecognised status down the dangerous path; listing the terminal states
`{released, done}` sends it down the safe one. The original bug was an
_incomplete_ blacklist, not the blacklist. The live measurement covers only
statuses written today, so the predicate must not assume that set is closed.

Note the pre-existing `done` records are not migrated: they are simply no longer
read as held, so the 294 phantoms clear the moment this lands.

### The fix is not new output — it is output that now means something

Releasing #2916 with the FIXED tool prints:

```
#2916 is not currently claimed — nothing to release.
claim-issue: OK — #2916 holds no live claim (verified against origin/issue-assignments)
```

The first line is **the same sentence** the old script printed on a failed read —
the sentence that left #3661/#3685 falsely claimed. Nothing about the wording
changed. What changed is that it is now preceded by a read that is _proven_ to
have succeeded, and followed by an explicit verification statement. A reader who
only pattern-matches the message learns nothing new; a reader who checks the
verdict line learns whether it can be believed. That is the whole shape of this
issue: the tool was never short of output, it was short of output that carried
information.

### The forensic fields paid for themselves within hours

Not hypothetical. On the same day this landed, #3636's #3889 collision was
diagnosed **only** because the reservation carried `pr_scan: "ok"` — that field
is what ruled out a degraded scan and redirected the investigation to the real
cause (an id reserved correctly, then a _different_ file written against it 32
minutes later). And the one thing that could **not** be established was _who_
reserved what, because every record of that era carries `assignee: ""`. That is
exactly the gap `requested_by` closes. A forensic field justified by a real
diagnosis it enabled, and an attribution gap justified by a real diagnosis it
blocked, in the same investigation.

### Why records were anonymous

Bare `--allocate` wrote `assignee: ""` and nothing else, so the ref could not
attribute ownership at all. Verified on the live ref: `3889`, `3890` and `3891`
all carry `assignee: ""`.

## Fix — as implemented

1. **Tri-state reads.** `present` / `absent` / `failed`. A failed read is a hard,
   non-zero, legible error and never falls through to "unassigned". An
   unreadable ref is NOT an empty one.
2. **A dedicated bare cache repo** at `<git-common-dir>/claim-issue-cache.git`
   holds every assignment-ref operation, addressed **by URL**. A URL has no
   configured refmap, so the opportunistic remote-tracking update — and therefore
   the lock race — is structurally impossible. Each invocation also fetches into
   its own private ref, so two processes never contend on one mirror. Because the
   cache holds a handful of refs instead of 6,680, the connectivity check is
   trivial.
3. **Verify by effect, never by exit code.** After every push, regardless of what
   git reported, the ref is re-read and the entry compared byte-for-byte with
   what we intended to write. A push that reported failure but landed is reported
   as SUCCESS on the evidence of the ref; a push that reported success but did
   not land is retried.
4. **UNKNOWN is a first-class outcome (exit 7).** When the effect genuinely
   cannot be established, the tool says so and tells the caller to re-read the
   record rather than guessing in either direction. Blind retries after an
   unverified outcome are what burned #3890/#3891.
5. **Unscanned ids are refused before they are burned.** `--no-pr-scan` and a
   degraded open-PR scan both now exit non-zero _before_ reserving, unless
   `--allow-unscanned` is passed; the reservation records the choice in
   `pr_scan`, and a non-`ok` value prints an unmissable warning.
6. **Attribution.** Every record carries `requested_by`, never empty
   (`--by` / assignee / `$CLAIM_ASSIGNEE` / git identity / a traceable
   `unattributed:<host>:<pid>`). Bare `--allocate` still works — CLAUDE.md
   documents it.
7. **git's stderr is captured and surfaced**, not routed to `/dev/null`. This is
   the direct cause of the "produced no output at all" reports.
8. **The last line of output is always a verdict**: `claim-issue: OK — …`,
   `claim-issue: REFUSED — …` or `claim-issue: FAILED — …`. That survives a
   caller's `2>&1 | tail -4`, so a failure is legible even when the caller's pipe
   discipline is wrong. stdout stays clean so `NEW=$(… --allocate)` still works.
9. **Every network call is bounded** and SIGKILLed; a push _timeout_ routes to
   verification rather than to "failed".
10. **`git fetch <remote> main` → explicit refspec.** The old form ran under a
    15 s SIGKILL against a ~48 s connectivity check, so it **never completed** and
    the id scan silently ran against a stale main. It now uses
    `+refs/heads/main:refs/remotes/<remote>/main` with `--refmap=`, a budget that
    can finish, and a loud warning (with the local-vs-remote shas) when it cannot.

Two defects were found _by the new tests_ rather than by the field reports, and
both are now fixed:

- **Cache creation raced.** Building the cache in place let one process `rm -rf`
  a directory another was mid-initialising. It is now built in a private
  directory and moved in with one atomic `rename`.
- **Second-resolution timestamps are not a unique fingerprint.** Six allocators
  racing inside one second wrote byte-identical records, every loser's
  verification matched the _winner's_ entry, and all six reported success on the
  same id. Records now carry a per-invocation `write_id`.

### Exit codes

| code | meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | ok / free                                                                                    |
| 2    | usage error                                                                                  |
| 3    | already claimed by someone else (a legitimate refusal)                                       |
| 4    | already done/wont-fix on main (a legitimate refusal)                                         |
| 5    | gave up after retries under contention — **nothing was written**                             |
| 6    | infrastructure failure, ref unreadable/unwritable — **nothing was written**, safe to re-run  |
| 7    | **UNKNOWN** — the write may or may not have landed. Do NOT retry blindly; re-read the record |

## Test Results

`tests/issue-3880.test.ts` — 17 tests, hermetic (two local bare repos plus a
working clone; no network). Assertions read the **assignment ref itself**, not
stdout, because trusting the report instead of the record is the bug under test.

Every guard was kill-switch verified — reverted, confirmed red, restored:

| guard reverted                                                 | tests that went red                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| tri-state read → return `""` on failure                        | all 3 "a failed operation must never look like success"                            |
| `settle()` → trust `push.ok`                                   | "recovers when the push lands but git reports failure", "reports UNKNOWN (exit 7)" |
| `guardScanCoverage()` → no-op                                  | "refuses `--no-pr-scan` before reserving"                                          |
| `requesterId()` → `""`                                         | both "reservations are attributable" tests                                         |
| `emitMarker()` → no-op                                         | all 6 verdict-marker assertions                                                    |
| _(found during development)_ per-invocation `write_id` removed | "six concurrent allocators" — all six got the same id                              |
| _(found during development)_ in-place cache init               | "six concurrent allocators" — `unable to write symref for HEAD`                    |
| `requested_by` on release/complete → the holder                | "attributes a release to the ACTOR, not to the holder being cleared"               |
| `isHeld` → `status !== "released"`                             | "`--complete` actually frees the lock for readers"                                 |

Measured against the live remote, same repo, same operation:

| operation                    | before            | after                         |
| ---------------------------- | ----------------- | ----------------------------- |
| fetch the assignment ref     | 65-210 s          | **1.18 s cold / 0.50 s warm** |
| `--check <id>`               | (the fetch above) | **1.1-1.6 s**                 |
| `--list` (654 active claims) | **50 s**          | **2.3 s**                     |

`--list` was still spawning one `git cat-file` per entry — the #3079 batching had
only ever been applied to the id scan. Both now share one batched reader.

Portability: the suite also passes with `GIT_DIR` and `GIT_INDEX_FILE` exported,
which is how a git hook invokes it. That matters — see below.

### Live verification against real stale records

Two genuine phantom-owner records were created the same day by a departing
agent whose `--release`/`--complete` hung without writing: **#3893** and
**#3896**, both `in-progress` under `ttraenkler/dev-es3-editions`, both issues
already `done`. Cleared with the fixed tool and verified by re-reading the ref:

```console
$ node scripts/claim-issue.mjs --complete 3893 ttraenkler/dev-es3-editions --by ttraenkler/dev-claim-reliability
Marked #3893 complete (was ttraenkler/dev-es3-editions).
claim-issue: OK — complete #3893 verified on origin/issue-assignments (exit 0)
$ node scripts/claim-issue.mjs --check 3893
#3893 is UNASSIGNED.
claim-issue: OK — #3893 is unassigned (verified against origin/issue-assignments) (exit 0)
```

That run is also what surfaced the `isHeld` defect above: the first `--check`
after a verified-successful `--complete` still said CLAIMED, which is only
visible if you read the record back instead of trusting the success report.

The stored record shows `requested_by: ttraenkler/dev-claim-reliability` — the
**actor**, not the departed holder. That distinction was a bug in the first cut
of this fix: on release/complete the positional argument is the _expected
holder_, so attributing to it would have recorded the dead agent releasing
itself.

## A hazard this issue's own fix work uncovered

While developing the tests, the husky pre-commit hook ran them with `GIT_DIR`
exported. With `GIT_DIR` set, **`git init --bare <path>` does not initialise
`<path>`** — it re-initialises `$GIT_DIR` and writes `core.bare=true` into it.
Because this repo sets `extensions.worktreeConfig`, that landed in the shared
`/workspace/.git/config` and broke every worktree in the container with
`fatal: this operation must be run in a work tree` until it was reverted.

`claim-issue.mjs` had the same latent exposure: it shells out to git constantly
and deliberately sets `GIT_INDEX_FILE` for its commit-tree plumbing. Invoked from
a hook, an inherited `GIT_INDEX_FILE` would have made `read-tree`/`update-index`
clobber the invoking repo's real index, and an inherited `GIT_DIR` would have
aimed cache-repo commands at the wrong repository. All git calls in both the
script and the tests now run under a sanitised environment, with `GIT_INDEX_FILE`
re-added only where it is intended.

## The same failure, arriving through version control — and the session's thesis

Late in this issue's own fix work, the `idsFromMain` fix (see "Fix" item 11) went
missing from the branch. Not to a conflict — to a **lineage split**. The branch's
remote head was advanced by `auto-refresh-prs`; another agent, believing the
author absent after ~50 minutes of a quiet head, built on that refreshed head,
while my commit sat on the pre-refresh base. Neither lineage contained the other.
No conflict, no error, a clean-looking tree, and a PR that would have merged
without the fix.

> **My push failing is the only reason I noticed. Had it succeeded, I'd have
> reported the fix landed and it would simply not have been there.**

That is the same shape as every other failure catalogued here, arriving through
git rather than through a tool's output: a **correct-looking report about work
that isn't there**. The remedies are the same two that the rest of this issue
argues for — verify by reading the record at the tip (`git show <pushed-sha>:file`),
not the exit code; and treat "no error" as no evidence.

Two secondary lessons from the same incident:

- **A quiet branch is not an absent author.** The takeover condition was "wait
  ten minutes, re-check the head, take it if unchanged" — but the head was
  unchanged precisely _because_ the author's pushes were timing out on the very
  latency #3880 is about. The failure mode fed the misdiagnosis.
- **Under contention, preserve before you argue.** Pushing the orphaned commit to
  a separate `rescue-*` branch made it recoverable by anyone with zero clobber
  risk, and cost nothing, before any question of ownership was settled.

## Explicitly NOT fixed here

- **#3636** — "`--allocate` hands out already-taken ids **even with the full PR
  scan**". Separate `ready` issue, separate mechanism. Fresh evidence for it: the
  #3889 collision's reservation record reads **`pr_scan: "ok"`**, so a _complete_
  scan handed out a colliding id (this is #3636's case 4). Note that the `"off"`
  record is **#3891**, not #3889 — an early reading of this session attributed
  3891's value to 3889 and concluded `--no-pr-scan` was the mechanism; the ref
  itself contradicts that.
- **`tests/issue-2943.test.ts > falls back to REST pagination for >100-file PRs`
  is RED on `origin/main`** — verified by running it against main's own copy of
  the script, so it predates this change. It expects the union of the GraphQL
  first page and the REST tail (`[9997, 9998]`) and gets only `[9997]`: the
  first-page ids are dropped when the REST fallback engages. That is a plausible
  contributing mechanism for #3636 and should be triaged there.

## Why priority high

The lock is **advisory**. A standing instruction now says an advisory lock that
cannot be acquired in a few minutes must not stop work — verify the record's `status`
directly and proceed. But that is a workaround: the lock exists to prevent duplicate
dispatch, and while it is wedged the fleet is running without that protection.
The workaround's sharp edge — that it is only safe while the _reader_ path is
sound — is now confirmed rather than suspected (see the top of this file), which
is why the read path was fixed first.

## Acceptance

- [x] Concurrent claims from 4+ agents succeed within seconds, or fail fast with a
      non-zero exit and a legible error. _(six concurrent allocators, 820 ms,
      six distinct ids, asserted against the ref)_
- [x] A failed release/allocate can never be mistaken for success by its caller.
- [x] A successful one can never be reported as failure.
- [x] `--allocate` either reserves an id or exits non-zero — never both nothing and 0.
- [x] A reservation whose open-PR scan did not run is never handed out as clean.
- [x] Reservations carry the requesting agent.
