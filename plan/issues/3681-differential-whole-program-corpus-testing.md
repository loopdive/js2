---
id: 3681
title: "Differential whole-program corpus testing — diff stdout/stderr/exit-code against Node (scriptc-inspired)"
status: backlog
sprint: Backlog
updated: 2026-07-27
created: 2026-07-26
priority: medium
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: test-infrastructure
---

# #3681 — Differential whole-program corpus testing

## Context / provenance

From the 2026-07-26 [vercel-labs/scriptc](https://github.com/vercel-labs/scriptc)
comparison. scriptc's primary correctness harness is **differential testing**:
800+ corpus programs run under both Node and the compiled binary, and
**stdout, stderr, and exit codes must match byte-for-byte**. They make no
test262 claims at all — the corpus diff *is* their conformance story.

## Why we want it too (not instead of test262)

test262 measures spec conformance one assertion at a time; it is our roadmap
metric (29,568/43,097). But its shape has blind spots a whole-program diff
catches:

- **Miscompilations that don't trip an assertion** — wrong-but-plausible
  output, ordering bugs, output interleaving, exit-code paths.
- **Feature *interaction* bugs** — test262 files are deliberately minimal;
  real programs compose closures + classes + async + string ops in one flow.
  Our sprint history is full of bugs that only manifested in composition.
- **stderr/exit-code semantics** — essentially untested today; matters for the
  WASI/CLI target (`fd_write`, `proc_exit`).

We already have the seed: `tests/equivalence.test.ts` compares compiled
results against host evaluation, and `playground/examples/` is a ready-made
corpus (already walked by `check:ir-fallbacks`). This issue scales the idea
from expression-level equivalence to **process-level** equivalence.

## Proposal

1. **Harness** (`tests/differential.test.ts` or standalone runner): for each
   corpus program, run (a) under Node (tsx/ts-node), (b) compiled to wasm and
   executed in both JS-host and standalone/WASI modes. Diff stdout, stderr,
   exit code. Byte-for-byte, with a small documented normalization list
   (e.g. stack-trace frames) — every normalization is a numbered, deliberate
   divergence, scriptc-style: "nothing diverges silently."
2. **Corpus**: start with `playground/examples/` (zero new content), then grow
   with programs written to *compose* features. Target ~100 programs first,
   scaling toward scriptc's 800+.
3. **CI**: run in `quality` or as its own cheap job — this is minutes, not the
   test262 shard matrix. Failures block like equivalence failures.
4. **Divergence ledger**: `docs/divergences.md` — numbered list of deliberate
   Node/js2wasm output differences with rationale (mirrors scriptc's "a few
   dozen documented divergences" practice).

## Non-goals

- Not a replacement for test262 or the equivalence suite
- No fuzzing in v1 (a fuzzer feeding this differential oracle is the natural
  follow-up — file separately when the harness exists)

## Acceptance criteria

- [ ] Runner executes a corpus program under Node and under compiled wasm
      (JS-host mode) and reports a unified diff of stdout/stderr/exit-code
- [ ] Standalone/WASI lane included or explicitly deferred with a follow-up id
- [ ] `playground/examples/` corpus onboarded; count reported per run
- [ ] Wired into CI as a blocking check on a lane that runs per-PR
- [ ] `docs/divergences.md` exists; every normalization in the harness cites a
      numbered entry

## 2026-07-27 update — the proposed harness already exists

Filed independently the same day: **the runner this issue proposes already
exists** — `tests/differential/corpus/` + `scripts/diff-test.ts` (#1203),
predating this issue. It already does exactly item 1 (Node vs compiled-wasm
stdout diff, JS-host mode, `benchmarks/results/diff-test.json`) and item 3
(`scripts/diff-test-gate.ts` delta gate, wired in `.github/workflows/diff-test.yml`).
#3690 grew its corpus (generators/, private-fields/, deeper regex/symbol —
also scriptc-inspired) and found the existing gate design already matches
this issue's "failures block like equivalence failures" goal, scoped to
regressions only (new/still-failing corpus entries are informational, not
blocking, so the corpus can grow ahead of the compiler).

**Still genuinely open from this proposal**: no `stderr`/exit-code diffing
(stdout only today), no standalone/WASI lane, no `docs/divergences.md`
ledger, and the corpus is ~120 programs vs the ~100+ target. Worth
re-scoping this issue as "extend the existing harness" rather than "build
a harness" to avoid a future duplicate build.
