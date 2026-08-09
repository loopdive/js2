# shepherd-2 — PR-queue shepherd session context (2026-07-31)

Standing PR-queue shepherd. Took over a queue with no owner and ~6 PRs in or near it.

## Outcome

Seven PRs merged clean during the session: #3892, #3894, #3895, #3896, #3897, #3898, #3899.
No PR was enqueued or re-enqueued by me at any point — `auto-enqueue.yml` is the single
enqueuer and it worked correctly every time, including after a park-hold removal.

Filed **#3915** (PR #3900). Unparked **#3888** after diagnosis. Closed **#3883** as superseded.

---

## Reusable technique: a queue watcher must break on the LABEL, not on state

This is the one operational lesson most worth carrying forward.

**An `auto-park` leaves the PR `OPEN` while dropping it from the merge queue.** So a watcher
that polls only `gh pr view --json state` (OPEN/MERGED/CLOSED) cannot distinguish:

- a park (bot added `hold`, needs a human), from
- an ordinary ejection / rebuild (self-healing, needs nobody).

Both look like "still OPEN, no longer in `queue=[…]`". A state-only watcher therefore sleeps
through the single event it exists to catch, and reports it only when the loop finally expires.

**Poll the labels and break on `hold`:**

```bash
L=$(gh pr view "$PR" -R loopdive/js2 --json labels --jq '[.labels[].name]|join("+")')
case "$L" in *hold*) echo "PARKED — read the cited run BEFORE touching the label"; break ;; esac
```

Two corollaries:

- **Watcher exit ≠ settled.** A fixed iteration count can expire while a PR is mid-rebuild
  (each `merge_group` validation is ~11–13 min, and rebuilds are common — see #3915). Treat the
  exit as "resume sweeping", never as "resolved". Conflating the two is the #3121 gap itself.
- Working script: `/tmp/watch-queue.sh` (ephemeral; the technique above is the durable part).

## Reading merge_group runs correctly

**The SHA in `gh-readonly-queue/main/pr-N-<sha>` is the BASE commit, not the group head.** Two
distinct groups for the same PR look like one run set unless you compare that embedded SHA.
This produced an incorrect "all green" report on a _superseded_ group during this session; it
had to be retracted. Group by `(PR, base SHA)` — any PR with more than one distinct base had a
validation discarded.

`gh run view --json jobs` on a superseded group still reports `success`. That success is real
but applies to a base that no longer exists.

---

## #3915 — benchmark-refresh discards in-flight merge_group validations (PR #3900, open)

`benchmark-refresh.yml` pushes `chore(ci): refresh landing benchmark artifacts [skip ci]`
**directly to `main`** after every merge; any push to `main` rebuilds the merge group and
**discards the in-flight validation**, including fully-green ones.

**It is a feedback loop, not a coincidence:** the bot push is triggered _by_ each merge and
lands **7–12 min later**, while the next PR's group is built within seconds of that merge and
takes **11–13 min**. So every merge schedules a push timed to land inside the next merge's
validation window. **The tax scales with merge throughput.**

Measured (09:23–14:03Z, 17 PRs): **6 of 17 PRs (35%) needed >1 group; 8 rebuilds, 7
bot-attributable, 1 legitimate; 129 min discarded, 93 min attributable.** Two more were caught
live afterwards (#3894, #3899), taking the running tally to 9/8.

**The ratios are the finding, not the minutes** — `actions/runs?event=merge_group&per_page=100`
is a **sliding page**, so window bounds and absolute totals depend on when you sample. Two
independent samples gave different minutes and the **same 7:1 ratio**.

Traps recorded in the issue: `[skip ci]` does not stop a queue rebuild · base-vs-head SHA ·
the regressions artifact names almost no regressed path · `Newly trapping:` does not mean the
file used to pass · prose written to compensate for broken tooling outlives the breakage.

## #3888 — unparked on machine-checkable grounds (in queue at hand-off)

Bot park-hold was a **real** gate failure, but the failing arm was the **#3189 trap ratchet
alone** (`illegal_cast` 76→77, one named file). Settled from source, not inferred:
`test262-sharded.yml` runs _Fail on regressions_ only when `diff-test262.ts` exits 1, and that
exit is `if (gateFailed)` — set **only** by explicit arms (devac, regressions-allow, trap
ratchet, `netPerTest < 0`, per-bucket concentration). **No arm fails on "regressions exist."**
Net was +39; the ratio arm printed `WAIVED`.

"33 regressions" decomposed to **22 compile_timeout (flake) + 10 `absent` (missing rows) + 1
substantive** — the headline overstated the real finding ~33×.

Hold removed after confirming: the `trap-growth-allow` grant lives in `3643-*.md` which the PR
**itself touches** (grants only resolve from a file in the change-set); it names exactly one
file with `count: 1`; the baseline status was established **by reproducing it with main's
`src/runtime.ts`**, not inferred; and — decisively — `evaluateTrapReclassification`
machine-checks every named claim, so a `pass` baseline row would hard-fail regardless of my
judgement.

**OUTCOME: MERGED 2026-07-31T15:02:53Z**, merge commit `05686f7a42de`, **no labels, no
re-park.** It took two groups (bases `6149dd55` then `49d05c14`), both fully green on all four
merge_group workflows. **The `trap-growth-allow` declaration held on the merged state** — it
was both correct and complete, so neither of the two re-park paths below materialised. The
unpark decision is validated by the merged-state gate itself, not merely by my reading of it.

Those two paths are kept because they remain the right first questions for any future
`trap-growth-allow` park, and **neither would have implied the fix was wrong**:

1. Growth still exactly `illegal_cast 76→77` on that one file ⇒ **per-SHA baseline drift**.
2. A second file or a second category ⇒ **`trap-growth-allow` incompleteness**, because the
   declaration is measured pre-merge while the gate runs on the merged state.

Either remedy is a **frontmatter edit** (extend `tests:`, bump `count:`), not a re-diagnosis.

## #2916 / #3883 — read the record, not the prose

#3883 warned #2916's claim record was stuck at `in-progress`. The record reads
**`status: released`, `released_at: 2026-07-31T08:55:03Z`** — the release _did_ land; an attempt
reported as failed had already written it. `pre-dispatch-gate.mjs` tested `assignee` alone and
ignored `status`, so a released record still printed `CLAIMED by …` (fixed in #3901),
corroborating the wrong story. Three readers misled ~6 h.

```bash
gh api "repos/loopdive/js2/contents/2916.json?ref=issue-assignments" --jq '.content' | base64 -d
```

Quote the URL — zsh globs the `?`. **A tool that can report failure after succeeding makes its
own output inadmissible as evidence.** #3883 closed; the durable half carried, corrected, on
#3900.

## Environment notes

- `git fetch` / `claim-issue.mjs --allocate` frequently **time out or wedge** here (ref-lock
  contention across concurrent agents — #3880). Prefer the GitHub API over git for reads.
- `grep` returned a **false empty** on `scripts/diff-test262.ts` (a known, named hazard) —
  a positive control caught it. Use `node` to search that file.
- `gh pr edit` can fail on a Projects-classic GraphQL deprecation; use
  `gh api -X PATCH repos/loopdive/js2/pulls/<N> -F body=@file` instead.
- Label removal: `gh api -X DELETE repos/loopdive/js2/issues/<N>/labels/hold`.
- The pre-commit hook greps the **command line** for `✓`, not the `-F` message file — append
  `# checklist sign-off: ✓` to the `git commit` command.

## Open at hand-off

**Eight PRs merged clean this session** — #3892, #3894, #3895, #3896, #3897, #3898, #3899,
**#3888**. Nothing I unparked or touched re-parked.

- **#3900** (the #3915 filing, plus this summary) — **open**, awaiting auto-refresh.
  **Deliberately not enqueued by me**; `auto-enqueue.yml` owns that.
- **#3901** — open (claim-tooling fix; also unblocks #2916 by making heldness read `status`).
- **#3877** — left alone (contended).
- **#3687** — held since 2026-07-29, out of scope, **untouched**. Its park cited a genuine
  catastrophic-guard + regressions failure and it is DIRTY; it needs an owner, not a
  label removal.

Nothing is mid-flight and nothing is waiting on me.

---

## Late-session additions (post-#3900)

Two lessons that arrived after the summary above was written, plus the state that superseded its
hand-off list.

### Prefer someone else's stronger evidence over your own

Both `dev-ci-3880` and I independently reached the same conclusion — that `prettier` does not
gate `CLAUDE.md`, so the post-`sync:conformance` form is safe. **Their proof was better and I
said so**, in the reply and in the issue:

- **Mine (circumstantial):** `origin/main`'s own `CLAUDE.md` is prettier-dirty by exactly those
  two blank lines, and main is green — therefore prettier cannot be gating that file. True, but
  it only shows prettier does not _currently_ gate it.
- **Theirs (mechanistic):** `package.json` defines
  `format:check => prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`.
  `CLAUDE.md` matches none of those globs, so it is **never** prettier-checked. Exact, and it
  states _why_.

I verified their claim against `package.json` rather than relaying it, then told them to use
their version rather than mine. **Converging on the same answer by two routes is worth more than
either route alone** — and when a teammate's evidence is stronger, adopt it and say so rather
than defending your own derivation.

### A post-hoc census under-reports precisely the events that were handled

Re-running a failed CI job **overwrites its check-run record**. So a census taken later reads
`success` for exactly those jobs that someone noticed and remediated. Of four checkout-stall
flakes observed contemporaneously this session, two later read `success` **because they had been
fixed**.

**The bias runs in the worst possible direction for a flake count**: the instrument is blindest
to the failures that were caught, so remediation looks like absence of the problem, and the more
diligent the response the smaller the measured incidence. Corollary: **use contemporaneous logs
as the evidence for flake frequency and say so explicitly**; do not re-derive counts from check
history after the fact. Same family as the other silent-empty findings — an instrument that
cannot see what already happened, failing toward the reassuring answer.

### Superseding state

The "Open at hand-off" list above is stale. Later in the session: **#3900 merged**
(2026-07-31T16:05:32Z), putting the #3915 issue file and this summary on `main`; **#3901** was
found stranded with `quality` red on its current head for ~50 min behind an entirely benign
surface (`BEHIND`, no `hold`, absent from queue), root-caused to two prettier-added blank lines
in the `AUTO:conformance` block, fixed by the shepherd while its author was stopped, then
restored by that author after a lineage split and carried to queue position 1; **#3907** was
manually enqueued once under explicit tech-lead authorisation as the documented #3584
(token-relative `BLOCKED`) case, with preconditions checked at the moment of action and a PR
comment recording it so a label-driven sweep cannot rebuild the merge group; and **#3923** was
opened carrying the #3915 addendum.
