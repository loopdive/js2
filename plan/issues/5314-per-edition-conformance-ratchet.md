---
id: 5314
title: "Per-edition test262 conformance ratchet — a completed ES edition may never regress"
status: done
sprint: current
created: 2026-09-04
updated: 2026-09-04
completed: 2026-09-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, conformance
language_feature: n/a
goal: conformance-infrastructure
related: [2097, 1897, 1668, 3953, 4412, 3467, 959]
origin: "2026-09-04, project-lead directive: after an ES5 regression was reported during ES2016 standalone work, add a gate that does not allow any regression in an already-completed ES edition."
---

# #5314 — per-edition conformance ratchet

## The hole this closes

Every existing test262 guard scores the corpus as **one number**:

| gate | what it reads |
| --- | --- |
| #2097 standalone high-water floor | aggregate standalone pass count |
| #1897 standalone net gate | aggregate delta vs a moving floor |
| #1668 catastrophic guard | aggregate pass→fail magnitude |
| #3467 per-SHA regression diff | per-test, but corpus-wide and merge-base relative |

So **−40 in ES5 against +50 in ES2016 reads as +10 and passes all of them.** An
edition the project has already finished can rot silently while attention is on
the edition being worked, and nothing anywhere reports it. That is not a
hypothetical failure mode for this repo — the whole ES5 → ES2015 → ES2016
sequencing model assumes finished editions stay finished.

## What landed

`scripts/test262-edition-ratchet.ts`, run inside the **required**
`merge shard reports` check, so a breach blocks the merge queue.

It classifies every row of a run's JSONL by ES edition using the *same*
`classifyEdition` / `parseFrontmatter` the dashboard uses
(`scripts/generate-editions.ts` — one classifier, not a second opinion), then
applies two independent checks against
`scripts/test262-edition-ratchet-baseline.json`:

1. **Counts** — a ratcheted edition's pass count may rise or hold, never fall.
2. **Per-test** (`--compare <baseline.jsonl>`) — any individual test in a
   ratcheted edition that goes pass → not-pass fails the gate **even when the
   edition's total is flat or up**.

Check 2 is the one that matters. A count-only ratchet lets you break test A and
fix test B and call it even. It is not even: it is a regression plus an
improvement, and the regression still has to be a deliberate, reviewed act.

## Design decisions that are load-bearing

- **Every edition is ratcheted by default.** A ratchet that guards only the
  editions someone remembered to list is not a ratchet. Opting one out requires
  `ratcheted: false` **plus a `reason`**, in a reviewed diff.
- **Partial runs are skipped, never scored — and `--update` refuses them
  outright.** A path-filtered or sharded run sees only part of an edition, so
  its pass count is not a measurement; scoring it would read as a collapse, and
  banking it would silently lower the bar. This is the #4412 hazard, where a
  single-shard local run posted a partial total beside real full-corpus rows.
- **`--update` refuses to lower any number.** The gate cannot be made green by
  re-baselining. Lowering a floor is a hand edit to the JSON in the same PR,
  with a reason. cf. #3953: a high-water floor that sat 475 tests too low
  reported "passed" for 37 consecutive merges, because **a floor that is too low
  never fires**.
- **An edition measured but absent from the baseline reports `UNGATED`** with a
  CI warning annotation. Silence about an unprotected edition is the same defect
  class as #3953 — the gate would look like it was working.
- **The baseline records its `eval_engine`.** A refusal-only runtime-eval
  provider fails every eval-dependent test by construction (667 in the ES5
  corpus, measured), so its counts are not comparable to a QuickJS run. A
  mismatch **warns rather than refuses**: a floor from the weaker engine is a
  lower bound and cannot cause a false failure, whereas refusing would wedge CI
  over a difference that is harmless in that direction.

## Tests

`tests/test262-edition-ratchet.test.ts` — 10 cases, written to assert the gate
**FAILS** when it should, not merely that it passes when it should. That
emphasis is deliberate: a gate with no test is a gate that can silently stop
gating, which is exactly how #3953 happened. Covered: count regression;
count-neutral swap (per-test check); explicit opt-out honoured; partial run
skipped; partial run refused for `--update`; regression refused for `--update`;
cross-target refusal; improvement banked; ungated edition reported.

## Baseline provenance

Seeded from a full ES5 (9,029) and ES2016 (124) standalone run measured on this
`upstream/main` revision, under `eval_engine: interpreter` with the refusal-only
provider — the QuickJS provider needs clang-18, unavailable on the measuring
host. The remaining editions report `UNGATED` until the first full CI run banks
them with `--update`.

## Measurement note worth keeping

While building this, an apparent 8-test ES5 regression turned out to be entirely
a harness artifact. The eval-refusal provider is cached under a key derived from
the compiler bundle, so **rebuilding the bundle without rebuilding the provider**
makes every eval-dependent module fail at instantiate with
`Import #0 module="js2wasm:runtime-eval": module is not an object or function` —
which reads exactly like a pass→fail regression. Any local A/B that rebuilds the
bundle must rebuild the provider too, and must count *that* message separately
from the legitimate `dynamic code evaluation is not supported` refusal, which is
correct behaviour and not a fault.
