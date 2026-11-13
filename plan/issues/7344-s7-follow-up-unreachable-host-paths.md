---
id: 7344
title: "S7 follow-up: delete the host paths the S7 chain left unreachable"
status: ready
sprint: current
created: 2026-11-13
updated: 2026-11-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: architecture
parent: 6979
depends_on: [6979]
related: [6979, 3525]
---

# #7344 — S7 follow-up: delete the host paths the S7 chain left unreachable

## Problem

The S7 chain (#6979, PR #7226) removed the host-semantic implementation and
folded the IR resolver hooks that had become constants. Its adversarial review
found three host-only paths that no lane can reach any more but that the chain
does not delete, because each is larger than a contained deletion. Unreachable
code in `src/ir/` breaks the rule "no branches for cases that cannot occur",
so it is tracked here instead of being left unrecorded.

## What is left

1. **Host Promise-delay path.**
   - `supportsHostPromiseDelay` (`src/codegen/index.ts`) is
     `jsHostExterns && !ctx.fast && !ctx.nativeStrings`. On every WasmGC
     target `jsHostExterns` is false and `nativeStrings` is true, so it is
     always false, and `supportsStandalonePromiseDelay` requires `!ctx.wasi`.
     The `"host-executor"` projection therefore never occurs.
   - Dead with it: the host-executor arms of
     `src/ir/promise-delay-lowering.ts` (timer, resolve, `Promise_new`
     construction, the `env.__call_1_f64` import ref) and the non-native
     branch of `src/codegen/ir-overlay-finalize.ts` (`Promise_new`,
     `__box_number`, `ensureLateImport("__call_1_f64")`).
   - Why it was not deleted in the chain:
     `tests/issue-3525-prepared-source-map-data.test.ts` lowers exactly these
     arms to build its `donorFixture`, which 8 tests use. Deleting the arms
     needs a replacement donor first.
2. **Host generator lowering.** After the chain, the generator prologue arm is
   an unconditional build-stage refusal (`refuseIrGenerator`). Everything
   behind it is unreachable: `yield` to `gen.push`, the builder's buffer slot,
   the `isGenerator` plumbing and the backend gen ops.
3. **Runtime-manifest target `"strict-no-host"`.** `irProgramRuntimePolicy`
   now returns only `"wasi"` or `"standalone"`, so this variant can no longer
   be produced (the `RuntimeTarget` union in
   `src/runtime/contracts/provider-policy.ts`, `src/ir/runtime/manifest.ts`,
   `src/ir/runtime/number-remainder-callables.ts`, `src/ir/program-source.ts`).
   `"host"` stays: the linear backend still produces it
   (`src/ir/backend/linear-integration.ts`). 18 test files name
   `"strict-no-host"`.

Not part of this issue: `src/codegen/array-methods.ts` still reports
"Missing __call_1_f64 import for forEach" for
`[1, 2].forEach("x" as any)`. That path is reachable; it is a refusal whose
message names a retired import, and the right fix is a runtime `TypeError`.
File it separately if it is picked up.

## Implementation Plan

### Target structure

Deletions only, one PR per item, each in the module that owns the path. No
new helper, no new flag.

1. **S1 — Promise-delay.** Give `issue-3525-prepared-source-map-data` a donor
   built from a lowering that is still live (the standalone Promise-delay
   resolver), then delete `supportsHostPromiseDelay`, the `"host-executor"`
   projection, the host-executor arms and the non-native finalize branch.
2. **S2 — host generator lowering.** Delete everything behind
   `refuseIrGenerator` that only the host generator path used. Check each
   backend gen op for a second user before deleting it.
3. **S3 — `"strict-no-host"`.** Remove the variant and update the tests that
   name it.

### Constraints

- Output byte-identical to the base on gc, standalone and wasi for the 13
  playground examples and a 320-file test262 sample: the deleted code is
  unreachable, so any byte change means a path was live.
- Each slice lists what it searched to show the path is unreachable.

## Acceptance criteria

Correctness:

1. Byte identity as above, per slice.
2. The issue-3525 tests keep their count and pass with the new donor.
3. `check:dead-exports` and the LOC and function budgets pass without grants.

Code quality:

4. No reference to `host-executor`, `supportsHostPromiseDelay` or
   `"strict-no-host"` remains in `src/` after the respective slice, and no
   comment describes the deleted paths.
5. A fresh-context adversarial review records its verdict in each PR body.
