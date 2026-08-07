---
name: reference_standalone_eval_instrument_reports_unmeasured_failures
description: "A standalone eval A/B can report failures it never measured — several distinct mechanisms substitute a fake error, a stale number, or a vacuous pass for the real result. Validate two-sided, RED-on-base, and on a freshly cut base before believing any number."
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

### Two MORE ways the harness measures the wrong compiler (2026-08-07, W26)

Same family, different layer — neither is about the provider:

4. **The pool worker imports `scripts/compiler-bundle.mjs` and
   `scripts/runtime-bundle.mjs` — NOT `src/`.** Edit `src/`, re-run through the
   pool worker, and you measure the **previous compiler**. Both bundles must be
   rebuilt for **each arm** of an A/B. Fails exactly like the provider-cache
   trap: a plausible result, no error, nothing saying the arm never saw your
   change.

5. **`scripts/provision-worktree-deps.sh` silently no-ops on a container with
   no `/workspace`.** `SOURCE_ROOT` resolves to the agent's own worktree and the
   script **exits 0 having done nothing**. The pool worker then dies importing
   the missing `scripts/compiler-bundle.mjs`, every test times out at 90 s, and
   the run reports **everything FAILED with a 0-byte jsonl**. Workaround:
   `JS2_WORKTREE_SOURCE=/home/user/js2`. Cost one lane ~1 h.

   This one at least fails loudly — but *implausibly* loudly. A 201/201 wipeout
   reads as "my change broke the world", so the danger is not believing it; it
   is spending an hour bisecting your own diff. **A total failure with a 0-byte
   jsonl is an instrument failure until proven otherwise.**

   **The REPAIRED run has its own trap, and this one is silent.** A second lane
   hit the no-op, re-ran with `JS2_WORKTREE_SOURCE`, and the repaired run linked
   `node_modules` and a per-entry `test262/` symlink farm into **another agent's
   worktree** rather than the main checkout. Point it at `/home/user/js2` and
   verify where the links actually landed (`ls -l node_modules test262`).

   A dep tree living inside another lane's worktree is a **delayed** version of
   the clobber that once took a census from 1,609 attributed to 0: it works
   perfectly until that lane's worktree is removed after its PR merges, and then
   your next run fails — or worse, half-fails — for reasons that have nothing to
   do with your change. Worktree cleanup is routine, so this is a scheduled
   failure, not a hypothetical one.

### ⚠ The pre-scan "dirty" gates cannot bound a blast radius in THIS corpus

A tempting safety claim is "my change is gated on `protoNamedDirty` (or another
pre-scan dirty flag), so every file that fails the gate is byte-identical."
True in principle. Worth **0.07 %** of the corpus in practice.

The js2wasm host-globals shim that `assembleOriginalHarness` prepends to
**every** file contains `return eval(sourceText);`, so `isDynamicCodeUse` sets
`dynamicCodeDirty` ⇒ `protoNamedDirty`. Measured 2026-08-07 over the effective
source of all 48,619 baseline rows: **48,587 have the gate SET; 32 are provably
clear.**

So the gate is not a filter, it is a constant. Size exposure by the **real
trigger** — the syntactic shape that actually reaches your modified code path —
and byte-hash the emitted modules to prove the rest untouched. Any reviewer
seeing "gated on X ⇒ safe" should ask what fraction of the corpus fails gate X.

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

## The provider CACHE KEY tracks neither the input nor the output

The section above says an `src/` edit invalidates the provider. **Do not rely
on the key to tell you that it did.** Two independent measurements, 2026-08-06:

- W20 / #4201 — four builds in one worktree, key `854c120ce015d507` **unchanged
  throughout**, while the artifact was **3,971,954 bytes** on
  `origin/issue-4196-bind-construct` and **3,995,550 bytes** on `main` (with
  and without the #4201 edit). Full numbers in
  `plan/issues/4201-standalone-wrapper-valueof-returns-wrapper.md`.
- W21 / #4202 — same key, byte-identical output across an `src/` edit that
  demonstrably changed compiler behaviour.

Together those close both directions: **`cache MISS` is not evidence the key
noticed your edit, and a byte-identical rebuild is not evidence it didn't
recompile.** Deleting `.test262-cache/runtime-eval-provider-*.wasm` is the
only control.

## A VACUOUS fixture: green on unfixed main, having measured nothing

The worst member of the family, because the other mechanisms produce a *wrong
number* while this one produces a **passing test**, and nobody re-examines a
green test.

Worked case (W21, #4202): the probe harness wrapped the body in
`export function test() { … }` to read a verdict back. A top-level `export`
makes TypeScript call the source a **MODULE**, and module top-level `this` is
legitimately `undefined`. So the assertion

```js
function f() { "use strict"; return this; }
f.call(this) === this          // intended: the global object is installed
```

read `undefined === undefined` and **passed on unfixed main**. Only the
base A/B caught it; a head-only run would have shipped it.

It generalises well past `this`: **any fixture whose two sides collapse to the
same sentinel is vacuous** — `undefined`, `null`, `NaN`-vs-`NaN` under the
wrong comparator, `0`-vs-`-0`, an empty collection compared to an empty
collection.

The structural defence is the one that caught it, and it is cheap:

- **every fixture must be RED on base**, verified by A/B, not by reasoning;
- plus a separately *named* **PRECONDITION** case that is green on **both**
  arms, proving the probe reached the substrate at all.

For Script-goal `this` questions specifically, use #4190's harness shape:
no `export` anywhere in the body, signal failure by **throwing**, treat a
completed `__module_init` as the pass, and pass
`inferModuleStrictArguments: false` to pin the Script goal the way
`runTest262File` does.

## A STALE BASE — re-cut it if you sit behind another lane's landed fix

Same failure class, one layer out: the instrument is live, but the *base* it is
compared against is not.

- W20 / #4201 read **`FIXED 0`** from a base cut at `origin/main@50127992c8`,
  40 minutes before #4196's `[[Construct]]` slice landed as `14cb0f08d1`.
  Without that predecessor the 12 target files failed **upstream** of the
  lever, so the lever was genuinely dead and the zero read as a refutation.
  Re-measured on the true tip: **`FIXED 12` / BROKE 0.**
- W21 / #4202 was cut at the **same commit**, and re-measured on the tip for
  that reason. Result: **identical file-for-file, 0 differences across 307** —
  a null result, recorded deliberately, because "checked, unchanged" and
  "assumed unchanged" are different claims.

Note the two ran in **opposite directions**: a stale base made W20's real fix
read as zero, and could only have made W21's *residue census* read inflated. A
stale base distorts whichever side you did not re-cut — so re-cut before
believing either a zero or a headline residue.

## Why this keeps happening

Every mechanism here fails **toward a plausible-looking result**, never toward
a crash or an empty one. Nothing in the output says "I did not measure this".
The three link/refusal mechanisms produce an error that is *uniform across
files*, which reads as "this whole cluster shares a root cause" — the single
most attractive wrong conclusion available.

The wider family is one thing: **an instrument that answers confidently
without having measured.** They differ only in what they substitute for the
result, and the last one is the worst because nobody re-examines a green test:

| substitution | reads as | caught by |
| --- | --- | --- |
| link error / refusal error replaces the real signature | a shared root cause | provider tier + deleting the cached `.wasm` |
| base cut before a predecessor landed | a real fix reads `FIXED 0`; a residue reads inflated | re-cut the base at the true tip |
| fixture's two sides collapse to one sentinel | **a pass**, having asserted nothing | RED-on-base A/B + a named PRECONDITION case |

## Related

- [[reference_cached_baseline_jsonl_goes_stale_within_hours]] — same family:
  an instrument that returns confidently while being wrong.
