---
name: reference-baseline-jsonl-authoritative-over-local-repro-status
description: "When diagnosing a trap-ratchet park, the CI baseline jsonl status is authoritative — a local repro can report a DIFFERENT status (fail vs compile_error) and route you to the wrong fix"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T00:38:02.375Z
---

When diagnosing why a PR parked on the #3189 uncatchable-trap ratchet, the
**baseline status of the newly-trapping file decides which fix applies** — and a
local reproduction can report a *different* status than the CI baseline jsonl.

**Measured 2026-07-24/25 (#3563):** a local run reported `status: fail`; the
authoritative CI baseline jsonl said **`compile_error`**. Those route to opposite
remedies:

| baseline status | remedy |
| --- | --- |
| `compile_error` / `compile_timeout` / absent / same `wasm_sha` | **#3595 excludes it automatically — NO declaration**, the baseline never observed runtime behaviour |
| `fail` (ran to completion, real verdict) | **#3596 named `trap-growth-allow:` declaration** — the baseline legitimately testified, so it cannot be auto-excluded |
| `pass` | neither — a genuine pass→trap regression must hard-fail |

Trusting the local run would have produced a `trap-growth-allow` declaration for
#3563 that it does not need (noise, and it wrongly implies the class requires
paperwork). Conversely #3583's file really was baseline `fail`
(`negative_test_fail`), so #3595 correctly does *not* cover it and the valve
really was required — two PRs that look structurally identical resolved
differently.

**Rule:** fetch the baseline jsonl (`node scripts/fetch-baseline-jsonl.mjs` →
`.test262-cache/test262-current.jsonl`) and read the file's status there before
choosing a remedy. Never infer it from a local repro.

Related: [[feedback_verify_local_repro_against_known_good_control]] (check
`.status`, not `.outcome`), [[reference_grep_false_empties_diff_test262]]
(`grep -a` on that file), [[feedback_baseline_drift_cross_check]].
