# dev-ci-3584 — session context (2026-07-31)

Role: developer, CI/merge-queue lane. Brief: fix #3584 (auto-enqueue blind to
workflow-touching PRs), then whatever CI work the coordinator assigned.

## Outcome

| issue | PR | state |
| --- | --- | --- |
| **#3584** auto-enqueue can't see permanent `BLOCKED` | **#3897** | **merged** |
| **#3643** / #3888 unpark (trap ratchet) | **#3888** | **merged** |
| **#3915** trap-gate message wording | **#3902** | **merged** |
| **#3635** artifact storage exhaustion | **#3907** | in flight |

Issues filed from evidence: **#3906** (option G for #3584), **#3916** (latent
`Array.from(...).map()` trap).

## The through-line: four premises measured, three collapsed

Every task this session arrived with a stated cause. Measuring first changed the
answer three times out of four. That is the reusable part, not the individual
fixes.

### #3584 — the premise held, but the attribution was wrong twice

`mergeStateStatus` is computed **relative to the querying token**, so `BLOCKED`
means "*you* cannot merge this", not "this PR is not ready".

The failing cell is the **conjunction**: fork-head **AND** touching
`.github/workflows/`. Neither variable alone predicts anything — fork-head
without workflow files auto-enqueues (#3887/#3889/#3890), upstream-head with
them auto-enqueues (#3690/#3843/#3833), and 4/4 in the conjunction needed a
human (#3567/#3590/#3602/#3609). The memory note
`reference_workflow_touching_prs_never_autoenqueue` had already been corrected
once (to "fork-head is the real correlate") and **that correction was also
wrong**; it is now updated with the full 2×2.

**Why the mechanism is still not established:** "the app token lacks `workflows`
and GitHub treats fork-authored workflow changes differently" fits 4-vs-9 and is
probably right. It is **untested**. #3906 carries the one-call experiment. Do
not let option A (granting the app `workflows: write`) be justified by it —
that would buy arbitrary CI modification from a `workflow_run` trigger on an
unverified premise.

**#3884 was NOT a counter-example.** It looked like one: fork-head,
workflow-touching, merged unaided. Filtering `auto-enqueue` runs **server-side**
showed no run between 10:35:01Z and 11:01:30Z; it went green at 10:36:28Z and
was hand-enqueued at 10:42:56Z. **The app never observed it green.** Its single
`skip (BLOCKED)` reading was taken with checks still pending.

What landed (option C, script-only): `classifyBlockedSkip()` splits transient
from suspected-permanent `BLOCKED` and emits a `::warning::` plus a
`needs-manual-enqueue` label. That label is **deliberately absent from
`HOLD_LABELS`** — a hold would make `auto-enqueue` skip the PR forever, turning
the warning into the stall it reports.

### #3888 — the park said `pass → trap`; the baseline said `fail`

The ratchet reported *"Newly trapping: …"*, which reads as "this used to pass".
It only ever meant the **category** grew. Baseline recorded `status: "fail"`,
confirmed by checking main's `src/runtime.ts` into the branch and reproducing
the identical error at the identical line — a `fail → fail` flavour change,
i.e. exactly #3596's valve, the opposite of the brief.

Slice B introduced no trap; it advanced a test past its first assertion into a
**pre-existing** one. Probes isolated it: `Array.from("ab").map(f)` traps **on
main**, and `Array.from({length:5}).map(f)` traps on main too — where
`Array.from` returns `[]`, so the callback runs **zero times**. Not `undefined`
elements, not element type, not `Array.from` itself. Filed as **#3916**.

**#3915 (PR #3902) fixes the wording that caused this**: the failure now prints
each file's baseline status and names which mechanism it selects. A comment ten
lines above the message already said what the message didn't.

### #3635 — the headline collapsed by ~250×

`total_count` = 1,017,559 is a **metadata row count**. An expired artifact keeps
its row with `size_in_bytes` still populated — which is exactly how a naive sum
manufactures a fake terabyte — while occupying zero storage.

Binary search on the expired/live boundary (expiry is a **suffix**, so it
bisects): **99.1 % already expired**; live ≈ 8,800 ≈ **4.9 GB**.

Two independent falsifications, either sufficient:
- **Storage is not exhausted** — an artifact uploaded **31 s** before the check.
- **The 403s are not recurring** — 14/15 recent runs green incl. every
  `merge_group`, and storage has only *grown* since.

The proposed retention fix was **already implemented** (26/27 upload steps).
Closed the one gap (`vacuity-canary.yml`), sized honestly: it leaks **nothing**
today — that workflow has run once and produced zero artifacts.

**Do not run the bulk delete.** ~0 bytes reclaimed for ~1M rate-limited
DELETEs. Accepted by the coordinator.

### #3634 — un-suppressed

#3635 had parked #3634 as "a symptom of storage exhaustion". Falsified. The
durable argument: **alerting is cause-independent by construction** — whatever
caused six silent failures, #3634 asks for the thing that would have surfaced
them. Stated at **both** ends of the link, because a wrongly-*suppressed* issue
is never re-read: the reason it was parked sits in a different issue that reads
as settled.

## Reusable hazards this session (all cost real time)

1. **A tool that returns "nothing" may be broken, not empty.** Five instances:
   - `grep` silently returns **zero hits on `scripts/diff-test262.ts`** (treated
     as binary; `grep -c` prints nothing). Use `grep -a`. There is a memory note
     for this exact file; reach for it sooner.
   - `prettier --check` on a path under `.tmp/` reports **"All matched files use
     Prettier code style!"** while checking **zero** files — `.tmp/` is
     gitignored and prettier honours `.gitignore`. That false green nearly put
     **40 files of unrelated artifact churn** into a PR.
   - A step-aware retention checker reported **0/27**: `uses:` and `with:` are
     **sibling keys at the same indent**, so each step's scan ended before
     reaching `with:`. Caught only because grep had already proven one file
     *does* declare it — a positive control doing its job.
   - `cmd | tail` reports **`tail`'s** exit status. `VERDICT=0` while node had
     died `MODULE_NOT_FOUND`. Heuristic that saved it: **a passing gate should
     not print a stack trace.**
   - `git push` reported as **timed out had already succeeded** (twice). Verify
     with `ls-remote`, not the exit code.
2. **`claim-issue.mjs` misreports in both directions.** Its stdout showed only
   `push rejected (attempt 1/6)` while the claim had in fact landed. **Read the
   record back** (`git show origin/issue-assignments:<id>.json`); never retry on
   apparent failure without reading first — two ids were burned that way today.
3. **`quality` is fail-fast**, so the first failure masks every downstream gate.
   Run the lanes locally rather than discovering them one round trip at a time.
4. **`CLAUDE.md` conformance-drift gate**: if it goes red, **diff the marker
   block against main** before assuming staleness. One occurrence today was
   **whitespace** — an earlier `prettier --write CLAUDE.md` inserted blank lines
   inside the `AUTO:conformance` markers. `format:check` is scoped to `src/`,
   `tests/`, `scripts/`, so `CLAUDE.md` is **not** prettier-checked and that run
   was self-inflicted. `sync:conformance` rewrites the **number, not the
   whitespace**, so it reports drift it cannot repair. Merge-then-sync is right
   only when the *figure* is genuinely stale.
5. **`core.bare = true` can appear transiently in `/workspace/.git/config`**,
   breaking every worktree with `fatal: this operation must be run in a work
   tree`. Root cause (per coordinator): a `git init --bare` inheriting `GIT_DIR`
   from a husky hook. Check
   `git config --file /workspace/.git/config core.bare` — it must be `false`.

## Open threads

- **#3907** in flight. If it parks, diagnose rather than pushing more work into
  it. Note it is fork-head **and** workflow-touching — the #3584 cell — so a
  green-but-unqueued state is the measured behaviour, not a fault.
- **#3906** — the option-G experiment is unrun. One deliberate app-token
  `enqueuePullRequest` against a scratch PR answers it. Its half-success mode is
  **worse than today** (doomed `merge_group` on a serial queue → auto-park
  `hold` → permanently skipped), which is why it was not bundled.
- **#3916** — the `Array.from` trap is unfixed and the root cause is a
  hypothesis (`T[]` lowered as a WasmGC vec while the runtime returns an
  externref host array). Confirm against emitted Wasm before fixing.
- **Two items needing more authority than a dev has**, passed to the
  stakeholder: lowering the repo artifact-retention default from 90 days (org
  admin), and reading the actual bill — `orgs/loopdive/settings/billing/
  shared-storage` now returns **410 "moved"** *and* needs `admin:org`. The
  4.9 GB figure is this repo's live artifacts, **not** the bill, and 41 other
  private repos share the quota.
- **TaskList was never available in this session's context** (`TaskList exists
  but is not enabled in this context`, the #3121 gap). Every task came by direct
  assignment from the coordinator.
