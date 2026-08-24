---
id: 4604
title: "npm-compat refresh runtime exceeds its 180-min timeout — dashboard stale since 2026-08-20 18:45Z"
status: in-progress
created: 2026-08-21
updated: 2026-08-22
assignee: loopdive/claude
priority: critical
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci, npm-compat
goal: performance
sprint: current
horizon: s
related: [3988, 4585, 4586, 4602]
origin: "Check-in while verifying the acorn/clsx recovery (#4602): 39 consecutive npm-compat-refresh runs (683-721) have failed to publish; the last successful run is 682 (2026-08-20 18:45Z), which is exactly the snapshot still showing the pre-fix collapse on the website."
files:
  - .github/workflows/npm-compat-refresh.yml
  - scripts/generate-npm-compat-report.mjs
  - scripts/lib/npm-compat-partials.mjs
  - scripts/merge-npm-compat-partials.mjs
  - tests/npm-compat-partials.test.ts
---

# #4604 — npm-compat refresh runtime exceeds its timeout; dashboard stale >22h

## Problem

`benchmarks/results/npm-compat*.json` is only updated by `npm-compat-refresh.yml`
(measure on main → promotion PR). The last run that completed is **682**
(measuring `7b2a1f94`, finished 2026-08-20 18:45Z) — the snapshot that shows
the acorn/clsx standalone-dynamic collapse. Every one of the **39 runs since
(683–721)** died without publishing, so the website keeps serving the
regression even though the compiler fixes (#4578, #4586, #4602) are long
merged and verified.

Three failure phases:

1. **683–692:** hard failures — `React.captureOwnerStack is not a function`
   from the #4660 upstream React infra (fixed by #4683/#4685), plus two quick
   infra failures.
2. **693 onward:** the marathon phase. Generation time now **approaches or
   exceeds the job's `timeout-minutes: 180`**:
   - run 700: started 06:59Z, dead 10:44Z (3h44m)
   - run 705: started 10:26Z, dead 13:44Z (3h18m)
   - run 714: started 13:19Z, dead 16:08Z (2h49m — cancelled before its own
     timeout; the cancellation source is unclear and worth confirming from
     the run's annotations)
   None completed. The roster growth that drove this is visible in the same
   window: six+ merges on 2026-08-21 alone expanded the upstream suites
   (lodash #4693/#4698, stylelint #4696/#4697, React #4660/#4683/#4686/#4687).
3. **Supersession:** each push to main replaces the QUEUED run (by design,
   `cancel-in-progress: false` keeps one running + one queued), so on a busy
   day only one marathon attempt exists at a time — and each one dies.

Net effect: the 6h-staleness guarantee #3988 was built for is void; the
artifact is >22h old and structurally cannot catch up.

## Why this is not #3988's livelock again

`cancel-in-progress` is already `false`; running jobs are not being killed by
new pushes. The #3988 analysis warned: "never `cancel-in-progress` a job
longer than its own trigger interval". The new failure mode is the sibling
hazard on the OTHER bound: **never let the job's runtime outgrow its own
`timeout-minutes`** — a timeout kill and a supersession cancel produce the
same stale artifact.

## Status

- **S1 landed previously: `timeout-minutes` 180 → 350.** Run 721's job record
  settled the diagnosis: its generate step was killed at exactly 180:00
  (16:09:17 → 19:09:01Z), promotion steps never reached — a pure timeout, the
  fourth in a row (700/705/714/721). 350 sits just under the 6h GitHub-hosted
  hard cap. The structural bound and the staleness alert below remain OPEN.
- **S2 implemented in the follow-up workflow PR:** the serial package walk is
  split into seven `fail-fast: false` matrix groups. Each worker writes a focused
  report; a read-only coordinator validates the complete package set, merges
  the rows/history, and only then enters the existing promotion path. A
  package failure therefore cannot cancel sibling measurements, and the
  active refresh wall clock is bounded by the slowest group rather than the
  sum of all upstream suites. `cancel-in-progress` remains `false`: pending
  runs may still be coalesced by GitHub, but the active run is no longer a
  multi-hour serial bottleneck that repeatedly times out before publishing.
  The implementation is in [#4745](https://github.com/loopdive/js2wasm/pull/4745).
- **S3 (this PR): the staleness guard.** A scheduled workflow
  (`npm-compat-staleness.yml`, 6h cron) asserts the PRODUCT — the committed
  `npm-compat.json` is younger than 12h — instead of any run's own success,
  which is the gap that let this episode run >24h undetected (a run that never
  publishes fails no gate; cancelled/superseded runs don't notify). Verdict
  logic is pure and time-injected (`scripts/lib/npm-compat-freshness.mjs`,
  pinned by `tests/npm-compat-freshness.test.ts`): anything short of a
  parseable recent `generatedAt` — missing file, malformed JSON, absent or
  future timestamp — is STALE. Read-only by design: it alerts, recovery stays
  with the refresh workflow. Verified against the live episode: at
  implementation time it reports `STALE — artifact is 33.2h old`.
- **S4 (this PR): first matrix flight findings (run 770, id 32549785178).**
  Five groups finished in 3–11 min — the split works. Two blockers surfaced:
  (a) the `tools` group CRASHED at 33 min: `styled-components-upstream-suite.mjs`
  wrote `.styled-components-upstream-suite-generated/styled-components-version.ts`
  without creating the directory (ENOENT). The suite landed 2026-08-21 (#4726)
  and no serial CI run ever reached it, so the first focused `--only` worker was
  its first-ever execution. Fixed here with the eslint-suite `mkdirSync` idiom —
  without this, EVERY run's tools group fails and the coordinator (correctly)
  refuses to publish, so the dashboard can never heal.
  (b) the `renderers` group (react-dom, jsdom, redux) ran >3h and was still
  going at 06:57Z — react-dom's upstream suite dominates; group re-balancing /
  bounding is follow-up for the roster owners (context: #4751 isolated the
  ReactDOM server/Fizz batches the day before).
- **S5: the renderers group was not slow — it was HUNG, and this PR fixes the
  hang class.** Run 778 (id 32559024885, job 96997622379) settled it: the
  renderers worker printed exactly one line
  (`[npm-compat] react-dom — package entry + react-dom's own upstream unit
  tests...` at 07:14:03Z) and then NOTHING until the 350-min timeout kill at
  13:03:44Z, leaving orphaned node/sh/esbuild processes. Every parallel
  per-SHA run died identically, so the coordinator never gets a renderers
  partial and the dashboard cannot heal. Root cause: the React suite added a
  per-test watchdog in #4683 (`withTimeout`, 2s default,
  `DOGFOOD_REACT_TEST_TIMEOUT_MS`) around both its native-oracle and
  compiled-test awaits — but `react-dom-upstream-suite.mjs`, which reuses the
  React suite's extractor and shim, **never inherited the watchdog**. Its
  `runNative` awaited each test unbounded, so one upstream test whose native
  run never settles (a Fizz stream await, an `act` whose scheduler work never
  drains — the node/edge Fizz lanes are recent) parks the generator forever
  with zero output. Fixed by moving `withTimeout` into the shared
  `react-upstream-shim.mjs` and wrapping react-dom's native and legacy
  compiled awaits (`DOGFOOD_REACT_DOM_TEST_TIMEOUT_MS`, default 2s; the
  project-lane Wasm side was already bounded by the compile-worker kill).
  Additionally the generator now arms an unref'd 10s forced-exit after its
  final artifact writes: a timed-out test can leak live scheduler timer
  chains (`setTimeout(run, 0)` reschedules while render work remains) that
  would otherwise keep a FINISHED run's process — and its CI step — alive
  indefinitely.
- **S6: the remaining budget-eater is subdivision-on-timeout, not a hang.**
  Run 785 (id 32576730177) measured the S5 watchdog merge itself and its
  react-dom group STILL died at exactly 350:00 (job 97040048748,
  13:46:49 → 19:36:27Z) with the same single-line log. Two facts resolve the
  contradiction: (a) the log is single-line **by design** — the generator ran
  the suite with `quiet: true`, so batch progress was invisible and a bounded
  slow run is indistinguishable from a hang; (b) a local smoke showed a
  1-test browser-Fizz batch consuming the full 300s compile-worker timeout,
  and `runServerHarness`'s `compileGroup` subdivided on ANY invalid result —
  timeouts included — up to depth 6. Since every sub-batch repeats the same
  multi-megabyte renderer graph, halving a timed-out batch re-pays the full
  timeout per half: the ~60-test browser-Fizz file alone can burn up to
  2^7−1 ≈ 127 attempts × 300s ≈ 10.6h of perfectly bounded compiles — more
  than the entire 350-min job. Fix in this slice: (1) `compileGroup` no
  longer subdivides when the worker timed out — one timeout is the verdict
  for the whole group, its tests recorded as blocked with the timeout as
  reason; (2) the refresh workflow sets `NPM_COMPAT_SUITE_LOGS=1` and the
  generator honors it by running react-dom's suite non-quiet, so the next
  timeout names the lane and batch it went to. All other groups were green
  in run 785 (jsdom 4 min, redux 2 min, tools 46 min), so react-dom is the
  sole remaining publisher-blocker.
- **S7: the bounds worked — react-dom now fails at 2h42m instead of timing
  out at 350min, and the new failure is a crash, not a hang or a budget
  blow-up.** Run 796 (id 32597629293, job 97090976800, S6 merge commit)
  measured all 9 groups; react-dom's per-batch `[dogfood]` log (now visible
  via `NPM_COMPAT_SUITE_LOGS=1`, S6) shows dozens of client-project batches
  completing or bounded-timing-out cleanly for ~2h40m, then the whole job
  dying: `Error: expected Hello toBe Goodbye` thrown from
  `testUserInteractionBeforeClientRender` (`ReactDOMFizzForm-test.js`),
  uncaught, killing node with exit 1 — no partial report for the entire
  react-dom group despite the dozens of completed batches before it.
  Root cause: `installNativeHostErrorBoundary`'s `uncaughtException` handler
  re-threw anything that wasn't the one known late-jsdom-removal error. The
  per-test watchdog (S5) makes an abandoned test body with a still-pending
  scheduler/timer callback routine — that callback can fire its own
  `expect(...).toBe` assertion after the watchdog has already moved on,
  landing as an uncaughtException with no test context to attribute it to,
  and the re-throw crashed the whole process. Fixed by making the boundary
  record every late host error (file/test/name/message +
  `expectedLateJsdomHostError` flag) into the report's `nativeHostErrors`
  instead of re-throwing — one stray callback now costs one report entry,
  never the whole measurement.
- **S8: after S5–S7, every measure group succeeds — the coordinator itself
  was broken.** Run 801 (id 32619275535, S7 merge commit) and run 805 (id
  32624575420, a later commit) both show all 9 matrix groups green
  (react-dom completing in 3h48m and 3h10m respectively, no timeout, no
  crash), but the `refresh` coordinator job's "Sanity-check the generated
  artifact" step fails on both: `[eval]:18 ... Expected '}', got '<eof>'`
  from `node -e`. Root cause: `#4779` ("keep npm-compat refresh publishing
  partial results") added a comment inside that step's inline
  `node -e '...'` script — `// must not block publication or masquerade as
  this run's data.` — whose apostrophe terminates the bash single-quoted
  string wrapping the whole script. Everything after it, including the
  rest of the validation logic and the closing quote, falls outside the
  quoted argument node receives, so `node -e` gets a truncated script and
  throws a `SyntaxError` before ever reading the artifact. Unrelated to
  react-dom or timing — a plain bash-quoting bug that blocked every run
  from publishing regardless of how clean the measurements were. Fixed by
  rewording the comment to avoid the apostrophe; verified by extracting the
  exact script bash constructs (`bash -n`) and running it against synthetic
  data.

## Fix directions (pick during implementation)

- **Immediate unblock (S1, done):** raise `timeout-minutes` so one run can
  actually land and publish the recovery. Cheap, reversible, buys time.
- **Structural:** the generation is a serial walk over ever-growing upstream
  suites. Options, roughly in order of leverage:
  - split measurement per package (matrix jobs) and merge artifacts, so
    wall-clock is the slowest package, not the sum;
  - add a per-package time budget in `generate-npm-compat-report.mjs` with a
    loud `unavailableInfra`-style marker when exceeded (precedent: the React
    watchdogs of #4683), so one slow suite cannot eat the whole budget;
  - a runtime guard in the workflow that publishes whatever completed before
    a self-imposed deadline rather than losing the entire measurement.
- **Guard:** a CI assertion or scheduled check that alerts when
  `generatedAt` in the committed artifact is older than ~12h, so the next
  silent-staleness episode is caught by machinery instead of a manual audit
  (this episode ran >22h before being noticed).

## Acceptance criteria

- [ ] One matrix-based `npm-compat-refresh` run completes end-to-end and its promotion PR
      merges; the committed `npm-compat-perf.json` shows acorn and clsx
      standalone-dynamic recovered (acorn back in its ~0.10–0.15 band per
      #4602, clsx ~0.12–0.2).
- [ ] The workflow's matrix runtime has headroom against its timeout; each
      package group emits a partial report and the coordinator refuses to
      publish if any expected package is missing or duplicated.
- [x] Staleness of the committed artifact is observable (guard or alert),
      not only discoverable by manual audit — `npm-compat-staleness.yml` (S3).

## 2026-08-22 follow-up — pending refreshes were still being cancelled

The matrix split fixed the active-run timeout, but it did not eliminate the
other GitHub Actions concurrency rule: `cancel-in-progress: false` protects the
currently running job only. GitHub retains one pending run per group and
cancels an older pending run when another push arrives. The run history after
[#4745](https://github.com/loopdive/js2wasm/pull/4745) still shows this shape:
the refresh for `3f8b6e6` was cancelled when the next main push queued
`2860d72d`, even though the workflow declared `cancel-in-progress: false`.

The follow-up in [#4755](https://github.com/loopdive/js2/pull/4755) keys
push-triggered refreshes by `github.sha`. Every main commit therefore gets a
runner instead of being silently replaced while pending; scheduled and manual
runs continue to serialize on the branch ref. The promotion push uses
`--force-with-lease` so concurrent SHA lanes cannot overwrite a newer
promotion branch update. The workflow-shape test now pins both invariants.

## 2026-08-22 renderer timeout follow-up

The first matrix flight confirmed that the `renderers` row itself was the
remaining timeout bottleneck: it serialized `react-dom`, `jsdom`, and `redux`
behind one 350-minute job. Run 770's renderer job was cancelled at the job
ceiling after the other groups had completed, so the smaller jsdom and Redux
reports were discarded with the long ReactDOM run. The workflow now gives each
renderer its own `fail-fast: false` matrix cell. A slow ReactDOM measurement can
still be investigated in isolation, while jsdom and Redux can finish and
upload their partial artifacts instead of being cancelled as collateral.

Implementation: [PR #4767](https://github.com/loopdive/js2wasm/pull/4767) (the
Jest infrastructure change and npm-compat reliability follow-up share the
same branch checkpoint).

## 2026-08-22 cancellation audit after the matrix landed

The remaining `cancelled` entries in the run list are not new
`cancel-in-progress` cancellations. Runs 32564073432 and 32561947825 both
finished their short matrix cells successfully, then their old `renderers`
cell was killed at exactly 350 minutes (09:07:04→14:57:18 and
08:18:47→14:09:00). Because that cell contained the serial ReactDOM, jsdom,
and Redux group from the pre-#4767 workflow, the coordinator correctly had no
complete artifact to publish. The SHA-keyed concurrency fix in #4755 protects
pending push runs; it cannot revive a job that reaches its own timeout.

The first post-#4770 run, 32576730177, uses the new independent
`react-dom`/`jsdom`/`redux` cells. jsdom and Redux completed successfully while
ReactDOM continued in its own cell, so they are no longer collateral
cancellations. Keep this run as the acceptance probe: if ReactDOM itself
reaches 350 minutes, the next slice must bound or subdivide the ReactDOM suite
and publish an explicit `unavailableInfra` result rather than letting the
workflow be killed without a partial report.

## 2026-08-22 ReactDOM compile-pool follow-up

The ReactDOM cell is now independently protected from the old renderer-group
timeout, but its client project still contains 110 compile batches. They were
being compiled one after another, so a valid but slow corpus could still reach
the cell's 350-minute ceiling. The project lane now compiles those independent
batches with two isolated workers and runs the shared native oracle in stable
source order. The workflow pins the pool to two workers to keep memory bounded;
each batch retains its own timeout and report entry. This reduces wall-clock
time without dropping tests or converting compiler failures into
`unavailableInfra`. Compilation is pipelined with the source-ordered native
oracle, so the workers continue compiling later batches while the shared host
consumes the next completed batch.

Implementation: [PR #4771](https://github.com/loopdive/js2/pull/4771), stacked
on the renderer/compiler baseline in [PR #4769](https://github.com/loopdive/js2/pull/4769).
## 2026-08-22 follow-up — promotion checks must never be cancelled by refresh

The SHA-keyed measurement groups prevent newer main pushes from replacing an
older pending refresh, but a second cancellation race remained at promotion.
When the reusable `ci/npm-compat-refresh` branch already had an open pull
request, the coordinator checked only whether it was in the merge queue. It
could then force-update that branch while the pull request's current checks
were queued or running. GitHub emits `pull_request:synchronize` for that push
and cancels the checks for the old head before starting a new set; frequent
refreshes could therefore keep the artifact pull request permanently pending.

The workflow now reads all check-run pages for the promotion pull request's
current head and leaves the branch untouched while any check is active. The
guard is intentionally not aged out: the refresh matrix has a 350-minute
timeout, so a two-hour cutoff would still cancel a legitimate long run. A
wedged pull request is retained for diagnosis and surfaced by the staleness
workflow instead of being repeatedly reset.

Implementation: [PR #4774](https://github.com/loopdive/js2wasm/pull/4774).

## 2026-08-22 follow-up — cancellation protections need to cover every updater

The merged check guard still had two holes. First, a two-hour cutoff could
reset a legitimate long-running promotion check even though the refresh matrix
allows 350 minutes. Second, scheduled and manual refreshes shared one
concurrency group, so GitHub could discard an older pending run even with
`cancel-in-progress: false`. The generic `auto-refresh-prs` cron could also
rebase the bot-owned promotion branch independently of the npm coordinator.

The workflow now uses per-SHA keys for pushes and per-run keys for scheduled or
manual refreshes, paginates every check-run page without aging the active-check
guard out, and fails closed when the check API is unreadable. The generic
behind-PR sweep excludes `ci/npm-compat-refresh` entirely. This makes the npm
coordinator the only updater of its promotion branch and prevents both direct
and indirect `pull_request:synchronize` cancellation churn.

The generic `auto-refresh-prs` cron also excludes the exact
`ci/npm-compat-refresh` head. Its two-hour stale-check heuristic is appropriate
for ordinary behind pull requests, but it could otherwise rebase this bot-owned
branch and emit the same cancelling `synchronize` event outside the npm
coordinator.

Implementation: [PR #4776](https://github.com/loopdive/js2/pull/4776).

## The promotion PR never lands: the queue guard loses a race it now runs constantly (2026-08-23)

**Symptom.** `benchmarks/results/npm-compat.json` on main sat at
`generatedAt 2026-08-23T15:27:53Z` for 6+ hours while the fast lane promoted
successfully over and over. The dashboard was frozen with green CI everywhere.

**Not the enqueuer.** `auto-enqueue` is healthy and explicitly reports
`#4807 skip (already-queued)`; the queue held 5 entries with another PR
`AWAITING_CHECKS` at the head. The promotion PR reaches the queue fine.

**What actually happens.** Every fast-lane promotion force-updates the reused
`ci/npm-compat-refresh` branch, which ejects the PR from the merge queue and
restarts it. The coordinator has a guard against exactly this — it skips the
push when the PR has checks in flight or appears in the queue — but the guard
is a POINT-IN-TIME read, and there is a window between "ejected" and
"re-enqueued" in which the PR is neither queued nor check-busy. Measured on
run 827:

```
20:02:34  refresh-fast starts; queue guard passes (the publish step ran, so skip != 1)
20:03:20  + b87c9042...a1793bff HEAD -> ci/npm-compat-refresh (forced update)
20:40:39  auto-enqueue: "#4807 skip (already-queued)"
```

**Why it started now.** Before the per-package split (#4796) the whole fleet
promoted roughly once per ~25 minutes, and only after every package finished.
The fast lane now promotes on EVERY merge — ~12 minutes after each one — so
the race window is entered several times an hour instead of occasionally, and
the PR never survives long enough to reach the front of a 5-deep queue. This is
a consequence of the split, not a pre-existing bug.

**Not fixed here — it needs a call on cadence**, and cadence is a stakeholder
instruction ("merge-driven, no cron", 2026-08-23). Options, cheapest first:

1. **Only push when the numbers actually changed.** Perf timings differ every
   run, so every run currently publishes something. Comparing the artifact
   modulo perf noise would collapse most promotions to no-ops, and the PR would
   sit still long enough to merge. Does not touch the trigger.
2. **Do not re-push while an open promotion PR exists.** Let the current one
   land; the next run's measurement is picked up by the run after it. The
   artifact is then never more than one cycle behind.
3. **Rate-limit promotions** (at most one push per hour). Closest to a cron and
   the option that most contradicts the stated instruction.

(1) or (2) look right; both keep the trigger merge-driven.

**Decision (stakeholder, 2026-08-23): option 2.** The coordinator never pushes
while a promotion PR is open. The check-runs probe and the merge-queue GraphQL
probe are gone — there is no longer a "looks idle right now" path to race. An
unreadable PR listing now fails CLOSED (skip the cycle) rather than pushing.

Consequence accepted: a genuinely wedged PR freezes promotion rather than
trampling it, and `npm-compat-staleness.yml` is the alarm. A frozen artifact
that shouts beats the silent six-hour freeze this replaces.
