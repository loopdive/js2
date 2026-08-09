---
id: 3649
title: "`regressions-allow` is read only in rebase mode, so it is inert on ordinary PRs — a well-formed declaration is theatre, not a machine check"
status: done
sprint: 77
created: 2026-07-26
updated: 2026-07-30
completed: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue
es_edition: multi
goal: release-pipeline
assignee: ttraenkler/opus-loop-b
related: [3596, 3303, 3370, 3644, 3648, 3650]
origin: "Found by the harness lane while landing #3615; sharpened by opus-loop-a, which hit the composed form of it. Same family as #3644 — an allowance honoured in one context and silently absent in another."
---

# #3649 — an allowance must be readable in every context where it is enforced

This is the second instance of one defect. **#3644** was `trap-growth-allow`
honoured on the PR and unreadable in the baseline writers. This is
`regressions-allow` honoured in rebase mode and unreadable on an ordinary PR.
Same shape, same fix, and the generalisation is the durable deliverable:

> **An allowance must be readable in every context where it is enforced — and
> each enforcement point needs a test proving it reads one.**

## The gap

`regressions-allow` was read **only** inside the `if (rebaseMode)` branch, and

```ts
const rebaseMode =
  oracleRebase || (typeof baseOracle === "number" && typeof newOracle === "number" && newOracle > baseOracle);
```

so it required `ORACLE_REBASE=1` or a forward `ORACLE_VERSION` bump. On an
ordinary PR the declaration **parsed correctly and did nothing**. A dev with a
genuine, proven, intentional `pass → fail` had no way to declare it that any gate
would read.

**The failure was also undiagnosable**, which is the worse half: the gate fails
whether the ceiling was too small *or* the declaration was never consulted, and
nothing in the log distinguished them. `opus-loop-a` caught the composed form
only by looking for the reader's own output line and noticing its **absence**.

## Measured

`REGRESSIONS_ALLOW_FILE` hermetic hook; same-oracle fixtures (so: not rebase
mode); two `pass → fail` regressions with changed `wasm_sha`. **Real** exit codes
— captured to a file, never through a pipe (`${PIPESTATUS:-$?}` is a `sh`
bashism that reports the *last* command's status; it produced a vacuous
all-green table for #3644's first harness).

| case | before (stock main) | after |
| --- | --- | --- |
| **named** declaration (`tests:` naming both) | **exit 1**, and *no mention of the declaration anywhere in the log* | **exit 0**, `EXCUSING 2 named wasm-change regression(s)` |
| bare `count:` | exit 1, silent | exit 1, but now states it is INERT here and why |
| names a test that is **not** regressed | — | **exit 1**, named and refused |
| names 2, ceiling 1 | — | **exit 1**, ceiling refused |
| no declaration | exit 1 | exit 1 (unchanged) |

The first row is the issue: a correct, well-formed, honest declaration was worth
exactly nothing, and the log did not say so.

## Fix — the declaration's shape selects the contract

Identical rule to #3596/#3644, so all three enforcement points now agree:

- **`tests:` present** → verified and honoured in **both** modes. The named files
  are excused from the regression set the net/ratio/bucket gates see — the same
  mechanism `devacExcusedFiles` already uses.
- **bare `count:`** → #3303 semantics **byte-for-byte unchanged**: a ceiling,
  rebase mode only. No existing declaration changes behaviour. *(This matters
  operationally: `opus-loop-a` is landing a bare `{count, reason}` form right
  now, and it is safe by construction — the bare form parses to `tests: []`.)*

Verification (`evaluateNamedRegressionsAllowance`, pure) requires two things:

1. **Real** — every named test must actually be among this diff's wasm-change
   regressions. A name that is not is stale or speculative; both are refused, so
   a declaration cannot be written ahead of the evidence.
2. **Bounded** — the number excused may not exceed the declared `count`.

Deliberately **not** required: completeness. Undeclared regressions are simply
not excused and still gate normally. That is strictly safer than failing outright
on undeclared collateral, and it means an honest under-declaration degrades
gracefully instead of becoming a hard stop.

**Silence removed too:** a bare declaration on an ordinary PR now prints that it
is inert and how to make it checkable, so "ceiling too small" and "never read"
can never look alike again.

## A correction worth recording

The task brief said `changeSetNumericAllowances` "has no `tests:` support, unlike
its sibling `parseFrontmatterCountReason`". **That is wrong** — they are not
siblings; the former *calls* the latter and spreads its result, and
`readChangeScopedNumericAllowance` carries `tests` through. Measured directly:

```
with tests -> {"count":12,"reason":"r","tests":["test/a.js","test/b.js"]}
bare       -> {"count":12,"reason":"r","tests":[]}
```

#3596 added `tests:` to the **shared, key-agnostic** parser, not to a
trap-specific path. So this was **one** gap (mode-scoping), not two, and the fix
is correspondingly smaller. `opus-loop-a` reached the same conclusion
independently. Recorded because designing around the false constraint would have
meant re-implementing parsing that already worked.

## Not fixed here

**#3650** — `check-verdict-oracle-bump.mjs` watches five harness files but not
the runtime layer, so a verdict-changing `src/runtime.ts` PR is never asked to
bump the oracle, which is what put loop-a in non-rebase mode in the first place.
Filed separately because it is a scope question about that gate, not about
allowance plumbing, and the answer is *not* simply "add `src/**`".

## Validation

- `tsc --noEmit -p tsconfig.json` clean. `scripts/tsconfig.json` reports 9
  `diff-test262.ts` errors — **A/B'd: main's version reports the same 9**, so
  none is introduced (they are pre-existing, and my insertion only shifted the
  line numbers).
- `tests/issue-3303.test.ts` 44/44 pass unchanged.
- Behavioural repro above, five cases, real exit codes.

⚠️ This PR touches `scripts/diff-test262.ts`, which **is** on `&test262-paths`,
so it runs the full shard matrix — and per **#3648** its verdict is computed
against a baseline cloned at gate time, so a re-run can legitimately differ.
Record the baseline provenance if triaging it.

## Acceptance criteria

- [x] `regressions-allow` with a `tests:` list is verified and honoured in both
      modes; bare `count:` keeps current behaviour exactly.
- [x] Each named test must be shown to be a genuine regression in this diff —
      the property that stops it becoming a general escape hatch.
- [x] The ceiling still binds.
- [x] An unread/inert declaration now says so in the log.
- [ ] Unit tests pinning mode-independence — folded into **#3645**, which should
      assert the **general property** (an allowance is readable at every
      enforcement point) with one test per point, rather than two tests asserting
      two instances of it.
- [ ] Record that the non-rebase path is **not yet field-exercised** until a real
      run proves it: a green gate says nothing about *which* mechanism passed it.
      Pull the artifact and confirm the `EXCUSING` line before believing it.
