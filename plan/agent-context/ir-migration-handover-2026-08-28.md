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
