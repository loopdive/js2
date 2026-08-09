---
id: 3650
title: "`check-verdict-oracle-bump.mjs` watches five harness files but not the runtime layer — a verdict-changing `src/runtime.ts` PR is never asked to bump the oracle"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci
es_edition: multi
goal: release-pipeline
related: [3649, 3303, 3370, 3596, 3648, 3644]
origin: "Found by opus-loop-a while landing the #3603 host arm; filed by opus-loop-b so it is not lost while that measurement is in flight. Credit: opus-loop-a."
---

# #3650 — the oracle-bump gate's file list misses the layer that changes verdicts

**Found by `opus-loop-a`**, filed here so it survives that agent's in-flight
measurement cycle.

## The gap

`scripts/check-verdict-oracle-bump.mjs` demands an `ORACLE_VERSION` bump when a
PR changes how verdicts are computed. It watches exactly five files:

```
PURE:  scripts/negative-verdict.mjs
MIXED: scripts/test262-worker.mjs, tests/test262-shared.ts,
       tests/test262-vitest.test.ts, tests/test262-runner.ts
```

`src/runtime.ts` and `src/runtime/**` are **not** on that list. But the runtime
is a verdict-determining layer: loop-a's #3603 host arm flips on the order of a
**thousand** verdicts corpus-wide from `src/runtime.ts` alone, and the gate never
asks for a bump. (This is not hypothetical — my own #3637 changed
`for (x of {})` from "iterates zero times" to `TypeError`, which is a verdict
change for every test that shape reaches.)

## Why it is worse than a missing nag

Composed with the `regressions-allow` mode-scoping, it produced a **silent,
undiagnosable** failure — and this is the part that makes it high priority
rather than cosmetic:

1. A dev declares `regressions-allow: {count, reason}` — well-formed, parses fine.
2. No oracle bump happens, because **nothing demands one** for a runtime change.
3. `rebaseMode` is therefore false, so (pre-#3649) the allowance is **never read**.
4. The gate fails on regressions ⇒ the PR parks.
5. The park is **indistinguishable from "your ceiling was too small"**.

loop-a only caught it by going looking for the reader's own output line
(`=== regressions-allow (#3303): excused N of M …`) and noticing its **absence**,
rather than trusting the red/green outcome. Absence-as-diagnosis again — the same
silent-ambiguity class as #3644 (`never read` vs `read-and-rejected`) and #3648
(which baseline produced the verdict).

**#3649 removes step 3** (the allowance is now read in both modes, shape-driven),
which resolves the immediate trap and is the higher-value half. This issue is the
remaining half: the *gate that decides when the corpus is being re-measured* does
not watch the layer that most often re-measures it.

## Scope question to settle first

This is arguably a **`check-verdict-oracle-bump.mjs` scope bug**, not a
`change-scope.mjs` one, and the fix is not simply "add `src/**`":

- `src/**` is the compiler. A codegen change alters what the *program* does — a
  genuine pass/fail change, not a re-measurement. Demanding an oracle bump for
  every codegen PR would be wrong and would make the bump meaningless.
- `src/runtime.ts` is a **host-boundary semantics** layer: a change there can
  alter how an *already-compiled* module's behaviour is observed and classified,
  which is much closer to what the harness files do.

So the real question is **which parts of the runtime are verdict-determining**,
and the answer probably is not the whole file. Worth measuring rather than
guessing: take a known verdict-flipping runtime change (#3603's host arm, or
#3637) and identify what distinguishes it from an ordinary runtime bugfix.

## Acceptance criteria

- [ ] A decision, recorded with reasoning, on which runtime paths are
      verdict-determining for oracle purposes.
- [ ] `check-verdict-oracle-bump.mjs` watches them.
- [ ] A test proving a verdict-changing runtime PR is asked for a bump, and an
      ordinary runtime bugfix is not.
- [ ] The composed failure above cannot recur silently: if an allowance is not
      read, the log says so (already true after #3649 — keep it true).
