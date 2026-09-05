# ES5-standalone campaign — standing agent brief

Shared protocol for every agent working a `goal: standalone-gap` ES5 bucket
issue (#4479–#4485 and successors). The issue file gives the WHAT; this brief
gives the HOW. Read both before the first edit.

## Single-test driver

Write verbatim to `.tmp/run-one.mts`, run
`npx tsx .tmp/run-one.mts <rel-path-under-test262/test/>`:

```ts
import { join } from "node:path";
import { runTest262File } from "../tests/test262-runner.js";
const ROOT = join(process.cwd(), "test262", "test");
const rel = process.argv[2];
const cat = rel.split("/").slice(0, -1).join("/");
const r = await runTest262File(join(ROOT, rel), cat, 15000, "standalone");
console.log(JSON.stringify(r, null, 2));
```

- Standalone lane: 4th arg `"standalone"` (as above).
- Host/gc lane: **OMIT the 4th argument entirely.** Passing `"gc"` is wrong —
  it corrupts compile options and disables `deferTopLevelInit` (burned an
  agent on 2026-08-15; see #4456's merge-group record).

Direct compile probes: `compile(src, {target:"standalone", allowJs:true,
skipSemanticDiagnostics:true, deferTopLevelInit:true, hostBridge:"always"})`
from `src/index.js`; `emitWat:true` to read WAT. All probes live in `.tmp/`.

## Methodology (non-negotiable — distilled from this campaign's audit chain)

1. **Re-verify the issue's failure list live before touching anything.** The
   baseline lags main; the issue's row counts are a map, not a measurement.
2. **Capture `.tmp/base-<file>.ts` revert copies at the FIRST edit** of every
   source file (`git show HEAD:src/... > .tmp/base-...`). Every before/after
   delta you report must come from runs YOU executed. A figure inherited from
   an artifact and restated as a measurement is the campaign's most-repeated
   documented defect.

   **One snapshot per touched file, and check `git diff --stat` before each
   arm (2026-08-23, dev-4491).** Restoring only ONE snapshot when your change
   spans two files silently measures a HYBRID tree — half your change, half
   the base — and nothing in the run announces it. The cheap detector is
   `git diff HEAD --stat` immediately before each arm: if it names a different
   number of files than your change touches, you have a partial restore. That
   count mismatch is the only reason the one measured instance was caught.

   **Use `git diff HEAD --stat`, NOT bare `git diff --stat` (2026-08-23,
   dev-4492 — this corrects the earlier wording here).** `git checkout <commit>
   -- <paths>` writes the INDEX as well as the worktree, so a bare `git diff`
   compares against the already-updated index and under-reports: measured, it
   showed **5** changed files where `git diff HEAD --stat` correctly showed
   **15**. The detector for a silent partial restore must not itself be blind to
   the restore.

   **Branch-update merges use a PLAIN `git merge <ref>` — never `--ff-only`.**
   `pre-merge.sh` treats `--ff-only` as the legacy merge-TO-main path and
   refuses it without a fresh test-proof artifact, so a lane pulling the
   campaign tip into its own feature branch gets blocked and may be tempted to
   `--no-verify` past a gate doing its job. The documented protocol is a plain
   merge anyway (CLAUDE.md: "Dev merges `origin/main` INTO their branch —
   `git merge origin/main` (not rebase)"). Use the right form; do not bypass.
3. **One probe per compiled module where identity matters** (in-process
   pollution confound, #3673). Isolate and re-run anomalous batch results.
4. **Absent-not-wrong.** A new arm that cannot be certain about a dynamic
   receiver must DECLINE (fall through), never answer wrongly. A wrong answer
   in a fold is worse than no fold.
5. **Eval-tier awareness.** CI's changed-root `quality` lane runs
   `JS2WASM_EVAL_ENGINE=interpreter` with the REFUSAL provider: modules that
   CALL `eval`/`Function(...)` at runtime throw there by design. Any vitest
   pin whose module mints from a body string needs a tier arm — see
   `tests/issue-4442.test.ts` / `tests/issue-4464.test.ts` for the pattern.
   Build the provider locally with
   `node scripts/build-runtime-eval-provider.mjs --refusal-only` and run the
   pin under `JS2WASM_EVAL_ENGINE=interpreter` before calling it done.
6. **A table is only evidence for the axes it VARIES — the axis you did not
   vary is where the wrong rule hides (2026-08-23, #4653/#4662).** A rule
   generalised from a discriminator table is exactly as strong as the table's
   dimensions, and a probe harness silently fixes the dimensions you did not
   think to name. Measured: one lane published THREE successive rules for the
   same defect. v1 varied only the operator. v2 varied operator ×
   surrounding-syntax × top-level-vs-inside-a-function — three axes, none of
   them the one that decided the answer — because every probe wrapped its
   subject in the same helper, so every "outer" variable happened to be
   module-level. The real axis was **where the name is bound**; the first probe
   that varied it (a function-LOCAL, neither eval-local nor module-level)
   refuted v2 in two lines, and a second two-line probe refuted its remaining
   half. v2 had already been filed as an issue by then.
   - Before publishing a rule, name the axes your probes varied and the ones
     they held FIXED. The held-fixed list is the honest confidence interval —
     and it is usually short enough to close by hand.
   - Suspect any axis your harness supplies rather than your test data: the
     wrapper, the scope you happened to declare things in, the lane, the
     tier. Those are fixed by convenience, not by design.
   - A rule that survives only the cells you found convenient is a
     description of your harness, not of the compiler.

7. **Cross-lane claims need a third arm (2026-08-23, #4637/#4639).** With
   sibling lanes branching from one tip, your two-arm A/B (tip vs your
   branch) answers "did I change this" and is STRUCTURALLY SILENT on "did
   the other lane fix or break it". One measured case: a defect was
   pre-existing on the tip AND fixed by the sibling's change — one lane's
   tip-vs-own A/B read "unaffected", the other's branch-only read
   "introduced by them"; both were measured correctly and both concluded
   wrongly. Rules that fall out:
   - A claim about ANOTHER lane's effect requires an arm containing their
     change — measured by whoever owns it and cited as theirs, or measured
     by the lead on the combined tree. Never infer it from your own pair.
   - **This rule governs CLAIMS, not DISAGREEMENTS (2026-08-23, #4653/#4515).**
     When two lanes' results on the "same" shape conflict, the first move is to
     reconcile — did we measure the same CELL? — NOT to stop at "different
     trees, I can't speak for yours". Both lanes did the latter here and it kept
     a wrong rule alive for three rounds and one filed issue. The repro turned
     out not to be the snippet that had been pasted (its error text named a
     variable the quoted source never declared), so one lane was measuring a
     module-level binding and the other a function-local one — same words,
     different cell, no tree difference at all. "It does not reproduce here" is
     a hypothesis about YOUR cell before it is a fact about their tree. Invoke
     the third arm for what survives reconciliation; a third-arm caveat is not a
     substitute for reconciling two results.
   - Corollary, cheap and repeatedly decisive: **read the peer's error text
     against the peer's quoted source.** A name, line, or type that does not
     match the snippet means you are not looking at the program that ran.
   - **Verify every pin fails on the arm it claims to test** (revert for
     your own change; DELETE the named interaction for a cross-lane pin —
     a revert proves sensitivity to *your* change only). A canary nobody
     has seen fail is an assertion about the code, not a test of it.
   - Write pins UNFOLDABLE where a compile-time fold could bypass the
     path under test (loop-carried index beats a syntactic literal).
   - **A pin that asserts a shape is not a pin that exercises the shape.**
     Both wave-3 lanes wrote one while actively hunting this class: one
     asserted identity relations and sat one property READ away from an
     uncatchable trap, reporting green; the other read the property and
     was `it.fails`-green *because* the read trapped. Neither assertion
     was wrong; neither pin could fail for the reason it existed. Every
     pin must execute the operation whose behavior it guards.
   - A sibling's change alters not only what is CORRECT but what is
     REACHABLE: the wave-3 trap needed one lane's classification widening
     plus a shape only the other lane's domain produced, and no sweep
     either lane could run would have compiled the combination. Cross-lane
     hazards are only visible on the combined tree — the lead's merge
     verification must include running each lane's suite there.
   - The merge check reads the run's **counts**, never its exit status —
     and the exit status is UNCORRELATED with the outcome in both
     directions — and both inversions were measured on the SAME suite, so
     "different suites, different causes" does not explain it away:
     **exit 1 with `23 passed (23)`, everything green** (the failure being
     vitest's own `onTaskUpdate` RPC timeout, no test involved), and
     **exit 0 with `22 passed | 36 skipped (58)`**, thirty-six tests never
     executed. `$?` is not a verdict in either direction.
     Five measured ways a run reports green having measured nothing (or
     less than it claims), and the check comes in **two tiers — do the free
     one first** (2026-08-23, dev-4491's calibration):

     **Tier 1 — internal, needs nothing but the summary line, catches four
     of the five.** Vitest prints its own denominator and the parts sum to
     it. Let `executed = passed + failed`.
     - **Floor, always safe: `total > 0 && executed > 0`.** All four
       zero-selection members produce `executed == 0`, and a file with real
       tests plus a few deliberate `it.skip` always executes some — so this
       never false-alarms and needs no count anywhere.
     - **Strong form: `executed == total`.** When it holds you are done.
     - **When it does not hold, do NOT reach for a number — climb.** A
       count of expected skips is grepped from `it.skip(` and carries the
       identical hazards as the tier-2 denominator below (a commented-out
       `// it.skip(`, one inside a template string, a `describe.skip`
       wrapping four tests). Reading what was skipped also catches what a
       count structurally cannot: **the right number of skips from the
       wrong set** — a partial `skipIf` skipping three tests when you
       expected three *different* ones satisfies any count.

       It is a **three-rung ladder, and you climb only as far as the
       question needs** (measured 2026-08-23 across both lanes' pin files,
       skipping via a no-match `-t`):

       | rung | line | reporters | answers |
       | --- | --- | --- | --- |
       | 1 | `Tests 1 passed \| 30 skipped (31)` | all | something was lost |
       | 2 | `↓ tests/… (9 tests \| 9 skipped)` | default + basic | **which FILE** lost it |
       | 3 | `↓ tests/… > suite > test name` | **verbose only** | **which TESTS** |

       **Rungs 1 and 2 are reporter-independent, so no existing tooling
       needs re-plumbing** — this brief's per-file loops run
       `--reporter=basic` and get both. Switch to verbose only for rung 3.
       Reproduced independently on two different pin files (22 tests and
       23 tests, two lanes): basic gives one file-level `↓` line and no
       names; verbose gives one `↓` per test with its full path.

       **"Names are verbose-only" is too strong, though** (dev-4491,
       correcting its own earlier caveat): basic DOES print per-test `↓`
       names with full paths for a file that **failed** — vitest expands a
       failed file's per-test detail on basic and does not expand a passing
       one. Rung 3's "needs verbose" still holds for the case that matters,
       a partial `skipIf` in a file whose surviving tests all pass, which
       is the silent one. The blanket claim does not.

       Rung 2 matters on its own: in a MULTI-FILE run the aggregate can
       mask one file being wholly skipped while others run. Measured —
       `vitest run <pin> <equivalence> -t "labelled block"
       --reporter=basic` printed `Tests 1 passed | 30 skipped (31)` and
       `↓ tests/equivalence/in-operator-edge-cases.test.ts (9 tests | 9
       skipped)`, naming the dead file without verbose. (`Test Files 1
       passed | 1 skipped (2)` is the same signal at file granularity.)

       **Match `skipped` on the file line — not the marker, and NOT a
       fixed suffix shape** — this
       corrects an earlier reading of rung 2 (dev-4491, measured on
       `basic`). A file skipped in its entirety gets a `↓`; a PARTIALLY
       skipped file still has a passing test, so it lands on a `✓` line and
       a search for `↓` will not find it:
       ```
       ✓ tests/issue-4491-t4-add-parity.test.ts (5 tests  | 4 skipped)
       ✓ tests/issue-4491-wave4.test.ts        (14 tests | 13 skipped)
       ```
       The file WAS reported. Reading the marker is what makes rung 2 look
       blind to partial loss and sends you to verbose for something already
       on screen.

       **The suffix has a VARIABLE number of segments, so do not grep the
       pair** (dev-4515, closing dev-4491's stated limit — all three
       markers now measured):
       ```
       ↓ …in-operator-edge-cases.test.ts (9 tests | 9 skipped)
       ✓ …issue-4515-wave5.test.ts       (22 tests | 21 skipped)
       ❯ …probe-failskip.test.ts         (3 tests | 1 failed | 2 skipped)
       ```
       A failing file inserts `| N failed`, so a pattern written for the
       two-segment `(N tests | M skipped)` form misses exactly the shape
       you most want to catch. A fully-passing file prints `(2 tests)` with
       no pipe and no `skipped` at all — which is what makes matching the
       WORD complete across all four shapes: absent when nothing was lost,
       present for fully-skipped, partial-skip and fail+skip. It is the
       only candidate that cannot false-negative.

       **Anchor it to the file line — a bare `grep skipped` false-positives
       three ways** in that same output (a test NAME containing "skipped",
       a source excerpt in the failure dump, and the summary line). Use
       `\.test\.ts \(.*skipped`, or a file whose tests are named after
       skipping reports itself as broken.
     ```
     Tests  1 failed | 45 passed (46)   healthy
     Tests  22 skipped (22)             a `-t` regex matched nothing
     Tests  1 failed | 21 skipped (22)  same file, filter finally biting
     Tests  36 skipped (36)             dead CompilerPool worker
     ```
     That covers a `describe.skipIf` gate, a suite whose own
     `CompilerPool` worker cannot start (below), a path/glob matching no
     file, and a `-t` filter matching nothing — **`vitest -t` is a REGEX**,
     so `-t "f + 1 must agree"` requires two spaces and selects zero, on a
     file with no `skipIf` in it at all. Escape `+ ( ) [ ] . * ?`, or match
     a plain substring. Nothing here can be mis-counted, because the
     denominator comes from the same line as the parts.

     **Exit status is UNCORRELATED with the outcome — and both directions
     have been measured on ONE suite, which removes the "different suites,
     different causes" objection** (dev-4653, `tests/issue-4653.test.ts`):
     ```
     Tests  23 skipped (23)   exit 0   nothing executed, exits GREEN
     Tests  23 passed  (23)   exit 1   everything passed, exits RED
     ```
     Tier 1 gets both right (`executed 0 != 23` fails; `executed 23 == 23`
     passes) while `$?` is inverted from the truth in each. A second,
     independent exit-0 instance from a real accident rather than a
     deliberate filter: `Tests 22 passed | 36 skipped (58)` from a dead
     `CompilerPool` worker, thirty-six tests never executed (dev-4491).

     So "counts, never exit status" is a rule, not a preference: neither
     direction of the status tells you anything.

     **Tier 2 — external declared count, and ONLY for the fifth member.**
     Vitest's RPC dropping task updates under load
     (`[vitest-worker]: Timeout calling "onTaskUpdate"`) shrinks `passed`
     and `total` TOGETHER, so tier 1 still holds and only a count from
     outside the runner catches it. This is the one place an external
     denominator earns its keep — and the one place its accuracy has to be
     established rather than grepped, because **the same pattern is wrong
     in BOTH directions — measured on two files, one each**:
     - `tests/issue-4515-wave5.test.ts` declares **22**. `grep -c "it("` →
       **16** (misses every `it.fails(`); `grep -cE "it\(|test\("` → **21**
       (picks up `export function test()` in a doc comment, the same text
       in a template string, and `exports.test()`). Neither is 22, and the
       two errors partially cancel.
     - dev-4653's pin file declares **23**; the naive `it\(` answers
       **13** — under by ten, again because `it.fails(` is invisible to it.

     `grep -cE '^\s+it(\.fails)?\('` gets the first file right *because it
     was calibrated to it*, not because it is correct — the same defect as
     a stale baseline restated as a measurement. It still misses `it.each`,
     `test(` and generated cases, and a comment containing `it (`
     over-counts. If you cannot establish the number, say so rather than
     quoting an equality you did not verify.
   - **Contention fakes the ABSENCE of failure as well as its presence.** A
     run can print `22 passed` beside `Errors 1 error` where the error is
     that RPC timeout and no test is involved. Read what the error IS. In
     the measured case the tally equalled the file's declared 22, so
     nothing had been lost — which is exactly the comparison above doing
     its job, and is why an `Errors` line is not by itself a verdict.
   - **A pipe can hide the line that would have told you.** Several
     result-bearing runs were filtered inline through
     `grep -E "✓|×|passed|failed|skipped"`, which does not match `Errors N
     error` — so those runs cannot retrospectively be cleared of the RPC
     case (dev-4491, self-audit; the totals matched the declared counts, so
     the conclusions stood). Same defect class as the `-t` regex: a filter
     that removes the evidence of its own unreliability.

## Environment trap: fresh worktrees have NO .test262-cache (#4484 finding)

A fresh agent worktree lacks `.test262-cache/`, so eval-dependent rows fail
as "quickjs provider is not built" on BOTH sides of an A/B — a silently
under-measured sweep (21 rows misread in one measured case). Before any
sweep: copy the main checkout's `.test262-cache/` artifacts in, or build the
provider (`npx tsx scripts/build-quickjs-eval-provider.mjs`, falling back to
`node scripts/build-runtime-eval-provider.mjs --refusal-only` +
`JS2WASM_EVAL_ENGINE=interpreter`), and confirm a known eval-dependent row
runs before trusting the numbers.

## Environment trap: a suite that runs ZERO tests and exits 0 (2026-08-23, dev-4491)

`tests/issue-4504-inherited-set.test.ts` spins its **own `CompilerPool`**, whose
worker imports the GITIGNORED `scripts/runtime-bundle.mjs` and
`scripts/compiler-bundle.mjs`. A fresh worktree has NEITHER, so the worker dies
(`[pool] worker failed before ready (exit 1)`), vitest reports **`36 skipped`**,
and the process **exits 0**. Every lane that ran it in a fresh worktree read a
green that measured nothing.

This is the concrete instance of the brief's "N passed, never exit 0" rule:
`skipped` is not `passed`. Read the counts. When a suite spins its own pool,
build BOTH bundles from **the arm you are measuring**
(`pnpm run build:compiler-bundle`), or its verdict is about your bundle, not
your branch. Built correctly this suite is 1 failed / 35 passed, and that one
failure is pre-existing on the campaign base.

## Environment trap: CONTENTION fakes both failures and regressions (2026-08-23, dev-4491 + lead)

With several lanes sweeping at once, load on this box runs 12–16 and a compile
that normally takes ~9 s can take **47–123 s**, so `runTest262File`'s timeout
fires and the row reports `compile_error: compilation timeout`. Measured the
same day in both directions: three of dev-4491's 2,279 sweep rows moved for
infrastructure reasons alone — one of them (`15.2.3.6-4-298-1`, an ENOENT from
the symlink-farm race) **would have read as a regression** — and two lead-run
pins (`issue-4641`, `issue-4643`) failed on timeout under 5-lane load and passed
**25/25** when re-run serially minutes later.

**Standing practice: re-run every apparent flip AND every apparent regression
serially before it goes in a report.** A timeout is not a verdict about your
change. Note also that `runTest262File`'s `timeoutMs` is a POST-HOC check — it
measures elapsed time after `await compile(...)` returns and cannot interrupt a
slow compile, so a 600 s compile runs the full 600 s and only then reports a
timeout; bounding it needs an OS-level `timeout` on the driver process.

## Environment trap: STALE `scripts/compiler-bundle.mjs` poisons every eval-tier A/B (2026-08-23, dev-4647)

The quickjs eval ADAPTER is a js2wasm-compiled artifact, and
`loadProviderCompiler` prefers the prebuilt, GITIGNORED
`scripts/compiler-bundle.mjs` over live `src/`. The adapter cache key is
sha256(adapter source ∥ bundle hash) — it hashes the BUNDLE, so a stale
bundle produces a **self-consistent cache HIT**: the build script reports
"adapter cache HIT + linked-pair verification" while handing you an
adapter compiled by a compiler that may be WEEKS behind your tree.
Measured 2026-08-23: the shared cache's adapter was 8 days / 3 waves
stale; rebuilding the bundle + adapter with ZERO source change flipped 12
`built-ins/Function` SyntaxError-family rows green. Both directions are
live: a stale-adapter base OVERSTATES your flips (rows your change never
touched read as yours) and can HIDE a real regression (a truly-passing
row reads "already failing on base").

Before ANY eval-dependent A/B or sweep:
`pnpm run build:compiler-bundle && npx tsx scripts/build-quickjs-eval-provider.mjs`
— on BOTH arms if the arms differ in compiler source. A cache HIT is not
freshness; check the bundle's mtime against your base commit date. CI is
unaffected (it rebuilds per run).

## Environment trap: the worktree `test262/` symlink farm + the GITLINK hazard

The isolation layer rebuilds a fresh worktree's `test262/` as a symlink farm
pointing at SIBLING worktrees (whose chains can dead-end in an empty dir),
and it does so repeatedly — measured ~every 2s / at the start of every Bash
call. `ls` works intermittently while `node` gets ENOENT, so sweeps fail
silently. Fixes, in order of robustness: re-point the link to
`/home/user/js2wasm/test262` **in-process immediately before each read** and
retry on ENOENT (fighting it from the shell is futile); at minimum verify a
LEAF test file resolves (`readlink -f`) before trusting any sweep. Also:
`test262/test/test` is a self-referential symlink — use lstat, skip symlinks
in every recursive walk.

**The gitlink hazard that rides along (2026-08-23, hit independently by two
lanes):** `test262` is a git SUBMODULE gitlink. Replacing the directory with
a symlink flips the gitlink to a symlink in the index — it shows as `T` in
`git status` and silently rides into any `git commit -a`, breaking every
other checkout. If you repoint `test262`, (1) never use `commit -a` (the
brief already requires staging specific files), (2) check `git status --
test262` before every commit, and (3) before finishing, verify with
`git diff <base>..HEAD --stat -- test262` that NO commit touched it, and
restore the plain directory/gitlink state.

## Engine trap: a CONCRETE-ref `try_table` block type traps on entry (#4620)

A `try_table` whose **block type is a concrete ref** (`(ref null <typeidx>)` /
`(ref <typeidx>)` — the two-byte `0x63`/`0x64 <typeidx>` form) traps with
`RuntimeError: unreachable` **when the instruction is entered**, before its
protected body runs and with nothing thrown. Measured 2026-08-22 on Node
v22.22.2 / V8 12.4.254.21 in a **hand-built module with no compiler involved**;
the same module with an `i32` or `externref` block type runs correctly.
Abstract single-byte ref types (`externref`, `funcref`) are fine — only the
two-byte concrete form is affected.

Why it hides: the ordinary `try`/`catch` lowering emits an **empty** try_table
block type and `return`s out of the protected body, so it never produces this
shape. Only hand-built scaffolds do — `named-this-call.ts`'s receiver-install
trampoline did, which made every `foo.call(x)` on a named function that reads
`this` and returns a **string or object** trap (`language/function-code/
10.4.3-1-{1,2,4,5}-s`, the primitive-`this` boxing family). Scalar-returning
targets were fine, which is why it stayed invisible.

**The pattern to use instead:** give the `try_table` an EMPTY block type and
park the value in a local INSIDE the protected body
(`…call…; local.set $result`), then read the local after the scaffold. See
`ensureNamedThisCallTrampoline` (#4620) for the worked example, and keep scalar
block types as they are so their bytes do not move.

**How to recognise it:** a trap whose innermost frame is the function
CONTAINING the try_table, at an offset that decodes to the try_table's own
bytes, with the protected callee provably never entered (set a global in the
callee's first statement and read it after the trap). Binary-patching the
`try_table` bytes to a plain `block` + `nop`s is a cheap confirmation.

Other emitters that pass a non-empty block type to `buildStandardTryTable` /
`buildTargetTaggedTry` are suspect; grep for them before assuming a lane is
clean (`src/ir/backend/wasmgc-emitter.ts` passes a variable block type).

## Verification floor (every issue, before `status: done`)

**SCALE THE SWEEP TO BLAST RADIUS — always (project-lead directive,
2026-08-23).** The floor is not a fixed row count. Measured that day: the box
has 4 cores, four lanes sweeping at once drove load to 13–15, and one row cost
**~20 s instead of ~4 s** — so a 4,000-row two-arm sweep took ~4.5 h for a
change whose fixes were written in the first hour, and the contention itself
manufactured three false flips/regressions that then cost re-runs. An oversized
sweep is not extra rigour; it buys nothing and corrupts what it measures.

Size it from what your diff can actually reach:

| what you changed | sweep |
| --- | --- |
| a new leaf module, or one arm behind an existing gate | the directories its call sites reach — often 1–3, low hundreds of rows |
| a shared helper or driver several arms call | those arms' directories, plus the one family most likely to regress |
| a signature, carrier, ABI or type-resolution rule | wide — this is the case the big sweep exists for |

Rules that make the cut honest:

- **State what you dropped and why.** A reasoned scope cut is a floor; a silent
  one is a gap. Name the directories you did not sweep.
- **Never drop a directory that tests one of your own fixes.** Measured the
  same day: a lead-written drop list (from directory names) would have removed
  the only directory testing one of a lane's four root fixes, and the lane was
  right to refuse it. Read your diff, not the directory names — and push back
  when the two disagree.
- **The merge queue re-validates the WHOLE corpus on the merged state.** Your
  sweep exists to catch YOUR regressions early and cheaply, not to prove global
  safety — that is already someone else's job, and duplicating it wastes hours
  the campaign needs elsewhere.
- Everything below still applies at whatever size you choose: before AND after
  arms, per-file flip list, **zero regressions**, and every apparent flip and
  regression serially re-verified before it enters a report.

- Scoped standalone sweep over the chosen scope before AND after, from
  your own runs; per-file flip list; **zero regressions**.
- The issue's named pin suites green (`npm test -- <files>`); skip-and-say-so
  if a pin file doesn't exist on your base.
- New `tests/issue-<id>.test.ts` pinning each fixed family + `it.fails` pins
  for measured residuals.
- **`tests/equivalence/` CANNOT run in one vitest invocation** in these
  containers (OOMs; chunks >6 files OOM too). Per-file loops only, scoped to
  files your diff plausibly touches.
- Record `## Root cause`, `## Fix`, `## Test Results` (with which runs YOU
  executed), `## Residuals` with owners, in the issue file. `status: done` +
  `completed:` only when the acceptance bar is met and verified.

## Commit rules (worktree branch, do NOT push, do NOT open PRs)

- Author `Thomas Tränkler <git@thomas.traenkler.com>`, **committer `Claude
  <noreply@anthropic.com>`** — set them SEPARATELY. `-c user.name/-c user.email`
  sets **both**, which is how 11 lane commits landed with the wrong committer on
  2026-08-24 and tripped the unverified-commit gate:

  ```bash
  GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com \
    git commit --gpg-sign --author="Thomas Tränkler <git@thomas.traenkler.com>" ...
  ```

  The repo-local `.git/config` used to pin `user.email=git@thomas.traenkler.com`,
  which every worktree inherits and which overrides the global Claude identity —
  so a plain `git commit` produced the wrong committer no matter what the global
  config said. That local override is now `Claude <noreply@anthropic.com>`, but
  pass the env vars anyway: they are what makes the intent explicit.
- Message `fix(#<id>): <summary> ✓` — the ✓ token is required by the hooks.
- Commit-gate failures (LOC/func budget, coercion-sites, dead-export,
  oracle-ratchet): grant a frontmatter allowance in the issue file with
  per-file rationale (see the 44xx issues for the pattern). Use `ctx.oracle`,
  never raw `ctx.checker`.
- The session lead merges your worktree branch, verifies pins independently,
  and ships. Your final report: per-family root cause, fix, before/after
  numbers from your runs, flip list, pin results, commit sha, branch name.

## Reference implementations from this campaign (read before inventing)

- Reflective String dispatch: `src/codegen/string-proto-concat.ts` (#4426),
  `string-proto-match-search.ts` (#4439), `array-object-proto.ts` arms.
- `__current_this` save/install/restore discipline: #4429 record +
  `src/codegen/type-coercion.ts` `emitWithCurrentThis`.
- Identity-stable builtin carriers: `src/codegen/function-intrinsic-carrier.ts`
  (#4442) — the module-level provider-linked vs provider-free dispatch.
- Per-function metadata (`.length`/`.name`): `function-instance-meta*.ts`
  (#4437), `function-instance-props.ts`.
- Construct/return semantics: `src/codegen/construct-return-value.ts` (#4464).
- Nominal-brand guards (`ref.test` on branded structs, never structural):
  `function-instance-meta-arms.ts` family-arm comments.

## Two false-green mechanisms measured on 2026-08-24 — both cost real time

### 1. A stale compiler bundle silently SKIPS every eval-gated pin

Symptom: `tests/issue-4654.test.ts` printed `9 passed | 8 skipped (17)` and exited **0**.
That is not a pass, and the exit status agreed with the wrong answer.

Chain: `scripts/compiler-bundle.mjs` was older than files under `src/` →
`computeCompilerBundleHash()` differs → the QuickJS **adapter cache key** differs →
`quickjsProviderAvailable()` returns `null` → `describe.skipIf(!quickjsEnabled)` drops the
eight corpus-backed pins with no diagnostic at all.

Forcing `JS2WASM_EVAL_ENGINE=quickjs` does **not** fix it — it converts the silent skip
into a *suite-level* error (`the quickjs provider is not built (missing …-<hash>.wasm)`)
while the counts line **still** reads `9 passed | 8 skipped (17)`. Two different runs, two
different exit statuses, the same misleading counts line.

Before measuring anything eval-gated, per arm:

```bash
pnpm run build:compiler-bundle && node scripts/build-quickjs-eval-provider.mjs
```

Then read **rung 2**: the file line must say `(17 tests)` with **no** `skipped` suffix.
`(17 tests | 8 skipped)` is an unrun suite wearing a green checkmark.

### 2. A per-test timeout kill writes NO jsonl row — the denominator shrinks silently

`tests/test262-shared.ts` kills a test that exceeds `IT_TIMEOUT_MS` (default 90 s)
**without recording a result**. The row does not become a failure; it *disappears*. So the
run under-reports its own denominator, and it does so **as a function of load**, which
means the same tree measures differently depending on what else is on the box.

This is not hypothetical twice over: the constant's own header records the mechanism
costing **202 of 816 eval-code rows at 2 workers**, and #4654 then produced six
`language/literals/regexp/` files that legitimately need 130–200 s.

Consequences for a lane:

- A pass-rate delta computed from two runs at different load levels is **not a delta**.
  If your arms did not run under comparable load, say so rather than reporting the number.
- If your sweep's row count differs between arms, that difference is a **finding**, not
  noise to be normalised away — reconcile it before reporting flips.
- CI's standalone cells now run at `TEST262_IT_TIMEOUT_MS=300000` (#4654 lead ruling).
  A local sweep at the 90 s default is therefore measuring a *different* denominator than
  CI. Raise it locally too when the rows you care about are eval-heavy.

## Measuring the campaign's own pass rate — the cheap method, and its one caveat

Do **not** run a full-corpus sweep to answer "where is the ES≤5 rate now". The
targeted method is ~25 minutes on this box instead of hours, and it is what the goal
loop uses:

```bash
node scripts/fetch-baseline-jsonl.mjs --standalone --force     # ~23 MB, seconds
# tally main's ES≤5 bucket, and write the NOT-PASSING rows to a list
# (denominator is the 8,115 rows of .tmp/es5-files.txt that have a jsonl row;
#  the ~145 with no row are intl402 and are not ES≤5 core)
# then sweep ONLY that list on your tree:
JS2WASM_EVAL_ENGINE=quickjs TEST262_FULL_RUNTIME_EVAL=1 npx tsx .tmp/sweep-135.mts 0 1
```

New rate = `main_baseline_passes + (rows in the list that now pass)`.

**The caveat, and state it whenever you quote the number:** this measures only rows that
were *failing* on main, so it finds newly-passing rows and is structurally **blind to
regressions**. That is an acceptable division of labour — the merge queue re-validates
the whole corpus on the merged state and is the regression gate — but a lane must not
present this number as "no regressions". It is "N rows newly pass".

**Second caveat: the baseline artifact LAGS main HEAD.** The promote job runs on push to
main, so recently-landed work can already be on main while its rows still read as failing
in the baseline you just downloaded. So the *absolute* rate on your tree is solid; the
*delta* attribution to your own change is not, unless you also ran the base arm yourself.

Measured 2026-08-24: 135-row list, 135 verdicts, **zero timeouts**, ~25 min under two
concurrent lanes — versus the ~4.5 h a full two-arm sweep cost the night before for the
same question.

## Load at DISPATCH time does not predict load at SWEEP time (measured 2026-08-24)

The lead's concurrency gate has been "check `uptime`, spawn if load is low". That gate is
wrong, and the failure is structural rather than a misjudgement:

A lane spends its first stretch reading source and forming a root-cause hypothesis — cheap,
near-zero CPU — and only then starts sweeping, which pins a core. So four lanes dispatched
across a 45-minute window against a load average of 1.5–2.0 each looked individually safe,
and then **all four reached their sweep phase at once**: load 1.57 at the last dispatch,
**9.58** twenty minutes later on a 4-core box.

Two rules follow.

1. **Spawn on the count of ACTIVE lanes, not on instantaneous load.** On this 4-core box
   the cap is four lanes total, and load at spawn time is not evidence about the fourth.
2. **The lane, not the lead, holds the measurement gate.** A lane must run `uptime`
   *immediately before launching a sweep arm* — not when it was dispatched. Analysis
   parallelises fine; measurement does not.

**Correction, same day: a bare `wait for load < 5` is a DEADLOCK, not a gate.** It was
written for a box with one marginal sweeper. With two siblings sweeping continuously the
threshold is never reached, so a lane that obeys it literally sits on a finished
implementation until its pacer times out and then reports nothing — which is strictly
worse than a slightly noisier measurement. A lane asked instead of waiting the full two
hours, and it was right to.

The gate is therefore conditional on whether **your** sweep is the marginal load:

- **Load is low and you would be the one raising it** → go, and stagger against siblings.
- **Load is already saturated by siblings and yours is not the marginal contribution**
  → waiting buys nothing. Go at whatever the load is, with **two** obligations:
  **record the measured load per arm in the report**, and **serially re-verify every
  apparent flip AND every apparent regression** before it enters the report. A sweep at
  load 7 with those two things is sound evidence; a sweep at load 2 without them is not.
- **Either way, commit your implementation BEFORE you sweep.** A container restart today
  killed four lanes and only committed work survived. Holding a finished fix in an
  uncommitted tree through a multi-hour pacer window is the avoidable half of that risk;
  A/B arms live in `.tmp/` and do not require a dirty tree.

## Movement is not a flip — say which one you measured

A row that goes from failing at assertion 1 to failing at assertion 3, or from *wrong
values* to *correct values with wrong presence*, has **moved** but has **not flipped**.
Report it as movement, name the new failing assertion, and keep it out of the flip count.

This matters more than it sounds. The campaign's rate is a sum of per-lane flip counts,
and the tempting shorthand — "4 rows improved" — makes that total unauditable, because
the next reader cannot tell which rows a later measurement should find passing. Movement
is real evidence that the root was correctly identified; it is just not a row.

Corollary for reading results: a `compilation timeout` or `driver_error` row from a sweep
taken at load ≥ 8 is a **measurement failure, not a status**, and must be re-run serially
before it appears in any report as a flip or a regression. This is the same trap that cost
~4.5 h and three false flips the night before — it just arrived through scheduling rather
than through a single oversized sweep.

## The base arm is usually unnecessary — byte identity replaces it

A row can only move if its **emitted module changed**. So for any diff that is gated,
syntactic, or otherwise reaches only part of the corpus, running a full second arm is
paying twice for rows that were never at risk.

Do this instead:

1. Compile the scoped set on **both** arms and compare `wasm_sha` per module. Compiling is
   cheap relative to executing.
2. **Execute the base arm only for modules whose bytes differ.** That is the real reachable
   set, and it is typically one or two orders of magnitude smaller.
3. Report the identity result as the zero-regression argument for everything else:
   *"N of M modules are byte-identical across arms, so no row among them can move."*

**That claim is STRONGER than having run them, not weaker.** Executing a row proves it
did not change *in that run*, under that load, with that flake surface. Byte identity
rules the change out **by construction** — no contention artifact, no timeout, no flake
can hide in it. This is why the argument survives a saturated box while a re-run does not.

Keep the **fix** arm: a module whose bytes changed must be executed to learn which way it
went. It is only the base side that identity replaces.

Provenance: #4655 wave-1 fell back on this when its 3,082-file sweep was OOM-killed and
got a better answer from a smaller set (adjacent tier 0 differ, 200-file sample 0 differ,
own tier 21 differ and every one a `toLocaleString` caller). lane-4655b reused it for a
125-file sample. It is now the preferred zero-regression argument, not the fallback.

## `includes:` splices harness code into YOUR compilation unit

Building a scoped file list by grepping the test *sources* for the API you touched will
miss files that reach it through their metadata. A test262 file's
`includes: [someHarness.js]` is compiled into the **same unit**, so a file whose own body
never mentions `concat` still changes bytes when `resizableArrayBufferUtils.js` calls
`builtinCtors.concat(...)`.

Measured 2026-08-24 (#4655 concat lane): a byte-identity sample of 125 files had exactly
one unexplained difference, and it was exactly the one file in the sample whose `includes:`
pulled in a concat-calling harness. The anomaly closed completely — which is the point.

Two consequences:

- When you grep for callers, grep the `harness/` directory too, and expand `includes:`.
- **An unexplained byte difference in an identity sample is a lead, not noise.** Chase it
  to a named cause. If it will not close, your reachable set is wrong and every "cannot
  move" claim resting on it is unsupported.

## A pin made "unfoldable" can land on a DIFFERENT carrier

The brief's unfoldability rule (write the pin loop-carried so the compiler cannot constant-fold
the case away) has a failure mode that has now bitten twice.

#4655 R8: an `it.fails` pin written loop-carried **passed** on the fix arm while the corpus
row stayed red — when the defect *is* the spelling, unfoldability rewriting moves the pin to
a cell that already worked.

The concat lane hit the inverse. Rewriting the receiver as `var a = []; a[0] = 0; a.length = 3`
instead of the corpus's `var a = [0]; a.length = 3` broke even the **direct** read — five pins
moved onto a different carrier, exposing a separate live defect in the grow-gap marker rather
than the one under test.

So: after making a pin unfoldable, **re-derive that it still exercises the same carrier as the
corpus row**. A pin that is unfoldable but lands elsewhere tests something real and answers the
wrong question.

## ⚠ A sweep scoped to FAILING rows cannot see a row that passes for the WRONG reason

This is the blast-radius rule's real failure mode, and it nearly shipped a regression
today (#4668). It also constrains the campaign's own pass-rate measurement, so read it
before quoting a number.

The #4668 lane's first cut scored **+3 flips, zero regressions** against its own row list —
and **regressed `language/function-code/10.4.3-1-105.js`**, which was *passing on the base
for the wrong reason*. That row is `noStrict` and asserts `(5).x === 5` is **false** and
`typeof (5).x` is `"object"`. Both are satisfied by the correct answer **and** by the
terminal `ref.null.extern` the base was returning. The row was green because two wrongs
agreed.

Why no probe table caught it: every cell that reads through an assertion which `null` also
satisfies is blind by construction. Varying receiver type and strictness — the obvious two
axes — still could not see it. **Only the wider sweep found it**, because the row was never
in the failing set to begin with.

Consequences, in order of how much they cost if ignored:

1. **Size the sweep from what the diff can REACH, never from the rows you intend to fix.**
   Those are different sets, and the difference is exactly where this class of regression
   lives. The #4668 lane derived its scope from the gate — the arm can only fire in a
   module naming `Object`/`Number`/`Boolean.prototype`, so a text grep is a strict superset
   of the gate: 375 files ∪ its own 38 = 408. That is the right shape of argument.
2. **Grep the `harness/` directory separately.** A harness file that arms your gate makes
   the reachable set the whole corpus. #4668 checked: `assert.js` and `propertyHelper.js`
   both *name* a prototype but neither matches the gate; only `testIntl.js` does, and it is
   intl402-only. Without that check the 408-file scope would have been unjustified.
3. **The campaign's targeted pass-rate sweep inherits this blind spot.** Re-running only
   main's not-passing rows finds newly-passing rows and cannot see a row that was passing
   for the wrong reason and is now correctly failing. That is a *third* blind spot on top
   of the two already recorded. The merge queue's full-corpus re-validation remains the
   only thing that catches it — so never present a targeted-sweep delta as "no regressions".

## …and when byte identity does NOT apply — `harness/assert.js` is in every test

The rule above (identity replaces the base arm) has a hard limit, measured by the #4491
wave-7 lane on 2026-08-24: of a 149-row two-arm compile-only sample, **4 identical, 145
differ**. Its diff touched `Object.prototype.toString`, and `test262/harness/assert.js` —
spliced into essentially every assembled test — carries
`Object.prototype.toString.call(value)` on a parameter. So ~97% of modules changed bytes
and the full execution sweep was the correct instrument. It ran 3,114 rows on the branch
arm and a 954-row base arm covering every branch-non-pass row, which rules out a regression
anywhere in the 3,114.

**Take the identity sample FIRST, and let it decide the instrument.** Identity is cheap to
measure and expensive to assume:

- mostly identical ⇒ execute only the differing modules, and the identity result is your
  zero-regression argument for the rest;
- mostly differing ⇒ your diff really does reach the corpus; run the sweep.

Deciding by intuition is how a lane either wastes hours on rows that could not move, or —
worse — claims "cannot move" for modules that all changed.

Note this is the **same mechanism** as the `includes:` finding above, arriving from the
other side: there it made a scoped file list too small, here it makes an identity shortcut
inapplicable. Both reduce to: *harness code is your code*.

## Stray files in the shared `test262/` tree contaminate `find`-built row lists

`test262/test/__probe4481__/` holds stray probe files from a lane closed 2026-08-15, and
they are **untracked in the submodule**, so they survive a normal status check while any
`find`-built row list silently includes them — they compile and "pass", inflating a
denominator with files that are not test262.

Two defences:

- **Build row lists from the baseline JSONL, not from `find`.** Intersecting the corpus
  with rows that exist in `test262-standalone-current.jsonl` excludes anything that is not
  really in the corpus, by construction. The campaign's own pass-rate measurement does
  this, which is why its numbers were unaffected.
- If you must use `find`, diff your list against `git -C test262 ls-files` and account for
  every extra.

## Implement, measure, REVERT — a refusal beats a silent wrong answer

The #4492 wave-6 lane built a fix for `new X.prototype.constructor`, measured it, and
**reverted it**. That was the right call and the pattern is worth naming, because the
temptation runs the other way: code already written feels like sunk value.

What it measured: excluding the `constructor` name from the "prototype METHOD"
classification turns a **loud refusal** into a **silent wrong answer**.
`new String.prototype.constructor("choosing one")` builds a plain object, `== "choosing one"`
answers `false`, and **nothing throws**. Neither target row flips either way — so the change
bought zero rows and cost the diagnostic.

The rule: **when a fix converts an explicit refusal into a wrong value, it is a regression
even if no test262 row records it.** A `TypeError: … is not yet callable as a value` is a
correct statement about the compiler's coverage; a plain object that silently compares
false is not. Absent-not-wrong applies to *fixes*, not only to features you decline to
start.

Report the reverted attempt anyway — the diagnosis is the deliverable. This one routed to
#4515 with the real requirement named (the intrinsic-construct path, not a predicate edit),
which is worth more than the two rows it did not move.

## "Arming" is a separate blocker from "the mechanism is broken"

Same lane, second decline worth copying. Two rows fail not because the mechanism is wrong
but because it is never **armed**: their modules never name a builtin prototype, so
`protoMemberDirty` stays clear and the store is never reserved. Adding one line
(`var arm = Function.prototype`) to the probe flips both.

That is a genuinely different finding from "broken", and it changes the cost estimate
completely — closing it means arming on "a non-literal is assigned to a `.prototype`",
which turns the seeder on for every such module, and `isProtoMemberValueUse`'s own comment
records that perturbing IR eligibility (#2855) is expensive. The lane priced it and
declined: two rows is not that price.

**So when a row fails, establish which of the two you have** — a broken mechanism, or a
correct mechanism that never armed. The probe that distinguishes them is one line, and the
answer changes the issue's size by an order of magnitude.
