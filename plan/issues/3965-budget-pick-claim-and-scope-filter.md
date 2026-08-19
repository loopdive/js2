---
id: 3965
title: "budget-status --pick steers agents into already-claimed and out-of-lane work — filter on the live claim ref, role scope and lane, and print every exclusion"
status: done
sprint: 78
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: tooling
goal: maintainability
created: 2026-08-01
completed: 2026-08-01
assignee: ttraenkler/dev-budget-pick
---

# #3965 — `budget-status --pick` recommends work the pre-dispatch gate then refuses

## Problem

`scripts/budget-status.mjs --pick` ranked candidate tasks on `priority` +
`horizon` **only**. It never asked:

- whether the issue is **already claimed** on the `issue-assignments` ref, or
- whether the agent reading the list is **allowed to take it** (`task_type:`,
  title role-tags, `model:` lane pin).

So it recommended work that `scripts/pre-dispatch-gate.mjs` then refuses.

`--pick` is the documented **first** step of the dev claim loop in `CLAUDE.md`
("check budget fit → claim an adequately-sized task"), so an agent following the
documented protocol is steered into duplicate work, and only the pre-dispatch
gate catches it — after the agent has burned context orienting. That makes the
picker a **duplicate-dispatch amplifier**, not merely a lossy ranker.

## Measurement (2026-08-01)

**Harness matters — the bare invocation does not reproduce this.** At the live
budget setting that afternoon (30 % remaining, parallelism 2) the recommended
horizon was `L`, not `XL`. The XL set was surfaced by forcing a fresh window:

```
JS2WASM_BUDGET_REMAINING_PCT=100 JS2WASM_PARALLELISM=1 node scripts/budget-status.mjs --json
```

**XL set — 5 of 5 unusable for an Opus-lane developer:**

| pick  | why it was unusable                                                             |
| ----- | ------------------------------------------------------------------------------- |
| #2773 | title `[EPIC][ARCH]` — architect scope (also `task_type: epic`, `model: fable`) |
| #2865 | `model: fable` — Lane B                                                          |
| #2949 | **CLAIMED** by `ttraenkler/codex-ir-array-param` since 2026-07-29T23:34:55Z      |
| #3029 | `task_type: architecture` (also `model: fable`)                                 |
| #3030 | `task_type: architecture` (also `model: fable`)                                 |

#2949 is the concrete cost: `--pick` misdirected a real dispatch onto an issue
another lane was actively working.

**The defect is not confined to the XL path.** The `L` set that the same
invocation returned at the live 30 % setting — #1032, #2700, #2866, #2867,
#2872 — is **also 5 of 5 unusable**: none were claimed, but every one carries
`model: fable`. Both horizons, same denominator, same result.

Live-ref scale at the time of measurement: 1,123 records, 366 held claims.

## Fix

### 1. `claim-issue.mjs --list --json`

A machine-readable form of the existing `--list`, added so other tools reuse
**this** read path instead of growing their own. TSV remains the default.

The one tool that grew its own — `pre-dispatch-gate.mjs`'s
`git show origin/issue-assignments:<id>.json` — is a remote-**tracking** read:
it answers from whatever the last `git fetch` left behind, so it is stale by
construction and silently empty when the local ref was never fetched. Anything
routed through `--list --json` instead inherits the #3880 tri-state hardening
for free: an unreadable ref exits 6, never degrades to "unassigned", and "no
claims" therefore means what it says. (Fixing the gate's own cached read is a
follow-up, deliberately not in this PR.)

### 2. `budget-status.mjs --pick` filters and explains

New optional identity flags — **each one absent is announced, never silently
treated as "no filter needed"**:

| flag                | meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `--as <name>`       | requesting agent; its **own** claim is not a blocker (resume case)   |
| `--role <role>`     | `developer` (default), `senior-developer`, `architect`, `product-owner`, `tech-lead`, `any` |
| `--model <name>`    | lane pin; absent ⇒ lane filter **not applied**                       |
| `--limit <n>`       | rows to print (default 5); truncation is disclosed                   |
| `--no-claim-check`  | explicit offline opt-out; every row is then stamped `[UNVERIFIED]`   |

Three filter stages, each printing a per-row reason:

- **claim** — read **live at the moment of the call**, never from a cached
  fetch. A slice claim (`<id>-<slice>`) counts as held: part of the issue is
  being worked, so handing the whole thing to a second agent is exactly the
  collision the lock exists to stop.
- **scope** — title role-tags (`[ARCH]`, `[EPIC]`, `[SENIOR-DEV ONLY]`,
  `[CONFLICT]`, `[PO]`, `[PARKED]`, `[PAUSE]`) plus `task_type:`.
- **lane** — `model:`, exact-match-or-unset.

Both are **deny-lists, not allow-lists**, for the asymmetry
`scripts/lib/claim-record.mjs` already argues for heldness: `task_type:` has 57
distinct values in the wild against SCHEMA.md's 10, so an allow-list would
silently make real work invisible. A deny-list sends the unknown down the safe
path — it stays visible, with the pre-dispatch gate still behind it.

### 3. Nothing is dropped silently

- Every exclusion prints `skipped #N: <reason>`.
- A four-stage funnel prints: `scanned → considered → horizon-fit →
  after claim → after scope → returned`, with truncation disclosed.
- **Zero returned is distinguishable from zero considered**: the no-picks line
  says either "The queue itself is EMPTY" or "The queue is NOT empty — the
  fitting work is taken or out of your lane", with the counts behind each.
- **Zero claims is distinguishable from unreadable claims.** This is the
  failure this fix must not have: `catch { return [] }` would make an
  unreadable ref and an empty one the same value, every candidate would pass,
  and `--pick` would print a confident *unfiltered* list — the defect, relocated
  one layer up. So the read is tri-state, an unreadable ref exits **6**, the
  header says `claim ref: UNREADABLE — <error>`, and every row is stamped
  `[UNVERIFIED]`.
- Provenance travels in `--json` too (`claim_ref`, `filters_applied`,
  `picks_unverified`, `funnel`, `skipped`) — a consumer reading `picks` without
  it would be back to trusting a possibly-unverified list.
- `--quiet` and the bare invocation do **not** read the ref (the statusline
  calls `--quiet` on every render) and stay exit 0.

### 4. `model:` is now a defined field

`model:` is written on 306 issues and, before this, was read by **nothing** —
`plan/issues/SCHEMA.md` did not define it. Filtering on an undefined field is
how the next drift starts, so its semantics are documented in SCHEMA.md in this
PR: **exact-match-or-unset**. An issue with no `model:` is claimable by any
lane; an issue pinned to a lane is skipped for every other one. `Opus 5` /
`opus-5` / `opus` all normalise to `opus`, so an agent may pass the model name
it knows itself by.

### 5. `--role` announces when it was ASSUMED

`--model` absent is self-announcing, but `--role` has a default, so an architect
passing only `--as` would have had developer scope applied **silently**, with
exclusions printed against a role it never claimed. The report now distinguishes
`role=developer` (asked for) from `role=developer (DEFAULT — no --role/$JS2WASM_ROLE
given; scope filtered as a developer)`, and `--json` carries `role_defaulted`.

## Test Results

`tests/issue-3965.test.ts` — 17 tests, hermetic (local bare repo standing in for
the assignment ref; no network). All green.

**Positive control, both directions** — one direction alone proves nothing,
because a picker that returns nothing at all also "excludes" the claimed issue:

| step                             | assertion                                                          |
| -------------------------------- | ------------------------------------------------------------------ |
| baseline, nothing claimed        | #9001 **and** #9002 are both returned; no `skipped #9002` line     |
| claim #9002                      | #9002 gone from picks **and** `skipped #9002: claimed by ttraenkler/dev-x since <ts> on issue-9002-x` is printed; #9001 still returned (selective, not blanket) |
| release #9002                    | #9002 **returns** to the picks and the skip line disappears        |

Live-ref verification of the same behaviour on the real data
(`--role developer --model opus`, forced fresh window) — all five
originally-recommended XL picks now excluded, each for a different reason:

```
skipped #2773: title carries [ARCH] — out of scope for role developer
skipped #2865: model: fable — pinned to another lane (you are opus)
skipped #2949: claimed by ttraenkler/codex-ir-array-param since 2026-07-29T23:34:55Z on codex/2949-acorn-recursive-bool
skipped #3029: task_type: architecture — not claimable by role developer
skipped #3030: task_type: architecture — not claimable by role developer

funnel: scanned 3408 issue files → considered 234 (sprint: current + ready)
        → horizon-fit 234 → after claim 201 → after scope 138 → returned 5 (+133 more not shown)
budget-status: OK — 5 pick(s) returned of 138 claimable, 234 considered, 96 skipped with reasons
```

**Non-vacuity of the suite itself** (verify by reverting, not by a green run):

| sabotage                                          | result                                            |
| ------------------------------------------------- | ------------------------------------------------- |
| claim filter forced off (`if (false)`)            | **4 of 15 fail**                                  |
| lane filter forced off (`if (false)`)             | **5 of 15 fail**                                  |
| pick-row indentation changed 4 → 6 spaces         | **8 of 17 fail**, each naming "output shape changed" |
| restored                                          | 17 / 17 pass                                      |

The third row exists because the assertion helpers are themselves a silent-empty
risk: `pickedIds` returning `[]` on an unrecognised line shape would turn every
`not.toContain(...)` — and the `[UNVERIFIED]` loop, which iterates the same
shape — green **and empty** rather than red, and the filter-sabotage rows above
would not catch it. Both helpers now throw instead of returning empty, which is
the same rule the script itself follows for `catch { return [] }`.

**Quality gates, run locally with their exit codes read directly** (not inferred
from output text — `pnpm run lint` prints "diagnostics exceed the allowed
number, 1430 not shown", which is consistent with either verdict):

| gate                                | exit |
| ----------------------------------- | ---- |
| `lint`                              | 0    |
| `format:check`                      | 0    |
| `typecheck`                         | 0    |
| `check:ir-fallbacks`                | 0    |
| `check:ir-only -- --policy=hybrid`  | 0    |
| `check:dead-exports`                | 0    |
| `check:oracle-ratchet`              | 0    |
| `check:pushraw`                     | 0    |
| `check:loc-budget`                  | 0    |
| `check:issues`                      | 0    |
| `check:issue-ids`                   | 0    |
| `check:issue-ids:against-main`      | 0    |

Read timing, which is what makes reading the ref at the moment of the call
practical: `claim-issue.mjs --list --json` costs **~1.4 s** via the warm cache
repo, against a measured **1 m 45 s** to fetch the same ref directly into a full
working repo.

## Follow-ups (not in this PR)

- `pre-dispatch-gate.mjs` still reads `git show origin/issue-assignments:<id>.json`
  — a remote-tracking read that is stale by construction and silently empty when
  the ref was never fetched locally. It should route through
  `claim-issue.mjs --list --json` / `--check` for the same tri-state guarantee.
- One record on the live ref has a **title** in its `assignee` field
  (`#3782: claimed by Compile linked Acorn benchmark driver for standalone …`).
  Harmless here — it still reads as held, the safe direction — but the claim
  path should reject an assignee that is not a `<account>/<name>` handle.
- `--pick` filters lane by `model:` only. `plan/method/lane-partition.md` also
  defines an explicit `lane: A` / `lane: B` field (on 30 issues) with a
  `goal:`-based default. Wiring those in would make the lane filter complete.

## Acceptance criteria

- [x] `--pick` excludes issues with a live claim on the `issue-assignments` ref
- [x] `--pick` excludes `task_type:` / `model:` values the requesting agent cannot take
- [x] every exclusion prints its reason; no silent drops
- [x] candidates considered vs returned reported; zero returned distinguishable from zero considered
- [x] positive control proven in both directions (claimed ⇒ excluded + reason; released ⇒ reappears)
- [x] claim ref read live at the moment of the call, not from a cached fetch
- [x] an unreadable ref never reads as "no claims" — exit 6, `UNREADABLE`, rows stamped `[UNVERIFIED]`
- [x] `model:` documented in `plan/issues/SCHEMA.md`
