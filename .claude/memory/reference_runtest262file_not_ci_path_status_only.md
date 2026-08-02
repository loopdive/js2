---
name: reference-runtest262file-not-ci-path-status-only
description: runTest262File is NOT the CI path — only its pass/fail status is trustworthy; its error category AND source location are both artifacts that manufacture non-existent blockers
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T07:23:14.830Z
---

**`runTest262File` (`tests/test262-runner.ts`) is not the CI path. Trust only its
pass/fail status. Its error *category* and *source location* are both wrong for
standalone failures.**

It renders payloads via `originalHarnessThrownText`, which skips
`tryNativeExnRender`, so a standalone `Test262Error` shows as
`uncaught Wasm-GC exception (non-stringifiable payload)` instead of its real
assertion message — and the reported line is the wrong frame.

**The CI path** is `assembleOriginalHarness` → `CompilerPool(n, "unified")` →
`scripts/test262-worker.mjs`. It needs two generated bundles
(`scripts/compiler-bundle.mjs`, `scripts/runtime-bundle.mjs`) which are
**gitignored** — build them with esbuild first. Running ONE test through this
path takes ~10 minutes and is the only trustworthy classifier.

**Measured cost of not knowing this (2026-07-25, two lanes):**
- Lane A saw every standalone `Test262Error` as an opaque payload and nearly
  triaged the wrong defect.
- Lane B got `category: other` + `frame: null` and concluded a
  **frameless trap** → believed no declaration could excuse it → predicted a
  wedged queue → stopped and escalated. The CI path showed
  `category: assertion_fail` (**not** a trap category — `TRAP_ERROR_CATEGORIES`
  is `null_deref/illegal_cast/oob/unreachable`), so the #3189 ratchet never
  engaged and the frame was irrelevant. **The blocker did not exist.**
- Lane B's reported failure line (`at L16`, a top-level `typeof` read) was ALSO
  an artifact: the real failure was deep inside the harness callback. The CI
  path turned a hypothesis into a confirmed finding.

**Corollary — the frame tiering:** the frame/innermost check applies to the
**trap tier only**. A non-trap `pass→fail` flip is excusable on a declared
ceiling alone (`isDevacuificationExcusableFlip`); a null frame there is
harmless. Do not treat "frameless" as fatal without first checking the category.

## Second blind spot: it does NOT apply the #2961 host-import refusal

**Measured 2026-08-01 (#3962 / native `instanceof`).** The standalone
import-leak refusal lives in the **CI worker only**
(`scripts/test262-worker.mjs`: `target === "standalone" && imports.length > 0
→ compile_error`). `runTest262File` does not apply it, so it happily
**satisfies** the very host import under test.

**Consequence: any lever whose mechanism is "stop emitting a host import" reads
as `+0 / −0` locally — and the zero is an artifact, not a result.** The tests
already ran on their merits locally *because* the import was satisfied, so
removing it changes nothing there.

The agent nearly reported "+0, the fix does nothing" on a working change. What
saved it was interrogating the zero instead of accepting it. Measure such
levers by:

1. **Census the import count** (N files going 1 → 0 imports) — that proves the
   leak is closed and is trustworthy locally.
2. **Run with zero imports and record pass-on-merits** — status is the half of
   this instrument you can trust.
3. **Derive the CI delta from the worker's rule** and label it a *derivation*,
   quoting the rule so a reader can check it. Do not call it measured.
4. For a primitive, prefer **verdict agreement** (native vs host answer on every
   gated file — here 36/36) as the correctness evidence; it is stronger than a
   flip count.

## Companion technique: trigger-shape enumeration

When a change is **inert unless the source contains a specific syntactic
shape**, statically scan the corpus for that shape. That converts an
extrapolation into a **complete population** — files without the shape compile
byte-identically, so they cannot move.

**Positive-control the enumerator** against a directory where you already have
ground truth (2026-08-01: 20/20 of the known gains fell inside the trigger set,
and the only non-trigger file that moved was a known contention flake). That is
what makes a number quotable as a *population* rather than a sample. Applies to
most codegen levers.

## ⚠ It does NOT apply the #2961 host-import refusal — lane shifts are INVISIBLE

Measured 2026-08-02. `runTest262File` does not enforce the standalone
host-import refusal, so a change that pushes work **off a native lane and onto a
host-import lane** produces **no signal at all** in a 500-file runner control —
the files still pass, and the control reports clean either way.

That is a silent-regression channel for any **lane-routing** change. The runner
control is necessary and not sufficient; it needs a **second instrument**:

```js
// compile the affected shapes in standalone, then read the imports directly
WebAssembly.Module.imports(mod)   // must not gain env::* entries
```

The agent that found this only caught it by compiling five array shapes and
listing the imports by hand. **Any change that moves work between lanes must
carry this check**, or "0 regressions" means only "0 regressions among the
things this instrument can see" — the [[reference_silent_empty_is_indistinguishable_from_real]]
shape again.

Same family as [[reference_untested_recovery_paths_rot_silently]] and
[[reference_label_evidence_by_source_before_reasoning]]: a tool that works
locally and silently reports something different in CI. Also see
[[reference_baseline_jsonl_authoritative_over_local_repro_status]] — the
baseline jsonl, not a local run, decides a park's remedy.
