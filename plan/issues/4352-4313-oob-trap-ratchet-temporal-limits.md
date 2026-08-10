---
id: 4352
title: "#4313 is blocked by a reproducible oob trap-ratchet growth on Temporal/PlainDateTime/from/limits.js, plus a 221 > 200 catastrophic-guard trip on a net-POSITIVE diff"
status: ready
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

## Not part of this issue

The first park also cited a standalone high-water breach of −2324. That did
**not** reproduce: the second run measured `+26` (29,520 vs mark 29,494) with no
code change, so that portion was base-related.

## State

The `hold` label is intentionally in place. #4313 should not be re-admitted
until the trap growth is addressed — it is the one PR of the four parked that
day with a confirmed, reproducible defect.
