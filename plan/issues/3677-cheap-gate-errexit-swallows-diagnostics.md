---
id: 3677
title: cheap gate aborts at `wait` under `bash -e` — every failure is diagnostic-free and lint hard-fails against its own declared intent
status: done
sprint: 77
priority: high
horizon: s
feasibility: easy
task_type: ci
area: ci
goal: ci-reliability
related: [3437]
assignee: ttraenkler/pr-queue-shepherd
created: 2026-07-26
completed: 2026-07-26
---

# #3677 — cheap gate swallows its own diagnostics under `errexit`

## Problem

The required check **`cheap gate (main-ancestor + lint)`**
(`.github/workflows/test262-sharded.yml`, step "Typecheck + lint (parallel)")
runs under GitHub's default `shell: /usr/bin/bash -e`. The script did:

```bash
wait $pid_tc;   tc_rc=$?
wait $pid_lint; lint_rc=$?
echo "--- typecheck (last 50 lines) ---"; tail -50 "$tmp_tc"
echo "--- lint (last 50 lines) ---";      tail -50 "$tmp_lint"
if [ "$tc_rc" -ne 0 ]; then echo "::error::typecheck failed (rc=$tc_rc)"; exit "$tc_rc"; fi
if [ "$lint_rc" -ne 0 ]; then echo "::warning::lint failed (rc=$lint_rc) — not blocking"; fi
```

Under `-e`, a **bare** `wait $pid` whose job exited non-zero aborts the step *at
that line*. So neither `tail -50` dump, neither rc check, and neither annotation
was ever reachable on a failing run. Two distinct consequences:

1. **Every cheap-gate failure is diagnostic-free.** The log ends at a bare
   `##[error]Process completed with exit code 1` with no typecheck or lint
   output at all — you cannot tell *which* lane failed, let alone why.
2. **A lint-only failure HARD-FAILS the required check**, directly
   contradicting the `::warning::lint failed (rc=$lint_rc) — not blocking`
   line in the same script. The declared policy is "lint does not block"; the
   observed behaviour was "lint blocks, silently".

### Evidence

PR #3678 run
[30197510215](https://github.com/loopdive/js2/actions/runs/30197510215):
the cheap gate log ends at `Process completed with exit code 1` with **no**
`--- typecheck (last 50 lines) ---` header. The `quality` job on the *identical
tree* reported `lint=1, format=1, typecheck=0` — so typecheck passed and the
abort must have been at `wait $pid_lint`.

## Fix

```bash
tc_rc=0;   wait $pid_tc   || tc_rc=$?
lint_rc=0; wait $pid_lint || lint_rc=$?
```

`cmd || rc=$?` makes the wait a *tested* command, so `errexit` does not fire
while the real exit status is still captured.

**Deliberately NOT `set +e`.** That would disable errexit for the remainder of
the step, and a later edit that stopped propagating `tc_rc` would silently turn
this required gate into a decorative one — a green gate is indistinguishable
from a disabled one. The `|| rc=$?` form keeps propagation explicit and local.

## Is lint still enforced?

**Yes — by the `quality` job, independently.** `.github/workflows/ci.yml`
(lines 122-125) fails on `lint_rc != 0`:

```bash
if [ "$lint_rc" -ne 0 ] || [ "$format_rc" -ne 0 ] || [ "$typecheck_rc" -ne 0 ]; then
  echo "::error::quality lanes failed (lint=..., format=..., typecheck=...)"
  exit 1
fi
```

`quality` is itself a required check, and PR #3678 demonstrated this live: it
carried a real biome `noSelfCompare` error and `quality` failed on it. So
restoring the cheap gate's declared non-blocking behaviour removes **no** lint
enforcement repo-wide — it removes a duplicate, undocumented, diagnostic-free
one.

## Acceptance criteria

- [x] A typecheck error still FAILS the cheap gate (the gate is not neutered)
- [x] A lint-only error PASSES the cheap gate, with `::warning::lint failed`
      visible
- [x] Both `--- typecheck ---` and `--- lint ---` dumps are present on a
      failing run
- [x] Lint remains enforced repo-wide via `quality`

## Test Results

### Local truth table (fixed logic, `bash -e`)

| typecheck | lint | step exit | annotation                | dumps |
| --------- | ---- | --------- | ------------------------- | ----- |
| pass      | pass | 0         | —                         | both  |
| pass      | FAIL | 0         | `::warning::lint failed`  | both  |
| FAIL      | pass | 1         | `::error::typecheck failed` | both  |
| FAIL      | FAIL | 1         | `::error::typecheck failed` | both  |

### Verify-by-reverting (old logic, same harness)

| case             | step exit | dumps        |
| ---------------- | --------- | ------------ |
| lint-only fails  | **1**     | **none**     |
| typecheck fails  | 1         | **none**, no `::error::` |

The bug is present in the old form and absent in the new one, observed in both
directions.

### CI positive control (observed, not reasoned)

Two scratch draft PRs off this branch, both carrying the fixed workflow. Both
have been closed and their branches deleted; the run logs remain linked.

**PR #3688 — deliberate typecheck error** (`const x: number = "..."`).
Cheap gate conclusion: **fail** — the gate is NOT neutered.
[job 89839251412](https://github.com/loopdive/js2/actions/runs/30219450969/job/89839251412):

```
--- typecheck (last 50 lines) ---
##[error]src/__ci_control_3677.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
--- lint (last 50 lines) ---
##[error]typecheck failed (rc=2)
##[error]Process completed with exit code 2.
```

Both dumps present, and `::error::typecheck failed (rc=2)` — an annotation that
was **unreachable** before this fix — is now emitted.

**PR #3689 — lint-only error** (`value !== value` → `lint/suspicious/noSelfCompare`,
typechecks cleanly, isolating the lint lane).
Cheap gate conclusion: **pass** — declared intent restored.
[job 89839272201](https://github.com/loopdive/js2/actions/runs/30219458491/job/89839272201):

```
--- typecheck (last 50 lines) ---
--- lint (last 50 lines) ---
src/__ci_control_3677.ts:2:10 lint/suspicious/noSelfCompare
  × Comparing to itself is potentially pointless.
Found 1 error.
##[warning]lint failed (rc=1) — not blocking
```

Both dumps present, the offending rule and line visible, and the
`not blocking` warning surfaced. `quality` FAILED on the same PR for the same
lint error — confirming lint enforcement is retained repo-wide.

## Second finding — a check NAME does not identify a check

Found while building the controls above, and it generalises well past this PR.

**Two different checks report under the identical name
`cheap gate (main-ancestor + lint)`**: a stub workflow that always concludes
`skipping`, and the real `test262-sharded.yml` job. On both control PRs:

```
cheap gate (main-ancestor + lint)   skipping   .../job/89839307250
cheap gate (main-ancestor + lint)   pending    .../job/89839251412
```

So the everywhere-used idiom

```bash
gh pr checks "$PR" | grep '^cheap gate' | head -1     # ← WRONG
```

returns `skipping` — a **terminal-looking, non-failing** value — while the real
job is still `pending`. My first control watcher did exactly this and printed
`SETTLED: typecheck-control=skipping lint-control=skipping`. That is a clean,
confident, entirely artifactual result: had I trusted it I would have reported
positive controls that had **never run**.

This is the silent-empty family again: the poller answered "is there a row
named X with a terminal state?" while I was asking "did the gate that guards
this PR conclude, and how?" Those differ whenever a name is not unique.

**Rules this implies, for any check-polling code:**

- **Never let a name alone identify a check.** Disambiguate by job/run id, or
  at minimum exclude `skipping` rows.
- **Settle only on a terminal `pass`/`fail`.** `skipping` is not a verdict about
  this PR — it means some *other* workflow declined to run.
- A watcher that can only ever report success is untestable; make sure the
  polling predicate can distinguish "concluded green" from "never ran".

## Third finding — an unset `task_type` defaults to GATED

This PR tripped `Issue→probe coverage gate (#2093)` on its own issue file:

```
✖ FAIL  #3677 flipped to done with NO probe/test reference (created 2026-07-26).
```

`scripts/check-issue-spec-coverage.mjs:160` is:

```js
if (taskType && !GATED_TASK_TYPES.has(taskType)) continue;
```

with `GATED_TASK_TYPES = {bug, bugfix, fix, feature, conformance, codegen, runtime}`.
The exemption is guarded on `taskType` being **truthy**, so an issue with **no
`task_type:` field at all** never reaches the membership test and is gated as
behavioural by default. It then demands either a `tests/issue-<id>*.test.ts` on
disk or a body citing a `tests/….test.ts` / `test262/….js` path.

Fixed here by declaring `task_type: ci` — honest classification, not
gate-gaming: the file already carried `area: ci` and `goal: ci-reliability`, and
a workflow shell bug has no runnable behavioural repro by construction. Sibling
precedent: `1170-move-test262-baselines-out-of.md` and
`1214-ci-playground-benchmark-baseline.md` are both `task_type: infrastructure`,
`status: done`, `area: ci`.

**Why this is worth recording.** Measured on this branch: **1,197 of 3,236**
issue files (37%) carry no `task_type` at all. Gating-by-default is a
defensible safe choice, but it means the gate's verdict on an old, untyped
issue depends on **whether a PR happens to touch that file** — the rule is
change-scoped, so 1,197 latent trip-wires sit dormant until someone edits one
for an unrelated reason and inherits a probe requirement for work that may not
be behavioural at all. Anyone editing an untyped issue file should expect this
and set `task_type:` honestly rather than inventing a probe.

## A process note, recorded because it caused real delay

This PR's `quality` failure went unobserved: the CI watcher was backgrounded
and then the session stood down reporting "the enqueue fires when quality
settles". It settled as a **failure**, the watcher died with the session, and
the PR sat `BLOCKED` with nothing watching it — the tech lead had to catch it.

The rule: **do not stand down while a required check is still unresolved.**
Backgrounding a watcher is not delegation if the watcher's lifetime is bounded
by your own. Silence is only a healthy signal while something is actually
watching.

Compounding it: `quality` runs under `bash -e` and fails fast, so step 25
failing meant **steps 26–38 never ran**. Clearing step 25 is therefore *not*
the same as `quality` going green — the remaining gates were unknown, not
passing. They were run locally before re-push (done-status integrity #3474,
required guard suite #3552, conformance sync #1522, feature badges) and all
pass.
