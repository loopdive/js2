# js2wasm

TypeScript-to-WebAssembly compiler using WasmGC.

## Running Tests
- Run all tests: `npm test` (vitest — may OOM on full suite in constrained envs)
- Run a specific test file: `npm test -- tests/issue-277.test.ts`
- Run equivalence tests only: `npm test -- tests/equivalence.test.ts`
- Test262: `pnpm run test:262` — vitest-based runner, creates its own worktree, writes to `benchmarks/results/`. Default 3 workers.
- **Local CI on Claude Code on Web** (or any 16GB+ container): `JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh` — idempotent pnpm install + test262 submodule init, then `pnpm run test:262` with `COMPILER_POOL_SIZE=$(nproc)`. Baseline 2026-05-20 on a 4-core/16GB container: ~68 min wall-clock, ~2.8 GB peak RAM. CI sharded is still faster end-to-end; this is for in-container validation runs. See `plan/issues/1522-race-local-test262-vs-ci.md` for the scoped pre-flight design.

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
- **Push safety**: `.git/config` sets `push.default=current` — `git push` always pushes to the remote branch matching the local branch name, regardless of upstream tracking. This prevents the `git worktree add -b <branch> origin/main` trap where the inherited tracking ref routes pushes to origin/main.
- **Worktree cleanup after merge**: after a dev self-merges their PR, they remove their own worktree (`git worktree remove /workspace/.claude/worktrees/<branch>`) before claiming the next task. Tech-lead only removes worktrees for suspended or abandoned branches.

## Architecture Principles
- **Dual-mode: JS host optional** — the compiler supports two modes: JS host mode (uses host imports for performance/completeness) and standalone mode (pure Wasm, no JS runtime). New features should have Wasm-native implementations for standalone mode; JS host imports are acceptable as a fast path when a JS runtime is available. Don't add new host imports without a standalone fallback.
- This follows the pattern of #679 (dual string backend) and #682 (dual RegExp backend).
- **Two orthogonal axes in codegen** (see #1527):
  - **Backend lowering**: `src/codegen/` (WasmGC) vs `src/codegen-linear/` (linear memory). These are **alternatives, not one superseding the other** — the choice depends on target (browser/WasmGC vs WASI/linear) and tradeoffs. Both stay.
  - **Front-end**: direct AST→Wasm (legacy, accumulated hacks) vs IR (`src/ir/`, typed representation). IR **replaces the hacks**; it does **not** compete with the backend choice. IR adopts AST node kinds step by step, only for parts that do not yet need to decide between linear and WasmGC lowering. IR-path failures currently demote to a warning channel (#1530 phases this fallback out).
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
- Sprints: `plan/issues/sprints/{N}.md` — planning, task queue, results, retrospective (living doc updated during sprint)
- Issues: **flat** at `plan/issues/<id>-<slug>.md` (#1616). The on-disk
  location is stable; sprint membership and status live **only** in
  frontmatter, never in the directory:
  - `sprint: <N>` numbered sprint · `sprint: 0` pre-sprint history ·
    `sprint: Backlog` unscheduled
  - `status: ready|in-progress|in-review|done|wont-fix|blocked|backlog`
  - `sprints/{N}.md` (the sprint doc) lives directly under `sprints/`; the
    numbered issue files are flat under `plan/issues/`. See
    `plan/issues/SCHEMA.md`.
- Dependency graph: `plan/log/dependency-graph.md`
- Goals (DAG): `plan/goals/goal-graph.md` — high-level goals with dependencies; issues belong to goals
  - Goals are not sequential milestones — they form a DAG and multiple can be active in parallel
  - Only work on issues from goals whose dependencies are met (active/activatable)
  - Legacy milestones in `plan/milestones/` are superseded by goals

## Key Patterns
- `VOID_RESULT` sentinel in expressions.ts — `InnerResult = ValType | null | typeof VOID_RESULT`
- Ref cells for mutable closure captures — `struct (field $value (mut T))`
- FunctionContext must include `labelMap: new Map()` and `isGenerator?: boolean` in all object literals
- `as unknown as Instr` for Wasm ops not yet in the Instr union (f64.copysign, f64.min/max) — 158 occurrences, tracked for cleanup
- f64.promote_f32 IS now in the Instr union (added for Math.fround)
- `return_call` / `return_call_ref` for tail call optimization in return position
- Peephole pass removes redundant `ref.as_non_null` after `ref.cast`
- Native type annotations: `type i32 = number` → emits i32 locals and i32 arithmetic
- `nativeStrings` flag decouples WasmGC string arrays from fast mode (auto-enables for WASI)

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
- Skip filters: eval, with, Proxy, SharedArrayBuffer, Temporal, WeakRef, FinalizationRegistry, dynamic import(), top-level-await
- Many previously-skipped features now supported: TypedArray, DataView, ArrayBuffer, delete, async, generators, for-of
- Issues #618-#634 cover current failure patterns (from 2026-03-19 error analysis)
- parseInt import: `(externref, f64) -> f64` with NaN sentinel for missing radix

### Baseline files (which is authoritative?)

| File | Lives in | Authoritative for | Refreshed by | Validated by |
|------|----------|-------------------|--------------|--------------|
| `benchmarks/results/test262-current.json` | main repo (committed, ~kB) | landing-page summary, pass/total badges | `test262-sharded.yml` `promote-baseline` job (every push to main) | (none) |
| `test262-current.jsonl` (in `loopdive/js2wasm-baselines`) | separate repo | PR regression-gate baseline (fetched fresh per CI run); `dev-self-merge` Step 4 bucket-by-path regression analysis (#1528) | `test262-sharded.yml` `promote-baseline` job (every push to main) | `test262-baseline-validate.yml` spot-checks 50 random `pass` entries on every PR (#1218); fails the PR if any sampled entry no longer passes on main HEAD |
| `benchmarks/results/playground-benchmark-sidebar.json` | main repo (committed, ~1KB) | landing-page sidebar wasm/js perf chart; `benchmark-refresh.yml` regression diff baseline | `benchmark-refresh.yml` auto-commit step on every push to main (#1216) | (none) |

**Baseline JSONL is no longer committed to the main repo (#1528).** It lives only in `loopdive/js2wasm-baselines` and is fetched on demand by `scripts/fetch-baseline-jsonl.mjs` to `.test262-cache/test262-current.jsonl` (gitignored). Consumers (validator, `dev-self-merge` bucket analysis, regression triage, sprint wrap-up harvest) either call the helper directly or accept the cache path via fallback. This removes the ~15 MB blob from every clone and retired the dedicated `refresh-committed-baseline.yml` workflow.

To validate the baseline on demand, run `pnpm run test:262:validate-baseline` — the validator calls the fetch helper itself, then spot-checks 50 random `pass` entries against current HEAD (uses a deterministic seed; pass `PR_NUMBER=N` to reproduce a specific CI run, or `SAMPLE_SIZE=10 SEED=12345` for a quicker check). Set `SAMPLE_SIZE=50` to match CI exactly. The validator fails fast on the first 5 most-affected entries with a pointer to the fetch helper for forcing a refresh.

## IR Fallback Budget (#1376) — being phased out (#1530)

The IR retirement gate `pnpm run check:ir-fallbacks` walks every `.ts` file
under `playground/examples/` with `trackFallbacks: true` and aggregates
rejection reasons against `scripts/ir-fallback-baseline.json`. CI fails when
any **unintended** bucket grows.

**Direction**: this budget is a transitional safety net, not a permanent
ceiling. #1530 prioritises ratcheting the unintended buckets to zero so the
IR path becomes the only path for the affected node kinds. Once a bucket
hits zero, the rejection reason gets added to `STRICT_IR_REASONS` in
`src/codegen/index.ts`, which promotes any future regression of that
reason from a silent legacy fallback to a hard compile error. Per-bucket
ownership + target dates live in `plan/log/ir-adoption.md`.

| Reason                       | Category   | Reduces with                         |
|------------------------------|------------|--------------------------------------|
| `body-shape-rejected`        | unintended | #1370 (class methods), #1373 (async) |
| `external-call`              | unintended | #1371 (whitelist Math.* / parseInt)  |
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

**Ratchet** (#1530): `pnpm run check:ir-fallbacks -- --update-on-decrease`
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
- The role accumulates context that's hard to capture in a skill (e.g., SM during retro discussion)

**Pick the right spawn mode (this matters for lifecycle):**

- **Teammates** (`Agent` with `team_name: "js2wasm"`) — long-running, lead-orchestrated. Use for **dev agents** that pull from the TaskList, receive mid-task redirects via SendMessage, or need to coordinate file locks with other agents. Teammates do **not** self-terminate — the tech lead sends `shutdown_request` when they're idle.
- **Subagents** (`Agent` without `team_name`) — fire-and-forget. Use for **one-shot architects, research agents, spec writers** that read inputs, write an output file, and return a summary. Subagents auto-cleanup when their task returns — no pane management needed.

Default rule: if the agent's job is "produce one document and exit," it's a subagent. If the agent's job is "stay on the task queue and grab the next thing," it's a teammate. Misusing teammates for one-shot work causes pane exhaustion because they idle forever waiting for orchestration that never comes (confirmed via Claude Code docs — see [[feedback_agent_self_termination]]).

**Worktree isolation on spawn (REQUIRED for writers).** The lead runs as an un-isolated background job in `/workspace`. A background-isolation guard (`worktree.bgIsolation` in `.claude/settings.json`) blocks file writes from background-spawned agents that aren't isolated. The agent-def `isolation: worktree` frontmatter (set on developer/senior-developer/architect/product-owner/scrum-master) is honored for plain **subagent** spawns but is **NOT auto-applied to teammate spawns** (`team_name` set) — so **always pass `isolation: "worktree"` explicitly on every teammate `Agent` spawn**. That gives each teammate a harness-managed worktree, satisfying the guard with it ON. `bgIsolation` is **`"worktree"` (guard ON)** as of 2026-05-29 — the temporary `"none"` unblock has been removed now that teammate spawns pass `isolation: worktree` explicitly. So every background-spawned writer MUST carry explicit `isolation: "worktree"` or its file writes are blocked. Valid `bgIsolation` values are only `"worktree"` (default/on) and `"none"` — there is no auto mode (Claude Code v2.1.143+).

**IMPORTANT: Always use team name `"js2wasm"`** — this is the single permanent team. Never create ad-hoc team names (e.g. `"wasi-conflicts"`, `"s52-wave2"`). One team, one task queue, always.

**Key numbers**: 16GB RAM + 16GB swap (container, set in `.devcontainer/devcontainer.json`), **8 cores**. `free -m` may report ~20GB but Docker enforces 16GB hard limit. **CPU is the binding constraint, not RAM** — keep concurrent *active* agents to ~`cores − 2` (≈6 here) so the box stays interactive; the `pre-agent-spawn.sh` load gate enforces this. All agents use `bypassPermissions` mode + worktree isolation. Work driven by `plan/log/dependency-graph.md`.

**RAM monitoring**: Use `free -m` "available" column (not "free"). "free" excludes reclaimable disk cache. Hooks check "available" before allowing agent spawns.

**CPU / concurrency cap (the binding limit)**: The real bottleneck on this box is CPU, not RAM — agents are cheap while idle (waiting on the API) but each *active* one bursts a core during compile/test. With no ceiling, load oversubscribes (it hit 13–16 on 8 cores), which starves sshd and drops interactive SSH sessions. `pre-agent-spawn.sh` therefore hard-blocks a new spawn when the **1-min load average ≥ `cores − 2`** (the `JS2WASM_MAX_LOAD` env var; default leaves ~2 cores for the lead/IDE/sshd/system). It gates on *load*, not a process count, because the harness keeps a warm `claude.exe` pool (`--bg-spare`/`--bg-pty-host`) that makes process-counting a poor proxy for active agents. Raise `JS2WASM_MAX_LOAD` to trade SSH responsiveness for throughput.

**Memory budget** (measured peaks via `/proc/[pid]/status` VmHWM):
- Fixed: Cursor ~1,400MB + system ~1,200MB + tech lead ~1,400MB = **~4,000MB**
- Dev agent: ~700MB peak (no local test262)
- Test262 (CI only): ~4,300MB peak per shard — runs in GitHub Actions, not locally
- RAM allows ~8 devs (~9.6GB headroom), but **CPU is the tighter limit**: target ~`cores − 2` (≈6) concurrent *active* agents. The `pre-agent-spawn.sh` load gate (see "CPU / concurrency cap" above) enforces it; `free -m` available is still a secondary floor.

### Agent lifecycle — when to spawn, skill, or terminate

| Situation | Action |
|-----------|--------|
| Dev needs to test + merge | Invoke `/test-and-merge` skill (no tester agent needed) |
| Need to validate 1-2 issues | Invoke `/smoke-test-issue` skill |
| Sprint planning (collaborative, multi-issue) | Spawn PO + Architect agents |
| Hard issue needs design | Invoke `/architect-spec` skill, or spawn architect if multiple issues |
| Sprint retro (discussion with user) | Spawn SM agent |
| Planning agents done, user not talking to them | Write context summary → terminate |
| Planning agents done, user IS talking to them | Keep alive until user signals done |
| Dev between tasks | Keep alive — wait for CI, self-merge if green, then claim next task from TaskList |
| Dev sending idle_notification pings | If TaskList has unowned work: redirect them to it. Otherwise: send `shutdown_request` — that's the correct lifecycle exit, not a punishment. |
| Dev idle, no tasks available | Send `shutdown_request` immediately. Idle teammates burn pane slots and block new spawns. Re-spawn when work appears. |
| End of sprint | All agents write context summaries → terminate → run `/sprint-wrap-up` |

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
Scrum Master
  ↔ reviews sprint → proposes process changes to PO + tech lead
```

| Role | Agent | Owns | Reads from | Writes to |
|------|-------|------|-----------|-----------|
| **Product Owner** | `.claude/agents/product-owner.md` | Backlog, issue creation, priorities | test262 results, dependency graph | `plan/issues/`, `plan/log/dependency-graph.md` |
| **Architect** | `.claude/agents/architect.md` | Implementation specs | Issue files, compiler source | `## Implementation Plan` in issue files |
| **Tech Lead** | (orchestrator) | Task queue, merges, test runs | Issue files, agent messages | `main` branch, task list |
| **Developer** | `.claude/agents/developer.md` | Code changes in worktree | Issue file + impl spec, checklists | Source code, test files, issue status |
| **Scrum Master** | `.claude/agents/scrum-master.md` | Process improvement | Done issues, git history, messages | `plan/retrospectives/`, checklist edits (proposed) |

**Interaction flow:**

Sprint planning:
1. **PO** validates candidate issues against current main → closes stale ones
2. **PO** prioritizes remaining issues by value → routes hard ones to architect
3. **Architect** reads issue + compiler source → writes implementation plan in the issue file
4. **PO** creates task queue with full context → tech lead dispatches to devs

During sprint:
5. **Dev** reads issue (with impl plan) → implements → follows checklists → signals completion
6. **Dev** invokes `/test-and-merge` skill → merges main into branch → equiv tests → if pass: ff-only to main → post-merge cleanup. If fail: fixes on branch.
7. **PO** accepts/rejects completed work against acceptance criteria

End of sprint:
8. **Tech lead** runs full test262 → records results
9. **SM** reviews sprint → proposes process improvements
10. **PO** grooms backlog for next sprint

**Tech lead discipline:**
- **Populate TaskList** at sprint start from the issues with `sprint: {N}` frontmatter (flat `plan/issues/<id>-<slug>.md`) and immediately whenever new issues are added mid-sprint. Empty queue = agents spin idle.
- **Reconcile the TaskList against issue-status every loop / session start** — `node scripts/reconcile-tasklist.mjs` (also wired as a SessionStart hook, `--quiet`). It reads the on-disk task stores (`~/.claude/tasks/{<session-uuid>,js2wasm}/*.json`) and reports every non-`completed` task whose **target issue** (first `#NNNN` in the subject) is already `done`/`wont-fix`; apply `TaskUpdate status=completed` for each (or `--apply` for a best-effort direct rewrite of dead-session task files). **Why this exists / root cause of stale tasks:** a task's flip to `completed` is a manual `TaskUpdate` nobody is structurally forced to make — (1) PRs merge *asynchronously* in the queue after the authoring dev has moved on; (2) PO/lead **tracking-tasks** get completed via the *issue file* (`status: done` in the impl PR — the source of truth) with no agent owning the TaskList twin; (3) tasks live in **two stores** (per-session + team `js2wasm`) that don't reconcile each other. So `issue status` (accurate) and `TaskList status` (stale) drift silently. The reconciler derives done-ness from the authoritative issue frontmatter and closes the loop. Devs should also flip their own task to `completed` at **enqueue** time (enqueue ⇒ will-merge), not "after merge" (by then they're gone).
- Batch doc/plan commits on main AFTER all pending agent merges, not between them (doc commits force agents to re-merge main)
- Complete post-merge issue cleanup (set `status: done` in sprint dir issue file, update dep graph) after each merge
- **Tag sprints**: `git tag sprint-N/begin` when starting a sprint, `git tag sprint/N` when it finishes. Sprint stats (duration, commits, issues) are auto-generated from tags during `build:pages`.

### Sprint planning (PO + Architect + Tech Lead)

Sprint planning is a collaborative process, not a solo tech lead activity:

1. **PO validates** — smoke-tests top candidate issues against current main, closes already-fixed ones
2. **PO prioritizes** — orders by value (impact × unblocking potential), not just CE/FAIL count
3. **PO routes hard issues to Architect** — any issue marked `feasibility: hard` or touching core codegen gets an implementation spec before dev dispatch
4. **Architect specs** — reads compiler source, writes `## Implementation Plan` in the issue file with exact functions, line numbers, Wasm patterns, edge cases
5. **PO creates tasks** — via `TaskCreate` with full context, referencing architect specs where available
6. **Tech lead dispatches** — assigns tasks to devs, manages the merge queue

### Agent work dispatch
- **Tech lead populates TaskList** — devs self-serve from it. No per-task dispatch messages needed.
- **Owner pins + scope are how the auto-dispatcher is steered.** The native agent-teams auto-dispatcher only auto-offers tasks with **no `owner`**, and it does **not** read role. So the tech lead encodes routing in two places the dispatcher/agents actually honor:
  - **Set `owner` immediately** on any task pinned to a specific agent (e.g. an in-flight `[CONFLICT]` for a named senior-dev, or a one-PR migration). An ownerless `in_progress` task is the #1 mis-route cause — the dispatcher re-offers it. Reconcile (`TaskUpdate status=completed` the moment a PR merges) so stale entries never get re-offered.
  - **Tag role/scope in the subject** so agents can self-gate: `[SENIOR-DEV ONLY]`, `[CONFLICT]` (senior-dev), `arch(...)`/`[ARCH]` (architect), `po:`/`[PO]` (product owner), `[PARKED …]`/`[PAUSE]` (not ready). Plain `fix(...)`/`refactor(...)`/`dev:` = developer-claimable. Agents skip tasks owned by others or tagged outside their lane (see the pre-claim gate in `developer.md`/`senior-developer.md`).
- **Dev loop**: claim task from TaskList → implement → push PR → wait for CI → self-merge if green → mark completed → claim next task.
- **Dev self-merge**: when `.claude/ci-status/pr-<N>.json` has matching SHA, `net_per_test > 0`, ratio <10%, no bucket >50 — **enqueue via the GraphQL `enqueuePullRequest` mutation**: `PRID=$(gh pr view <N> --json id -q .id); gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id="$PRID"`, then verify the PR appears in the queue. Do **NOT** use `gh pr merge <N> --auto`: `--auto` only arms auto-merge on a *check-state transition*, so on a PR that's already fully green (`CLEAN`) it **silently no-ops and the PR is never queued** — this stranded a 9-PR backlog with an empty queue on 2026-05-29. (Never pass `--merge`/strategy flags either — the queue owns the strategy.) Escalate to tech lead only when criteria fail. `--admin --merge` is reserved for workflow-only / hotfix bypass. See `.claude/skills/dev-self-merge.md`. **Backstop:** `.github/workflows/auto-enqueue.yml` (`scripts/enqueue-green-prs.mjs`) runs on every CI completion + every 10 min and auto-enqueues any open, non-draft, mergeable PR not already in the queue — this catches PRs that strand (already-green when the dev acted) or that the merge queue dropped when main advanced under them. So enqueue failures self-heal within ~10 min; manual `node scripts/enqueue-green-prs.mjs` forces a sweep now. Drafts and PRs labelled `hold`/`do-not-merge`/`wip` are never auto-enqueued.
- **Tech lead reading ci-status files**: always verify `head_sha` matches current PR HEAD (`gh pr view N --json headRefOid`) before interpreting `net_per_test` or regression counts. A SHA mismatch means CI ran on a stale commit — the numbers are misleading. Also check `baseline_staleness_commits` > 0 as a secondary signal.
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

**Authoritative ruleset**: see [`docs/ci-policy.md`](docs/ci-policy.md) for
the required-checks list, reviewer rules, force-push policy, linear-history
mode, and the admin script (`scripts/enable-branch-protection.sh`) that
applies them. Required checks today: `cheap gate (main-ancestor + lint)`
(test262-sharded.yml), `merge shard reports` (test262-sharded.yml),
`quality` (ci.yml). The dev-self-merge skill is a UX layer on top —
GitHub branch protection is the hard block.

**Devs do NOT run local test262.** Branch validation happens in GitHub Actions:

1. **Dev merges `origin/main` INTO their branch** — `git merge origin/main` (not rebase), BEFORE opening a PR
   - Planning artifact conflicts (`dashboard/`, `plan/`, `public/`) → `git checkout --theirs` + regen
   - Compiler source conflicts (`src/**/*.ts`) → create a priority `[CONFLICT]` TaskList item; assign to `senior-developer` (Opus); do NOT resolve inline
2. **Dev runs scoped local checks** — issue-targeted compile/run checks for confidence
3. **Dev pushes the branch to origin and opens a PR against `main`** — PRs MUST target the **upstream** repo (`loopdive/js2`), never the fork (`ttraenkler/js2`). **Always pass `-R loopdive/js2 --head ttraenkler:<branch>` to `gh pr create`** — the container's gh 2.23 ignores the pinned default (`remote.upstream.gh-resolved=base`) for `pr create` and silently opens the PR on the fork (verified 2026-06-11: fork PRs #6/#7 both had to be closed as misrouted). After creating, verify the PR URL starts with `github.com/loopdive/`. Note the pre-push integrity gate chokes on the fork/upstream divergence — `git push --no-verify` is sanctioned (CI runs the real gate).
4. **Dev blocks on CI** — polls `gh pr checks <N>` every 30s for ~2 min wall time, in-context (Sonnet idle is nearly free). Use `gh run watch <run-id>` or a `while ! done; do sleep 30; done` loop with a max timeout (~10 min before noting unusual wait, ~20 min before escalating).
5. **On CI completion**:
   - **All required checks green** → run `/dev-self-merge`; if MERGE, enqueue via GraphQL `enqueuePullRequest` (NOT `gh pr merge --auto` — it silently no-ops on already-green `CLEAN` PRs and never queues them), then proceed to step 8
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
- **Self-merge path (the common case)** — when a dev opens the implementation PR for an issue they will self-merge, the **implementation PR sets `status: done` directly** (with `completed:`), not `in-review`. By the time the merge queue lands the PR, the issue *is* done, and there is no separate observer who can make a post-merge commit. Setting `in-review` here orphans the issue: the dev can't flip it to `done` afterward from `/workspace` once the queue lands the PR. So the impl PR carries the final status. (See #1602/#1603/#1606 — stuck at `in-review` because of exactly this.)
- **`in-review`** — reserved for the **handoff/external case**: the PR author is NOT the merger (e.g. work handed off to another agent, or an external contributor's PR). Set when the PR opens; flipped to `done` by whoever observes the merge.
- **`done`** — true once the **PR merges**. In the self-merge path it's already set in the impl PR; in the handoff/external case it's set by the merge observer. A merged PR ⇒ `done`. Never leave a merged issue at `in-review`.

### Issue completion (post-merge)
1. Set `status: done` in the issue file at `plan/issues/<id>-<slug>.md`
2. Update `plan/log/dependency-graph.md` — remove/strikethrough completed issue
3. Update `plan/issues/backlog/backlog.md` if the issue was listed there

<!-- AUTO:conformance-start -->
**test262 conformance**: 31,357 / 43,135 (72.7 %) — baseline unknown, 2026-06-17T03:16:20.635Z
<!-- AUTO:conformance-end -->

### Sprint History
- **Sprint 1**: 550 → 1,509 pass (+174%), 167 fail, 5,700 CE. Issues #138-#173.
- **Sprint 2**: 12 branches, 18 issues (#207-#224). Key: destructuring hoisting (~1200 CE), string comparison, .call(), member increment/decrement, labeled break. Equivalence tests: 86 → 170.
- **Sprint 3**: 32 issues (#225-#256). Target: 0 runtime failures, ~1,500 CE reduction.
- **Sprint 4+**: Transitioned to dependency-driven execution. See `plan/log/dependency-graph.md`.
- **2026-03-19 session**: 53 issues in one session. WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer support, and extensive test262 improvements.
