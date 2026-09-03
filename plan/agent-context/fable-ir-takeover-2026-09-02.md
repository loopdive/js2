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

**FINDING from the 02:15 sweep — four non-mergeable checkpoint PRs are neither
draft nor `hold`-labelled.** #5390, #5393, #5397 and #5400 (all `ttraenkler`
codex-lane checkpoints) each say in their own body that they must not merge —
*"remains draft"*, *"not mergeable"*, *"intentionally red"*, *"keep this PR
draft until…"* — yet the API reports `draft: false` and no label on any of them.
Nothing but red CI is keeping them out of the queue: `auto-enqueue.yml` takes
any `CLEAN`, non-draft, non-held PR, and it does not read prose. If someone
fixes CI on one of these intending only to unblock a check, it merges.

**Not acted on deliberately** — these are the project lead's own PRs, and
labelling four of them unilaterally at 02:00 is an outward-facing change to
someone else's work that costs nothing to defer. Urgency is genuinely low
(they have sat since 2026-09-01 without being taken, which is itself evidence
they are not `CLEAN`). The fix is one `hold` label each, or `draft: true`,
whichever the author prefers — **`hold` is the safer of the two**, because
`auto-refresh-prs` SKIPS drafts, so marking them draft would also stop them
being rebased and let them rot behind main the way #3919 did at 177 commits.


**#5511 arrived after suspend and is REVIEWED — verdict release, no blocker.**
`feat(ir)`: string module bindings on both string backends (#3523 R4-M1), the
largest R9 blocker. Reviewed at
<https://github.com/loopdive/js2/pull/5511#issuecomment-5519202513>. One `{ kind:
"string" }` deferring the carrier to the backend, byte-neutral on 66/66, storage
blocker 20 → 17 rows. Its `scripts/ir-kind-neutrality-baseline.json` edit is
**sanctioned** — that gate documents author-committed refreshes, unlike the
loc/func ratchets. CI was still running at suspend (only `cla-check` reported).
**#5511 and #5509 both append to the end of
`plan/issues/3523-ir-r4-module-init-compile-once.md` and will conflict: union in
document order, the #5509 retraction first.**

**It also refuted a finding of mine that was live in #5509.** I had recorded
that each of the 13 blocked dogfood files has exactly ONE storage-blocking
category, and concluded payoffs were "independent and additive." That is an
artifact: `buildModuleBindingGlobals` (`src/ir/integration.ts:5839-5846`) throws
on the FIRST unrepresentable declaration and the shape-diag recorder sits on that
throw, so it can only ever report one category per file. `escapes-unicode.js`
(string line 1, object literal line 5) was recorded string-only and did not move
under R4-M1, while `templates.js` and `regex.js` did. Retracted in `05f1b64992`
with the mechanism; **the all-or-nothing rule stands and the category counts are
lower bounds.** Do not rank storage extensions by them until the diagnostic pass
is made non-short-circuiting.


**Late arrivals — two lane PRs landed after this handoff was first written, both
`hold`-labelled and both needing a reviewer. A held PR is skipped by
`auto-enqueue` and strands until someone resolves it, so these are the two most
time-sensitive items here:**

- **#5506** — `fix(#5280)`: stop the null-proto-super flake from parking
  unrelated PRs. Directly relieves the flake that parked three PRs on
  2026-09-02; worth reviewing first for that reason.
- **#5507** — `refactor(#3521)`: R2-F1 fast-lane mixed string/scalar signature
  admission. Stacked on R2-T1 (#5486, merged), so the stack is resolvable.

**#5508** carries this handoff and the R9/R4 census; **#5502 has merged.**

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

## Post-suspend work, 2026-09-03 02:00–03:00 (read this before the threads below)

Six increments after the handoff was written. Four findings change what the
next session should do; two issues were filed with plans.

**R4 — the slice order was wrong, and is now measured.** The retracted per-file
census ranked `string` first. Re-measured non-short-circuiting (parse every
top-level declaration statically; `.tmp/census-all-decls.mjs`): it is **14 files
not 13** (`destructuring.js` throws upstream of the recorder entirely), 10 of 14
mix categories, and **`any` unlocks 4 files alone while `string` unlocks zero
and does not enter the best set until position 9.** So R4-M1 (#5511, string) was
correct to move no file to `emitted` — its target was unreachable by
construction. **The next R4 slice is the `any`/dynamic carrier**, specified
against #5285 rather than this syntactic probe.

**R9 — #4522's inventory was missing seven hatches**, each verified at its site.
Two classified (`JS2WASM_STRICT_FALLBACKS` is subsumed by R9's definition; the
module-init discovery seam matches an existing row). **Five left open on
purpose**: `DIRECT_CALLS` and its pinned-`this` sibling gate devirtualization
inside `src/codegen/` — backend lowering, the axis that *stays* — so on one
reading they are not R9's at all. The answer decides whether R9's retire-at-R9
population is **14 or 16**. Needs the table owner.

**R10 — the discrepancy is attributed, and the sizing is real.** The July tree
was reachable all along (`git fetch --shallow-since=2026-07-10`); the audit
script is byte-identical across the two dates. Legacy-only fn-lines reproduce
(60,126 measured vs 59,676 recorded a day earlier) so **+42.7% growth is real**
and any R10 estimate built on 59,676 understates by ~26,000 lines. The `files`
column does *not* reproduce (47, not 35) — it was undercounting.

**R10's shape matters more than its total: 78 of 107 frontend files are 100%
legacy-only (65,318 lines, 76%) and delete whole.** The work is 29 mixed files
holding 266 shared functions. `for-of-destructuring.ts` is the ideal first
slice — lift **one** function, delete 2,041 lines. Ordering is forced by
`check:dead-exports` gating `quality`: delete callers before definitions, run
the gate *between* slices.

**One figure I published tonight and withdrew.** "Frontend share of legacy-only
rose 48.5% → 51.9%, the deletion target is being outpaced" — invalid.
`bucketOf` is a hardcoded path lookup and two of its prefixes are directories,
so the frontend *set* grew as `expressions/` and `statements/` grew. The +42.7%
survives (per-function class); the share and the 47 → 107 file rise do not.

**Filed with implementation plans:** **#5285** (the module-init refusal survey —
until it lands, do not rank storage extensions by category counts) and **#5286**
(make the audit report asserted-vs-measured; deliberately does *not* re-bucket,
because the buckets encode intent a ratio cannot express).

**#5511 reviewed → release; its `hold` removed 02:14.** It was the lane's own
do-not-enqueue label awaiting a reviewer.

**Method, three times in one night, one root.** A fail-fast path read as a
survey; a fetch boundary read as absent history; a hardcoded label read as an
analysis result. Each time the instrument was assumed to answer the question
asked of it, and each time one look at the source settled it in under a minute.
**Name the instrument and ask what answer it cannot return.**

## Open threads, ranked

1. **#3522's claim is a GHOST — one command unblocks a `priority: critical`
   issue that has been undispatchable for five days.** `claim-issue.mjs --check
   3522` refuses (exit 3) for `ttraenkler/opus-3522-f4`, claimed
   2026-08-28T22:01:28Z. That lane's PR **#5199 merged 2026-08-29T04:27:46Z**
   and never released; its branch is 0 ahead / 1299 behind and no `*3522*`
   branch has moved since 2026-08-16. Meanwhile R3 is the **second-largest
   blocker** in tonight's dogfood census (7 of 33 single-host rejections are
   the class family) and is invisible to both `claim-issue` and
   `budget-status --pick`.

   ```bash
   node scripts/claim-issue.mjs --release 3522 ttraenkler/opus-3522-f4
   ```

   **Deliberately not run by this seat**, and the reason is an asymmetry worth
   preserving: #3522 is `horizon: xl` and #5199's body says "F4 is a checkpoint
   under #3522, not its completion," so a release that is wrong lets a second
   lane redo XL work (a week) while a release that is late costs a day. I also
   checked whether the F4 session still exists — it does not appear in a
   100-row `list_sessions` covering the window — but **that proves less than it
   looks**: an in-process subagent never gets a session row, and the claim
   landed 17 minutes after the still-RUNNING `IR migration` session opened,
   which is exactly that shape. Full evidence, including what the listing does
   and does not establish, is on
   `plan/issues/3522-ir-r3-classes-closures-compile-once.md` (two dated
   sections at the end). The one check I could not make: whether that RUNNING
   seat considers F4 unfinished work of its own.

2. **The merge-queue configuration contradiction — unresolved, and it decides
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
3. **#5280 null-proto-super flake** — `class-definition-null-proto-super.js`
   flipping pass→fail with "Maximum call stack size exceeded", bucket signature
   `96690aa5e0efb4ff`, parked three unrelated PRs today (#5479, #5480, #5486).
   Lane dispatched. Until it lands, expect roughly one park per few merges, and
   the sanctioned response is exactly one diagnosed re-admission.
4. **R9's denominator — measured on two corpora, and root-caused.**
   `check:ir-only` is READY only against 5 hardcoded entry files. Widening it
   flips the verdict, so R9's flip cannot be scheduled off the current green.
   The blocker is **corpus-dependent**: on `tests/dogfood/corpus` (20 module-
   bearing programs) module-init adoption is 0 of 20 executable units on both
   lanes; on the playground's uncovered eight all 8 module-inits are
   non-executable and the standalone blocker is `host-surface-unavailable`
   (12 of 14, R6). So R4 and the standalone host surface **both** gate R9.
   Root cause of the R4 half, established by instrumenting the resolver: all 11
   rejections come from one arm (`module-bindings.ts:2029`), because
   `scalarKind` (`:923`) has **no `StringLike` branch** — module-binding storage
   is scalars-only, so a module-level `const` of a string, object, array,
   function, class instance or bigint is unrepresentable by construction.
   Full record on `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`
   and `plan/issues/3523-ir-r4-module-init-compile-once.md`; both on PR #5508.
   **A lane is dispatched** for the string slice (R4-M1,
   `session_01SK6yHmgvNg8bRBasbfQC2p`) with an explicit instruction to write a
   design record instead of forcing an implementation if the dual-backend ABI
   decision proves larger than one slice.

   Three of my own claims were retracted on the way to this, all kept visible on
   #3518: attributing the gap to R3 (reason labels read without grouping by
   `unitKind`), pointing at `from-ast.ts` for rejections raised in `select.ts`,
   and promoting "R4 first" from a single corpus. Standing rule that came out of
   it: **name the corpus in the claim, and do not promote a per-corpus finding
   to a ladder dependency until a second corpus agrees.**

5. **Superseded, kept only so the trail is legible.** Two earlier framings of
   item 3 stood before it was root-caused: "READY is genuine but narrow" (true,
   but it stopped at the gate's five files), and a first widening that reported
   the playground's uncovered eight as 8 unsupported / 10 legacy bodies
   single-host and 14 / 14 standalone. Both are subsumed above. The open
   question they left — the denominator past `website/playground/examples/` —
   is the one item 3 answers.

6. **#3523 gap-6b** — record verified and shipped. Verdict: the recommendation
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

## Method note from this session — nine corrections, one root cause

Nine claims in this session were wrong and corrected on the record. They look
varied (R3 vs R4, `from-ast.ts` vs `select.ts`, a corpus generalisation, a seed
table, a denominator, an impossible plan step) but they share one shape:

**I reasoned about what a system probably does instead of reading what it
does.** Every underlying *measurement* held up — each names the command that
produced it. The errors lived in the inferences stacked on top.

Four of them were caught by doing something that took under a minute:

| what I assumed | what reading it took | what it overturned |
| --- | --- | --- |
| the `body-shape-rejected` label names a feature area | grouping by `unitKind` | wrong lane (R3 → R4) |
| a baseline gate probably tolerates an unseeded lane | reading `evaluateIrOnlyReport` | a plan step that would have landed a red gate |
| `legacyBodyEmitted` means a legacy body was emitted | one compile of `extern-demo.ts` | a 4× inflation of my own counts |
| the corpus figures in my seed table were the ones I measured | re-running the measurement | playground numbers labelled as dogfood |

Two things follow for whoever works here next:

1. **Trust the measurements, re-check the inferences.** Every number in
   `#3518`, `#3523`, `#3090` and `#4522` from this session names its command and
   can be re-run. Every *conclusion* drawn from one deserves the thirty seconds
   it takes to read the code it describes.
2. **The fluency is the hazard.** The wrong tables were not sloppy — they were
   plausible, well-formatted and internally consistent, which is exactly why
   they survived re-reading and only died to re-measuring. When output is
   coming easily, that is the moment to switch from generating to auditing. The
   one time I did that deliberately, the audit found another error immediately.

The standing rules that came out of it, both already applied above: **name the
corpus in the claim**, and **do not promote a per-corpus finding to a ladder
dependency until a second corpus agrees.**
