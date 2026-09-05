---
agent: remote-ir-orchestrator (Fable lane, CCR session)
session_end: 2026-08-28
next_session_entry_point: read this file, then plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md (Dependency spine)
supersedes: ir-migration-handover-2026-08-27.md
---

# IR-migration lane handover — 2026-08-28

Remote orchestrator session on the IR/core-semantics lane. Fable planned and
dispatched; Opus subagents implemented; every dispatch gated by
`node scripts/pre-dispatch-gate.mjs <N>` plus a claim on
`origin/issue-assignments` at dispatch time (parallel codex session active —
coordination held all session, zero duplicated work).

## State at handoff

- **Baseline**: 34,416 / 43,621 on main (`dbdd620789`, scheduled refresh
  2026-08-28). All six waves' code PRs merged; zero regressions landed.
- **Merged this session (16 PRs)**: #5125 #5126 #5127 #5128 #5130 #5140 #5153
  #5154 #5156 #5157 #5161 #5164 #5168 #5169 #5171 #5174. Headliners:
  - **#4406 Phase 4 (PR #5171)** — boolean unboxing ABI default-ON; fixes 4
    shipping miscompiles, −11.7% executed boolean boxes. Third-site record
    (prover internal-call arm, rejected loop variant at +51,252 boxes) is in
    `plan/issues/4406-return-type-unboxing-abi.md`.
  - **#3481 Symbol cluster** enumerated: 18 failing rows = 4 root causes;
    largest fixed in #5174 (hint-free `Symbol.keyFor`, byte-identical result
    table was the only honest evidence — `compileExpression` honours its
    `{kind:"i32"}` hint, so post-call checks cannot see the bad unbox).
- **Claims still open on the ledger** (multi-slice, deliberate): `opus-4406`,
  `opus-3481`, plus the wave-7 trio below. Complete each with
  `node scripts/claim-issue.mjs --complete <id> <agent>` after its PR merges.

## Wave 7 — IN FLIGHT at handoff (dispatched 21:10Z)

Three Opus agents running, claims verified (`ttraenkler/opus-5160/5161/5162`).
Each was instructed to open a **DRAFT PR** on loopdive/js2 and stop.

| issue | branch | scope / trap notes |
| --- | --- | --- |
| #5160 | `claude/issue-5160-padsundefined-siblings` | 3 one-entry `padsUndefined` fixes (includes/startsWith/search) in `src/codegen/expressions/call-receiver-method.ts`; MUST update the wrong-value pins in `tests/issue-5155-string-indexof-no-argument.test.ts`; `search()` routes via `RegExp(undefined)` (§22.1.3.19), agent verifies the host arm first |
| #5161 | `claude/issue-5161-config-error-cause` | Error `cause` under `nativeStrings`/`fast` hosts; agent measures WHICH boundary throws per config before fixing; must not violate the `_hostToPrimitive` walker rules (#3481 cause-2 + #5159 records) |
| #5162 | `claude/issue-5162-ctor-proto-trap` | ctor→own-prototype-method trap; repro matrix FIRST (source order × class-vs-prototype syntax × lane); structural verdict ⇒ record + route to codex fnctor lane (#3521), do not force a fix |

**Release procedure for each draft PR** (orchestrator's job, not the agent's):
validate the report against the bars (A/B with base captured at first edit,
complete-cohort byte-identity per-row sha256, pins red on base, name-set
equivalence diff clean, chained ratchet gates + `LOC_GATE_BASE` simulation) →
`update_pull_request_branch` if BEHIND → `update_pull_request draft:false` →
`enable_pr_auto_merge` → subscribe. **Never enqueue manually** —
`auto-enqueue.yml` owns it. Known trap: a PR that finishes CI **as a draft**
strands (the responsive trigger skips drafts); the sanctioned recovery is one
`workflow_dispatch` of `auto-enqueue.yml` on `main`.

**Staggered 4th dispatch** (22:07Z check-in, `trig_01X1VdEJDDwt9i4fyA84hFbw`,
bound to this session): the two remaining #3481 Symbol sub-families — Map
statically-symbol keys (×3) and the symbol[]-declaration gate (×3). The
symbol[] one carries its **own regression budget**: a new host import touching
the shared i32-vec path where `new Uint8Array([Symbol()])` must keep throwing
(see #5174's record in `plan/issues/3481-bigint-symbol-coercion-value-rep.md`).
Claim `opus-3481` is already held. Respect the load gate (1-min load < 2 per
spawn; box showed 0.71 at wave-7 dispatch).

## Ready next (not started)

- **#4405 receiver-specialisation** — interlock for #4406 Phase 5. Larger;
  needs an `## Implementation Plan` written by the Fable lane FIRST
  (plan/implement split, project-lead order 2026-08-15). Do not dispatch bare.
- **#5127 / #5128 (CI tooling: dead wasm_sha noise filter; row-runner nans.js
  gap)** — PARKED: CI/infra is nominally Lane A (codex/lead); raise at next
  sync before dispatching here.

## Codex-lane sync items

- Their claims ledger carries **stale `in-progress` records for issues already
  done on main** — reconciliation gap on their side; flagged, not fixed.
- R5 #3525 / R6 #3526 planning claims started by codex 2026-08-28; R1–R4 all
  codex-owned. This lane's contribution to R9 is coverage closure
  (#2949/#2952/#1373b/#3583).
- The runtime-eval lane inherits from #5156's report: D1–D2 (regression at
  `372f6b6aae`), the `compile()` import under-report, and the
  verifyProvider-canary caveat.

## Migration state (one line)

#3518 R-spine: R0a/R0b done; R1–R4 in-progress (codex); R5/R6 planning
(codex); R7/R8 blocked; R9 fail-closed flip waits on this lane's coverage
closure; R10 is the ~59.7k-line deletion. Full table:
`plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md` §Dependency spine.

## Conventions that bit us (verify before trusting)

- Commits: author `Thomas Tränkler <git@thomas.traenkler.com>`, subject ends
  ` ✓`, trailer `Co-Authored-By: Claude <noreply@anthropic.com>`, no model ids
  pushed. PR bodies: website issue links + the Claude Code footer.
- Shell cwd resets between Bash calls — `cd` into the worktree in every git
  command, and read the `[branch hash]` line in commit output, not the hook
  reminder.
- Never pipe a gate whose exit status you need; `--allocate` runs degraded
  here (`--allow-unscanned`) — the `check:issue-ids:against-main` CI gate is
  the real arbiter.
- Plan-file ids and PR numbers are one sequence apart — overlapping numbers
  (e.g. PR #5161 vs issue #5161) are coincidence, not linkage.

## Addendum — 22:30Z (wave-7 partial completion)

State moved after the main handover above was written; this section is the
live truth, superseding the wave-7 table where they differ.

- **#5162 DONE and MERGED (PR #5182, 22:17Z)** — structural verdict, no src
  change. The filed compile-order hypothesis was REFUTED by measurement: the
  deciding axes are lane (gc always correct) and syntax (`class` always
  correct); standalone fnctor instances are closed WasmGC structs with no
  runtime prototype, so a constructor's `this.m()` — which always declines
  typed-`this` resolution (`resolveTypedThisField`, `not-in-twin` bucket) —
  falls to a dynamic lookup that finds nothing. 18 pins shipped, XFAIL pins
  on the broken shapes. Issue stays `ready`, `blocked_by: [4405]`; claim
  opus-5162 RELEASED (not completed) on the ledger.
  - **#4405 is actively claimed** by `ttraenkler/senior-dev` on
    `impl-4405-receiver-spec` since 2026-08-14 (`origin/issue-assignments`,
    record 4405.json). This AMENDS the "#4405 plan-first, ready next" note
    above: #4405 is OFF this lane's dispatch list; the #5162 fix routes there.
  - Bonus finding pinned in `tests/issue-5162-ctor-own-prototype-method.test.ts`:
    `this.twice.call(this, x)` inside a ctor throws in BOTH lanes (gc via a
    null receiver in `__extern_method_call`) — an independent hole, not yet
    filed as its own issue.
- **#5160 (PR #5181, draft)** — implementation + full evidence in the PR body
  (132-cell sweep, 12 expected gc-lane moves, standalone 66/66 identical,
  non-vacuity 15/48 red on base, gates green incl. LOC_GATE_BASE, #5155
  grant restated). CI green on head f0806d64. The agent is finishing its
  base-tree equivalence run for the name-set diff; RELEASE once it reports
  clean (update branch — it is BEHIND — then un-draft, auto-merge). After
  merge: `claim-issue.mjs --complete 5160 ttraenkler/opus-5160`.
- **#5161 agent still running** (boundary-throw measurement per config, then
  fix). Claim opus-5161 held. Same release protocol when its draft PR lands.
- **#3481 Symbol sub-families dispatch still pending** — deferred twice on
  the load gate (box at ~8 while the #5160 base shards run). A check-in is
  armed at 22:55Z (`trig_01JYrcPXGySXAfNZpJh21Rnu`) to dispatch when load
  clears, sweep #5181/#5161 to merged, and reconcile claims.
- Handover PR #5180 merged 21:56Z (this file + diary entry).

## Addendum 2026-09-03 — codex lane retired, spine takeover

- **The parallel codex lane is retired** (project-lead message 2026-09-03).
  Its R-spine rows R1–R6 (#3520 #3521 #3522 #3523 #3525 #3526) are now on
  THIS lane's critical path; the "do not duplicate codex work" constraint is
  lifted. Ledger sweep of the 219 codex claims done at 09:53Z: 214 reconciled
  (`--complete` where the issue is `done` on main, `--release` otherwise),
  5 benign refusals on sub-slice slugs of the multi-claim issues #3518/#3529
  (held by the `-plan` slugs, which were themselves released/completed —
  verified with `--check`: #3518 released, #3529 done, both read from
  `origin/issue-assignments`). Scratch trail: session scratchpad
  `codex-claims-classified.tsv`, `sweep-summary.txt`.
- **Wave 8/9 status**: #5525 (#5289) released, CLEAN, waiting on the queue;
  #5528 (#5282) released, CLEAN, in queue; #5530 (#5263+#5262) draft, CI
  green on `5404b825`, its agent is finishing the final IR-gate re-run —
  RELEASE on its report (update branch if BEHIND → un-draft → auto-merge).
  After each merge: `claim-issue.mjs --complete 5289 ttraenkler/opus-5289`,
  `--complete 5282 ttraenkler/opus-5282`, `--complete 5263 ttraenkler/opus-5263`,
  `--complete 5262 ttraenkler/opus-5263`. Then claim + dispatch **#5283**
  (branch `claude/issue-5283-legacy-body-receipt`, plan on main; branch only
  AFTER #5530 merges).
- **New issues filed this addendum** (ids from `--allocate --allow-unscanned`,
  CI `check:issue-ids:against-main` arbitrates): #5297 R4 compat-lane
  symbolization slice (the real blocker #5525 found; branch after #5525
  merges); #5298 kind-neutrality line-pinned evidence (tooling, S); #5299
  prepared-callable rows missing the receipt triple (R9 denominator, branch
  after #5530); #5300 from-ast overload call-site plan gap.
- **Spine-takeover audit** (architect `arch-spine-takeover`, output
  `plan/agent-context/spine-takeover-2026-09-03.md` on
  `claude/docs-spine-takeover`) — spawn blocked twice on the load gate
  (≥2 on this 4-core box while wave-9 shards run). Re-spawn when 1-min load
  < 2; it audits R1–R6 checkpoints, judges whether `opus-3522-f4` on R3 is
  live, lists the 14 R9 readers with file:line, and proposes a 2-wave
  dispatch of disjoint slices.
- **Lesson banked**: the orchestrator owns draft state. The MCP
  `create_pull_request` result reports `draft:false` even when draft was
  requested, which led one agent to re-draft an already-released PR; briefs
  now say "never toggle the draft flag".
