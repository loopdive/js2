---
id: 3987
title: "test262 shards are stranded on the absent Node 25 manifest pin — moving them to 24 needs the baseline regenerated first, because conformance results are Node-version-bound"
status: ready
created: 2026-08-01
updated: 2026-08-01
priority: medium
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: current
horizon: m
es_edition: n/a
related: [3963, 2547, 3597, 3467]
---

# #3987 — the test262 lane cannot leave Node 25 until its baseline is regenerated

## Status: open — the remaining half of #3963

## Problem

#3963 established that **Node 25 is not in `actions/node-versions` at all**
(majors present: 26, 24, 22, 20, 18, 16, 14, 13, 12, 10, 8, 6 — zero `25.x`
entries). Every `node-version: 25` job therefore misses the manifest
deterministically and falls through to a direct `nodejs.org` download on every
run. That download is an unconditional third-party network dependency, and when
it fails inside a `merge_group` test262 shard the PR is **auto-parked** with a
`hold` label (#2547) — costing a human-grade diagnosis cycle and stranding the
PR, because the auto-enqueue backstop skips held PRs. Observed on #3914.

#3963 fixed **7 of 18** workflows. `test262-sharded.yml` — the workflow that
actually parked #3914 — was **deliberately left on 25**, and so was the
`setup-node-pnpm` composite default it depends on.

## Why it was left behind

Because moving it broke the conformance verdict. #3963's first revision moved
every pin; the `merge_group` re-validation reported:

```
pass           31086 → 31035    -51
compile_error    652 →  1829  +1177
skip            1278 →   108  -1170
```

`skip` −1170 and `compile_error` +1177 are mirror images — ~1170
previously-skipped tests were suddenly compiled, the transition list
wall-to-wall `Temporal/…: skip → compile_error`. Alongside it, `compile_timeout`
127 → 171 and aggregate compile time +0.9%.

That is a **test-selection and timing change, not a codegen regression**, and
the PR carried no compiler source at all.

**What established attribution** was PR #3964: an unrelated PR that passed the
*same* `check for test262 regressions` gate in `merge_group` in the same window,
**on Node 25**, because it merged just before the pin change. Same gate, same
window — one clean, one showing a 1170-test flip. Baseline drift would have hit
both.

Conclusion: **test262 conformance results are Node-version-bound.** Comparing a
Node-24 run against a Node-25 baseline is not a valid comparison, so the pin and
the baseline have to move together.

## What is not yet known

The exact mechanism was never pinned down, and should be before the change
lands — the plan below differs depending on the answer:

- **Compile-cache invalidation.** The runner keeps a disk cache
  (`.test262-cache`). If cache identity is affected by the Node/V8 version,
  a major bump forces mass recompilation, which fits the `compile_timeout`
  127 → 171 growth and the +0.9% aggregate compile time.
- **Host-engine capability.** Some statuses may depend on what the executing
  V8 provides (Node 25's V8 differs from 24's), which would make certain
  results genuinely engine-dependent rather than merely cache-dependent.
- **Something in the harness** that reads the host engine's own globals.

The `skip → compile_error` direction specifically is not yet explained by
either, since `classifyTestScope` is path-based and has no Node dependence
(see #3986, which was investigated and **ruled out** as the cause here).

## Scope

1. Determine *why* the results move with the Node major. Until that is known,
   any regeneration risks baking in whatever the real effect is.
2. Decide the target: 24 (manifest-present, LTS line, already used by 9
   workflows) or 26 (also in the manifest). Note `engines` is `>=20` and local
   development runs v22, so neither is constrained by the repo's own floor.
3. Sequence the switch so the pin and the baseline move atomically:
   - move `test262-sharded.yml` + the `setup-node-pnpm` composite default,
   - regenerate `test262-current.jsonl` in `loopdive/js2wasm-baselines` under
     the new major via `promote-baseline` / `refresh-baseline.yml` (which must
     move in the same step — it is currently pinned to 25 for exactly this
     reason),
   - expect one noisy diff for every in-flight PR until it settles, and say so
     in advance rather than letting agents diagnose it as a regression.
4. The other baseline-adjacent workflows left on 25 by #3963 move with it:
   `test262-canary`, `test262-differential`, `test262-cache-prune`,
   `baseline-floor-staleness-alert`, `baseline-summary-sync`, `deploy-pages`,
   `issue-tests`.

## Explicitly out of scope

The **benchmark** baselines (`benchmark-refresh.yml`,
`landing-four-lane-backend.yml`) are the same class of problem in a different
domain — the JS lane measures V8, so moving the Node major silently moves
published numbers. #3963 left both on `25.7.0` for that reason. They are worth
their own decision and should not be swept along with the conformance move.

## Acceptance criteria

1. The mechanism behind the Node-version sensitivity is identified and recorded
   — not merely worked around.
2. `test262-sharded.yml` and the `setup-node-pnpm` composite no longer request
   an absent major, so the shard stops depending on a per-run `nodejs.org`
   download.
3. The committed baseline is regenerated under the same major the shards run,
   and a PR opened afterwards shows a clean regression diff.
4. #3963's acceptance criterion 2 — currently marked **not met** — can be
   closed honestly.

## Worth doing regardless — the park is expensive either way

Independent of the version question: `auto-park` could **decline to park** when
the failing step is a known setup/infrastructure step rather than a verdict
step. It already identifies the failing step by name (#3597), which is the hard
part, and its own comment footnote tells the reader to check for exactly this.
That would remove the manual diagnosis cycle for this whole class. Carried
forward from #3963, where it was also left open — the parking behaviour is
conservative on purpose and narrowing it deserves its own judgement.

## Provenance

The unfinished half of #3963, split out so the deferral is tracked rather than
buried in a merged issue's prose. #3963 shipped 7 workflows and recorded its own
criterion 2 as not met specifically so this could be picked up deliberately.
