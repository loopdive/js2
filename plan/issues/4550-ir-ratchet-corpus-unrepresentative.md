---
id: 4550
title: "The IR ratchet corpus is 13 files and unrepresentative: measured 0 % linear-lane claim rate on 5 real npm entry modules, with body-shape-rejected dominant despite its bucket reading zero"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: analysis
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [652, 1376, 2855, 2856, 2859, 3341, 4538, 4539, 4541, 4549]
# id 4550 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: sole open PR was 4639
# (ci/npm-compat-refresh, artifact-only), which adds no issue file.
---

# #4550 — The ratchet's zero is corpus-specific, and now measured

## What was measured (2026-08-17)

The #1376 ratchet reports its unintended buckets at zero, and the bucket work
is `done`: **#2856 — "IR: drive body-shape-rejected fallback bucket to zero
(dominant unintended bucket)"** and **#2859 — "IR: drive
param-type-not-resolvable fallback bucket to zero (TypeMap propagation)"**,
under **#2855 — "IR fallback-corpus ratchet: drive unintended function buckets
to zero"**.

Its corpus is **13 files** under `website/playground/examples`.

Compiling five real npm entry modules through `--target linear` and reading
`getLastLinearIrReport()`:

| module | claimed | rejected | claim rate |
| --- | ---: | ---: | ---: |
| `playground/benchmarks.ts` | 3 | 5 | 37.5 % |
| `cookie@2.0.1` | **0** | 9 | **0 %** |
| `clsx@2.1.1` | **0** | 2 | **0 %** |
| `redux@5.0.1` | **0** | 2 | **0 %** |
| `marked@18.0.2` | **0** | 2 | **0 %** |
| `moment@2.30.1` | **0** | 2 | **0 %** |
| **total** | **3** | **22** | **12 %** |

Rejection reasons across all files:

| reason | count |
| --- | ---: |
| `select:body-shape-rejected` | **10** |
| `select:recursive-type-evidence` | 4 |
| `select:logical-value-unsupported` | 3 |
| `select:param-type-not-resolvable` | 2 |
| `select:string-builder-candidate` | 1 |
| `illegal:instr-vec.set_length` | 1 |
| `select:constructor-resolution-unsupported` | 1 |

**`body-shape-rejected` is the single most common rejection — the same bucket
the ratchet reads as zero.** `param-type-not-resolvable` appears too. This is
not a ratchet defect; CLAUDE.md already states the hazard (#3341): a bucket
absent from the baseline means *the corpus does not trigger it*, never *the
reason is unreachable*. What is new is that the claim is now measured rather
than cautioned about.

**Validity.** A positive control (a known-claimable non-escaping-object
function) was claimed in the same run, so a 0 % rate means "not claimed", not
"the probe cannot see". A first version of this probe lacked that control and
its output would have been indistinguishable from a broken harness.

## The denominators are truncated — do not quote 12 % as coverage

`moment@2.30.1` is 176 KB and reports **2** functions; `marked@18.0.2` is 42 KB
and reports **2**. Those packages contain hundreds. So the linear IR path is
reporting only a small prefix of each module — plausibly bailing at a
module-level gate (`select:recursive-type-evidence` appears exactly once per
large package) before enumerating the rest.

That means the numbers above **understate the population, not the coverage**:
the true claim rate is no better than 12 % and probably worse, but the honest
statement is that we cannot yet count the denominator. Establishing it is the
first deliverable below.

## Why this matters beyond the ratchet

Every downstream measurement in the current program is gated on this, and each
one hit the same wall this session (recorded in **#652 — "Compile-time ARC:
static lifetime analysis for linear memory mode"**):

- the stack-allocation census returned **0/0** — no allocation sites in claimed
  functions, so no denominator;
- `cookie` yielded no analysable function at all;
- ordinary shapes — *object returned*, *object passed to a local callee*,
  *closure capturing a local* — are rejected outright.

**#4549 — "Shared inter-procedural summary framework…"**, #652's region work,
and #4541's representation slice all consume IR that mostly does not exist for
real code today.

## Deliverables

- [ ] **Establish the real denominator.** Determine why large modules report a
      handful of functions, and report claim rate over *all* functions in a
      module, not the reported prefix. Until this lands, no coverage percentage
      should be quoted.
- [ ] **Widen the measured corpus** beyond the 13 playground files — the
      `tests/dogfood/fixtures/*.tgz` pinned tarballs are already in-tree and
      need no network.
- [ ] **Decide the corpus's relationship to the gate.** Widening the *gating*
      ratchet corpus would fail CI immediately, so this is deliberately two
      decisions: a **reported** wide corpus (informational, tracked over time)
      and, separately, whether/when any of it becomes gating. Do not silently
      widen the gate.
- [ ] **Re-rank the buckets by the wide corpus.** `body-shape-rejected` at 10/22
      suggests the retired bucket work was corpus-fitted; the next bucket
      campaign should be prioritised by real-code frequency.
- [ ] Publish the reasons histogram per corpus so a future reader can see which
      corpus a "zero" refers to.

## Non-goals

- Fixing any individual rejection reason. This issue establishes the honest
  measurement; the bucket campaigns act on it.
- Changing the existing gate's pass/fail behaviour. The 13-file ratchet keeps
  doing its job; it simply must not be read as a coverage statement.

## Repro

Probe used: `.tmp/coverage-census.ts` (gitignored — restated here so it does
not die with the container). For each module: `compile(src, { target: "linear",
allocator: "analysis-stack" })`, then read `getLastLinearIrReport()`'s
`compiled` / `rejected` arrays and histogram `rejected[].reason`. Fixtures
extracted from `tests/dogfood/fixtures/<pkg>-<ver>.tgz`; entry modules taken
from `tests/dogfood/<pkg>-pin.json`'s `entryModule`.
