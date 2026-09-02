# Handoff — IR migration lane (Fable planning seat), 2026-09-02

Written at suspend. This is the state a successor needs to resume without
re-deriving it. Everything below was measured or read, not inferred; where a
claim is unverified it says so.

## What this seat does

Writes measured, adversarially-critiqued `## Implementation Plan` sections into
issue files, then dispatches Opus lanes (remote CCR sessions) to implement them.
It does not implement. It also owns the merge-queue shepherding for its own PRs.

## Landed today (main)

| PR | What |
| --- | --- |
| #5482 | #3526 F2-S8 `string.const` — **completes R6 family 2** at manifest level |
| #5480 | #3523 gap-6a v2 (re-applied after the #5477 revert) |
| #5483 | docs: #3521 R2-T1/G1 + R2-F1 plans; #5276 filed |
| #5485 | docs: R6 family-2 close-out + family-3 census and slice map |
| #5496 | docs: #5278 filed (selector callable-equality pre-claim gap) |
| #5486 | #3521 R2-T1/G1 — R2 admission-withdrawal telemetry, `tests/ir` under CI |
| #5487 | #3526 F3-S1 — host callback maker under manifest policy |

## Open PRs and exactly what unblocks each

- **#5502** (docs, this branch `claude/docs-f3s2-gap6b`) — carries the F3-S2
  plan, the #3523 gap-6b design record, the #5276 reachability correction, #5280
  and #5281 filings, this handoff, and the **conflict-marker resolution**
  described below. `hold` removed at suspend; nothing gates it.
- **#5498** (#5276 fix — for-head var stale module-global index). Held.
  Code verified correct by this seat: the pin fails 4/4 on base with the seam
  OFF and passes 4/4 on branch. The review lane
  (`session_01GbawkoAxzNaS1GKQx2HY1W`) returned **"code correct, test
  non-vacuous; hold on evidence record"** — its written report was never
  retrieved. **Retrieve that report before releasing.**
- **#5504** (#3526 F3-S2 callable capability-record schema widening). Held,
  stacked on F3-S1 (now merged, so the stack is resolvable). The lane reports
  11/12 plan rows shipped, `closure.apply` deferred to F3-S6, V-A/B/D/F green.
  An adversarial review lane (`session_01KESR3Jb6NRvURvJiSnXKBw`) was still
  running at suspend. **Release only on that review's verdict.**

## The conflict markers — fixed forward on #5502, do not re-break

PR #5487's merge commit `b16a68d06f` committed literal `<<<<<<<` / `=======` /
`>>>>>>>` into `plan/issues/3526-ir-r6-semantic-runtime-contract.md` (lines
9551/9583/9608) and **merged to main that way**. The merge message stated the
intended resolution — "Both kept: the lane's re-measurement first, then the
review findings" — but never wrote it.

Resolved on this branch in that stated order, with a content-loss check: every
non-marker line of both `origin/main` and this branch's version is present in
the result (0 missing, verified programmatically). No prose was edited.

`#5281` is filed to make the cheap gate refuse this class. Note the design
constraint recorded there: a bare `=======` is a legitimate markdown setext
underline, so the gate must only flag it when a `<<<<<<<` precedes it.

## Remote lanes still in flight at suspend

Each is a CCR session (survives container restarts, unlike local Workflow runs).
Read the session, harvest the work, then archive it.

| Session | Lane | State at suspend |
| --- | --- | --- |
| `session_01KESR3Jb6NRvURvJiSnXKBw` | F3-S2 adversarial review of #5504 | running |
| `session_01R1JN3ZKjCsrom8FpAMH4N1` | #3521 R2-F1 fast-lane mixed string/scalar admission | running, in V-C/V-D verification |
| `session_01Fv4uVvb6ttPfMbzbuR4xaK` | #5280 queue flake root-cause | running, still cloning |
| `session_01W3s7iH2LKukgBuaZHXm53m` | #3526 F3-S3 plan (`functionPrototypeCall`) | running |
| `session_016KaHznvZiVM68kvonzqeoT` | #3521 R2-E1 plan (extern/reference-carrier certification) | running |
| `session_019wV6MkAzbxEyTEe3MaQCPr` | #3527 R7 readiness census | **idle, review-ready** — design record drafted |
| `session_01VDoJL5WxevynhetPFVFWGE` | R9 precursor — ir-only denominator census | **idle, review-ready** — R9a gate analysis, 3 findings, 3 open questions |
| `session_01GbawkoAxzNaS1GKQx2HY1W` | #5498 evidence review | **idle, review-ready** — report unretrieved |

The four review-ready ones are the cheapest resumption points: their work is
done and only needs harvesting into issue files.

## Open threads, ranked

1. **The merge-queue configuration contradiction — unresolved, and it decides
   whether an escalation already made to the project lead was a no-op.**
   `plan/issues/5275-merge-queue-lands-failed-predecessor-via-skipped-shard-group.md` attributes four same-day landings of a failed
   predecessor to speculative group building (`max_entries_to_build > 1`), and
   this seat escalated "set it to 1" to the user twice. But
   `docs/ci-policy.md:189-190` says the canonical config **already is**
   `max_entries_to_build: 1`, and `:257` says that setting makes the very
   mechanism #5275 describes impossible ("requires ≥2 entries green
   simultaneously"). Both cannot be true alongside four observed instances.
   The doc names `scripts/set-merge-queue-config.sh --show` authoritative and
   itself admits it went six weeks stale on this exact value.
   **Resolution blocked at suspend: `gh` is not installed in this container**
   (the script shells out to it), so `--show` could not be run. Run it first
   thing. If the live value is already 1, #5275's mechanism section and
   acceptance criteria are wrong and must be rewritten, and the lead should be
   told the admin change is unnecessary.
2. **#5280 null-proto-super flake** — `class-definition-null-proto-super.js`
   flipping pass→fail with "Maximum call stack size exceeded", bucket signature
   `96690aa5e0efb4ff`, parked three unrelated PRs today (#5479, #5480, #5486).
   Lane dispatched. Until it lands, expect roughly one park per few merges, and
   the sanctioned response is exactly one diagnosed re-admission.
3. **R9's denominator is the real gate, and part of it is now measured.**
   Before suspending I measured the eight playground entries the gate does not
   run (the gate's own lane observers take an entries override). They carry
   **8 unsupported / 10 legacy bodies on single-host and 14 / 14 on
   standalone**, against 0 and 0 on the gate's five — so widening the corpus
   flips READY to NOT READY. Full table, the two compile-once violations, and
   a probe trap that produced a wrong reading are recorded in
   `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`. What
   remains open is the denominator beyond `website/playground/examples/`.

4. **The original framing of that gate, for context.**
   `pnpm run check:ir-only` reports **READY** on main — both lanes, 41 terminal
   units, 38 emitted, 0 unsupported, 0 invariants, 0 legacy body emitted. That
   is genuine but **narrow**: `scripts/check-ir-only.ts:14-20` runs a **five-file**
   corpus. The script's own comment says wider compiler reachability is a
   separate R9/R10 requirement. Do not read READY as "the migration is done";
   the goal's completion criterion needs the denominator census
   (`session_01VDoJL5WxevynhetPFVFWGE`) first.
5. **#3523 gap-6b** — record verified and shipped. Verdict: the recommendation
   ("retire pass 2, not pass 1") **holds only as a gated slice choice**. The
   direction is measured; acceptance is not, because every corpus row was
   measured under the route being rejected. P1, P4 and #5276 are hard
   preconditions. **No lane dispatched, deliberately.**

## Corrections made this session (do not silently re-introduce)

Four filed facts were withdrawn after measurement contradicted them:

- **#5276 was filed as "invisible on main today"** — false. It is a live
  wrong-code bug on the default route, refuted twice independently (#5498's pin
  failing 4/4 on base with the seam OFF; the gap-6b verification reading
  `read = 4` against a forced two-pass `read = 2`). Priority raised to high.
- **The F3-S2 plan draft declared three contracts the compiler does not
  follow** — a `hostSelection` axis contradicted by `host-call-fallback.ts:20`,
  a `callable.boundary_callback.call` `max: null` asserted on zero measurement,
  and a control list claiming seven moving pins were unchanged. Plus two missed
  guard sites. All re-anchored (14 edits) before dispatch.
- **The R2-T1/G1 checkpoint explained the multi-route default with the wrong
  mechanism** ("written later, so it wins"). Correct: it is *the only writer* —
  `compiler.ts:1102-1103` picks `generateMultiModule` XOR `generateModule`.
- **A CI-comment diagnosis was wrong in three places**, `docs/ci-policy.md:63`
  included: both cited commits are src-only, so the advisory directory match
  (which selects on changed *test* paths) would not have caught either. The
  **pin** is what catches that shape.

The pattern behind all four is worth carrying forward: each was a figure
inherited from an artifact and restated as a measurement.

## Standing operational constraints

Never `--no-verify`. Never enqueue or re-enqueue from an agent — the server-side
`auto-enqueue.yml` is the single enqueuer. Never rebase or force-push. Never
bare `git stash` (one shared stack across every worktree). Run all five ratchet
gates chained before committing, and again under
`LOC_GATE_BASE=$(git rev-parse origin/main)` to simulate CI's base. New issue
ids only via `claim-issue.mjs --allocate`. Docs-only work goes in **one** open
docs PR.

Note for the next container: **`gh` was absent here.** GitHub work went through
the `mcp__github__*` tools against `loopdive/js2` (this session's only permitted
repo). Anything in the docs that shells out to `gh` — including
`set-merge-queue-config.sh` — will fail until `gh` is installed.
