---
id: 4352
title: "#4313 is blocked by a reproducible oob trap-ratchet growth on Temporal/PlainDateTime/from/limits.js, plus a 221 > 200 catastrophic-guard trip on a net-POSITIVE diff"
status: in-progress
sprint: current
created: 2026-08-10
updated: 2026-08-10
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: ci
goal: test-infrastructure
related: [4313, 3189, 3596, 1668, 2547]
---

# #4313's park is real, unlike the other three of that day

PR #4313 (`feat(npm-compat): advance real package execution frontiers`) has been
auto-parked twice. Unlike the other parked PRs of 2026-08-09/10, its failure is
**deterministic and reproduces identically across both merge_group runs**, so it
is a genuine gate failure rather than baseline drift.

## Failure 1 — oob trap-ratchet growth (both runs)

```
GATE FAIL: trap category "oob" grew 35 → 36 (+1) — uncatchable-trap ratchet (#3189).
Now trapping: test/built-ins/Temporal/PlainDateTime/from/limits.js (baseline: fail).
```

Identical file, identical delta, in both:

- run `31322523731` (2026-08-09 16:19)
- run `31349616814` (2026-08-10 02:39)

Per the gate's own policy text the baseline status selects the remedy, and this
file's baseline status is `fail`, not `pass`:

> `fail` ⇒ named **trap-growth-allow** (#3596)

So this is not a conformance regression — the file was already failing. What
changed is *how* it fails: from a plain failure to an uncatchable trap. That
needs either a named `trap-growth-allow` entry or a fix to whatever now traps.

## Failure 2 — catastrophic guard on a net-positive diff

```
Catastrophic guard: 221 wasm-change regressions (threshold 200)
=== Net: +52 pass (32533 → 32585) ===
=== Host stable-path fine-gate net: +41 (262 improvements − 221 regressions) ===
```

The diff is **net positive** (+41 / +52) yet trips a guard that counts raw
regressions and ignores improvements. #4313 is large (133 files, 47 commits), so
high churn in both directions is expected. Worth deciding whether the guard
should consider net, or whether this PR genuinely needs splitting.

## CORRECTION 2026-08-11 — the two failures are one failure and its consequence

**Failure 2 is not independent of Failure 1.** The #1668 guard is subordinate to
`diff-test262`'s own verdict, not a parallel check. From `test262-sharded.yml`:

```bash
if [ "$diff_exit" -eq 0 ]; then
  echo "Catastrophic guard: diff-test262 gate PASS (exit 0, authoritative — #3303)"
  if [ "$NET" -gt "$CATASTROPHIC_REGRESSION_THRESHOLD" ]; then
    echo "Raw count exceeds ${CATASTROPHIC_REGRESSION_THRESHOLD} but the script's own gate approved it"
  fi
  exit 0        # passes regardless of the raw count
fi
# the coarse 200 threshold is consulted ONLY on diff_exit == 1
```

So the 221 > 200 trip is downstream of the trap-ratchet failure. Once the fine
gate exits 0 the guard passes on 221 raw regressions by design. **No net-vs-raw
policy change is required, and this issue should not be read as calling for
one.** The fine gate is already net-aware — it waived the 84.4 % regression
ratio on this very diff because "net conformance change is +41 … ratio is
advisory on a net-positive diff" (#3457).

## CORRECTION 2026-08-11 — Failure 1 does not reproduce on current main

Measured by A/B on current `main` (`8b4c45b`) for
`test/built-ins/Temporal/PlainDateTime/from/limits.js`:

| target | main | #4313 |
| --- | --- | --- |
| gc / host | `RuntimeError: dereferencing a null pointer` (null_deref trap) | `Test262Error: Expected a RangeError but got a ReferenceError` — clean failure, no trap |
| standalone | `compile_error` (#2046) | `compile_error`, identical — excluded by #3595 |

The file moves *out* of the trap categories, matching the gate's own
`null_deref 1629 → 145`. Swapping only #4313's `calls.ts` onto main reproduces
the baseline exactly, so the missing-argument NaN sentinel and the
`__extern_is_undefined` guard are **not** implicated.

Why the recorded runs disagree: all three report byte-identical totals (221,
+52, 32533 → 32585) despite being a day apart, i.e. the measured state never
moved. #4313 only reached current `main` on 2026-08-11.

**No `trap-growth-allow` was declared, deliberately.** A declaration carrying
`tests:` is machine-verified and verification can only refuse, never admit;
declaring a reclassification that no longer occurs risks the
`REFUSING baseline push` wedge of 2026-07-25 (#3644), and would permanently mask
a genuine future regression on that file. The park-hold was removed instead so
the queue re-measures against current `main`.

## Not part of this issue

The first park also cited a standalone high-water breach of −2324. That did
**not** reproduce: the second run measured `+26` (29,520 vs mark 29,494) with no
code change, so that portion was base-related.

## State

The `hold` label is intentionally in place. #4313 should not be re-admitted
until the trap growth is addressed — it is the one PR of the four parked that
day with a confirmed, reproducible defect.
