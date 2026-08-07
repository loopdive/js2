---
name: reference_standalone_eval_instrument_reports_unmeasured_failures
description: "A standalone eval A/B can report failures it never measured — three distinct mechanisms all substitute a fake error for the real one. Validate the instrument two-sided before believing any number."
metadata:
  node_type: memory
  type: reference
  originSessionId: 003c07aa-a2eb-5278-b5b1-6c63a0be18a6
---

**Any `--target standalone` measurement over eval-touching test262 files can
report failures that were never measured.** Three independent mechanisms do
this, all with the same signature: the *real* per-file result is replaced by a
uniform fake error, so the run looks like a clean result and is not one.

Hit by **three separate lanes in one session (2026-08-06)**, each rediscovering
it from scratch, one of them reading a correct `+2` as `−10`.

## The three mechanisms

1. **The runner does not supply the namespace at all.** `runTest262File`
   (`tests/test262-runner.ts`) omits `js2wasm:runtime-eval`, which
   `scripts/test262-worker.mjs` does supply. The module dies at *instantiate*
   and **the link error overwrites the real signature** — every eval-mentioning
   file reports the same thing regardless of what it would have done. Measured
   82/162 and 44/152 on two different levers. (#4147 / #4162 / PR #4163.)

2. **The provider cache silently downgrades to the REFUSAL tier.** Any `src/`
   edit changes `computeCompilerBundleHash`, invalidating the built provider.
   The run falls back to `--refusal-only`, whose modules instantiate and then
   throw `dynamic code evaluation is not supported`. **That is not what the
   baseline records** — it swaps one failure for another and looks like a
   result. This is the nastiest of the three because it triggers on *exactly*
   the action an A/B performs: editing `src/`.

3. **Only the FULL INTERPRETER tier is CI-comparable.** Build with
   `node --import tsx scripts/build-runtime-eval-provider.mjs` (~99 s) and run
   with `TEST262_FULL_RUNTIME_EVAL=1`. At that tier the error strings match the
   published baseline verbatim; at any other tier they do not.

Also in the family, different layer: a **fresh worktree has no `node_modules`
and no populated `test262/`** (`bash scripts/provision-worktree-deps.sh`). A
hand-made `ln -s test262` was clobbered mid-session and a census went from
1,609 attributed to **0** with no error at all.

## The rule

**Build a two-sided instrument before believing any number**: the failing lever
list *and* a control of files from the same population that currently PASS.

A lever-only measurement cannot distinguish "my fix did nothing" from "my
runner cannot see a pass". Both read as 0.

Concretely, from the lanes that did it right:

- lever 0/168 at base + control 138/138 → the base agrees with the baseline
  *and* the runner can see a pass. Then `+58 / 0 regressed` means something.
- lever 1/42 at base + control 427/427 → same shape, full control population,
  not a sample. Then `+16 / 0 regressed` means something.

Cross-check the base run against the published standalone jsonl file-by-file
and state the disagreement count (one lane: 41 of 42 agree, the one outlier a
CI `compile_timeout` that passes locally). A base run that does not reproduce
the baseline is a broken instrument, not a discovery.

## Why this keeps happening

All three mechanisms fail **toward a plausible-looking failure**, never toward
a crash or an empty result. Nothing in the output says "I did not measure
this". The error is uniform across files, which reads as "this whole cluster
shares a root cause" — the single most attractive wrong conclusion available.

## Related

- [[reference_cached_baseline_jsonl_goes_stale_within_hours]] — same family:
  an instrument that returns confidently while being wrong.
