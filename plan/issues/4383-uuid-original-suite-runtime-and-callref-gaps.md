---
id: 4383
title: "UUID original suite exposes vector, crypto, exception, and callback ABI gaps"
status: ready
sprint: current
created: 2026-08-12
updated: 2026-08-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: arrays, closures, exceptions, crypto
goal: npm-library-support
assignee: ttraenkler/codex
related: [3995]
files:
  - tests/dogfood/uuid-upstream-suite.mjs
  - tests/dogfood/report/uuid-upstream-suite.json
---

# UUID original suite exposes vector, crypto, exception, and callback ABI gaps

## Problem

The pinned `uuid@14.0.1` adapter runs ten original upstream files and all 75
registered callbacks pass in Node. Only **3/75** pass after compiling the same
callbacks and the published implementation to Wasm. This is runtime evidence,
not an extrapolation from compiler diagnostics.

Nine generated test modules validate. `v7.test.ts` instead emits an invalid
callback trampoline:

```text
__call_fn_2: call_ref[1] expected i64, found externref
```

That single ABI defect blocks all 14 v7 callbacks before execution.

## Measured failure buckets

The runner records the thrown assertion/error text for every callback. The
remaining 58 executing failures cluster as follows:

- byte-vector parsing/stringification and output-buffer writes return unequal
  arrays or `undefined` strings (`parse`, `stringify`, v4, and v6);
- v1's option/state path traps with `RuntimeError: illegal cast` in all ten
  selected callbacks;
- v3/v5 digest helpers produce empty output, namespace/property reads become
  null, and expected exceptions are not preserved;
- the Node RNG path reports length 0 instead of 16, while v4's native-random
  probes report `crypto is not defined`;
- `validate` and `version` table cases observe null/undefined results rather
  than the published helper results.

The exact names and messages live in the generated
`tests/dogfood/report/uuid-upstream-suite.json`; the headline alone is not the
acceptance oracle.

## Acceptance criteria

- [ ] `v7.test.ts` emits valid Wasm and its 14 callbacks execute.
- [ ] The v1 illegal-cast cluster is reduced to a minimal compiler regression
      and fixed without UUID-specific source rewriting.
- [ ] Byte-vector parse/stringify/buffer-offset behavior matches Node.
- [ ] Node-platform `crypto`/RNG capability is either provided honestly or
      reported as unavailable without silently returning wrong bytes.
- [ ] Expected RangeError/validation paths preserve throw behavior.
- [ ] The unchanged original suite reaches 75/75 Node and 75/75 Wasm, with zero
      harness-incompatible tests.

## Reproduction

```bash
node --import tsx tests/dogfood/uuid-upstream-suite.mjs --json
```
