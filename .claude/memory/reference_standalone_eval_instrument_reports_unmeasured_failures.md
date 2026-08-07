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

Cross-check the base run against a **same-mode** jsonl file-by-file and state
the disagreement count (one lane: 41 of 42 agree, the one outlier a CI
`compile_timeout` that passes locally). A base run that does not reproduce its
same-mode baseline is a broken instrument, not a discovery.

### ⚠ The DEFAULT baseline path is the HOST lane — do not diff standalone against it

`.test262-cache/test262-current.jsonl`, what a bare
`scripts/fetch-baseline-jsonl.mjs` hands you, is the **host** lane. Verified
2026-08-07 over all 48,619 rows: the only import namespace appearing anywhere
is **`env`** (2,145,612 occurrences, zero `js2wasm:runtime-eval`), and there is
no `mode`/`target` field to warn you.

**`oracle_lane: "honest"` is NOT a mode marker.** It is the honest-vs-fast
*oracle* axis (#3462) and it is on 100% of rows. It reads like "the real lane",
which is exactly why this is easy to get wrong.

A standalone run diffed against it produces a large disagreement count that
**is the host-vs-standalone gap itself** (one lane measured ~219), not
instrument error. A lane that follows the cross-check instruction literally
will either distrust a working instrument or — far worse — tune its runner
until it agrees with the host lane's answers.

There **is** a standalone baseline; it is just not the default:
`ensureStandaloneBaselineJsonl({ force: true })` from the same module
(`STANDALONE_BASELINE_CACHE_PATH`). Use that, or a prior standalone lane's
jsonl.

### Rebuilding the provider can silently HIT the cache

`node --import tsx scripts/build-runtime-eval-provider.mjs` is **not** by itself
proof of a rebuild: the cache key is `no-bundle`-static in this configuration,
so a plain rebuild can no-op while reporting success — leaving you in the very
refusal tier you were trying to escape. **Delete the cache first, then verify
the emitted binary actually changed** (measured: 3,970,936 → 3,970,952 on one
lane, 3,970,952 → 3,971,726 on another). Two lanes independently reported the
`cache HIT` line after a `src/` edit.

## The trap has a false-NEGATIVE form too, and it is worse

Mechanism 2 does not only turn a good fix into an apparent regression. It also
makes a **landed** fix look like it did nothing — and that reading is harder to
doubt, because "the fix didn't help" is an ordinary outcome nobody
double-checks.

Worked case (W13, 2026-08-06): the 8-file `<Builtin>.bind(null)` bucket in
#4196 fails with `dereferencing a null pointer in __module_init()`. That is
**the same signature the stale-provider path manufactures**. The bucket is
expected to move when #4176/#4155 lands, so someone will re-measure it — and if
they re-measure on top of the new main *without rebuilding the provider*, they
will see the bucket still failing with an unchanged signature and conclude
#4176 did not touch it.

So: **rebuild the provider before any re-measure, and be especially suspicious
when the failure signature is one the trap can synthesise** (null-deref in
`__module_init`, `dynamic code evaluation is not supported`, link/instantiate
errors). Matching signatures before-and-after is evidence of nothing unless you
know the instrument was live for both runs.

## Why this keeps happening

All three mechanisms fail **toward a plausible-looking failure**, never toward
a crash or an empty result. Nothing in the output says "I did not measure
this". The error is uniform across files, which reads as "this whole cluster
shares a root cause" — the single most attractive wrong conclusion available.

## Related

- [[reference_cached_baseline_jsonl_goes_stale_within_hours]] — same family:
  an instrument that returns confidently while being wrong.
