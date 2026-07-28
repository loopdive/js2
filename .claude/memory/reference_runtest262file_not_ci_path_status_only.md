---
name: reference-runtest262file-not-ci-path-status-only
description: runTest262File is NOT the CI path — only its pass/fail status is trustworthy; its error category AND source location are both artifacts that manufacture non-existent blockers
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T11:45:18.683Z
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

Same family as [[reference_untested_recovery_paths_rot_silently]] and
[[reference_label_evidence_by_source_before_reasoning]]: a tool that works
locally and silently reports something different in CI. Also see
[[reference_baseline_jsonl_authoritative_over_local_repro_status]] — the
baseline jsonl, not a local run, decides a park's remedy.
