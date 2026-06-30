---
id: 2879
title: "Standalone metric must measure HOST-FREE-ness — credit only host-free passes, not host-satisfied leaky passes"
status: ready
assignee: sendev-hostfree
created: 2026-06-30
priority: high
task_type: enhancement
area: tooling
goal: standalone
sprint: current
horizon: m
related: [2860, 2097, 2870, 2864, 2865, 2866, 2867]
umbrella: 2860
---

# Standalone metric must measure host-free-ness

## Problem (stakeholder strategic call)

The standalone pass metric counts **`status == "pass"`** regardless of whether the
module actually ran host-free. In `--target standalone` the runner still
instantiates with the JS host runtime available, so a module that emitted
`env::__*` host imports **passes by leaning on the host** — a "leaky pass". These
inflate the standalone number and, worse, make the carrier-migration work
(#2864–#2867: generator / async-generator / symbol / promise-microtask carriers,
the `$Object` dynamic reader, etc.) look like **regressions**: replacing a
host-satisfied leaky pass with an in-progress native carrier can drop the test to
fail _while removing a host dependency_ — i.e. real progress scored as a loss.

The metric must measure what "standalone" actually means: **a test counts as a
standalone pass only when it is host-free AND passes.**

## The re-baseline (KEY NUMBER for the stakeholder)

Measured on the PR-2335 merge_group standalone results (48,088 entries; close to
the main baseline):

| metric                                      | count                          |
| ------------------------------------------- | ------------------------------ |
| js-host pass                                | 34,052                         |
| standalone pass — **current** (any imports) | 25,279                         |
| standalone pass — **HONEST (host-free)**    | **12,768**                     |
| leaky passes (pass but `env::` imports)     | 12,511 (**49.5%** of "passes") |

**Scaled to the main-reported basis (24,656 standalone pass):**

- Honest host-free standalone pass ≈ **~12,450** (≈ 50.5% of the current number).
- Current reported gap ≈ 9,177 → **HONEST gap ≈ ~21,600** (vs js-host ~34,052) —
  roughly **2.4× larger**. About half of today's "standalone passes" lean on the host.

Leak-class breakdown of the 12,511 leaky passes (the carrier-migration pool):
`host_import` 4,952 · `iterator_protocol` 4,670 · `dynamic_object_property` 2,553
· `dynamic_code` 328 · `regexp` 8. These are exactly the surfaces #2864–#2867 +
the dynamic-object substrate convert from host-satisfied → native.

### Authoritative host-free criterion (already computed, zero new analysis)

A pass is host-free **iff `host_import_leak_class` is null/absent** — which is
**identical** to "no `env::` import" (verified: 12,768 ≡ 12,768, exact match on
the run). `classifyHostImportLeak` (`scripts/test262-worker.mjs:798–815`) already
derives this per record; `build-test262-report.mjs` already reads
`record.host_import_leak_class`. So the metric change is pure accounting over data
the pipeline already records — no recompile, no new harness pass needed for the
report side.

## Implementation Plan (spec — hand off or land the low-risk parts)

### 1. Report counting — `scripts/build-test262-report.mjs` (additive, safe)

`createCounts()` / `buildSummary()` (lines ~51–72) tally by status. Add a parallel
**host-free** tally:

- In `createCounts()` add `host_free_pass: 0`.
- In the record loop where `counter[status]++` happens, also do:
  `if (status === "pass" && !record.host_import_leak_class) counter.host_free_pass++;`
  (null/undefined/"" leak class ⇒ host-free).
- In `buildSummary()` emit `host_free_pass: counter.host_free_pass` (and a derived
  `leaky_pass: counter.pass - counter.host_free_pass`).
- Surface it in `summary`, `official_summary`, `full_summary`, `strict_summary`
  (all built via `buildSummary`) so every scope reports both numbers.

This is **additive** — adds fields, changes no existing number — so it can land
immediately and start surfacing the honest figure on the dashboard without
disturbing any gate. Landing pages should show `host_free_pass` as the headline
standalone number and `pass` (any) as a secondary "host-assisted" figure.

### 2. Floor / high-water gate — `scripts/check-standalone-highwater.mjs`

`readPassCount()` reads `full_summary.pass`. Switch the gate to the **host-free**
mark:

- Read `full_summary.host_free_pass` (fall back to `pass` for old reports so the
  gate doesn't crash mid-migration).
- **Re-baseline the high-water file** `benchmarks/results/test262-standalone-highwater.json`
  to the honest number (`pass: ~12,450`, not 24,656). This is a ONE-TIME reset
  done WITH stakeholder sign-off (the headline number drops by half — that's the
  point). Keep `tolerance` (50) semantics.
- Effect: carrier migrations now move `host_free_pass` UP (host-satisfied →
  native = host-free gain), so they are scored as **progress**, and a leaky-pass →
  in-progress-native-carrier that temporarily drops to fail no longer trips the
  floor as long as net host-free pass holds.

### 3. Harness `strictNoHostImports` — `scripts/test262-worker.mjs` `doCompile` (line 834)

Today standalone compiles WITHOUT `strictNoHostImports`, so leaks compile and the
host satisfies them at instantiate. Two options (spec recommends 3a now, 3b later):

- **3a (recording, recommended first):** keep compiling as-is, but the record
  already carries `host_import_leak_class` — so the report/gate change above is
  sufficient to MEASURE host-free-ness without changing what runs. Lowest risk;
  no test flips run-status.
- **3b (enforcement, follow-up):** add an opt-in lane that passes
  `strictNoHostImports: true` to `doCompile` so a leaky module **compile-errors**
  instead of silently leaking — turning leaks into honest CEs. This is a stricter,
  noisier mode; gate it behind a flag and roll out after 3a's measurement settles.
  Do NOT flip the default standalone lane to strict in this issue (it would
  reclassify ~12,500 passes to CE in one step).

### 4. Carrier-migration crediting (the regression-avoidance requirement)

With the gate on `host_free_pass`:

- A migration that converts a **leaky pass → host-free pass** is `+1 host_free_pass`
  (progress) even though `pass` (any) is unchanged.
- A migration **mid-flight** (leaky pass → native carrier not yet complete → fail)
  is `host_free_pass` unchanged (the leaky pass never counted) and `pass` (any)
  −1 — but the **floor is on `host_free_pass`, so it does not breach.** Document
  this explicitly in the gate so reviewers read a temporary `pass` (any) dip as
  expected, not a regression.
- Recommend a per-PR companion line in `dev-self-merge` analysis: report
  `Δhost_free_pass` alongside `Δpass`, and treat **`Δhost_free_pass ≥ 0`** as the
  pass/fail signal for standalone, not `Δpass`.

## Acceptance

- Report emits `host_free_pass` (+ `leaky_pass`) in every summary scope.
- High-water gate keys on `host_free_pass`, re-baselined to ~12,450 (stakeholder
  sign-off on the headline drop).
- A carrier migration that removes a host dependency scores as progress, and a
  mid-flight migration does not trip the floor.
- Landing page shows host-free as the headline standalone number.

## Notes

- The re-baseline number (~12,450 host-free vs 24,656 reported; honest gap ~21,600
  vs ~9,177) is the deliverable the stakeholder asked for. Re-measure on the live
  main baseline jsonl before committing the high-water reset (this estimate is off
  the PR-2335 run; expect ±a few hundred).
- Spec authored by sendev (verify-first measurement). Low-risk part (§1 report
  counting) can land immediately; §2 re-baseline + §3b enforcement want stakeholder
  sign-off given the headline halving.
