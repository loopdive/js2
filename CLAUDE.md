# js2wasm

TypeScript-to-WebAssembly compiler using WasmGC.

## Answering style

Be concise. Lead with the answer, then only the context needed to act on it.

- **No repetition.** Do not restate the question, re-explain what you just did,
  or repeat a caveat you already gave. If it was said earlier in the session, a
  pointer is enough.
- **No long prose.** Prefer a sentence or a short list over a paragraph, and a
  table over a list when comparing. Cut throat-clearing and summaries of
  summaries.
- **Match the question's size.** A yes/no question gets a yes/no plus the one
  fact that makes it actionable, not a status report.
- **Introduce terminology with a quick example.** The first time a term of
  art appears in an answer (demote, claim, merge-queue park, CPS, …), attach a
  one-line concrete example of what it means — e.g. "the selector _demotes_
  the function (a `**` operator makes it fall back to the legacy compiler
  instead of erroring)". A term the reader has to reverse-engineer costs more
  than the sentence that grounds it.
- Brevity is about redundancy, not omission. Findings that change what someone
  would do — a real failure, an unverified assumption, work deliberately left
  out — still get stated plainly. Say them once, in the fewest words that keep
  them accurate.
- **Plain language to the stakeholder.** No jargon, no empty phrases, gist
  first. Internal codenames, gate names, and spec terms only when the reader
  needs to act on them — then with a one-line gloss.

## Hooks and ratchet gates — never skipped, always before the commit

**Never pass `--no-verify` to `git commit` or `git push`** (project-lead order,
2026-08-22). The pre-commit and pre-push hooks are the last check that runs on a
human timescale; skipping them moves every failure into CI, where a red gate
costs a full cycle plus a branch re-sync. If a hook is slow, use the sanctioned
`SKIP_SLOW_PRECOMMIT=1` (which still runs the fast checks) and run the heavy
gates by hand — do not disable the hook.

Run every source-ratchet gate BEFORE committing, chained so a failure blocks:

```bash
node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
  && npm run -s check:dead-exports && git commit ...
```

- **Never pipe a gate whose status you need** (`gate | tail` reports `tail`'s
  status — a red gate reads as green). Run bare, or `>out 2>&1; echo $?`.
- **Simulate CI's base too.** CI diffs the merge preview, not your fork point,
  so a gate can pass locally and still fail `quality`:
  `LOC_GATE_BASE=$(git rev-parse <upstream-main-tip>) node scripts/check-loc-budget.mjs`
  (same variable works for check-func-budget). Two failure classes appear ONLY
  this way: growth whose allowance lives in an issue file this PR does not
  modify (**stranded grants** — restate the grant in a file the PR touches), and
  a ceiling reset by main's post-merge baseline refresh.
- **Run `check:dead-exports` after any supersede-style merge resolution** —
  taking upstream's version of a mechanism leaves your twin's exports
  unreferenced, which fails `quality`.
- Growth allowances go in the PR's own `plan/issues/*.md` YAML frontmatter with
  a dated rationale; **never** edit `scripts/*-baseline.json` (main is its sole
  writer).

## Running Tests

- Run all tests: `npm test` (vitest — may OOM on full suite in constrained envs)
- Run a specific test file: `npm test -- tests/issue-277.test.ts`
- Run equivalence tests only: `npm test -- tests/equivalence.test.ts`
- Test262: `pnpm run test:262` — vitest-based runner, creates its own worktree, writes to `benchmarks/results/`. Default 3 workers.
- **Local CI on Claude Code on Web** (or any 16GB+ container): `JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh` — idempotent pnpm install + test262 submodule init, then `pnpm run test:262` with `COMPILER_POOL_SIZE=$(nproc)-1` (min 1 — one core is left for the shell/editor/sshd; boxes are not all 4-core, so never hardcode it). Baseline 2026-05-20 on a 4-core/16GB container, then at pool 4: ~68 min wall-clock, ~2.8 GB peak RAM. CI sharded is still faster end-to-end; this is for in-container validation runs. See `plan/issues/1522-race-local-test262-vs-ci.md` for the scoped pre-flight design.

## Dev scratch

- **All ad-hoc probe / debug / repro files go in `.tmp/`** — gitignored, not picked up by vitest, doesn't pollute `git status`.
- If you spin up a quick `check-foo.ts`, `debug-bar.mts`, or `probe-*.test.ts` to investigate a bug, write it inside `.tmp/`, not at repo root or under `tests/`.
- Root-level patterns like `check-*.ts`, `debug-*.ts`, `run-*.ts`, `test-*-debug.ts`, `tests/probe-*.test.ts`, `tests/*-debug*.test.ts` are also gitignored as a safety net, but the convention is `.tmp/`.

## Working in worktrees

- **All agent work happens in worktrees**, not in `/workspace` directly. The `check-cwd.sh` hook blocks `git commit`/`merge`/`push` from `/workspace` for non-tech-lead users.
- **Canonical worktree path**: `/workspace/.claude/worktrees/<branch-name>/` — this is enforced by the `check-worktree-path.sh` hook on `git worktree add`. Worktrees outside this root (e.g. `/tmp/worktrees/`) are rejected.
- **Persistent shell cwd resets between Bash invocations**: every Bash tool call starts from `/workspace` regardless of where the previous one ended. Trailers like `Shell cwd was reset to /workspace` confirm this. The agent must prefix git commands with `cd /workspace/.claude/worktrees/<branch> &&` for them to land on the right branch.
  - Read/Edit/Write tools use absolute paths and are unaffected.
  - The `pre-git-commit.sh` hook injects a "VERIFY BEFORE COMMITTING: pwd=/workspace branch=main" reminder; that's the hook reading the (reset) shell cwd, NOT the actual command's working dir. The reminder is informational — verify by reading the commit's branch in git output (`[issue-1183-string-forof-ir 0527c7c5]`-style line shows the real branch).
- **Worktree creation**: `git worktree add /workspace/.claude/worktrees/issue-NNN-slug -b issue-NNN-slug origin/main`. Always branch from `origin/main` (post-fetch), never from local `main`.
  - ⚠ **Check what `origin` IS first — in some checkouts (including agent worktrees of `/workspace`) `origin` is the FORK, whose `main` has diverged from upstream.** Branching from fork-main silently bundles unrelated fork-side commits into your PR, invisible until a conflict forces a look (bit a dev 2026-08-02: 18-file PR, 16 unintended). When in doubt: `git fetch upstream && git worktree add … upstream/main`, and verify with `git merge-base --is-ancestor upstream/main <your-base>` reasoning — the authoritative base is **upstream**, whatever the remote is named.
- **Branch base — `origin/main`, never the merge-queue tip (#2522)**: for independent work, branch from `origin/main`, then `git merge origin/main` again right before enqueue — that catch-up rebases the work onto future-main but incorporates only PRs that _actually landed_. Do **not** branch from a `gh-readonly-queue/main/pr-N-<sha>` tip or otherwise base work on the queue's _speculative_ end-state: queued PRs eject, and a base built on an ejected PR carries phantom commits that force a rebase (forbidden — public main is append-only). **Exception — known dependency (explicit predecessor-stacking)**: when a new task is known to depend on / heavily overlap a specific in-flight PR, branch from _that PR's real branch_ (durable, not the ephemeral queue ref) and enqueue only after the predecessor lands; re-merge it if it changes. The inter-PR conflict rate is a queue-_speculation_ lever (`max_entries_to_build > 1`, re-raise once runner capacity from #2519 allows), not a dev-branch-base lever.
- **Push safety**: `.git/config` sets `push.default=current` — `git push` always pushes to the remote branch matching the local branch name, regardless of upstream tracking. This prevents the `git worktree add -b <branch> origin/main` trap where the inherited tracking ref routes pushes to origin/main.
- **`git stash` is safe ONLY when you are provably the only one working in this clone — `refs/stash` is a SINGLE SHARED STACK across every worktree of the repo.** It lives in the common `.git` dir, not per-worktree, so with agents running in parallel it is an interleaved free-for-all: your `git stash pop` takes whatever entry is on top, which is very likely **another agent's**, and drops it from the stack. This is not theoretical — on 2026-07-31 two agents popped each other's stashes within minutes, losing 546 lines of `native-strings-rewrite.ts` and 240 lines of `src/runtime.ts`. Both were recoverable only as dangling commits.
  - **When you MAY use it (2026-08-14):** you are the sole agent in your own worktree, or you are on the main working copy and no other agent is working in it. A solo session — one agent, no teammates spawned, no other worktrees active — is the ordinary case for this, and there `git stash` is an ordinary tool.
  - **How to establish "alone" — check, do not assume.** `git worktree list` shows every worktree sharing this stack; `git stash list` shows entries you did not create. If either says someone else is here, use file copies. The hazard is *concurrency*, not the command.
  - **Still prefer file copies for a revert-and-measure (A/B) cycle** even when alone: the copies survive a crash, can be diffed, and let you flip back and forth without touching shared refs at all.
  - **The file-copy A/B pattern:**
    ```bash
    cp src/foo.ts .tmp/new.ts
    git show HEAD:src/foo.ts > .tmp/base.ts
    cp .tmp/base.ts src/foo.ts    # measure baseline
    cp .tmp/new.ts  src/foo.ts    # restore
    ```
  - **Capture `.tmp/base.ts` at the FIRST edit — the measurement rationale is
    stronger than the stash-safety one (2026-08-15, #2916/#4433 cross-audit).**
    Of ~11 documentation corrections across those two issues, the large
    majority were ONE defect: a figure inherited from an artifact (stale
    baseline, stale skip list, unjustified scan filter, never-run lane),
    restated as a measurement — and the skips tracked PRICE, not care: the
    before-state check that got run cost one `cp`, the one that got skipped
    cost a corpus compile, with a plausible artifact offering a free answer
    exactly where measuring cost most. Capturing the revert copy up front
    makes every later base run one `cp` away, so "measure the before-state
    yourself" stops being a decision. Corollary: when you quote a number, name
    the artifact it came from and when that artifact was made; a delta claimed
    without a base run you executed is attribution, not measurement.
  - **Recovery if it already happened**: `git fsck --unreachable | grep commit`, then `git log -1 --format=%s <sha>` on each — a stash entry's message is `WIP on worktree-agent-<id>`, which identifies the **owner** unambiguously. Restore with `git checkout <sha> -- <paths>`. Tell the lead so the commit can be pinned (`git update-ref refs/recovered/<name> <sha>`) before garbage collection takes it; unreachable objects are collectable.
  - The hazard is **worse than it looks** because the failure is silent and delayed: `pop` succeeds, you keep working, and you only notice when the file you expected is someone else's. The victim usually suspects their own change first.
- **Worktree cleanup after merge**: after a dev self-merges their PR, they remove their own worktree (`git worktree remove /workspace/.claude/worktrees/<branch>`) before claiming the next task. Tech-lead only removes worktrees for suspended or abandoned branches.

## Architecture Principles

- **Dual-mode: JS host optional** — the compiler supports two modes: JS host mode (uses host imports for performance/completeness) and standalone mode (pure Wasm, no JS runtime). New features should have Wasm-native implementations for standalone mode; JS host imports are acceptable as a fast path when a JS runtime is available. Don't add new host imports without a standalone fallback.
- This follows the pattern of #679 (dual string backend) and #682 (dual RegExp backend).
- **Two orthogonal axes in codegen** (see #1527):
  - **Backend lowering**: `src/codegen/` (WasmGC) vs `src/codegen-linear/` (linear memory). These are **alternatives, not one superseding the other** — the choice depends on target (browser/WasmGC vs WASI/linear) and tradeoffs. Both stay.
  - **Front-end**: direct AST→Wasm (legacy, accumulated hacks) vs IR (`src/ir/`, typed representation). IR **replaces the hacks**; it does **not** compete with the backend choice. IR adopts AST node kinds step by step, only for parts that do not yet need to decide between linear and WasmGC lowering. IR-path failures currently demote to a warning channel (#2855 phases this fallback out).
  - Full discussion: [docs/architecture/codegen-axes.md](docs/architecture/codegen-axes.md). Per-AST-kind adoption status: [plan/log/ir-adoption.md](plan/log/ir-adoption.md).

## Project Structure

- Codegen: `src/codegen/expressions.ts`, `src/codegen/index.ts`, `src/codegen/statements.ts`, `src/codegen/type-coercion.ts`, `src/codegen/peephole.ts`
- WIT generator: `src/wit-generator.ts` (TypeScript → WIT interface generation)
- Optimizer: `src/optimize.ts` (Binaryen wasm-opt integration)
- Tests: `tests/equivalence.test.ts` (main), `tests/test262.test.ts` (conformance dashboard, non-failing)
- Test262 runner: `tests/test262-runner.ts` — TEST_CATEGORIES list
- Test262 runner (preferred): `pnpm run test:262` — vitest-based, auto-worktree, disk cache, default 3 forks. Use `TEST262_WORKERS=5` for solo runs (no dev agents).
- Test262 runner history: `runs/index.json` is appended by the vitest runner after each run. `benchmarks/results/report.html` reads this for the trend graph.
- Backlog: `plan/issues/backlog/backlog.md`
- Sprints (rolling budget-window model, #2751): live work is tagged `sprint: current` and forms one long, priority-ordered, over-provisioned TaskList (auto-synced by `scripts/sync-current-tasklist.mjs`). A numbered `plan/issues/sprints/{N}.md` is the **frozen retrospective record** written by `scripts/freeze-sprint.mjs` at token-budget rollover (≥99% spent or ≤1h left): done `current` issues are re-tagged `sprint: {N}`, not-done ones roll forward as `current`. See `plan/issues/SCHEMA.md` and #2751.
- Issues: **flat** at `plan/issues/<id>-<slug>.md` (#1616). The on-disk
  location is stable; sprint membership and status live **only** in
  frontmatter, never in the directory:
  - `sprint: <N>` numbered sprint · `sprint: 0` pre-sprint history ·
    `sprint: Backlog` unscheduled
  - `status: ready|in-progress|in-review|done|wont-fix|blocked|backlog`
  - `sprints/{N}.md` (the sprint doc) lives directly under `sprints/`; the
    numbered issue files are flat under `plan/issues/`. See
    `plan/issues/SCHEMA.md`.
  - **New issues MUST get their id from `claim-issue.mjs --allocate` (#2531) —
    never hand-pick a number.** Hand-picking "next free off main" races: two
    devs on separate branches each pick the same id (neither file is on `main`
    yet), the dup is green at PR time and only fails in the `merge_group`,
    wedging the queue. `--allocate` reserves the next id **atomically** against
    **upstream**'s `main` ∪ every open PR's added issue files ∪ ids already
    reserved on the orphan `issue-assignments` ref (first-push-wins; loser
    re-scans). Flow:
    ```bash
    NEW=$(node scripts/claim-issue.mjs --allocate --by ttraenkler/<agent>)
    # (or: node scripts/claim-issue.mjs --allocate ttraenkler/<agent> --branch <b>
    #  to reserve AND claim in one step)
    # create plan/issues/$NEW-<slug>.md with frontmatter id: $NEW
    ```
    `--dry-run` previews without reserving; `--json` for tooling; `--by <name>`
    records who asked (every record carries a non-empty `requested_by` since
    #3880 — bare `--allocate` still works, it just attributes to your git
    identity). The required CI gate `check:issue-ids:against-main` (in
    `quality`) rejects any PR that introduces an id already taken on `main` — so
    a hand-picked collision can't merge.
  - **`--no-pr-scan` now REFUSES to reserve unless you also pass
    `--allow-unscanned` (#3880).** Skipping the open-PR scan removes the only
    check against ids that an in-flight PR already uses, and a reservation made
    without it must not be handed out as if it were clean. The refusal happens
    **before** anything is written, so declining costs nothing — whereas
    reserving and then abandoning an id leaves a permanent hole in the sequence
    (#3890/#3891 were burned exactly that way). `--dry-run --no-pr-scan` is
    still fine: it reserves nothing.
  - **There is ONE assignment book and it is UPSTREAM's (#4045/#4117).** Until
    2026-08-03 the ref defaulted to `origin`, which in agent worktrees is the
    **fork** — so the repo kept two disjoint reservation books and "atomic
    reservation" was atomic against whichever one you were standing in. Two
    lanes were handed the same id twice on the record (3750/3751 on 2026-07-28;
    4113 on 2026-08-02, where a claim 24 minutes older was simply invisible).
    Reads are now the union of upstream's book and any legacy book; writes go
    only to upstream's, so the fork's drains. Consequences for you:
    - **`--check` now distinguishes three states**, and prints WHICH ref
      answered: `CLAIMED` (exit 3) · `RESERVED — id TAKEN, nobody working`
      (exit 0) · `UNASSIGNED` (exit 0). The middle one used to print
      "UNASSIGNED", so the tool that writes `reserved` records could not see
      what it had just written. **A claim assertion without its ref is unusable
      evidence** — quote the `read <remote>/issue-assignments` line.
    - An unreadable **legacy** book REFUSES an allocate. `--allow-unscanned`
      does *not* excuse it (that flag is about the open-PR scan); the specific
      consent is `--allow-unmerged-books`. Once the fork's book is drained, set
      `CLAIM_ASSIGN_LEGACY_REMOTES=""`.
    - An unreadable **authoritative** book refuses outright and never falls back
      to the fork.
    - **Still open, by design:** the open-PR scan is a point-in-time check, not
      a lock, so an id reserved now and PR'd minutes later is invisible to a
      scan in between. The required `check:issue-ids:against-main` /
      open-PR-collision gate is the backstop that actually arbitrates.
  - **Read the RECORD, not the exit code — and never pipe a command whose exit
    status you need.** `cmd | tail -4; echo $?` reports **`tail`'s** status, so a
    crashed script reads as success; this trap bit three agents in one session,
    one of whom had the rule in their own memory at the time. Use
    `cmd >out 2>&1; echo $?`, `${PIPESTATUS[0]}`, `set -o pipefail`, or run bare.
    As a backstop the tool's **last output line is always a verdict** —
    `claim-issue: OK — …` / `REFUSED` / `FAILED` — which survives a bad pipe.
    Exit codes: `0` ok · `2` usage · `3` claimed by someone else · `4` already
    done on main · `5` contention, nothing written · `6` infrastructure failure,
    nothing written, safe to re-run · `7` **UNKNOWN, the write may or may not
    have landed — re-read the record with `--check`, do NOT blindly retry**.
- Dependency graph: `plan/log/dependency-graph.md`
- Goals (DAG): `plan/goals/goal-graph.md` — high-level goals with dependencies; issues belong to goals
  - Goals are not sequential milestones — they form a DAG and multiple can be active in parallel
  - Only work on issues from goals whose dependencies are met (active/activatable)
  - Legacy milestones in `plan/milestones/` are superseded by goals

## Key Patterns

- `VOID_RESULT` sentinel in expressions.ts — `InnerResult = ValType | null | typeof VOID_RESULT`
- Ref cells for mutable closure captures — `struct (field $value (mut T))`
- FunctionContext must include `labelMap: new Map()` and `isGenerator?: boolean` in all object literals
- `as unknown as Instr` double-casts eliminated (#1095) — the `Instr` union now covers every emitted opcode (i64.store added) and the emitter's `default` case is a `never` exhaustiveness check, so a new union variant without an encoding case is a compile error. Prefer adding the op to the union over any cast; `as Instr` single-assertions remain for the few computed-`op` sites.
- f64.promote_f32 IS now in the Instr union (added for Math.fround)
- `return_call` / `return_call_ref` for tail call optimization in return position
- Peephole pass removes redundant `ref.as_non_null` after `ref.cast`
- Native type annotations: `type i32 = number` → emits i32 locals and i32 arithmetic
- `nativeStrings` flag decouples WasmGC string arrays from fast mode (auto-enables for WASI)
- **New codegen needing type info: use `ctx.oracle` (`src/checker/oracle.ts`), not the raw TS checker.** Raw `checker.getTypeAtLocation`/`ctxChecker` calls trip the oracle-ratchet gate (#1930/#3273) — 5+ independent PRs hit this same wall in one session (#3169/#3171/#3176/#3178/#3188) before landing, each needing the identical fix (route through `ctx.oracle.signatureOf`/equivalent, or grant `oracle-ratchet-allow:` only when the query genuinely needs raw `ts.Type` identity that the oracle can't express — e.g. a wasm-lowering `ValType` question, which is deliberately ABOVE what `ctx.oracle` can answer). Check the oracle's existing dispatch before reaching for `checker.*` directly.

## Type Coercion (now in `src/codegen/type-coercion.ts`)

- ref/ref_null → externref: use `extern.convert_any` (in coerceType)
- f64 → externref: use `__box_number` import
- i32 → externref: use `f64.convert_i32_s` + `__box_number`
- null/undefined in f64 context: emit `f64.const 0` / `f64.const NaN` directly (avoids externref roundtrip)

## addUnionImports

- Late import addition shifts function indices — `addUnionImports` in index.ts
- Must also shift `ctx.currentFunc.body` (the current function being compiled)
- `body: []` in FunctionContext (NOT `body: func.body`) — shared references break savedBody/swap pattern

## Test262

- test262.test.ts has no assertions — all vitest tests pass; conformance is tracked via report
- Skip filters — **verified against `tests/test262-runner.ts` on 2026-07-26 (#24); this is now the
  complete list, not a historical one.** `shouldSkip` skips exactly:
  - `_FIXTURE.js` helper files
  - `HANGING_TESTS` (an explicit per-path set — compiler hangs)
  - `language/import/import-defer/` (proposal, no harness)
  - the 18-file `eval-script-code-host-resolves-module-code` family (#1696)
  - anything `classifyTestScope` calls a **proposal**, unless `TEST262_INCLUDE_PROPOSALS=1`
  - one **feature** skip only: `IsHTMLDDA`. (`top-level-await` was listed here
    until 2026-08-15 but is NOT skipped — `shouldSkip` has no such branch;
    `tests/test262-runner.ts` ~L3269 explicitly HANDLES those files via the
    #1612 synchronous TLA wrapper, so they run and count. The stale line
    nearly caused 4 real regressions to be dismissed as "CI skips these"
    during #4433.)

  **Everything else RUNS and is counted against conformance.** In particular `eval` and `with` are
  **NOT** skipped (measured 2026-07-25: 826 eval-dependent / 512 failures, 171 `with` / 148 failures
  in the ES5 bucket alone). The old list also named **Proxy, SharedArrayBuffer, Temporal, WeakRef,
  FinalizationRegistry and dynamic `import()`** — **none of those are skipped either.** Temporal is
  the easy proof: the baseline carries Temporal entries with `status:"fail"` and error
  `Temporal is not defined`, which only appears if the tests ran. A stale "these are skipped" claim is
  how a real multi-hundred-test gap stays invisible, so treat this list as load-bearing and re-verify
  it in the runner before editing.

- Many previously-skipped features now supported: TypedArray, DataView, ArrayBuffer, delete, async, generators, for-of
- Issues #618-#634 cover current failure patterns (from 2026-03-19 error analysis)
- parseInt import: `(externref, f64) -> f64` with NaN sentinel for missing radix

### Baseline files (which is authoritative?)

| File                                                      | Lives in                    | Authoritative for                                                                                                          | Refreshed by                                                           | Validated by                                                                                                                                              |
| --------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmarks/results/test262-current.json`                 | main repo (committed, ~kB)  | landing-page summary, pass/total badges                                                                                    | `test262-sharded.yml` `promote-baseline` job (every push to main)      | (none)                                                                                                                                                    |
| `test262-current.jsonl` (in `loopdive/js2wasm-baselines`) | separate repo               | PR regression-gate baseline (fetched fresh per CI run); `dev-self-merge` Step 4 bucket-by-path regression analysis (#1528) | `test262-sharded.yml` `promote-baseline` job (every push to main)      | `test262-baseline-validate.yml` spot-checks 50 random `pass` entries on every PR (#1218); fails the PR if any sampled entry no longer passes on main HEAD |
| `benchmarks/results/playground-benchmark-sidebar.json`    | main repo (committed, ~1KB) | landing-page sidebar wasm/js perf chart; `benchmark-refresh.yml` regression diff baseline                                  | `benchmark-refresh.yml` auto-commit step on every push to main (#1216) | (none)                                                                                                                                                    |
| `benchmarks/results/npm-compat.json` (+ `-perf`, `-history`, and the `website/public/` twins) | main repo (committed) | the whole `npm-compat.html` dashboard — every package card's compile/validate, tests and perf | `npm-compat-refresh.yml` on every push to main, 6h cron backstop (#3988); promotes via a **PR on `ci/npm-compat-refresh`**, not a direct push | pre-promote check in that workflow: refuses to publish <20 packages or entries missing `name`/`compile` |


**`npm-compat.json` is refreshed by CI on every merge to main
(`npm-compat-refresh.yml`, #3988) — do NOT hand-commit it.** Until 2026-08-01
nothing regenerated it, so changing `scripts/generate-npm-compat-report.mjs` and
merging left `website/npm-compat.html` serving the previous JSON with green CI
and no signal; that shipped stale twice in one day (#3958 rendered `39/null`;
#3977 kept showing `lit` as `not-integrated` after its suite landed). The
workflow regenerates, sanity-checks (refuses <20 packages, or entries missing
`name`/`compile`), and **promotes through a pull request** on the single reused
branch `ci/npm-compat-refresh` — force-updated each cycle, at most one PR open,
enqueued by `auto-enqueue.yml` like any other PR.

**It no longer pushes to `main`, and the merge-queue gate is gone from this
path.** Any push to main — _including_ a `[skip ci]` one — rebuilds every
in-flight `merge_group` and discards the ~19-minute `Test262 Sharded` job under
it (2026-08-09: PR #4323 lost a window to this bot; #4297 lost three). The gate
(`scripts/main-push-queue-gate.mjs`) only bounded that: its staleness floor
_overrides_ the queue check, and it fails open, so a busy day accumulated
deferrals until a push landed in a live group anyway. The artifact diff touches
nothing on the `&test262-paths` anchor, so the PR's merge group skips the shard
matrix — **never add `package.json`, `pnpm-lock.yaml` or any source file to that
branch.** The gate script stays for `benchmark-refresh.yml` and
`refresh-baseline.yml`, which still push directly. See `docs/ci-policy.md`.

**The refresh job is ~24 min — LONGER than the interval between merges to main.
That is load-bearing for anything you change about it (#3988).** Its first cut
carried `cancel-in-progress: true` plus a "main advanced, a newer run owns
promotion" guard, and the two composed into a livelock: every run was cancelled
mid-flight by the next push, the single run that survived deferred to a "newer
run" that had itself been cancelled, and the artifact did not move for 9 hours
while CI stayed green. The 6h cron did not save it — a scheduled run shares the
same concurrency group and is cancelled like any other. If you touch a long
auto-commit-to-main workflow, the two rules that fall out of this are: **never
`cancel-in-progress` a job longer than its own trigger interval**, and **gate
promotion on artifact FRESHNESS (`generatedAt`), never on commit-sha equality
with the revision you measured** — main always advances underneath you, so a
sha check defers 100% of runs. Replay the artifact onto current main and retry
instead.

Two consequences worth knowing:

- **You do not need to refresh it in your PR.** A generator change lands and the
  artifact catches up on the next merge. If you _do_ commit one by hand it is
  simply overwritten.
- **`--only <pkg>` cannot refresh it** if you ever need a local run: a focused
  run never writes (it would drop the other packages), so
  `pnpm run generate:npm-compat` regenerates everything — tens of minutes,
  because it re-runs the React and lit upstream suites and re-measures three
  perf lanes. That cost is why the manual step got skipped and why it is now
  CI's job.

**Baseline JSONL is no longer committed to the main repo (#1528).** It lives only in `loopdive/js2wasm-baselines` and is fetched on demand by `scripts/fetch-baseline-jsonl.mjs` to `.test262-cache/test262-current.jsonl` (gitignored). Consumers (validator, `dev-self-merge` bucket analysis, regression triage, sprint wrap-up harvest) either call the helper directly or accept the cache path via fallback. This removes the ~15 MB blob from every clone and retired the dedicated `refresh-committed-baseline.yml` workflow.

**The bare `node scripts/fetch-baseline-jsonl.mjs` is now SAFE — freshness is the default (#3629).** It used to be a **silent no-op whenever any cache existed**: exit 0, zero bytes of output, serving whatever was on disk. That is indistinguishable from a successful fresh fetch, and the error scales with cache age. Measured 2026-07-25: it served a **seven-day-old** cache reading `pass 25,545` while main was at `30,931` — a 5,386-test gap, an entire session's landed work invisible — to multiple dev lanes that had been told to "fetch fresh" with exactly that command.

- It now **refetches automatically** when the cache is older than 6h, and **always reports what it served and how old it is**. Reporting goes to **stderr**, so stdout stays parseable (`--print-path` and the path echoed under `--force`/`--no-cache` are unchanged).
- `--force` still forces; **`--offline`** is the new opt-in for the genuinely disconnected case, and it says loudly that freshness was not established. `--max-age-hours N` overrides the window.
- **A failed download with a cache present is a THIRD state, not a success.** It falls back to the cache but names the cache's age and states explicitly that this is *not* a confirmation the cache is current. "The fetch command exited 0" never means "the cache is up to date".

To validate the baseline on demand, run `pnpm run test:262:validate-baseline` — the validator calls the fetch helper itself, then spot-checks 50 random `pass` entries against current HEAD (uses a deterministic seed; pass `PR_NUMBER=N` to reproduce a specific CI run, or `SAMPLE_SIZE=10 SEED=12345` for a quicker check). Set `SAMPLE_SIZE=50` to match CI exactly. The validator fails fast on the first 5 most-affected entries with a pointer to the fetch helper for forcing a refresh.

## IR Fallback Budget (#1376) — being phased out (#2855)

The IR retirement gate `pnpm run check:ir-fallbacks` walks every `.ts` file
under `playground/examples/` with `trackFallbacks: true` and aggregates
rejection reasons against `scripts/ir-fallback-baseline.json`. CI fails when
any **unintended** bucket grows.

**Direction**: this budget is a transitional safety net, not a permanent
ceiling. #2855 prioritises ratcheting the unintended buckets to zero so the
IR path becomes the only path for the affected node kinds. Once a bucket
hits zero, the rejection reason gets added to `STRICT_IR_REASONS` in
`src/codegen/index.ts`, which promotes any future regression of that
reason from a silent legacy fallback to a hard compile error. Per-bucket
ownership + target dates live in `plan/log/ir-adoption.md`.

| Reason                       | Category   | Reduces with                         |
| ---------------------------- | ---------- | ------------------------------------ |
| `body-shape-rejected`        | unintended | #1370 (class methods), #1373 (async) |
| `external-call`              | unintended | #1371 (whitelist Math.\* / parseInt) |
| `call-graph-closure`         | unintended | #1370, #1373                         |
| `param-shape-rejected`       | unintended | #1372 (destructuring params)         |
| `param-type-not-resolvable`  | unintended | better TypeMap propagation           |
| `return-type-not-resolvable` | unintended | better TypeMap propagation           |
| `type-resolution-failure`    | unintended | better TypeMap propagation           |
| `async-generator`            | deferred   | (out of scope long-term)             |
| `deferred-feature`           | deferred   | (eval / Proxy / with — wont-fix)     |
| `type-parameters`            | deferred   | (generics specialisation, future)    |
| `non-export-modifier`        | deferred   | (`async` / declare-only — narrow)    |
| `unnamed`                    | deferred   | (anonymous default exports)          |

Refresh the baseline on PRs that intentionally retire a bypass:

```bash
pnpm run check:ir-fallbacks -- --update
git add scripts/ir-fallback-baseline.json
```

**Ratchet** (#2855): `pnpm run check:ir-fallbacks -- --update-on-decrease`
auto-writes the new (lower) counts to `scripts/ir-fallback-baseline.json`
when a PR shrinks any unintended bucket. Growth still fails. The
post-merge CI job is the intended caller of this mode so improvements
bank automatically; use `--verbose` on either mode to print the per-file
rejection breakdown.

## CLI Flags

- `--target wasi` — emit WASI imports (fd_write, proc_exit) instead of JS host
- `--optimize` / `-O` — run Binaryen wasm-opt on compiled binary
- `--wit` — generate WIT interface file for Component Model
- `--nativeStrings` — use WasmGC i16 arrays instead of wasm:js-string (auto for WASI)

## Team & Workflow

**Plan/implement split (project-lead order, 2026-08-15): every issue gets an
`## Implementation Plan` written by the Fable lane before implementation, and
the implementation itself is done by an Opus subagent working from that plan.**
Fable writes plans (measurements, exact functions/files, order-preservation
constraints, acceptance criteria); Opus implements and validates against them.

See [plan/method/team-setup.md](plan/method/team-setup.md) for full team config, roles, memory budget, communication protocol, and merge lessons. Agent preferences and rules are in `.claude/memory/` (MEMORY.md index).

**Checklists** (read at the right moment, not at spawn time):

- `plan/method/session-start-checklist.md` — tech lead reads at session start
- `plan/method/pre-commit-checklist.md` — devs read before every git add/commit
- `plan/method/pre-completion-checklist.md` — devs read before signaling task completion
- `plan/method/pre-merge-checklist.md` — dev reads before merging to main

**Skills** (on-demand role protocols — any agent can invoke these):

- `/test-and-merge` — full tester pipeline: merge main into branch, equiv tests, ff-only merge
- `/smoke-test-issue` — validate an issue still reproduces before dispatching
- `/analyze-regression` — diff two test262 runs to find which tests flipped
- `/sprint-wrap-up` — end-of-sprint cleanup checklist
- `/create-issue` — create issue file from a failure pattern
- `/architect-spec` — write implementation spec for a hard issue

Skills replace idle specialist agents. A dev can invoke `/test-and-merge` instead of waiting for a tester. Any agent can invoke `/architect-spec` instead of spawning an architect. Prefer skills over dedicated agents when:

- The task is short (< 5 min of agent time)
- Only one agent needs the capability at a time
- RAM is tight

Spawn dedicated agents when:

- Multiple tasks need the same role concurrently (e.g., 3 devs)
- The role needs sustained back-and-forth with the user (e.g., PO during planning)
- The role accumulates context that's hard to capture in a skill (e.g., PO during a multi-issue planning discussion)

**Pick the right spawn mode (this matters for lifecycle):**

- **Teammates** (`Agent` with `team_name: "js2wasm"`) — long-running, lead-orchestrated. Use for **dev agents** that pull from the TaskList, receive mid-task redirects via SendMessage, or need to coordinate file locks with other agents. Teammates do **not** self-terminate — the tech lead sends `shutdown_request` when they're idle.
- **Subagents** (`Agent` without `team_name`) — fire-and-forget. Use for **one-shot architects, research agents, spec writers** that read inputs, write an output file, and return a summary. Subagents auto-cleanup when their task returns — no pane management needed.

Default rule: if the agent's job is "produce one document and exit," it's a subagent. If the agent's job is "stay on the task queue and grab the next thing," it's a teammate. Misusing teammates for one-shot work causes pane exhaustion because they idle forever waiting for orchestration that never comes (confirmed via Claude Code docs — see [[feedback_agent_self_termination]]).

**Worktree isolation on spawn (REQUIRED for writers).** The lead runs as an un-isolated background job in `/workspace`. A background-isolation guard (`worktree.bgIsolation` in `.claude/settings.json`) blocks file writes from background-spawned agents that aren't isolated. The agent-def `isolation: worktree` frontmatter (set on developer/senior-developer/architect/product-owner) is honored for plain **subagent** spawns but is **NOT auto-applied to teammate spawns** (`team_name` set) — so **always pass `isolation: "worktree"` explicitly on every teammate `Agent` spawn**. That gives each teammate a harness-managed worktree, satisfying the guard with it ON. `bgIsolation` is **`"worktree"` (guard ON)** as of 2026-05-29 — the temporary `"none"` unblock has been removed now that teammate spawns pass `isolation: worktree` explicitly. So every background-spawned writer MUST carry explicit `isolation: "worktree"` or its file writes are blocked. Valid `bgIsolation` values are only `"worktree"` (default/on) and `"none"` — there is no auto mode (Claude Code v2.1.143+).

**IMPORTANT: Always use team name `"js2wasm"`** — this is the single permanent team. Never create ad-hoc team names (e.g. `"wasi-conflicts"`, `"s52-wave2"`). One team, one task queue, always.

**Key numbers**: 16GB RAM + 16GB swap (container, set in `.devcontainer/devcontainer.json`), **8 cores**. `free -m` may report ~20GB but Docker enforces 16GB hard limit. **CPU is the binding constraint, not RAM** — keep concurrent _active_ agents to ~`cores − 2` (≈6 here) so the box stays interactive; the `pre-agent-spawn.sh` load gate enforces this. All agents use `bypassPermissions` mode + worktree isolation. Work driven by `plan/log/dependency-graph.md`.

**RAM monitoring**: Use `free -m` "available" column (not "free"). "free" excludes reclaimable disk cache. Hooks check "available" before allowing agent spawns.

**CPU / concurrency cap (the binding limit)**: The real bottleneck on this box is CPU, not RAM — agents are cheap while idle (waiting on the API) but each _active_ one bursts a core during compile/test. With no ceiling, load oversubscribes (it hit 13–16 on 8 cores), which starves sshd and drops interactive SSH sessions. `pre-agent-spawn.sh` therefore hard-blocks a new spawn when the **1-min load average ≥ `cores − 2`** (the `JS2WASM_MAX_LOAD` env var; default leaves ~2 cores for the lead/IDE/sshd/system). It gates on _load_, not a process count, because the harness keeps a warm `claude.exe` pool (`--bg-spare`/`--bg-pty-host`) that makes process-counting a poor proxy for active agents. Raise `JS2WASM_MAX_LOAD` to trade SSH responsiveness for throughput.

**Memory budget** (measured peaks via `/proc/[pid]/status` VmHWM):

- Fixed: Cursor ~1,400MB + system ~1,200MB + tech lead ~1,400MB = **~4,000MB**
- Dev agent: ~700MB peak (no local test262)
- Test262 (CI only): ~4,300MB peak per shard — runs in GitHub Actions, not locally
- RAM allows ~8 devs (~9.6GB headroom), but **CPU is the tighter limit**: target ~`cores − 2` (≈6) concurrent _active_ agents. The `pre-agent-spawn.sh` load gate (see "CPU / concurrency cap" above) enforces it; `free -m` available is still a secondary floor.

### Agent lifecycle — when to spawn, skill, or terminate

| Situation                                      | Action                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev needs to test + merge                      | Invoke `/test-and-merge` skill (no tester agent needed)                                                                                      |
| Need to validate 1-2 issues                    | Invoke `/smoke-test-issue` skill                                                                                                             |
| Sprint planning (collaborative, multi-issue)   | Spawn PO + Architect agents                                                                                                                  |
| Hard issue needs design                        | Invoke `/architect-spec` skill, or spawn architect if multiple issues                                                                        |
| Sprint retro / process improvement             | Tech lead runs it directly (no SM agent)                                                                                                     |
| Planning agents done, user not talking to them | Write context summary → terminate                                                                                                            |
| Planning agents done, user IS talking to them  | Keep alive until user signals done                                                                                                           |
| Dev between tasks                              | Keep alive — wait for CI, self-merge if green, then claim next task from TaskList                                                            |
| Dev sending idle_notification pings            | If TaskList has unowned work: redirect them to it. Otherwise: send `shutdown_request` — that's the correct lifecycle exit, not a punishment. |
| Dev idle, no tasks available                   | Send `shutdown_request` immediately. Idle teammates burn pane slots and block new spawns. Re-spawn when work appears.                        |
| End of sprint                                  | All agents write context summaries → terminate → run `/sprint-wrap-up`                                                                       |

### Roles and interactions

```
User (stakeholder)
  ↕ directs priorities, approves plans
Product Owner
  ↓ creates issues with problem + acceptance criteria
Architect
  ↓ adds implementation specs to issue files (functions, Wasm patterns, edge cases)
Tech Lead
  ↓ creates task queue, dispatches to devs, merges (ff-only), runs test262
Developers (×3)
  ↑ signal completion → tech lead merges → broadcast rebase
PR-queue Shepherd
  ↔ owns the merge queue end-to-end: enqueues green PRs, handles parks/ejections
Tech Lead (also)
  ↔ owns process improvement / retrospectives (formerly Scrum Master)
```

| Role                  | Agent                                             | Owns                                | Reads from                                             | Writes to                                        |
| --------------------- | ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| **Product Owner**     | `.claude/agents/product-owner.md`                 | Backlog, issue creation, priorities | test262 results, dependency graph                      | `plan/issues/`, `plan/log/dependency-graph.md`   |
| **Architect**         | `.claude/agents/architect.md`                     | Implementation specs                | Issue files, compiler source                           | `## Implementation Plan` in issue files          |
| **Tech Lead**         | (orchestrator)                                    | Task queue, merges, test runs       | Issue files, agent messages                            | `main` branch, task list                         |
| **Developer**         | `.claude/agents/developer.md`                     | Code changes in worktree            | Issue file + impl spec, checklists                     | Source code, test files, issue status            |
| **PR-queue Shepherd** | `.claude/agents/developer.md` (standing teammate) | The merge queue end-to-end          | Open PRs, CI/`merge_group` results, park-hold comments | Enqueue mutations, `[CI-FIX]` tasks, escalations |

Process improvement / retrospectives are owned by the **Tech Lead** (the standing
Scrum Master role is retired) — see "Process improvement & retrospectives" in
`.claude/agents/tech-lead.md`.

**Interaction flow:**

Sprint planning:

1. **PO** validates candidate issues against current main → closes stale ones
2. **PO** prioritizes remaining issues by value → routes hard ones to architect
3. **Architect** reads issue + compiler source → writes implementation plan in the issue file
4. **PO** creates task queue with full context → tech lead dispatches to devs

During sprint: 5. **Dev** reads issue (with impl plan) → implements → follows checklists → signals completion 6. **Dev** invokes `/test-and-merge` skill → merges main into branch → equiv tests → if pass: ff-only to main → post-merge cleanup. If fail: fixes on branch. 7. **PO** accepts/rejects completed work against acceptance criteria

End of sprint: 8. **Tech lead** runs full test262 → records results 9. **Tech lead** runs the retrospective → applies process improvements (formerly SM) 10. **PO** grooms backlog for next sprint

**Tech lead discipline:**

- **Keep the TaskList full from `sprint: current`** (rolling budget-window model, #2751). The TaskList is no longer a per-sprint fixed list — it is a long, priority-ordered, **over-provisioned** queue auto-synced from every `sprint: current` + actionable (`ready`/`in-progress`) issue by `scripts/sync-current-tasklist.mjs` (wired into the `post-file-edit` + SessionStart hooks). To enqueue work, set an issue's `sprint: current` (and `priority:` high/medium/low → `[P1]`/`[P2]`/`[P3]` subject tag, `horizon:` xl/l/m/s → `[XL]`…`[S]` size tag); the sync upserts it. Keep more queued than a budget window can consume so it can't run dry; at rollover run `node scripts/freeze-sprint.mjs` to freeze the window. Empty queue = agents spin idle.
- **Reconcile the TaskList against issue-status every loop / session start** — `node scripts/reconcile-tasklist.mjs` (also wired as a SessionStart hook, `--quiet`). It reads the on-disk task stores (`~/.claude/tasks/{<session-uuid>,js2wasm}/*.json`) and reports every non-`completed` task whose **target issue** (first `#NNNN` in the subject) is already `done`/`wont-fix`; apply `TaskUpdate status=completed` for each (or `--apply` for a best-effort direct rewrite of dead-session task files). **Why this exists / root cause of stale tasks:** a task's flip to `completed` is a manual `TaskUpdate` nobody is structurally forced to make — (1) PRs merge _asynchronously_ in the queue after the authoring dev has moved on; (2) PO/lead **tracking-tasks** get completed via the _issue file_ (`status: done` in the impl PR — the source of truth) with no agent owning the TaskList twin; (3) tasks live in **two stores** (per-session + team `js2wasm`) that don't reconcile each other. So `issue status` (accurate) and `TaskList status` (stale) drift silently. The reconciler derives done-ness from the authoritative issue frontmatter and closes the loop. Devs should also flip their own task to `completed` at **enqueue** time (enqueue ⇒ will-merge), not "after merge" (by then they're gone).
- Batch doc/plan commits on main AFTER all pending agent merges, not between them (doc commits force agents to re-merge main)
- Complete post-merge issue cleanup (set `status: done` in sprint dir issue file, update dep graph) after each merge
- **Tag sprints**: `git tag sprint-N/begin` when starting a sprint, `git tag sprint/N` when it finishes. Sprint stats (duration, commits, issues) are auto-generated from tags during `build:pages`. Sprint tagging creates ONLY `sprint/N` (+ `sprint-N/begin`) tags — **never `vX.Y.Z` version tags**. Version tags are cut EXCLUSIVELY via `node scripts/release.mjs <x.y.z>` (lockstep `package.json` bump + reviewed release PR + tag-on-merge), never auto-tagged per sprint (44 legacy bare `v0.*` tags from the old convention caused publish-version drift — loopdive/js2wasm#389).
- **Prefer the dedicated PR-queue shepherd (below) over hand-shepherding the queue from the lead loop.** Hand-shepherding ad-hoc from the lead loop strands PRs and consumes lead attention; staff a standing shepherd so the lead only steps in on escalations. Since #2786 the **primary enqueuer is the server-side `auto-enqueue.yml` workflow** (its `workflow_run`-on-completion trigger, grace 0, enqueues every just-green PR within ~one workflow-startup). The lead/shepherd sweep is now a **backstop** alongside the ~30-min cron — it catches the rare stray the responsive workflow run misses (e.g. a PR the queue dropped on main-advance, or a green PR somehow not picked up). Still worth running every loop as belt-and-suspenders: sweep `gh pr list -R loopdive/js2wasm --state open` and **one-shot enqueue every CLEAN, non-`hold`, non-draft PR not already in the queue** (GraphQL `enqueuePullRequest`, **user PAT**, NEVER re-enqueue — the loop hazard is re-adding the PR already in the in-flight group, see `project_merge_queue_requeue_cancels_run`). **Held (`hold` label) or CI-failing / `BEHIND` / `DIRTY` PRs → add a high-priority `[CI-FIX]` task at the TOP of the TaskList** for the next dev to rebase/fix the gate failure (with full PR context). The authoring agent no longer enqueues (#2786) — the workflow does; the lead/shepherd sweep only mops up strays.

### PR-queue shepherd (standing role)

The merge queue needs a **dedicated owner**, not ad-hoc attention from the lead loop. Staff a **standing PR-queue shepherd** — a long-running teammate (team `js2wasm`, `isolation: "worktree"`) whose entire job is to drive open PRs to merged. Since #2786 the **`auto-enqueue.yml` workflow is the primary enqueuer** (responsive `workflow_run` trigger, grace 0); the shepherd is a **backstop sweep + queue-health owner** — it catches strays the workflow misses and, more importantly, monitors `merge_group` results and handles parks/ejections (which the workflow does NOT do).

The shepherd owns the queue end-to-end:

- **Sweep** `gh pr list -R loopdive/js2wasm --state open` every loop.
- **One-shot enqueue** every CLEAN, non-`hold`, non-draft PR not already in the queue, via the GraphQL `enqueuePullRequest` mutation with the **user PAT** (NOT `GITHUB_TOKEN`, which suppresses the `merge_group` event; NOT `gh pr merge --auto`, which silently no-ops on an already-green `CLEAN` PR). Verify the PR appears in the queue. **NEVER re-enqueue** — a single one-shot enqueue per PR. Re-adding a PR **that is in the in-flight merge group** cancels its run; appending a not-yet-queued PR to the tail is safe (re-verified 2026-08-02 — see `project_merge_queue_requeue_cancels_run`). A re-enqueue *loop* on the head is the hazard.
- **Check every open PR's checks every sweep, not just enqueue candidates (#3121 gap).** A dev correctly goes quiet in CI-wait per its own protocol; if CI resolves (pass OR fail) while it's idle, nothing wakes it back up — a fire-and-forget background watcher inside a dev's own turn does not reliably survive that dev's session going idle. Don't treat "not CLEAN" as "not my problem": `BEHIND`/`BLOCKED` with no failing check is legitimately "wait for auto-refresh," but any PR with a `FAILURE`-conclusion required check is a real finding. If it's not your own PR, diagnose (fetch the job log, name the specific gate + file) and message the owning dev directly with the fix — don't fix it in their branch yourself, and don't just skip it either. This was caught manually by the tech lead on 2026-07-16 after #3114/#3115/#3118 sat failing, unnoticed, for a while.
- **Monitor `merge_group` results** and handle parks/ejections per the auto-park rules below.
- **Escalate real regressions** to the lead (regressions >10, single bucket >50, or a genuine merged-baseline regression behind a bot park-hold); ordinary drift/flake is the shepherd's to resolve, not an escalation.

The lead steps in only on the shepherd's escalations, and runs the sweep itself only when no shepherd is staffed.

#### Auto-park handling rules (`auto-park-bot:merge-group-failure`)

When **`github-actions[bot]`** adds a `hold` label together with an **`auto-park-bot:merge-group-failure`** comment, that marks a **REAL merged-baseline regression** caught only in the `merge_group` re-validation (test262 "merge shard reports" / `quality` / standalone-floor) — a class of failure that **PR-level checks DO NOT catch** (the PR was green). Treat a bot park-hold as a signal of a genuine regression, not noise:

- **(a) NEVER remove a bot park-hold without first diagnosing the cited failed run.** Read the run the comment points at and identify the failing gate before touching the label.
- **(b) A bot park-hold is NOT a dev's own manual label — don't conflate the two.** A dev's own `hold` (a deliberate WIP/do-not-merge pause it set) is different from a bot park-hold (an automated regression flag). Removing a bot park-hold thinking it was your own manual label re-admits a regressing PR (a dev did exactly this on #1960 — removed the bot's park-hold believing it was its own).
- **(c) Before re-enqueueing a parked PR, distinguish real-regression vs flake/collateral** by pulling the regressed-test delta (the merged-report jsonl diff / failed-shard report). A real regression must be fixed on the branch first; only a confirmed flake/collateral may be re-admitted.
- **(d) NEVER re-enqueue in a loop.** Re-adding a PR that is in the in-flight merge group rebuilds that group and CANCELS its run (narrower than the old blanket claim — re-verified 2026-08-02, see `project_merge_queue_requeue_cancels_run`). Re-enqueue at most once, after a confirmed fix or flake determination.
- **(e) A held PR is SKIPPED by the `auto-enqueue` backstop** — so a wrongly-held PR, or a legitimately-parked-but-unaddressed one, **strands** until a human/shepherd resolves it. Don't assume the cron will recover a held PR; it won't.

### Sprint planning (PO + Architect + Tech Lead)

Sprint planning is a collaborative process, not a solo tech lead activity:

1. **PO validates** — smoke-tests top candidate issues against current main, closes already-fixed ones
2. **PO prioritizes** — orders by value (impact × unblocking potential), not just CE/FAIL count
3. **PO routes hard issues to Architect** — any issue marked `feasibility: hard` or touching core codegen gets an implementation spec before dev dispatch
4. **Architect specs** — reads compiler source, writes `## Implementation Plan` in the issue file with exact functions, line numbers, Wasm patterns, edge cases
5. **PO creates tasks** — via `TaskCreate` with full context, referencing architect specs where available
6. **Tech lead dispatches** — assigns tasks to devs, manages the merge queue

### Agent work dispatch

- **Two lanes run concurrently — partition the queue + gate every dispatch ([plan/method/lane-partition.md](plan/method/lane-partition.md)).** The queue is split by goal (Lane A = lead/opus: runtime-eval, error-model, dogfood, core-semantics, **all CI/infra/pipeline**; Lane B = fable/porffor: backend-agnostic-ir, ir-full-coverage, Porffor #3288, value-rep, standalone-gap #2860; broad goals = claim-first-wins). **Before dispatching ANY agent on #N, run `node scripts/pre-dispatch-gate.mjs <N>`** (exit 0 clear / 1 STOP / 2 caution). It checks merged-ness from the issue FILE on main, open PRs, the `origin/issue-assignments` claim ref, issues that CITE #N, and — the check the hand-run version lacked — **issues that share #N's distinctive title terms**, plus those issues' own claims. Any BLOCKER ⇒ adopt/close/route, do NOT start a parallel impl.
  - **Do NOT rely on `git log --grep="#N"` alone.** PR numbers and issue ids share ONE sequence, so it matches `Merge pull request #N` and reads as "already merged" when it is not (hit 2026-07-25 on #3571).
  - **It caught nothing that day because the old gate could not.** All three hand checks PASSED for #3571 while #3603's S1 slice was the same work, actively claimed by another lane — overlap by _idiom_, not by id, with neither issue citing the other.
  - **REMAINING BLIND SPOT the script cannot close:** a lane that has started but not yet claimed or pushed leaves no trace in main, open PRs, or the claim ref. **Claim at DISPATCH time** (`claim-issue.mjs <id> <agent> --branch <b>`), not at first push, or the next dispatcher is unprotected. `claim-issue.mjs` exit 0 is advisory (shared slug). Push branches to the **`fork`** so GitHub rejects dup PRs. This is the fix for the 2026-07-17 duplication (#3310/#3311/#3341/#3308 re-implemented by both lanes).
- **Tech lead populates TaskList** — devs self-serve from it. No per-task dispatch messages needed.
- **Owner pins + scope are how the auto-dispatcher is steered.** The native agent-teams auto-dispatcher only auto-offers tasks with **no `owner`**, and it does **not** read role. So the tech lead encodes routing in two places the dispatcher/agents actually honor:
  - **Set `owner` immediately** on any task pinned to a specific agent (e.g. an in-flight `[CONFLICT]` for a named senior-dev, or a one-PR migration). An ownerless `in_progress` task is the #1 mis-route cause — the dispatcher re-offers it. Reconcile (`TaskUpdate status=completed` the moment a PR merges) so stale entries never get re-offered.
  - **Tag role/scope in the subject** so agents can self-gate: `[SENIOR-DEV ONLY]`, `[CONFLICT]` (senior-dev), `arch(...)`/`[ARCH]` (architect), `po:`/`[PO]` (product owner), `[PARKED …]`/`[PAUSE]` (not ready). Plain `fix(...)`/`refactor(...)`/`dev:` = developer-claimable. Agents skip tasks owned by others or tagged outside their lane (see the pre-claim gate in `developer.md`/`senior-developer.md`).
- **Dev loop**: **check budget fit** (`node scripts/budget-status.mjs --pick --role developer --model <your-model> --as ttraenkler/<your-name>`) → claim an adequately-sized task from TaskList → **branch from latest `origin/main` and push the branch to origin immediately (the moment the task goes in-progress)** → implement → push PR → wait for CI → self-merge if green → mark completed → claim next task.
- **Always pass your identity to `--pick` (#3965).** Without `--role`/`--model`/`--as` the picker cannot filter by lane and says so; with them it also excludes issues already claimed on the `issue-assignments` ref, read **live** at the moment of the call. Every exclusion is printed (`skipped #N: claimed by … since …`) and the funnel counts are reported, so "no picks" is never confusable with "queue empty". If it exits **6** with `claim ref: UNREADABLE`, the recommendations are UNFILTERED and may already be claimed — re-run rather than claiming from that list. Measured before this landed: 5 of 5 XL suggestions were unusable for an Opus-lane developer, and one misdirected a real dispatch onto #2949, actively held by another lane.
- **Pull-time budget/parallelism awareness (#2751)**: before claiming, run `node scripts/budget-status.mjs --pick`. It reports the **remaining token budget**, the current **parallelism** (active agents), the **per-agent share**, and the largest task **horizon** (`XL`/`L`/`M`/`S`, from the issue's `horizon:` field, shown as a `[XL]`…`[S]` subject tag) you should pull. Claim the highest-priority task whose horizon fits. This prefers **long-horizon tasks at the start of a budget window** (large per-agent share → big rocks first) and avoids starting an oversized task late, where it would strand at the window's budget freeze; `S` tasks remain available as tail filler. With more agents active, each share shrinks → pull smaller tasks. (Budget source: the statusline caches the weekly rate-limit — the "wkly" % and "d left" it displays — to `~/.claude/js2wasm-budget.json`, which `budget-status`/`freeze-sprint` read automatically; `JS2WASM_BUDGET_REMAINING_PCT`/`JS2WASM_BUDGET_PCT` override it; with neither it assumes a fresh window.)
- **Pull-main-first + push-on-in-progress (the branch is a live sync point)**: when an agent moves a task to **in-progress** it MUST (1) pull/merge latest `origin/main` into its worktree branch FIRST — never start on a stale base — and (2) **push that branch to origin immediately** (an initial / WIP / grounding commit is fine). Do **not** work local-only for a long window before the first push: an unpushed branch is invisible, so staleness and collisions hide until the PR finally surfaces (e.g. a ~30-min local-only window before the PR appeared). Pushing early makes the branch a **live sync point** other agents can see and rebase against, and makes the assignment concrete. Keep merging `origin/main` as work proceeds. This is additive to — not a replacement for — the merge-before-PR step and the floor/CI discipline below.
- **Dev self-check, then stand down — the SERVER-SIDE workflow enqueues (#2786)**: the gate is GitHub's checks API, not any committed feed. When the PR's **required checks are all green** (`gh pr checks <N>` / `gh pr view <N> --json statusCheckRollup,mergeStateStatus,isDraft,labels` — authoritative list in `docs/ci-policy.md` §7 — **six**, re-verify with `gh api repos/loopdive/js2wasm/rules/branches/main --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'`: `cheap gate (main-ancestor + lint)`, `quality`, `merge shard reports`, plus `equivalence-gate`, `check for test262 regressions`, `cla-check`; `linear-tests` is NOT required, #3934), `mergeStateStatus == CLEAN`, the PR is not a draft and carries no `hold` label — the dev marks the task completed and **stands down. The dev does NOT enqueue.** The single enqueuer is now the server-side `.github/workflows/auto-enqueue.yml` (`scripts/enqueue-green-prs.mjs`): its `workflow_run`-on-completion trigger fires right after the required-check workflows finish, and with the grace window now **0** (#2786) it enqueues every just-green PR within ~one workflow-startup — without depending on any agent surviving. **Why the change:** the old "dev self-enqueue once" model relied on a backgrounded CI watcher that **died with the dev process** on stand-down, so green PRs stranded un-enqueued (#2225, #2247). Moving enqueue to the GitHub Actions workflow — the one actor that is long-lived and outside agent lifecycle — closes that hole. The merge queue still re-validates required checks on the merged state (`merge_group`), and `auto-park` (#2547) `hold`-labels any PR that fails the re-run. **NEVER enqueue or re-enqueue from a dev/agent** — re-enqueue **loops** on the queue head caused the ~3.5h cancellation churn of 2026-06-20 (re-adding the PR that is in the in-flight group rebuilds it and CANCELS its run; the workflow that drove that loop, `queue-unstick.yml`, has since been deleted — memory `project_merge_queue_requeue_cancels_run`, re-verified 2026-08-02); the workflow's single trailing-add never loops. See `.claude/skills/dev-self-merge/SKILL.md`. **Backstops (not the mechanism):** the workflow's ~30-min cron and the tech lead's per-loop open-PR sweep catch the rare stray the responsive run misses (e.g. a PR the queue dropped on main-advance). Manual `node scripts/enqueue-green-prs.mjs` forces a sweep now. Drafts and PRs labelled `hold`/`do-not-merge`/`wip` are never auto-enqueued. **Security:** the workflow's author-trust gate is now load-bearing — it enqueues only OWNER/MEMBER/COLLABORATOR PRs; external-contributor PRs require a deliberate maintainer enqueue plus a green `cla-check`.
- **The per-PR CI feed `.claude/ci-status/pr-<N>.json` is RETIRED — do not look for it, wait on it, or gate on it.** The writer workflows (`ci-status-feed.yml`, `ci-status-basic.yml`, `ci-status-pending.yml`) are disabled (`workflow_dispatch`-only stubs); the newest file on `main` is from the PR-471 era and the directory was last touched 2026-07-05. A current PR will NEVER get a feed file — treating its absence as "CI still in flight" strands you forever. Query the checks API directly (`gh pr checks <N>`, `gh pr view <N> --json statusCheckRollup,mergeStateStatus`).
- **PR-level `check for test262 regressions` (and `merge shard reports`) green is a DESIGNED no-op on `pull_request` — NOT conformance evidence.** The heavy test262 shard matrix is merge_group-only (#2519 slim-down; #3431 mg matrix; #3448/#3467 per-SHA baseline reuse), so on a PR both jobs green-skip with `SHARDS_RAN: false` — their logs literally say "shards intentionally skipped" / "no merged test262 report to diff". Never read a green PR-level regression check as "this PR causes no regressions". The REAL regression/trap gates — the #3467 per-SHA-merge-base regression diff, the catastrophic guard (#1668), the standalone floor/net guards (#1897/#2097) — run in the **`merge_group` re-validation on the merged state**. That is why `auto-park` (#2547) exists and why a fully-green PR can still fail the queue and be parked with a bot `hold` label.
- **Silence vs. pings is the dev health signal.** A dev correctly waiting on CI runs a **background watcher** and goes quiet (see `developer.md` CI-wait protocol) — silence is the healthy state, do NOT poke a silent dev. By contrast, **repeated `idle_notification` pings mean the opposite**: a dev with no background watcher idling in-context, or one wedged (e.g. a tool-param failure loop). Treat a stream of idle pings as an escalation/health signal — redirect to unowned work, send `shutdown_request` if idle, or recognize a wedged agent (it pings but can't ack shutdown; clears on lead-session end). Don't mistake an agent waiting on an already-merged PR for one doing work — reconcile the TaskList (`completed` on merge) so it learns its PR landed.
- **Devs contact tech lead for**: TaskList empty, blocked >30 min, CI ESCALATE result (immediately — do not wait to be asked), net < 0 result.
- Dev agents do NOT run full test262 locally — scoped checks only, CI validates conformance.

### Controlling agents

- **Pause (between tasks)**: create a task with `[PAUSE]` in the subject. Agents stop when they reach it and wait idle.
- **Pause (immediate)**: send `PAUSE` via SendMessage. Agent stops current work, kills running tests, waits idle. Send `RESUME` to continue.
- **Suspend**: send `SUSPEND` via SendMessage. Agent commits WIP, writes `## Suspended Work` to the issue file (worktree path, branch, resume steps), then **terminates**. A new agent resumes later from the issue file.
- **Resume suspended work**: assign the issue to a new dev agent. It reads `status: suspended` and `## Suspended Work` in the issue file, enters the existing worktree, continues.
- **Shutdown**: send `{"type": "shutdown_request"}` via SendMessage. Before sending: (1) confirm with user if they're talking to the agent, (2) ask the agent to write a context summary to `plan/agent-context/{name}.md` first. See `plan/method/agent-sessions.md` for the summary format.
- **Session registry**: track active agent sessions in `plan/method/agent-sessions.md` so sessions can be resumed. When respawning, pass the context summary in the spawn prompt.
- **Orphaned agents** (lost team context after crash): check worktrees for commits (`git -C <wt> log --oneline main..HEAD`) and uncommitted work (`git -C <wt> diff --stat`). Save any work, then kill the process. Write `## Suspended Work` in the issue file manually with the worktree path and state.

### Merge protocol (PR + CI, devs self-merge)

**PR bodies link issues to the WEBSITE issue page, never bare `#NNNN`**
(project-lead order, 2026-08-16). A bare `#NNNN` in a PR body autolinks to
GitHub's PR/issue numbering — which shares one sequence with PR numbers, so it
points at an unrelated PR, not the plan-file issue. Write
`[#NNNN](https://js2wasm.loopdive.com/dashboard/issue.html?slug=<file-basename-without-.md>)`
(e.g. `?slug=4491-es5-defineproperty-mop-residual`) for every issue reference.
Commit messages keep plain `#NNNN` (tooling greps them); this rule is for PR
bodies and PR-visible comments.

**ALWAYS open a PR on `loopdive/js2wasm` when a task is done — do not wait to be
asked** (project-lead decision, 2026-08-01). Finished work that sits on a pushed
branch with no PR is invisible: it is not in the merge queue, `auto-enqueue`
never sees it, and the next session has no way to know it is waiting. Opening the
PR is part of finishing the task, not a separate request.

- This **overrides** any ambient "do not create a pull request unless the user
  explicitly asks" default an agent harness may carry. If your environment
  states that default, this project instruction wins.
- It does **not** override the rest of this protocol: still branch from
  `origin/main`, still push the branch to the **`fork`** remote, still target
  **upstream** (`gh pr create -R loopdive/js2wasm --head ttraenkler:<branch>`), and
  still let the server-side `auto-enqueue.yml` do the enqueueing. Opening a PR
  is not merging one.
- Group per the docs-only rule immediately below — "always open a PR" means
  every finished task ends in *a* PR, not that every task gets its *own* PR.

**Every open PR must REACH the merge queue — verify it, do not assume it**
(project-lead decision, 2026-08-01). Opening the PR is not the end of the task;
a PR that never enters the queue is as invisible as one that was never opened.
Before standing down, check `mergeStateStatus`:

- **`CLEAN`, not draft, no `hold`** → `auto-enqueue.yml` owns it. Nothing to do
  but confirm it lands in the queue.
- **`UNSTABLE`** → it will **never** be auto-enqueued. `auto-enqueue` takes only
  `{CLEAN, HAS_HOOKS}`; `UNSTABLE` is deliberately excluded (#3878/#3904),
  so a PR with every REQUIRED check green can sit forever because one
  non-required check is red. Re-run the failed job to get back to `CLEAN`.
- **`BEHIND`/`DIRTY`** → merge `origin/main` in and push.
- **`hold` label from `github-actions[bot]`** → a real merged-baseline
  regression. Diagnose the cited run first; never just remove the label.

**This does NOT license enqueueing from a dev/agent, and it never licenses
RE-enqueueing.** The single enqueuer is the server-side workflow — and the
reason is **#2786**: a dev's backgrounded CI watcher dies on stand-down, so
green PRs stranded un-enqueued. That justification stands on its own. The
separate cancellation hazard is narrower than it was once written (re-verified
2026-08-02, `project_merge_queue_requeue_cancels_run`): **re-adding a PR that is
in the in-flight merge group cancels its run; appending a different PR to the
tail does not.** "Always get PRs into the queue" is satisfied by making them
*enqueueable* and confirming they were taken — see the shepherd's one-shot
backstop rules under "PR-queue shepherd" for the only sanctioned manual enqueue,
which is one-shot, PAT-authenticated, and never repeated.

**Docs-only changes go in ONE open PR — check before opening a second.** If a
docs-only PR is already open (issue files under `plan/issues/`, `plan/` notes,
`docs/`, README-level edits), **push your docs commits onto that PR's branch
instead of opening another**. Only open a new docs PR when none is open.

- "Docs-only" means the diff touches no `src/`, `tests/`, `scripts/`,
  `.github/` or `benchmarks/` code. A change that touches code is a normal PR
  and follows the rest of this protocol, even if it also edits docs.
- **Code PRs still carry their own issue-file edits.** An implementation PR
  that sets `status: done` on the issue it closes keeps that edit in the code
  PR — see the issue-status lifecycle below, where the self-merge path
  deliberately sets `done` in the impl PR. Do NOT split that out into the docs
  PR; it would orphan the issue exactly the way `in-review` does.
- Rationale: docs PRs are individually trivial to review and collectively
  noisy. A session that files a dozen issues should cost one review, not
  twelve. Grouping also keeps the merge queue free for changes that actually
  need the gates.
- To find the open one: `gh pr list -R loopdive/js2wasm --state open --label docs`,
  or scan open PR titles for a docs prefix. If you cannot reach `gh`, ask the
  tech lead rather than opening a speculative second PR.

**Authoritative ruleset**: see [`docs/ci-policy.md`](docs/ci-policy.md) for
the required-checks list, reviewer rules, force-push policy, linear-history
mode, and the admin script (`scripts/enable-branch-protection.sh`) that
applies them. Required checks today are **six** (`docs/ci-policy.md` §7):
`cheap gate (main-ancestor + lint)`, `merge shard reports`, `check for test262
regressions` (all test262-sharded.yml — the latter two are DESIGNED green
no-ops at PR level, see the note under "Agent work dispatch" above),
`quality`, `equivalence-gate`, `cla-check`. The dev-self-merge skill is a UX
layer on top — GitHub branch protection is the hard block.

- **`linear-tests` is NOT required** — it was documented as required here and
  in `docs/ci-policy.md` until 2026-08-01 and has never been in the ruleset
  (#3934). It still runs in `ci.yml`; it just does not gate.
- **Verify, don't trust the date.** Enforcement is a repo **ruleset**, not
  classic branch protection (the classic endpoint answers `404 Branch not
  protected`):
  ```bash
  gh api repos/loopdive/js2wasm/rules/branches/main \
    --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
  ```
- **A SKIPPED required check SATISFIES the requirement.** A job skipped by its
  own `if:` still publishes a check run (conclusion `skipped`) and branch
  protection accepts it — on a docs-only PR `equivalence-gate` skips via the
  path filter and the PR is still `CLEAN`. So do **not** decide readiness by
  counting six `SUCCESS` conclusions in `statusCheckRollup`; you will not find
  them and will wrongly conclude the PR is not ready. Use `mergeStateStatus`.
  (Different thing entirely: a **workflow**-level `paths:` skip creates no check
  run at all, leaving the context "Expected" forever — that is what
  `test262-pr-stub.yml` exists to prevent.)
- **`auto-refresh-prs` SKIPS DRAFTS.** A draft PR is never rebased and silently
  rots behind `main` (PR #3919 was 177 commits behind). Draft is not a pause
  button — it opts the PR out of branch maintenance.

**Devs do NOT run local test262.** Branch validation happens in GitHub Actions:

0. **At task START / in-progress**: branch from latest `origin/main` and **push the branch to origin immediately** (live sync point — see the "pull-main-first + push-on-in-progress" rule above). Don't work local-only for a long window before the first push.
1. **Dev merges `origin/main` INTO their branch** — `git merge origin/main` (not rebase), BEFORE opening a PR (and keep re-merging as `main` advances)
   - Planning artifact conflicts (`dashboard/`, `plan/`, `public/`) → `git checkout --theirs` + regen
   - Compiler source conflicts (`src/**/*.ts`) → create a priority `[CONFLICT]` TaskList item; assign to `senior-developer` (Opus); do NOT resolve inline
2. **Dev runs scoped local checks** — issue-targeted compile/run checks for confidence
3. **Dev pushes the branch to the `fork` remote and opens a PR against `main`** — PRs MUST target the **upstream** repo (`loopdive/js2wasm`), never the fork (`ttraenkler/js2`). **Push the branch with `git push fork <branch>` FIRST**, then **always pass `-R loopdive/js2wasm --head ttraenkler:<branch>` to `gh pr create`** — the container's gh 2.23 ignores the pinned default (`remote.upstream.gh-resolved=base`) for `pr create` and silently opens the PR on the fork (verified 2026-06-11: fork PRs #6/#7 both had to be closed as misrouted). After creating, verify the PR URL starts with `github.com/loopdive/`. Note the pre-push integrity gate can choke on the fork/upstream divergence. `--no-verify` is NO LONGER sanctioned (project-lead order, 2026-08-22) — fix the gate's complaint, or push from a branch whose base the gate can resolve; see "Hooks and ratchet gates" above.
   - **Push to `fork`, not `origin` — this is load-bearing, not cosmetic (#3343-era, 2026-07-17).** `origin` is **upstream** (`loopdive/js2wasm`) and `push.default=current`, so a plain `git push` puts the branch on **upstream**. `gh pr create --head ttraenkler:<branch>` then fails with "No commits between" (the branch isn't on the fork), and the tempting workaround — dropping the `ttraenkler:` prefix — opens an upstream-head PR. That is how a **duplicate PR** survives: **two lanes run concurrently** (this checkout + a fork-origin lane), and when the same branch NAME exists in two different head repos, GitHub **cannot** apply its normal same-head+base rejection. Both PRs coexist and the work is done twice. Pushing to `fork` restores that free rejection. Do NOT rely on `claim-issue.mjs` to prevent this — it returns **exit 0 to both lanes** (they share the `ttraenkler/senior-dev` slug); the lock is advisory. Before starting an issue, also run `git log origin/main --grep="#<id>"` to check it isn't already merged. A PR that goes **DIRTY on files it itself touched** is a duplicate-merge smell, not an ordinary conflict.
4. **Dev blocks on CI** — polls `gh pr checks <N>` every 30s for ~2 min wall time, in-context (Sonnet idle is nearly free). Use `gh run watch <run-id>` or a `while ! done; do sleep 30; done` loop with a max timeout (~10 min before noting unusual wait, ~20 min before escalating).
5. **On CI completion**:
   - **All required checks green AND `mergeStateStatus == CLEAN`** → run `/dev-self-merge`; if MERGE, mark the task completed and **stand down** (proceed to step 8). The dev does NOT enqueue — the server-side `auto-enqueue.yml` workflow enqueues on CI-completion (grace 0, #2786). NEVER enqueue or re-enqueue from a dev
     - **`CLEAN` is load-bearing, not decoration (#3878, #3904).** A red **non-required** check drives `mergeStateStatus` to **`UNSTABLE`**, and `auto-enqueue` enqueues only `{CLEAN, HAS_HOOKS}` — `UNSTABLE` is _deliberately_ excluded (`scripts/enqueue-green-prs.mjs`), because it once let red PRs into the queue. So a PR can have **every required check green and never be enqueued, indefinitely**. Standing down on "required checks green" alone is exactly the stranding condition. If you see `UNSTABLE` with only non-required checks red, **re-run the failed job** (`gh run rerun <run-id> -R loopdive/js2wasm --failed`) to get back to `CLEAN` — do not enqueue, and do not stand down assuming the workflow will pick it up.
   - **Drift detected** (mergeable_state becomes "behind") → `git merge origin/main` in the worktree, resolve conflicts with full PR context, push again, loop back to step 4
   - **CI failure** (any required check failed) → diagnose with full PR context (the agent KNOWS what it changed), fix locally, push again, loop back to step 4
6. **If regressions per `/dev-self-merge`**: dev fixes on branch, pushes again, loops back to step 4
7. **Escalate to tech lead** only when: regressions >10, single bucket >50, or judgment call needed. **Drift and ordinary CI failures are NOT escalations — dev handles them with full context.**
8. **After merge**: dev marks task `completed`, then **syncs the shared checkout** — `bash scripts/sync-workspace-main.sh` fast-forwards `/workspace` to `origin/main` (no-op when clean+current, refuses a dirty tree). Agents work in worktrees, so `/workspace` never advances on its own and silently rots behind `main` (it hit 135 commits behind on 2026-05-29, which made the statusline report a stale sprint off the old local tree). Always pull `/workspace` from `origin/main` after a PR merges. Then claim next task.
9. **Never use `git merge` on main directly.** All merges go through PRs + CI.
10. **Never rebase.** Merge preserves history and is safely reversible.
11. **Public `main` is append-only — never force-push or rewrite published history** (it breaks every external clone/fork). Fix bad commits forward via revert PRs. See `docs/ci-policy.md`.

### Issue status lifecycle

The issue frontmatter `status:` field tracks where an issue is, set by whichever agent drives the transition:

- `ready`/`in-progress` → dev starts work (sets `in-progress` when claiming).
- **Self-merge path (the common case)** — when a dev opens the implementation PR for an issue they will self-merge, the **implementation PR sets `status: done` directly** (with `completed:`), not `in-review`. By the time the merge queue lands the PR, the issue _is_ done, and there is no separate observer who can make a post-merge commit. Setting `in-review` here orphans the issue: the dev can't flip it to `done` afterward from `/workspace` once the queue lands the PR. So the impl PR carries the final status. (See #1602/#1603/#1606 — stuck at `in-review` because of exactly this.)
- **`in-review`** — reserved for the **handoff/external case**: the PR author is NOT the merger (e.g. work handed off to another agent, or an external contributor's PR). Set when the PR opens; flipped to `done` by whoever observes the merge.
- **`done`** — true once the **PR merges**. In the self-merge path it's already set in the impl PR; in the handoff/external case it's set by the merge observer. A merged PR ⇒ `done`. Never leave a merged issue at `in-review`.

### Issue completion (post-merge)

1. Set `status: done` in the issue file at `plan/issues/<id>-<slug>.md`
2. Update `plan/log/dependency-graph.md` — remove/strikethrough completed issue
3. Update `plan/issues/backlog/backlog.md` if the issue was listed there

<!-- AUTO:conformance-start -->

**test262 conformance**: 33,282 / 43,621 (76.3 %)

<!-- AUTO:conformance-end -->

### Sprint History

- **Sprint 1**: 550 → 1,509 pass (+174%), 167 fail, 5,700 CE. Issues #138-#173.
- **Sprint 2**: 12 branches, 18 issues (#207-#224). Key: destructuring hoisting (~1200 CE), string comparison, .call(), member increment/decrement, labeled break. Equivalence tests: 86 → 170.
- **Sprint 3**: 32 issues (#225-#256). Target: 0 runtime failures, ~1,500 CE reduction.
- **Sprint 4+**: Transitioned to dependency-driven execution. See `plan/log/dependency-graph.md`.
- **2026-03-19 session**: 53 issues in one session. WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer support, and extensive test262 improvements.
